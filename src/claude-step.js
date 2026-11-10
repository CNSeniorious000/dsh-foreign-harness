// 由 Claude Code 驱动一个 dsh step：拿这一轮的用户消息 → 跑 harness 一轮 → 把文本和每次工具调用
// 作为 assistant/message 的块和 tool/result 事件写进 dsh 会话，于是界面用 dsh 自己的卡片渲染。
import { createAssistantMessage, createToolResultMessage } from "@deepseek-ai/dsh-llm";
import { createHarnessSession } from "./harness.js";

// 会话的模式（preset）就是引擎选择：这两个 preset 交给 harness，其它 preset 交回 stock loop。
const ENGINES = { "claude-code": "claude-code", codex: "codex" };

// 模式记录在会话日志里；不去注入 agentPresets 服务，headless 没有它。
function presetOf(session) {
  const events = session.snapshotEvents(0, session.seq);
  for (let index = events.length - 1; index >= 0; index--) if (events[index].type === "agent-preset/selected") return events[index].data.agentPreset;
}

const textOf = (message) => (message.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
const sessions = new Map();

// dsh 的客户端/服务端投影要求 assistant/message 带可迭代的 stream 帧，否则整段历史都投影失败
// （"stream is not iterable"）。这里按顺序把每个块回放成最小的一组合法帧。
function streamFrames(blocks, time, usage) {
  const frames = [];
  const push = (chunk) => frames.push({ type: "chunk", time, chunk });
  blocks.forEach((block, index) => {
    push({ type: "block-start", index, blockType: block.type });
    if (block.type === "text") frames.push({ type: "text-chunks", time0: time, index, dt: [0], texts: [block.text] });
    if (block.type === "reasoning") frames.push({ type: "reasoning-chunks", time0: time, index, dt: [0], texts: [block.text] });
    if (block.type === "tool-call") frames.push({ type: "tool-call-chunks", time0: time, index, dt: [], id: block.id, name: block.name, args: [block.arguments] });
    push({ type: "block-end", index, block });
  });
  if (usage !== undefined) push({ type: "usage", usage });
  const hasToolCalls = blocks.some((block) => block.type === "tool-call");
  push({ type: "finish", reason: { kind: hasToolCalls ? "tool-calls" : "stop" } });
  return frames;
}

async function sessionFor(loop, engine) {
  const id = `${loop.session.id}:${engine}`;
  const cached = sessions.get(id);
  if (cached !== undefined) return cached;
  const cwd = loop.session.header?.cwd ?? process.cwd();
  const created = await createHarnessSession({ engine, cwd });
  sessions.set(id, created);
  return created;
}

export async function claudeStep(loop, decision, { turn, step, signal }) {
  const { session } = loop;
  const engine = ENGINES[presetOf(session)] ?? ENGINES[process.env.DSH_CC_ENGINE];
  if (engine === undefined) return undefined;

  for (const message of decision.messages) session.append("user/message", message, { surfaceOp: "append" });

  const prompt = decision.messages.map(textOf).filter(Boolean).join("\n\n");
  console.error("[cc-loop] step", { engine, turn, step, prompt: prompt.slice(0, 120) });
  const claude = await sessionFor(loop, engine);
  console.error("[cc-loop] claude session ready");
  signal.throwIfAborted();

  const blocks = [];
  const results = [];
  const pushText = (text) => {
    const last = blocks[blocks.length - 1];
    if (last?.type === "text") last.text += text;
    else blocks.push({ type: "text", text });
  };

  const { text, events } = await claude.turn(prompt, {
    onEvent: (part) => {
      if (part.type === "text-delta") pushText(part.text ?? part.textDelta ?? "");
      if (part.type === "tool-call") {
        // Claude 的 Task 工具在 wire 上叫 Agent；dsh 的界面只把 `subagent*` 认成子代理委托。
        const name = part.toolName === "Agent" ? "subagent" : part.toolName;
        blocks.push({ type: "tool-call", id: part.toolCallId, name, arguments: JSON.stringify(part.input ?? {}) });
      }
      if ((part.type === "tool-result" || part.type === "tool-error") && part.providerExecuted) {
        const output = part.type === "tool-error" ? String(part.error?.message ?? part.error) : JSON.stringify(part.output, null, 2);
        results.push({ callId: part.toolCallId, text: output.slice(0, 8000), isError: part.type === "tool-error" });
      }
    },
  });

  console.error("[cc-loop] turn done", { blocks: blocks.length, results: results.length, text: (text || "").slice(0, 80) });
  if (blocks.length === 0 && text) pushText(text);
  // harness 的失败（比如模型不支持、登录失效）只在日志里有一个 error 帧，不抛出来界面会显示空的「已完成」。
  if (blocks.length === 0) throw new Error(`${engine} produced no output for this turn`);

  const raw = events.filter((e) => e.type === "finish").at(-1)?.totalUsage;
  // dsh 的 session 事件要求纯 JSON：AI SDK 的 usage 带 undefined 字段，必须显式挑字段。
  const usage = raw === undefined ? undefined : {
    inputTokens: raw.inputTokens ?? 0,
    outputTokens: raw.outputTokens ?? 0,
    ...(raw.totalTokens === undefined ? {} : { totalTokens: raw.totalTokens }),
    ...(raw.inputTokenDetails?.cacheReadTokens === undefined ? {} : { cacheReadTokens: raw.inputTokenDetails.cacheReadTokens }),
    ...(raw.inputTokenDetails?.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: raw.inputTokenDetails.cacheWriteTokens }),
  };
  const assistant = createAssistantMessage({ content: blocks, source: { provider: "claude-code", model: "default" } });
  session.append(
    "assistant/message",
    { turn, step, message: assistant, ...(usage === undefined ? {} : { usage }), stream: streamFrames(blocks, Date.now(), usage) },
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
      { turn, step, message: createToolResultMessage({ callId: result.callId, content: [{ type: "text", text: result.text }], isError: result.isError === true }) },
      { surfaceOp: "append", sourceEventSeqs: [callSeqs.get(result.callId)].filter((seq) => seq !== undefined) },
    );
  }

  // headless 一轮就结束：不留长连接，否则进程退不出去。web 里靠 DSH_CC_SESSION_KEEP=1 保留会话。
  if (process.env.DSH_CC_SESSION_KEEP !== "1") {
    sessions.delete(`${loop.session.id}:${engine}`);
    await claude.dispose();
  }

  return { kind: "completed" };
}

export function disposeClaudeSession(sessionId) {
  const cached = sessions.get(sessionId);
  if (cached === undefined) return;
  sessions.delete(sessionId);
  void cached.dispose();
}
