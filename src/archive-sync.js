// dsh ↔ Codex 的会话归档双向同步。两侧都走原生入口（workspaceRegistry.archiveSession /
// `codex archive`），dsh 的归档闸门（agent/pre-step 拦截、session-stop）和 Codex 自己的归档流程
// （state 库、rollout 搬迁）才都会正常触发。映射不额外持久化——引擎会话的
// ~/.ai-sdk-harness/.agent-runs/<harnessSessionId>/bridge/event-log.ndjson 里的 `bridge-thread`
// 事件就是 threadId，目录名就是 harness sessionId（`<dshSessionId>:codex`），跨进程存活。
// Claude Code 本地没有归档概念（只有 claude.ai 云会话才有），不参与同步。
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const RUNS_DIR = join(homedir(), ".ai-sdk-harness", ".agent-runs");
const TICK_MS = 4000;

const exec = (file, args) => new Promise((ok) => execFile(file, args, { timeout: 15_000 }, (error) => ok(error === null)));

/** 给一对会话算该往哪边推（一致或基线建立中都返回 undefined）。 */
export function syncPlan(prevDsh, prevCodex, dsh, codex) {
  if (prevDsh === undefined || prevCodex === undefined) return undefined;
  if (prevDsh === dsh && prevCodex === codex) return undefined;
  if (prevDsh !== dsh && prevCodex !== codex) return undefined;
  if (prevDsh !== dsh) return dsh ? "archive-codex" : "unarchive-codex";
  return codex ? "archive-dsh" : "unarchive-dsh";
}

/** 读一个引擎会话事件日志里最后一个 bridge-thread（thread 可能因配置变更重启过，最新的才是活的）。尺寸没变就用缓存。 */
async function threadIdOf(name, cache) {
  const path = join(RUNS_DIR, name, "bridge", "event-log.ndjson");
  const info = await stat(path).catch(() => undefined);
  if (info === undefined) return undefined;
  const cached = cache.get(name);
  if (cached?.size === info.size) return cached.threadId;
  const head = await readFile(path, "utf8").catch(() => undefined);
  if (head === undefined) return undefined;
  let threadId;
  for (const match of head.matchAll(/"type":"bridge-thread","threadId":"([^"]+)"/g)) threadId = match[1];
  cache.set(name, { size: info.size, threadId });
  return threadId;
}

/** threadId → dshSessionId：扫引擎会话目录（只认 codex）。带尺寸缓存，日志没长就不重读。 */
async function codexThreadMap(cache) {
  const map = new Map();
  let names = [];
  try { names = await readdir(RUNS_DIR); } catch { return map; }
  for (const name of names) {
    if (!name.endsWith("%3Acodex")) continue;
    const threadId = await threadIdOf(name, cache);
    if (threadId !== undefined) map.set(threadId, decodeURIComponent(name).slice(0, -":codex".length));
  }
  return map;
}

/** Codex 的本地会话库（state_N.sqlite，N 是 schema 版本，取最新的）。 */
async function codexStatePath() {
  const names = await readdir(join(homedir(), ".codex")).catch(() => []);
  const versions = names.map((name) => name.match(/^state_(\d+)\.sqlite$/)?.[1]).filter((v) => v !== undefined).map(Number);
  return versions.length === 0 ? undefined : join(homedir(), ".codex", `state_${Math.max(...versions)}.sqlite`);
}

/** threadId → Codex 侧 archived 位。 */
async function codexArchivedMap(threadIds) {
  const map = new Map();
  const path = await codexStatePath();
  if (path === undefined || threadIds.length === 0) return map;
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = db.prepare(`SELECT id, archived FROM threads WHERE id IN (${threadIds.map(() => "?").join(",")})`).all(...threadIds);
      for (const row of rows) map.set(row.id, row.archived === 1);
    } finally { db.close(); }
  } catch {}
  return map;
}

/**
 * 启动双向同步：每 TICK_MS 对齐一次（首拍只建基线，之后单侧变化往另一侧推），
 * dsh 侧的 domain/changed 会立刻踢一拍，归档点下去几秒内 Codex 就能看到。
 * @param {object} ctx 插件服务上下文（要拿得到 workspaceRegistry）
 * @returns {() => void} 停止函数（挂在 ctx.effect 上）
 */
export function startArchiveSync(ctx) {
  if (ctx.workspaceRegistry === undefined) return () => {};
  const cache = new Map();
  /** @type {Map<string, { dsh: boolean | undefined, codex: boolean | undefined }>} threadId → 两侧上次值 */
  const prev = new Map();
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const map = await codexThreadMap(cache);
      const dshNow = new Set(ctx.workspaceRegistry.archivedSessionIds.map(String));
      const codexNow = await codexArchivedMap([...map.keys()]);
      for (const [threadId, dshId] of map) {
        const dsh = dshNow.has(dshId);
        const codex = codexNow.get(threadId) ?? false;
        const last = prev.get(threadId) ?? {};
        const plan = syncPlan(last.dsh, last.codex, dsh, codex);
        // 推送成功就乐观更新那一侧的基线：否则自己写入的回声会在下拍被当成「对方也动了」而双双跳过。
        let wroteDsh = false;
        let wroteCodex = false;
        if (plan === "archive-codex" || plan === "unarchive-codex") wroteCodex = await exec("codex", [plan === "archive-codex" ? "archive" : "unarchive", threadId]);
        if (plan === "archive-dsh") wroteDsh = await ctx.workspaceRegistry.archiveSession(dshId, { stopActivity: true }).then(() => true, () => false);
        if (plan === "unarchive-dsh") wroteDsh = await ctx.workspaceRegistry.unarchiveSession(dshId).then(() => true, () => false);
        prev.set(threadId, { dsh: wroteDsh ? !dsh : dsh, codex: wroteCodex ? !codex : codex });
      }
    } finally { running = false; }
  };

  const timer = setInterval(() => void tick(), TICK_MS);
  const off = ctx.on("domain/changed", (change) => { if (change.domain === "workspace") void tick(); });
  void tick();
  return () => { stopped = true; clearInterval(timer); off?.(); };
}
