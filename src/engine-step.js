// 一个引擎回合：把这轮的用户消息交给 harness 引擎跑完整回合（工具循环在引擎内部），
// 流事件实时翻译成 dsh 的 StreamChunk 走 agent/assistant-stream 帧（UI 边跑边渲染），
// 终局落成 durable 事件：assistant/message（带紧凑 stream）+ tool/call + tool/result。
// 引擎的每个内部 step（start-step/finish-step 边界）是一个「段」：段消息先 settle、段内工具事件后落——
// 与 stock「LLM 返回含 tool-call 的 message 后才 dispatch 工具」同形。折叠引擎落盘时按 settled.seq
// 重建锚点（firstVisibleSeq 是瞬态），工具事件若先落，思考行会被挤到工具卡之后。
import { appendFileSync } from "node:fs";
import { split as shlexSplit } from "shlex";
import { createAssistantMessage, createToolResultMessage, fileHandleText, textOnlyImageText } from "@deepseek-ai/dsh-llm";
import { appendPluginRecord, pluginRecordOf } from "@deepseek-ai/dsh-session";
import { createHarnessSession } from "./harness.js";
import { EngineStreamAttempt } from "./stream-attempt.js";
import { engineRoute, defined } from "./route.js";
import { engineCliId } from "./archive-sync.js";

/** 引擎会话的持久化记录：harness 的 resume state 交给 dsh 的 plugin record 通道（fork/resume 都携带）。 */
const STATE_RECORD = "plugin:dsh-foreign-harness/state";

/** 只把用户自己说的话喂给引擎；图片/文件按 dsh 的文本投影惯例变成确定性 handle 文本。 */
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

/** 引擎会话接不回来时（resume state 缺失/过期）的兜底：把已落日志的对话拼成上下文前缀。
 * 只取人和引擎真正说过的话：dsh 的 runtime/time context 是给自家 loop 的（文件策略、审批提示、GUI 地址之类），进引擎只会污染判断。
 * @param {object} session @param {Set<string>} excludeIds 本轮刚落的消息不算「此前」
 */
function historyTextOf(session, excludeIds) {
  const parts = [];
  for (const message of session.deriveMessages()) {
    if (excludeIds.has(message.id)) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (message.source?.kind === "runtime-context" || message.source?.kind === "time-context") continue;
    const text = (message.content ?? []).filter((block) => block.type === "text" || block.type === "reasoning").map((block) => block.text).join("\n").trim();
    if (text !== "") parts.push(`${message.role === "user" ? "用户" : "你"}：${text}`);
  }
  return parts.join("\n\n");
}

/** 只取指定引擎的记录；不传 engine 时取最后一条（写记录时的 no-op 比较用）。 */
function lastStateOf(session, engine) {
  for (let seq = session.seq - 1; seq >= 0; seq--) {
    const record = pluginRecordOf(session.eventAt(seq));
    if (record?.type === STATE_RECORD && (engine === undefined || record.data?.engine === engine)) return record.data;
  }
  return undefined;
}

/** 每个 dsh 会话一个引擎会话；引擎切换走新 sessionId，互不干扰。 */
async function engineSessionOf(agent, engine, settings, authEnv, model, { ignoreState = false, sessionId } = {}) {
  const cached = agent.foreignEngineSession;
  if (cached?.engine === engine) return cached;
  if (cached !== undefined) { await cached.handle.destroy(); agent.foreignEngineSession = undefined; }
  const state = ignoreState ? undefined : lastStateOf(agent.session, engine);
  const base = {
    engine,
    cwd: agent.session.header?.cwd ?? process.cwd(),
    settings,
    ...(authEnv === undefined ? {} : { authEnv }),
    ...(model === undefined ? {} : { model }),
    sessionId: sessionId ?? state?.sessionId ?? `${agent.session.id}:${engine}`,
  };
  let handle;
  try {
    handle = await createHarnessSession({ ...base, ...(state?.resumeFrom === undefined ? {} : { resumeFrom: state.resumeFrom }) });
  } catch (error) {
    if (state?.resumeFrom === undefined) throw error;
    // createSession 层的续接失败（lifecycle 校验/schema）降级为新会话；stale 引擎会话的真实失败在 turn 层重试。
    console.warn(`foreign-harness: cannot resume ${engine} session, starting fresh: ${String(error)}`);
    handle = await createHarnessSession(base);
    agent.foreignEngineSession = { engine, handle, fresh: true };
    return agent.foreignEngineSession;
  }
  // 没有 resumeFrom 就是接不回原会话（哪怕有同引擎的元数据记录，例如记录写失败只剩 sessionId）。
  agent.foreignEngineSession = { engine, handle, fresh: state?.resumeFrom === undefined };
  return agent.foreignEngineSession;
}

/**
 * 引擎会话一有身份就落轻量元数据（SSOT：dsh 只存引擎归属、当时绑定的 LLM 配置、续聊用的引擎会话 id；
 * bridge 坐标/令牌等引擎自身状态留在引擎自己的存储里）。每回合都落——teardown 的 effect 清理在
 * 一次性进程里根本不会跑，靠 dispose 落盘会静默丢记录。内容没变就不重复写；写完显式 flush
 * （写缓冲只在请求边界 drain）。
 */
async function rememberEngineState(ctx, agent, engine, engineSession, llm, cliIdHint) {
  // 元数据持久化是尽力而为：它绝不能把真实回合错误顶掉，也不能让成功回合的产出不落盘。
  try {
    const cliId = await engineCliId(engineSession.handle.sessionId, cliIdHint);
    if (cliId === undefined) return;
    const state = {
      engine,
      sessionId: engineSession.handle.sessionId,
      ...(llm === undefined ? {} : { llm }),
      resumeFrom: { type: "resume-session", harnessId: engine, specificationVersion: "harness-v1", data: engine === "codex" ? { threadId: cliId } : { claudeSessionId: cliId } },
    };
    if (JSON.stringify(lastStateOf(agent.session)) === JSON.stringify(state)) return;
    appendPluginRecord(agent.session, STATE_RECORD, state);
    await ctx.get("sessions")?.flush?.(agent.session)?.catch?.(() => {});
  } catch (error) {
    console.warn(`foreign-harness: cannot persist engine state record: ${String(error)}`);
  }
}

/** teardown 时停掉引擎会话（记录已在每回合落过；resume state 的事实源在引擎自己的存储里）。 */
export async function disposeEngineSession(agent) {
  const cached = agent.foreignEngineSession;
  agent.foreignEngineSession = undefined;
  if (cached === undefined) return;
  await cached.handle.stop();
}

const finishKindOf = (reason) => {
  if (reason === "tool-calls") return { kind: "tool-calls" };
  if (reason === "length") return { kind: "max-tokens" };
  if (reason === "error") return { kind: "error", failure: { message: "engine reported an error finish" } };
  if (reason === "abort") return { kind: "aborted", failure: { message: "engine aborted" } };
  return { kind: "stop" };
};

// MCP 工具的美化：`mcp__<server>__<tool>` 显示成 `<tool>`；args 的语义 key 排到首位——
// dsh 的 generic 工具卡摘要取 args 的第一个字符串值，不排的话摘要是一串 session_id。
const SUMMARY_KEYS = ["title", "description", "objective", "task", "task_name", "name", "question", "prompt", "message", "command", "cmd", "query", "pattern", "code", "url", "uri", "file_path", "path", "target", "action", "status"];
function prettyToolCall(name, args) {
  const parts = String(name).split("__");
  const short = parts.length >= 3 && parts[0] === "mcp" ? parts.slice(2).join("__") : name;
  try {
    const parsed = JSON.parse(args);
    const reordered = {};
    for (const key of SUMMARY_KEYS) if (key in parsed) reordered[key] = parsed[key];
    for (const [key, value] of Object.entries(parsed)) if (!(key in reordered)) reordered[key] = value;
    return { name: short, args: JSON.stringify(reordered) };
  } catch {
    return { name: short, args };
  }
}

// Codex 的 shell 命令在内部是 argv `[shell_path, "-lc", command]`（core/src/shell.rs 的
// derive_exec_args），app-server wire 上被 shlex join 成一个字符串（设计上 round-trippable）。
// 用 shlex 词法还原 argv，按 Codex 自己的分类形状（classify_shell_name：shell 家族 + -c 族旗标）
// 剥掉壳——引号/转义交给词法器，不 hard-code shell 路径。
const SHELL_NAMES = new Set(["sh", "bash", "zsh", "dash", "ksh", "tcsh", "csh"]);
function stripShellWrapper(args) {
  try {
    const parsed = JSON.parse(args);
    const raw = parsed?.command;
    if (typeof raw !== "string") return args;
    const argv = shlexSplit(raw);
    if (argv.length === 3 && SHELL_NAMES.has(argv[0].split("/").pop()) && /^-l?c$/.test(argv[1])) {
      parsed.command = argv[2];
      return JSON.stringify(parsed);
    }
    return args;
  } catch {
    return args;
  }
}

// usage 两代形状都要认：平铺（inputTokens: number + inputTokenDetails）与嵌套
// （inputTokens: {total, cacheRead, cacheWrite}）——codex adapter 发的是后者，不摊平会把
// 整个对象当 token 数存进 durable message（UI 读数直接坏）。
const normalizeUsage = (raw) => {
  const nested = typeof raw.inputTokens === "object" && raw.inputTokens !== null;
  const outputNested = typeof raw.outputTokens === "object" && raw.outputTokens !== null;
  return defined({
    inputTokens: (nested ? raw.inputTokens.total : raw.inputTokens) ?? 0,
    outputTokens: (outputNested ? raw.outputTokens.total : raw.outputTokens) ?? 0,
    totalTokens: raw.totalTokens,
    cacheReadTokens: nested ? raw.inputTokens?.cacheRead : raw.inputTokenDetails?.cacheReadTokens,
    cacheWriteTokens: nested ? raw.inputTokens?.cacheWrite : raw.inputTokenDetails?.cacheWriteTokens,
  });
};

/**
 * 跑一个引擎回合。返回 {kind:"completed"} | {kind:"max-tokens"}（stock step 的返回契约）；
 * 失败/中断先落可见产出再抛。decision.messages 会像 stock 一样落成 user/message。
 * @param {object} agent stock machine（有 session/model/dispatch/phase）
 * @param {{ messages: readonly object[], toolSet?: { dispose?: () => void } }} decision
 * @param {{ turn: number, signal: AbortSignal, engine: string, settings: object, ctx: object, claimStep: () => number }} context
 */
export async function runEngineStep(agent, decision, { turn, signal, engine, settings, ctx, claimStep }) {
  const session = agent.session;
  for (const message of decision.messages) session.append("user/message", message, { surfaceOp: "append" });

  const route = await engineRoute(ctx, agent, engine, settings);
  let engineSession = await engineSessionOf(agent, engine, settings, route.authEnv, route.model);
  const prompt = promptOf(decision.messages);
  const priorIds = new Set(decision.messages.map((message) => message.id));
  // 引擎会话全新（接不回原对话）才摊历史兜底；fallback 换会话后要重算，所以做成闭包。
  const inputOf = () => {
    const context = engineSession.fresh ? historyTextOf(session, priorIds) : "";
    const input = context === "" ? prompt : `${context}\n\n（以上是此前的对话记录。下面是用户的新消息。）\n\n${prompt}`;
    if (input === "") throw new Error(`${engine}: nothing to run — this turn has no user content`);
    return input;
  };
  let input = inputOf();

  const selection = agent.model.current();
  const source = { provider: engine, model: selection?.model ?? "default" };
  const dbg = (obj) => { if (process.env.DSH_FH_DEBUG) appendFileSync(process.env.DSH_FH_DEBUG, JSON.stringify(obj) + "\n"); };

  // 每个引擎内部 step 是一个「段」：独立 attempt（独立折叠上下文 turn:step），段消息 settle 后才落
  // 该段的工具事件（锚序 = stock 形态），段尾 step/end 把 retained 流帧退役掉（否则下一段 attempt 的
  // start 帧触发 rebaseline）。每个段自带 step/start+step/end 配对。
  /** @type {EngineStreamAttempt | null} 当前段的流 attempt（null = 无活跃段） */
  let attempt = null;
  /** 段内攒下的工具事件（到达序）：tool/call+tool/result 在段消息 settle 之后统一落。 */
  const segEvents = [];
  /** 段边界要穿过 agent.session.append 的 shell 过滤器：标记后 append，落盘后立即复位。 */
  const appendSegmentBoundary = (type, step) => {
    agent.foreignSegmentBoundary = true;
    try { return session.append(type, { turn, step }); } finally { agent.foreignSegmentBoundary = false; }
  };
  // 段只在产出到达时存在（块或工具事件）——finish/finish-step/start-step/raw 等控制件不会开出空 step。
  const ensureSegment = () => {
    if (attempt !== null) return;
    // 段号从 loop 的 step 账本上取：第一段复用 loop 刚分配的壳号（壳的 start/end 已被 append 过滤器丢弃），
    // 后续段递增，整条日志是顺序的顶级 step——step 不能嵌套，released 格式校验会拒绝。
    const segStep = claimStep();
    appendSegmentBoundary("step/start", segStep);
    attempt = new EngineStreamAttempt({
      sessionId: session.id,
      attempt: (agent.foreignAttempt = (agent.foreignAttempt ?? 0) + 1),
      turn,
      step: segStep,
      nextRevision: () => (agent.foreignRevision = (agent.foreignRevision ?? 0) + 1),
      emit: (frame) => agent.dispatch.emit("agent/assistant-stream", { frame }),
    });
    attempt.start();
    index = 0;
    open.clear();
    dbg({ event: "segment/start", turn, step: segStep });
  };
  /** @type {Map<string, {seq: number, step: number}>} callId → tool/call 事件（tool/result 回指与补果用） */
  const callSeqs = new Map();
  const reported = new Set();

  const dispatchToolCall = (callId, name, args) => {
    if (callSeqs.has(callId)) return;
    const seq = session.append("tool/call", { turn, step: attempt.step, callId, name, arguments: args }).seq;
    callSeqs.set(callId, { seq, step: attempt.step });
    dbg({ event: "tool/call", seq, turn, step: attempt.step, name });
  };
  const commitToolResult = (callId, text, isError) => {
    const call = callSeqs.get(callId);
    if (call === undefined || reported.has(callId)) return;
    reported.add(callId);
    // tool/result 必须落在当前 open step（format 的 requireStep）；同段时与 call.step 相同，回合末兜底时退回 call.step。
    const step = attempt?.step ?? call.step;
    const seq = session.append("tool/result", { turn, step, message: createToolResultMessage({ callId, content: [{ type: "text", text }], isError }) }, { surfaceOp: "append", sourceEventSeqs: [call.seq] }).seq;
    dbg({ event: "tool/result", seq, turn, step });
  };
  /** 已调用但没回报的补一个终止结果，否则卡片永远停在「运行中」。段尾必须补：step/end 的 closeTools 拒绝未决 call；
   * 跨段真结果在 dsh 日志里不可表示（tool/result 只能落在自己的 open step），迟到的真结果由 reported 守卫丢弃。 */
  const backfillMissingResults = () => { for (const callId of callSeqs.keys()) commitToolResult(callId, "(no result)", true); };

  // 流翻译的块索引账本（per attempt，段切换时重置）：harness 的部件 id → dsh 的块序号与缓冲。
  let index = 0;
  const open = new Map();
  const openBlock = (id, kind, extra) => {
    ensureSegment();
    const entry = { index: index++, kind, buffer: "", args: "", ...extra };
    open.set(id, entry);
    attempt.push({ type: "block-start", index: entry.index, blockType: kind === "tool" ? "tool-call" : kind });
    return entry;
  };
  const closeBlock = (id, block) => {
    const entry = open.get(id);
    if (entry === undefined) return;
    open.delete(id);
    attempt.push({ type: "block-end", index: entry.index, block });
  };
  const bufferSegEvent = (event) => {
    ensureSegment();
    segEvents.push(event);
  };

  /** 段收尾：finish 帧 → settle 段消息 → 落工具事件 → step/end 退役 retained 流帧。 */
  const finishSegment = ({ reason, usage, mode = "normal" }) => {
    if (usage !== undefined) attempt.push({ type: "usage", usage });
    attempt.push({ type: "finish", reason });
    // 空文本/空思考块不落（codex 会发 reasoning-start/end 零 delta 的空思考），UI 靠块渲染卡片。
    const content = (mode === "interrupted" ? attempt.interruptedBlocks() : mode === "failed" ? [] : attempt.blocks()).filter((block) => (block.type !== "text" && block.type !== "reasoning") || block.text.trim() !== "");
    if (content.length > 0) {
      attempt.settle("assistant/message", () => {
        const seq = session.append("assistant/message", { turn, step: attempt.step, message: createAssistantMessage({ content, source }), stream: attempt.stream, ...(mode === "interrupted" ? { interrupted: true } : {}), ...(usage === undefined ? {} : { usage }) }, { surfaceOp: "append" }).seq;
        dbg({ event: "assistant/message", seq, turn, step: attempt.step });
        return seq;
      });
    } else if (!attempt.ended) {
      attempt.settle("assistant/attempt", () => session.append("assistant/attempt", { turn, step: attempt.step, stream: attempt.stream }).seq);
    }
    for (const event of segEvents) {
      if (event.kind === "call") dispatchToolCall(event.callId, event.name, event.args);
      else commitToolResult(event.callId, event.text, event.isError);
    }
    segEvents.length = 0;
    backfillMissingResults();
    appendSegmentBoundary("step/end", attempt.step);
    dbg({ event: "segment/end", turn, step: attempt.step });
    open.clear(); // 块台账只活在本段：留着的话，段尾后迟到的 delta/end 会拿陈旧 entry 打到 null attempt
    attempt = null;
  };

  let cliIdHint;
  let debugSeq = 0;
  let finishReason = { kind: "stop" };
  let finishUsage;

  const translate = (part) => {
    // 诊断通道：DSH_FH_DEBUG=<path> 时把引擎流部件的形态按序落盘（字段名/大小，不含正文）。
    if (process.env.DSH_FH_DEBUG) {
      const shape = { i: debugSeq++, type: part.type, keys: Object.keys(part).sort() };
      for (const key of ["id", "toolCallId", "toolName", "finishReason"]) if (part[key] !== undefined) shape[key] = part[key];
      for (const key of ["text", "delta", "input", "output", "error"]) if (part[key] !== undefined) shape[key + "Len"] = JSON.stringify(part[key])?.length;
      appendFileSync(process.env.DSH_FH_DEBUG, JSON.stringify(shape) + "\n");
    }
    if (part.type === "text-start") openBlock(part.id, "text");
    if (part.type === "text-delta") {
      const entry = open.get(part.id) ?? openBlock(part.id, "text");
      const text = part.text ?? part.textDelta ?? part.delta ?? "";
      entry.buffer += text;
      attempt.push({ type: "text-delta", index: entry.index, text });
    }
    if (part.type === "text-end") {
      const entry = open.get(part.id);
      closeBlock(part.id, { type: "text", text: entry?.buffer ?? "" });
    }
    if (part.type === "reasoning-start") openBlock(part.id, "reasoning");
    if (part.type === "reasoning-delta") {
      const entry = open.get(part.id) ?? openBlock(part.id, "reasoning");
      const text = part.text ?? part.delta ?? "";
      entry.buffer += text;
      attempt.push({ type: "reasoning-delta", index: entry.index, text });
    }
    if (part.type === "reasoning-end") {
      const entry = open.get(part.id);
      closeBlock(part.id, { type: "reasoning", text: entry?.buffer ?? "" });
    }
    // 工具参数流式：bridge 的 tool-input-* 部件用 id/delta，完成部件（tool-call）才叫 toolCallId。
    if (part.type === "tool-input-start") openBlock(part.id, "tool", { toolCallId: part.id, name: part.toolName });
    if (part.type === "tool-input-delta") {
      const entry = open.get(part.id);
      if (entry !== undefined) {
        const delta = part.delta ?? "";
        entry.args += delta;
        attempt.push({ type: "tool-call-delta", index: entry.index, id: entry.toolCallId, name: entry.name, argumentsDelta: delta });
      }
    }
    // 工具调用完成：新旧两代部件名都要认（harness 两代都发）。
    if (part.type === "tool-call" || part.type === "tool-input-available") {
      const toolCallId = part.toolCallId ?? part.id;
      // Claude 的 Task 工具在 wire 上叫 Agent；dsh 的界面只把 `subagent*` 认成子代理委托。
      const pretty = prettyToolCall(part.toolName === "Agent" ? "subagent" : part.toolName, stripShellWrapper(open.get(toolCallId)?.args || JSON.stringify(part.input ?? {})));
      const name = pretty.name;
      const args = pretty.args;
      const entry = open.get(toolCallId);
      if (entry === undefined) {
        const created = openBlock(toolCallId, "tool", { toolCallId, name });
        created.args = args;
        attempt.push({ type: "tool-call-delta", index: created.index, id: toolCallId, name, argumentsDelta: args });
        closeBlock(toolCallId, { type: "tool-call", id: toolCallId, name, arguments: args });
      } else {
        entry.name = name;
        if (entry.args === "" && part.input !== undefined) {
          entry.args = JSON.stringify(part.input);
          attempt.push({ type: "tool-call-delta", index: entry.index, id: toolCallId, name, argumentsDelta: entry.args });
        }
        closeBlock(toolCallId, { type: "tool-call", id: toolCallId, name, arguments: entry.args });
      }
      bufferSegEvent({ kind: "call", callId: toolCallId, name, args });
    }
    // 工具结果（引擎内部执行，providerExecuted 才是真结果）——先攒着，段消息 settle 后按到达序落。
    if ((part.type === "tool-result" || part.type === "tool-output-available") && part.providerExecuted) {
      const output = typeof part.output === "string" ? part.output : JSON.stringify(part.output) ?? "";
      bufferSegEvent({ kind: "result", callId: part.toolCallId, text: output.slice(0, 8000), isError: false });
    }
    if ((part.type === "tool-error" || part.type === "tool-output-error") && part.providerExecuted) {
      const error = part.error ?? part.errorText;
      bufferSegEvent({ kind: "result", callId: part.toolCallId, text: String(error?.message ?? error).slice(0, 8000), isError: true });
    }
    if (part.type === "finish-step" && attempt !== null) {
      finishSegment({ reason: finishKindOf(part.finishReason), usage: part.usage === undefined ? undefined : normalizeUsage(part.usage) });
    }
    if (part.type === "finish") {
      finishReason = finishKindOf(part.finishReason);
      if (part.usage !== undefined) finishUsage = normalizeUsage(part.usage);
      // 引擎侧会话 id 官方就挂在 finish 部件的 providerMetadata（harness 透传 harnessMetadata）上。
      cliIdHint ??= part.providerMetadata?.["claude-code"]?.sessionId ?? part.providerMetadata?.codex?.threadId;
    }
  };

  const runTurn = async () => {
    try {
      await engineSession.handle.turn(input, { signal, model: route.model, onEvent: translate });
      engineSession.fresh = false;
    } catch (error) {
      // 零产出 + 非中断 = 疑似引擎会话级失效（stale resume）：换 fresh 会话重喂一次。已有段/工具就不重试，避免重复副作用。
      if (engineSession.fresh || attempt !== null || callSeqs.size > 0 || signal.aborted) throw error;
      console.warn(`foreign-harness: ${engine} turn failed before any output, retrying fresh: ${String(error)}`);
      const sessionId = engineSession.handle.sessionId;
      await engineSession.handle.destroy().catch(() => {});
      agent.foreignEngineSession = undefined;
      cliIdHint = undefined;
      finishReason = { kind: "stop" };
      finishUsage = undefined;
      engineSession = await engineSessionOf(agent, engine, settings, route.authEnv, route.model, { ignoreState: true, sessionId });
      input = inputOf();
      await engineSession.handle.turn(input, { signal, model: route.model, onEvent: translate });
      engineSession.fresh = false;
    }
  };

  try {
    await runTurn();
  } catch (error) {
    // 中断/失败也把可见产出落盘（stock 同款 interrupted），否则界面上这轮凭空消失。
    const aborted = signal.aborted;
    if (attempt !== null && !attempt.ended) finishSegment({ reason: finishKindOf(aborted ? "abort" : "error"), usage: finishUsage, mode: aborted ? "interrupted" : "failed" });
    backfillMissingResults();
    throw error;
  } finally {
    await rememberEngineState(ctx, agent, engine, engineSession, route.llm, cliIdHint);
  }

  // 引擎没有 finish-step 收尾的尾巴（例如最后只发 finish 部件）也要落盘收口。
  if (attempt !== null && !attempt.ended) finishSegment({ reason: finishReason, usage: finishUsage });
  backfillMissingResults();

  return finishReason.kind === "max-tokens" ? { kind: "max-tokens" } : { kind: "completed" };
}
