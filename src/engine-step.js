// 一个引擎回合：把这轮的用户消息交给 harness 引擎跑完整回合（工具循环在引擎内部），
// 流事件实时翻译成 dsh 的 StreamChunk 走 agent/assistant-stream 帧（UI 边跑边渲染），
// 终局落成 durable 事件：assistant/message（带紧凑 stream）+ tool/call + tool/result。
import { appendFileSync } from "node:fs";
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

function lastStateOf(session) {
  for (let seq = session.seq - 1; seq >= 0; seq--) {
    const record = pluginRecordOf(session.eventAt(seq));
    if (record?.type === STATE_RECORD) return record.data;
  }
  return undefined;
}

/** 每个 dsh 会话一个引擎会话；引擎切换走新 sessionId，互不干扰。 */
async function engineSessionOf(agent, engine, settings, authEnv, model) {
  const cached = agent.foreignEngineSession;
  if (cached?.engine === engine) return cached;
  if (cached !== undefined) await cached.handle.destroy();
  const state = lastStateOf(agent.session);
  const handle = await createHarnessSession({
    engine,
    cwd: agent.session.header?.cwd ?? process.cwd(),
    settings,
    ...(authEnv === undefined ? {} : { authEnv }),
    ...(model === undefined ? {} : { model }),
    sessionId: state?.sessionId ?? `${agent.session.id}:${engine}`,
    ...(state?.resumeFrom === undefined ? {} : { resumeFrom: state.resumeFrom }),
  });
  agent.foreignEngineSession = { engine, handle, fresh: state === undefined };
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

/**
 * 跑一个引擎回合。返回 {kind:"completed"} | {kind:"max-tokens"}（stock step 的返回契约）；
 * 失败/中断先落可见产出再抛。decision.messages 会像 stock 一样落成 user/message。
 * @param {object} agent stock machine（有 session/model/dispatch/phase）
 * @param {{ messages: readonly object[], toolSet?: { dispose?: () => void } }} decision
 * @param {{ turn: number, step: number, signal: AbortSignal, engine: string, settings: object, ctx: object }} context
 */
export async function runEngineStep(agent, decision, { turn, step, signal, engine, settings, ctx }) {
  const session = agent.session;
  for (const message of decision.messages) session.append("user/message", message, { surfaceOp: "append" });

  const route = await engineRoute(ctx, agent, engine, settings);
  const engineSession = await engineSessionOf(agent, engine, settings, route.authEnv, route.model);
  const prompt = promptOf(decision.messages);
  // 引擎会话全新（接不回原对话）才摊历史兜底，且只摊一次（回合成功才消费，失败重试还要重喂）。
  let context = "";
  if (engineSession.fresh) {
    context = historyTextOf(session, new Set(decision.messages.map((message) => message.id)));
  }
  const input = context === "" ? prompt : `${context}\n\n（以上是此前的对话记录。下面是用户的新消息。）\n\n${prompt}`;
  if (input === "") throw new Error(`${engine}: nothing to run — this turn has no user content`);

  const attempt = new EngineStreamAttempt({
    sessionId: session.id,
    attempt: (agent.foreignAttempt = (agent.foreignAttempt ?? 0) + 1),
    turn,
    step,
    nextRevision: () => (agent.foreignRevision = (agent.foreignRevision ?? 0) + 1),
    emit: (frame) => agent.dispatch.emit("agent/assistant-stream", { frame }),
  });

  const selection = agent.model.current();
  const source = { provider: engine, model: selection?.model ?? "default" };
  /** @type {{ callId: string, text: string, isError: boolean }[]} */
  const results = [];
  // 流翻译的块索引账本：harness 的部件 id → dsh 的块序号与缓冲。
  let index = 0;
  const open = new Map();
  const openBlock = (id, kind, extra) => {
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

  let usage;
  let cliIdHint;
  let debugSeq = 0;
  let finishReason = { kind: "stop" };
  const takeUsage = (raw) => {
    usage = defined({
      inputTokens: raw.inputTokens ?? 0,
      outputTokens: raw.outputTokens ?? 0,
      totalTokens: raw.totalTokens,
      cacheReadTokens: raw.inputTokenDetails?.cacheReadTokens,
      cacheWriteTokens: raw.inputTokenDetails?.cacheWriteTokens,
    });
  };

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
      const name = part.toolName === "Agent" ? "subagent" : part.toolName;
      const args = open.get(toolCallId)?.args || JSON.stringify(part.input ?? {});
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
    }
    // 工具结果（引擎内部执行，providerExecuted 才是真结果）。
    if ((part.type === "tool-result" || part.type === "tool-output-available") && part.providerExecuted) {
      const output = typeof part.output === "string" ? part.output : JSON.stringify(part.output) ?? "";
      results.push({ callId: part.toolCallId, text: output.slice(0, 8000), isError: false });
    }
    if ((part.type === "tool-error" || part.type === "tool-output-error") && part.providerExecuted) {
      const error = part.error ?? part.errorText;
      results.push({ callId: part.toolCallId, text: String(error?.message ?? error).slice(0, 8000), isError: true });
    }
    if (part.type === "finish-step" && part.usage !== undefined) takeUsage(part.usage);
    if (part.type === "finish") {
      finishReason = finishKindOf(part.finishReason);
      if (part.totalUsage !== undefined) takeUsage(part.totalUsage);
      // 引擎侧会话 id 官方就挂在 finish 部件的 providerMetadata（harness 透传 harnessMetadata）上。
      cliIdHint ??= part.providerMetadata?.["claude-code"]?.sessionId ?? part.providerMetadata?.codex?.threadId ?? part.providerMetadata?.["codex"]?.threadId;
    }
  };

  try {
    attempt.start();
    await engineSession.handle.turn(input, { signal, model: route.model, onEvent: translate });
    engineSession.fresh = false;
  } catch (error) {
    // 中断/失败也把可见产出落盘（stock 同款 interrupted），否则界面上这轮凭空消失。
    const content = signal.aborted ? attempt.interruptedBlocks() : [];
    if (content.length > 0) {
      attempt.settle("assistant/message", () =>
        session.append("assistant/message", { turn, step, message: createAssistantMessage({ content, source }), stream: attempt.stream, interrupted: true, ...(usage === undefined ? {} : { usage }) }, { surfaceOp: "append" }).seq,
      );
    } else if (!attempt.ended) {
      attempt.settle("assistant/attempt", () => session.append("assistant/attempt", { turn, step, stream: attempt.stream }).seq);
    }
    throw error;
  } finally {
    await rememberEngineState(ctx, agent, engine, engineSession, route.llm, cliIdHint);
  }

  if (usage !== undefined) attempt.push({ type: "usage", usage });
  attempt.push({ type: "finish", reason: finishReason });
  const content = attempt.blocks();
  attempt.settle("assistant/message", () =>
    session.append("assistant/message", { turn, step, message: createAssistantMessage({ content, source }), stream: attempt.stream, ...(usage === undefined ? {} : { usage }) }, { surfaceOp: "append" }).seq,
  );

  // tool/call 才是客户端画出带名字和参数的调用卡的来源；tool/result 再用 sourceEventSeqs 指回它。
  const callSeqs = new Map();
  for (const block of content) if (block.type === "tool-call") {
    callSeqs.set(block.id, session.append("tool/call", { turn, step, callId: block.id, name: block.name, arguments: block.arguments }).seq);
  }
  const reported = new Set();
  for (const result of results) {
    const callSeq = callSeqs.get(result.callId);
    if (callSeq === undefined) continue;
    reported.add(result.callId);
    session.append(
      "tool/result",
      { turn, step, message: createToolResultMessage({ callId: result.callId, content: [{ type: "text", text: result.text }], isError: result.isError }) },
      { surfaceOp: "append", sourceEventSeqs: [callSeq] },
    );
  }
  // 已记录但没回报的调用补一个终止结果，否则卡片永远停在「执行中」。
  for (const block of content) if (block.type === "tool-call" && !reported.has(block.id)) {
    session.append(
      "tool/result",
      { turn, step, message: createToolResultMessage({ callId: block.id, content: [{ type: "text", text: "(no result)" }], isError: true }) },
      { surfaceOp: "append", sourceEventSeqs: [callSeqs.get(block.id)] },
    );
  }

  return finishReason.kind === "max-tokens" ? { kind: "max-tokens" } : { kind: "completed" };
}
