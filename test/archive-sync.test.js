import { describe, expect, test } from "bun:test";
import { syncPlan, threadOfRollout } from "../src/archive-sync.js";

describe("syncPlan", () => {
  test("baseline (either prev undefined) only seeds, never writes", () => {
    expect(syncPlan(undefined, undefined, true, false)).toBeUndefined();
    expect(syncPlan(true, undefined, true, false)).toBeUndefined();
    expect(syncPlan(undefined, false, true, false)).toBeUndefined();
  });

  test("agreement is a no-op", () => {
    expect(syncPlan(true, true, true, true)).toBeUndefined();
    expect(syncPlan(false, false, false, false)).toBeUndefined();
  });

  test("dsh-side move pushes to codex", () => {
    expect(syncPlan(false, false, true, false)).toBe("archive-codex");
    expect(syncPlan(true, true, false, true)).toBe("unarchive-codex");
  });

  test("codex-side move pushes to dsh", () => {
    expect(syncPlan(false, false, false, true)).toBe("archive-dsh");
    expect(syncPlan(true, true, true, false)).toBe("unarchive-dsh");
  });

  test("both sides moved in the same tick: no double push", () => {
    expect(syncPlan(false, false, true, true)).toBeUndefined();
    expect(syncPlan(true, true, false, false)).toBeUndefined();
    expect(syncPlan(false, true, true, false)).toBeUndefined();
  });
});

describe("threadOfRollout", () => {
  test("rollout filename tail is the thread id, plain or zst", () => {
    expect(threadOfRollout("rollout-2026-04-21T15-05-03-019daedb-5656-7ef3-ba88-d33c7cf4a016.jsonl")).toBe("019daedb-5656-7ef3-ba88-d33c7cf4a016");
    expect(threadOfRollout("2026/11/12/rollout-2026-11-12T01-02-03-01a1cb9a-b181-7001-a516-cf1aed84eb7e.jsonl.zst")).toBe("01a1cb9a-b181-7001-a516-cf1aed84eb7e");
    expect(threadOfRollout("session_index.jsonl")).toBeUndefined();
    expect(threadOfRollout("rollout-2026-04-21T15-05-03.jsonl")).toBeUndefined();
  });
});
