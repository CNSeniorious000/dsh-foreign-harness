// 由 Claude Code / Codex 驱动一个 dsh step：拿这一轮的用户消息 → 跑 harness 一轮 → 把文本和每次工具调用
// 作为 assistant/message 的块和 tool/result 事件写进 dsh 会话，于是界面用 dsh 自己的卡片渲染。
import { AssistantStreamAccumulator, createAssistantMessage, createToolResultMessage } from "@deepseek-ai/dsh-llm";
import { createHarnessSession, ENGINES } from "./harness.js";

// 模式（preset）记在会话日志里；不去注入 agentPresets 服务，headless 没有它。记下找过的位置，后续只扫新增事件。
const presets = new WeakMap();
function presetOf(session) {
  let found = presets.get(session);
  for (let seq = session.seq - 1; seq > (found?.seq ?? -1); seq--) {
    const event = session.eventAt(seq);
    if (event?.type === "agent-preset/selected") { found = { seq, preset: event.data.agentPreset }; break; }
  }
  if (found !== undefined) presets.set(session, found);
  return found?.preset;
}

const textOf = (message) => (message.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
const defined = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

// 每个 dsh 会话一个 harness 会话；entry 随 session 对象一起回收。
const sessions = new WeakMap();
async function sessionFor(loop, engine) {
  const cached = sessions.get(loop.session);
  if (cached?.engine === engine) return cached.handle;
  const handle = await createHarnessSession({ engine, cwd: loop.session.header?.cwd ?? process.cwd() });
  sessions.set(loop.session, { engine, handle });
  return handle;
}

// assistant/message 必须带回放帧（否则服务端投影报 "stream is not iterable"）；用 dsh 自己的压缩器生成。
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

export async function claudeStep(loop, decision, { turn, step, signal }) {
  const { session } = loop;
  // preset 决定引擎；没有记录 preset（headless）才看 DSH_CC_ENGINE。其它 preset 交回 stock loop。
  const preset = presetOf(session);
  const engine = preset === undefined ? process.env.DSH_CC_ENGINE : preset;
  if (!ENGINES.has(engine)) return undefined;

  for (const message of decision.messages) session.append("user/message", message, { surfaceOp: "append" });

  // 只给引擎用户自己说的话：runtime/time context 是 dsh 给自家 loop 用的，喂给 Claude/Codex 只会污染判断。
  const prompt = decision.messages.filter((message) => message.source?.kind === "user").map(textOf).filter(Boolean).join("\n\n");
  console.error("[cc-loop] step", { engine, turn, step, prompt: prompt.slice(0, 120) });
  const claude = await sessionFor(loop, engine);
  signal.throwIfAborted();

  const blocks = [];
  const results = [];
  const pushText = (text) => {
    const last = blocks[blocks.length - 1];
    if (last?.type === "text") last.text += text;
    else blocks.push({ type: "text", text });
  };

  const { text, usage: raw } = await claude.turn(prompt, {
    signal,
    onEvent: (part) => {
      if (part.type === "text-delta") pushText(part.text ?? part.textDelta ?? "");
      if (part.type === "tool-call") {
        // Claude 的 Task 工具在 wire 上叫 Agent；dsh 的界面只把 `subagent*` 认成子代理委托。
        const name = part.toolName === "Agent" ? "subagent" : part.toolName;
        blocks.push({ type: "tool-call", id: part.toolCallId, name, arguments: JSON.stringify(part.input ?? {}) });
      }
      if ((part.type === "tool-result" || part.type === "tool-error") && part.providerExecuted) {
        const output = part.type === "tool-error" ? String(part.error?.message ?? part.error) : JSON.stringify(part.output) ?? "";
        results.push({ callId: part.toolCallId, text: output.slice(0, 8000), isError: part.type === "tool-error" });
      }
    },
  });

  console.error("[cc-loop] turn done", { blocks: blocks.length, results: results.length, text: text.slice(0, 80) });
  // harness 的失败（比如模型不支持、登录失效）只在日志里有一个 error 帧，不抛出来界面会显示空的「已完成」。
  if (blocks.length === 0) throw new Error(`${engine} produced no output for this turn`);

  // dsh 的 session 事件要求纯 JSON：AI SDK 的 usage 带 undefined 字段，必须显式挑字段。
  const usage = defined({
    inputTokens: raw.inputTokens ?? 0,
    outputTokens: raw.outputTokens ?? 0,
    totalTokens: raw.totalTokens,
    cacheReadTokens: raw.inputTokenDetails?.cacheReadTokens,
    cacheWriteTokens: raw.inputTokenDetails?.cacheWriteTokens,
  });
  session.append(
    "assistant/message",
    { turn, step, message: createAssistantMessage({ content: blocks, source: { provider: "claude-code", model: "default" } }), usage, stream: streamFrames(blocks, usage) },
    { surfaceOp: "append" },
  );

  // tool/call 才是客户端画出带名字和参数的调用卡的来源；tool/result 再用 sourceEventSeqs 指回它。
  const callSeqs = new Map();
  for (const block of blocks) if (block.type === "tool-call") {
    callSeqs.set(block.id, session.append("tool/call", { turn, step, callId: block.id, name: block.name, arguments: block.arguments }).seq);
  }
  for (const result of results) {
    session.append(
      "tool/result",
      { turn, step, message: createToolResultMessage({ callId: result.callId, content: [{ type: "text", text: result.text }], isError: result.isError }) },
      { surfaceOp: "append", sourceEventSeqs: [callSeqs.get(result.callId)] },
    );
  }

  // headless 一轮就结束：不留长连接，否则进程退不出去。web 里靠 DSH_CC_SESSION_KEEP=1 保留会话。
  if (process.env.DSH_CC_SESSION_KEEP !== "1") {
    sessions.delete(loop.session);
    await claude.dispose();
  }

  return { kind: "completed" };
}
