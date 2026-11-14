import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalSandbox } from "../src/sandbox.js";

const makeSandbox = async () => {
  const root = await mkdtemp(join(tmpdir(), "fh-sandbox-"));
  return createLocalSandbox({ root, port: 0 });
};

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const deadWithin = async (pid, ms = 1000) => { for (let t = 0; t < ms; t += 10) { if (!alive(pid)) return true; await new Promise((r) => setTimeout(r, 10)); } return !alive(pid); };

test("run captures stdout and exit code", async () => {
  const sandbox = await makeSandbox();
  expect(await sandbox.run({ command: "printf hello" })).toEqual({ exitCode: 0, stdout: "hello", stderr: "" });
  expect((await sandbox.run({ command: "exit 3" })).exitCode).toBe(3);
  await sandbox.destroy();
});

test("an aborted run reports a signal exit code, not success", async () => {
  const sandbox = await makeSandbox();
  const controller = new AbortController();
  const running = sandbox.run({ command: "sleep 5", abortSignal: controller.signal });
  controller.abort();
  expect((await running).exitCode).toBe(137); // 128 + SIGKILL
  await sandbox.destroy();
});

test("file round-trip: write, read, stat, list, delete", async () => {
  const sandbox = await makeSandbox();
  await sandbox.writeFile({ path: "sub/note.txt", content: "第一行\n第二行\n第三行" });
  expect(await sandbox.readTextFile({ path: "sub/note.txt", startLine: 2 })).toBe("第二行\n第三行");
  expect(await sandbox.stat({ path: "sub/note.txt" })).toMatchObject({ type: "file" });
  expect(await sandbox.listDirectory({ path: "sub" })).toContainEqual({ name: "note.txt", type: "file" });
  expect(await sandbox.deleteFile({ path: "sub/note.txt" })).toBe(true);
  expect(await sandbox.stat({ path: "sub/note.txt" })).toBeNull();
  await sandbox.destroy();
});

test("spawn streams stdout", async () => {
  const sandbox = await makeSandbox();
  const child = await sandbox.spawn({ command: "printf streamed" });
  expect(await new Response(child.stdout).text()).toBe("streamed");
  expect((await child.wait()).exitCode).toBe(0);
  await sandbox.destroy();
});

test("destroy reaps only its own children", async () => {
  const a = await makeSandbox();
  const b = await makeSandbox();
  const childA = await a.spawn({ command: "sleep 5" });
  const childB = await b.spawn({ command: "sleep 5" });
  await a.destroy();
  expect(await deadWithin(childA.pid)).toBe(true); // SIGKILL 异步送达，轮询到死亡为止
  expect(alive(childB.pid)).toBe(true);
  await b.destroy();
  expect(await deadWithin(childB.pid)).toBe(true);
});
