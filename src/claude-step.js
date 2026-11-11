// 由 Claude Code / Codex 驱动一个 dsh step：拿这一轮的用户消息 → 跑 harness 一轮 → 把文本和每次工具调用
// 作为 assistant/message 的块和 tool/result 事件写进 dsh 会话，于是界面用 dsh 自己的卡片渲染。
import { AssistantStreamAccumulator, createAssistantMessage, createToolResultMessage, fileHandleText, textOnlyImageText } from "@deepseek-ai/dsh-llm";
import { createHarnessSession, ENGINES } from "./harness.js";

/** @typedef {import("./harness.js").HarnessHandle} HarnessHandle */

/**
 * dsh 会话的最小面：事件只增不改，读取按序号。
 * @typedef {object} SessionLike
 * @property {number} seq
 * @property {string} [header] 会话头，cwd 从 header.cwd 取
 * @property {(type: string, data: unknown, options?: { surfaceOp?: string, sourceEventSeqs?: number[] }) => { seq: number }} append
 * @property {(seq: number) => { type: string, data: { agentPreset: string } } | undefined} eventAt
 */

/** @typedef {object} LoopLike
 * @property {SessionLike & { header?: { cwd?: string } }} session
 * @property {{ agentLoop?: { foreign?: Record<string, unknown> } }} [loopCtx]
 */

/** @typedef {object} EngineSettings
 * @property {string} [codexModel] Codex 引擎的模型；未设置时读 ~/.codex/config.toml
 * @property {boolean} keepSessions 跨 step 保留 harness 会话（web 用）
 * @property {boolean} stripAnthropicEnv 给引擎剥离 ANTHROPIC_* 网关变量
 */

// 模式（preset）记在会话日志里；不去注入 agentPresets 服务，headless 没有它。记下找过的位置，后续只扫新增事件。
const presets = new WeakMap();
/** @param {SessionLike} session @returns {string | undefined} */
function presetOf(session) {
  let found = presets.get(session);
  for (let seq = session.seq - 1; seq > (found?.seq ?? -1); seq--) {
    const event = session.eventAt(seq);
    if (event?.type === "agent-preset/selected") { found = { seq, preset: event.data.agentPreset }; break; }
  }
  if (found !== undefined) presets.set(session, found);
  return found?.preset;
}

const defined = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
// volatile 配置字段是 .get() 取值器，普通字段是值；注意 get() 可以合法地返回 undefined，不能 ?? 回包装器。
const readField = (field) => (typeof field?.get === "function" ? field.get() : field);
const envFlag = (name, fallback) => (process.env[name] !== undefined ? process.env[name] === "1" : fallback ?? false);

/** 引擎设置：Config 字段（见 index.js 的 ForeignHarnessLoop）为主，DSH_CC_* 环境变量显式设置时覆盖（headless/调试）。 @param {LoopLike} loop @returns {EngineSettings} */
function settingsOf(loop) {
  const config = loop.loopCtx?.agentLoop?.foreign ?? {};
  return {
    codexModel: process.env.DSH_CC_CODEX_MODEL ?? readField(config.codexModel),
    keepSessions: envFlag("DSH_CC_SESSION_KEEP", readField(config.keepSessions)),
    stripAnthropicEnv: envFlag("DSH_CC_STRIP_ANTHROPIC", readField(config.stripAnthropicEnv)),
  };
}

/**
 * 只把用户自己说的话喂给引擎：runtime/time context 是 dsh 给自家 loop 用的，喂给 Claude/Codex 只会污染判断。
 * 图片/文件附件按 dsh 的文本投影惯例变成确定性 handle 文本（dsh-llm/content 同款，引擎拿不到附件字节）。
 * @param {readonly { source?: { kind?: string }, content?: readonly object[] }[]} messages
 * @returns {string}
 */
function promptOf(messages) {
  const partOf = (block) => {
    if (block.type === "text") return block.text;
    if (block.type === "image") return textOnlyImageText(block.attachment);
    if (block.type === "file") return fileHandleText(block.attachment, undefined);
    return "";
  };
  return messages
    .filter((message) => message.source?.kind === "user")
    .map((message) => (message.content ?? []).map(partOf).join("\n"))
    .filter(Boolean)
    .join("\n\n");
}

// 每个 dsh 会话一个 harness 会话；entry 随 session 对象一起回收。
const sessions = new WeakMap();
/**
 * @param {LoopLike} loop
 * @param {string} engine
 * @param {EngineSettings} settings
 * @returns {Promise<HarnessHandle>}
 */
async function sessionFor(loop, engine, settings) {
  const cached = sessions.get(loop.session);
  if (cached?.engine === engine) return cached.handle;
  // 切换引擎时旧 bridge 不回收就一直占着端口，直到进程退出。
  if (cached !== undefined) { sessions.delete(loop.session); await cached.handle.dispose(); }
  const handle = await createHarnessSession({ engine, cwd: loop.session.header?.cwd ?? process.cwd(), settings });
  sessions.set(loop.session, { engine, handle });
  return handle;
}

/**
 * assistant/message 必须带回放帧（否则服务端投影报 "stream is not iterable"）；用 dsh 自己的压缩器生成。
 * @param {readonly object[]} blocks
 * @param {object} [usage]
 * @returns {readonly import("@deepseek-ai/dsh-llm").AssistantStreamRecord[]}
 */
function streamFrames(blocks, usage) {
  const accumulator = new AssistantStreamAccumulator();
  const time = Date.now();
  const push = (chunk) => accumulator.push({ time, chunk });
  blocks.forEach((block, index) => {
    push({ type: "block-start", index, blockType: block.type });
    if (block.type === "text") push({ type: "text-delta", index, text: block.text });
    if (block.type === "reasoning") push({ type: "reasoning-delta", index, text: block.text });
    if (block.type === "tool-call") push({ type: "tool-call-delta", index, id: block.id, name: block.name, argumentsDelta: block.arguments });
    push({ type: "block-end", index, block });
  });
  if (usage !== undefined) push({ type: "usage", usage });
  push({ type: "finish", reason: { kind: blocks.some((block) => block.type === "tool-call") ? "tool-calls" : "stop" } });
  return accumulator.snapshot();
}

/**
 * 把一轮产出落成 dsh 事件：assistant/message（带帧）→ tool/call → tool/result。
 * 成功和中断路径共用：tool/call 才是客户端画出带名字和参数的调用卡的来源，tool/result 再用 sourceEventSeqs 指回它。
 * @param {SessionLike} session
 * @param {{ turn: number, step: number, blocks: readonly object[], results: readonly { callId: string, text: string, isError: boolean }[], usage?: object, interrupted?: boolean, provider: string, model: string }} settled
 */
function settle(session, { turn, step, blocks, results, usage, interrupted, provider, model }) {
  session.append(
    "assistant/message",
    {
      turn,
      step,
      message: createAssistantMessage({ content: blocks, source: { provider, model } }),
      ...(interrupted ? { interrupted: true } : {}),
      ...(usage === undefined ? {} : { usage }),
      stream: streamFrames(blocks, usage),
    },
    { surfaceOp: "append" },
  );

  const callSeqs = new Map();
  for (const block of blocks) if (block.type === "tool-call") {
    callSeqs.set(block.id, session.append("tool/call", { turn, step, callId: block.id, name: block.name, arguments: block.arguments }).seq);
  }

  const reported = new Set();
  for (const result of results) {
    const callSeq = callSeqs.get(result.callId);
    // 没有对应 tool/call 的结果不能写 sourceEventSeqs（会带 undefined 炸掉整次 append）。
    if (callSeq === undefined) continue;
    reported.add(result.callId);
    session.append(
      "tool/result",
      { turn, step, message: createToolResultMessage({ callId: result.callId, content: [{ type: "text", text: result.text }], isError: result.isError }) },
      { surfaceOp: "append", sourceEventSeqs: [callSeq] },
    );
  }
  // 已记录但没回报的调用补一个空结果，否则卡片永远停在「执行中」。
  for (const block of blocks) if (block.type === "tool-call" && !reported.has(block.id)) {
    session.append(
      "tool/result",
      { turn, step, message: createToolResultMessage({ callId: block.id, content: [{ type: "text", text: "(no result)" }], isError: true }) },
      { surfaceOp: "append", sourceEventSeqs: [callSeqs.get(block.id)] },
    );
  }
}

/**
 * 一个 step 的完整回合；返回 undefined 表示这一轮不归外部引擎管（继续走 stock loop）。
 * @param {LoopLike} loop
 * @param {{ messages: readonly object[] }} decision
 * @param {{ turn: number, step: number, signal: AbortSignal }} context
 * @returns {Promise<{ kind: "completed" } | undefined>}
 */
export async function claudeStep(loop, decision, { turn, step, signal }) {
  const { session } = loop;
  // preset 决定引擎；没有记录 preset（headless）才看 DSH_CC_ENGINE。其它 preset 交回 stock loop。
  const preset = presetOf(session);
  const engine = preset === undefined ? process.env.DSH_CC_ENGINE : preset;
  if (!ENGINES.has(engine)) return undefined;

  for (const message of decision.messages) session.append("user/message", message, { surfaceOp: "append" });

  const prompt = promptOf(decision.messages);
  if (prompt === "") throw new Error(`${engine}: nothing to run — this turn has no user content`);
  const settings = settingsOf(loop);
  const claude = await sessionFor(loop, engine, settings);
  signal.throwIfAborted();

  /** @type {object[]} */
  const blocks = [];
  /** @type {{ callId: string, text: string, isError: boolean }[]} */
  const results = [];
  const pushText = (text) => {
    const last = blocks[blocks.length - 1];
    if (last?.type === "text") last.text += text;
    else blocks.push({ type: "text", text });
  };
  const pushReasoning = (text) => {
    const last = blocks[blocks.length - 1];
    if (last?.type === "reasoning") last.text += text;
    else blocks.push({ type: "reasoning", text });
  };

  const source = { provider: engine, model: engine === "codex" ? settings.codexModel ?? "default" : "default" };
  /** @type {object | undefined} */
  let usage;
  try {
    const raw = await claude.turn(prompt, {
      signal,
      onEvent: (part) => {
        if (part.type === "text-delta") pushText(part.text ?? part.textDelta ?? part.delta ?? "");
        if (part.type === "reasoning-delta") pushReasoning(part.text ?? part.delta ?? "");
        if (part.type === "tool-call") {
          // Claude 的 Task 工具在 wire 上叫 Agent；dsh 的界面只把 `subagent*` 认成子代理委托。
          const name = part.toolName === "Agent" ? "subagent" : part.toolName;
          blocks.push({ type: "tool-call", id: part.toolCallId, name, arguments: JSON.stringify(part.input ?? {}) });
        }
        if ((part.type === "tool-result" || part.type === "tool-error") && part.providerExecuted) {
          const output = part.type === "tool-error" ? String(part.error?.message ?? part.error) : typeof part.output === "string" ? part.output : JSON.stringify(part.output) ?? "";
          results.push({ callId: part.toolCallId, text: output.slice(0, 8000), isError: part.type === "tool-error" });
        }
      },
    });
    // harness 的失败（比如模型不支持、登录失效）只在日志里有一个 error 帧，不抛出来界面会显示空的「已完成」。
    if (blocks.length === 0) throw new Error(`${engine} produced no output for this turn`);
    // dsh 的 session 事件要求纯 JSON：AI SDK 的 usage 带 undefined 字段，必须显式挑字段。
    usage = defined({
      inputTokens: raw.usage.inputTokens ?? 0,
      outputTokens: raw.usage.outputTokens ?? 0,
      totalTokens: raw.usage.totalTokens,
      cacheReadTokens: raw.usage.inputTokenDetails?.cacheReadTokens,
      cacheWriteTokens: raw.usage.inputTokenDetails?.cacheWriteTokens,
    });
  } catch (error) {
    // 中断/失败也把已产出的内容落盘（stock 同款 interrupted: true），否则界面上这轮凭空消失。
    if (blocks.length > 0) settle(session, { turn, step, blocks, results, interrupted: true, ...source });
    throw error;
  } finally {
    // headless 一轮就结束：出错也必须回收 harness 会话，否则 bridge 焊住进程退不出去。web 里设 keepSessions（或 DSH_CC_SESSION_KEEP=1）保留。
    if (!settings.keepSessions) {
      sessions.delete(loop.session);
      await claude.dispose();
    }
  }

  settle(session, { turn, step, blocks, results, usage, ...source });
  return { kind: "completed" };
}
