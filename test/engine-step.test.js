// runEngineStep 的事件序契约：段消息先 settle、段内工具事件后落（折叠锚序的关键），
// 每段 step/start+step/end 配对、控制部件（finish 等）不产生空段。
import { test, expect, mock } from "bun:test";
import { KNOWN_SESSION_EVENT_TYPES } from "@deepseek-ai/dsh-session";
import { restoreReleasedV4Artifact } from "@deepseek-ai/dsh-session-format-v3-to-v4";

const parts = [];
mock.module("../src/harness.js", () => ({
  ENGINES: new Set(["claude-code", "codex"]),
  createHarnessSession: async () => ({
    sessionId: "harness-test",
    turn: async (_input, { onEvent }) => { for (const part of parts) onEvent(part); },
    destroy: async () => {},
    stop: async () => {},
  }),
}));
// mock.module 要先于被测模块加载（import 声明会提升），故动态 import。
const { runEngineStep } = await import("../src/engine-step.js");
const { guardEngineStepBoundaries } = await import("../src/index.js");

const makeAgent = (events) => ({
  session: {
    id: "s1",
    header: { cwd: "/tmp" },
    seq: 0,
    eventAt: () => undefined,
    deriveMessages: () => [],
    append: (type, data, options) => {
      events.push({ type, data, ...(options?.surfaceOp === undefined ? {} : { surfaceOp: options.surfaceOp }), ...(options?.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: options.sourceEventSeqs }) });
      return { seq: events.length - 1 };
    },
  },
  model: { current: () => ({ provider: "test", model: "m" }) },
  dispatch: { emit: () => {} },
});

const run = async (streamParts) => {
  parts.splice(0, parts.length, ...streamParts);
  const events = [];
  let step = 1;
  const agent = makeAgent(events);
  const result = await runEngineStep(agent, { messages: [{ id: "u1", source: { kind: "user" }, content: [{ type: "text", text: "hi" }] }] }, {
    turn: 1,
    signal: new AbortController().signal,
    engine: "claude-code",
    settings: {},
    ctx: { get: () => undefined },
    claimStep: () => step++,
  });
  // 单元里直接调 runEngineStep，没有 stock turn()；补上 turn 边界后让 released 校验器守门。
  assertReleasedLog(events);
  return { events, result };
};

const assertReleasedLog = (events) => restoreReleasedV4Artifact({
  header: { version: 4, id: "s1", createdAt: 0, cwd: "/tmp", isSeeded: false, delegationDepth: 0 },
  inheritedEventCount: 0,
  events: [
    { type: "turn/start", data: { turn: 1 } },
    ...events,
    { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
  ].map((event, seq) => ({ ...event, seq, time: 0 })),
}, KNOWN_SESSION_EVENT_TYPES);

test("segment settle precedes its tool events; segments pair step/start with step/end", async () => {
  const { events, result } = await run([
    { type: "reasoning-start", id: "r1" },
    { type: "reasoning-delta", id: "r1", text: "thinking" },
    { type: "reasoning-end", id: "r1" },
    { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "echo hi" } },
    { type: "tool-result", toolCallId: "c1", providerExecuted: true, output: "hi" },
    { type: "finish-step", usage: { inputTokens: 3, outputTokens: 4 }, finishReason: "tool-calls" },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", text: "answer" },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: "stop" },
    // 控制件尾巴：不得开出第三个空段
  ]);
  expect(result).toEqual({ kind: "completed" });
  expect(events.map((e) => e.type)).toEqual([
    "user/message",
    "step/start", "assistant/message", "tool/call", "tool/result", "step/end",
    "step/start", "assistant/message", "step/end",
  ]);
  // 锚序契约：段消息的 append 先于该段的 tool/call。
  const messageFirst = events.findIndex((e) => e.type === "assistant/message");
  const toolCall = events.findIndex((e) => e.type === "tool/call");
  expect(messageFirst).toBeLessThan(toolCall);
  // 段号从 claimStep 取，第一段复用壳号 1，后续 2；段内 message 的 step 与段一致。
  expect(events.filter((e) => e.type === "step/start").map((e) => e.data.step)).toEqual([1, 2]);
  expect(events.filter((e) => e.type === "assistant/message").map((e) => e.data.step)).toEqual([1, 2]);
  // 段消息带本段的块（含 tool-call，stock 形态）。
  const firstMessage = events.find((e) => e.type === "assistant/message");
  expect(firstMessage.data.message.content.map((b) => b.type)).toEqual(["reasoning", "tool-call"]);
});

test("empty-reasoning blocks are dropped and usage lands flat", async () => {
  const { events } = await run([
    { type: "reasoning-start", id: "r1" },
    { type: "reasoning-end", id: "r1" },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", text: "answer" },
    { type: "text-end", id: "t1" },
    { type: "finish-step", usage: { inputTokens: { total: 5, cacheRead: 2 }, outputTokens: { total: 6 } }, finishReason: "stop" },
    { type: "finish", finishReason: "stop" },
  ]);
  const message = events.find((e) => e.type === "assistant/message");
  expect(message.data.message.content.map((b) => b.type)).toEqual(["text"]);
  // 嵌套 usage 摊平成数字（codex adapter 的形状）。
  expect(message.data.usage).toEqual({ inputTokens: 5, outputTokens: 6, cacheReadTokens: 2, cacheWriteTokens: undefined });
});

test("segment end invalidates the block ledger; late deltas for stale ids open a fresh segment", async () => {
  // 块没关就收段（finish-step），段尾后迟到的 delta/end 不得打到已退役的 attempt。
  const { events } = await run([
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", text: "a" },
    { type: "finish-step", finishReason: "tool-calls" },
    { type: "text-delta", id: "t1", text: "b" },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: "stop" },
  ]);
  expect(events.map((e) => e.type)).toEqual([
    "user/message",
    "step/start", "assistant/message", "step/end",
    "step/start", "assistant/message", "step/end",
  ]);
  expect(events.filter((e) => e.type === "assistant/message").map((e) => e.data.message.content[0].text)).toEqual(["a", "b"]);
});

test("mixed usage shapes flatten per field", async () => {
  const { events } = await run([
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", text: "a" },
    { type: "text-end", id: "t1" },
    { type: "finish-step", usage: { inputTokens: { total: 5, cacheRead: 2 }, outputTokens: 6 }, finishReason: "stop" },
    { type: "finish", finishReason: "stop" },
  ]);
  const message = events.find((e) => e.type === "assistant/message");
  expect(message.data.usage).toEqual({ inputTokens: 5, outputTokens: 6, cacheReadTokens: 2 });
});

test("segment end backfills unresolved calls; a late real result is dropped", async () => {
  const { events } = await run([
    { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "x" } },
    { type: "finish-step", finishReason: "tool-calls" },
    { type: "tool-result", toolCallId: "c1", providerExecuted: true, output: "real" },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", text: "done" },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: "stop" },
  ]);
  const results = events.filter((e) => e.type === "tool/result");
  // 段尾必须补果（closeTools）；跨段真结果不可表示，由 reported 守卫丢弃。
  expect(results.map((e) => e.data.message.content[0].text)).toEqual(["(no result)"]);
  expect(results[0].data.step).toBe(events.find((e) => e.type === "tool/call").data.step);
});

test("engine step shells are dropped; marked segment boundaries pass", () => {
  const appended = [];
  const sessionOf = (preset) => ({
    seq: 1,
    eventAt: () => ({ type: "agent-preset/selected", data: { agentPreset: preset } }),
    append: (type, data) => { appended.push({ type, data }); return { seq: appended.length - 1 }; },
  });
  const agent = { session: sessionOf("claude-code") };
  guardEngineStepBoundaries(agent);
  agent.session.append("step/start", { turn: 1, step: 1 });
  agent.session.append("step/end", { turn: 1, step: 1 });
  agent.foreignSegmentBoundary = true;
  agent.session.append("step/start", { turn: 1, step: 1 });
  agent.foreignSegmentBoundary = false;
  expect(appended.map((event) => event.type)).toEqual(["step/start"]);

  // stock preset 的 step 边界必须原样落盘。
  const stock = { session: sessionOf("stock") };
  guardEngineStepBoundaries(stock);
  stock.session.append("step/start", { turn: 1, step: 1 });
  expect(appended.map((event) => event.type)).toEqual(["step/start", "step/start"]);
});
