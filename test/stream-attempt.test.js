import { test, expect } from "bun:test";
import { EngineStreamAttempt } from "../src/stream-attempt.js";

test("settle abandons the live attempt when the durable append throws", () => {
  const frames = [];
  let revision = 0;
  const attempt = new EngineStreamAttempt({
    sessionId: "s1",
    attempt: 1,
    turn: 1,
    step: 1,
    nextRevision: () => ++revision,
    emit: (frame) => frames.push(frame),
  });
  attempt.start();
  expect(() => attempt.settle("assistant/message", () => { throw new Error("append failed"); })).toThrow("append failed");
  expect(attempt.ended).toBe(true);
  expect(frames.at(-1)).toMatchObject({ type: "end", outcome: { kind: "abandoned" } });
});
