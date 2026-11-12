// runEngineStep 的事件序契约：段消息先 settle、段内工具事件后落（折叠锚序的关键），
// 每段 step/start+step/end 配对、控制部件（finish 等）不产生空段。
import { test, expect, mock } from "bun:test";

const parts = [];
mock.module("../src/harness.js", () => ({
  createHarnessSession: async () => ({
    sessionId: "harness-test",
    turn: async (_input, { onEvent }) => { for (const part of parts) onEvent(part); },
    destroy: async () => {},
    stop: async () => {},
  }),
}));
// mock.module 要先于被测模块加载（import 声明会提升），故动态 import。
const { runEngineStep } = await import("../src/engine-step.js");

const makeAgent = (events) => ({
  session: {
    id: "s1",
    header: { cwd: "/tmp" },
    seq: 0,
    eventAt: () => undefined,
    deriveMessages: () => [],
    append: (type, data) => {
      events.push({ type, data });
      return { seq: events.length };
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
    claimStep: () => ++step,
  });
  return { events, result };
};

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
  // 段号从 claimStep 取，两段 2/3；段内 message 的 step 与段一致。
  expect(events.filter((e) => e.type === "step/start").map((e) => e.data.step)).toEqual([2, 3]);
  expect(events.filter((e) => e.type === "assistant/message").map((e) => e.data.step)).toEqual([2, 3]);
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
