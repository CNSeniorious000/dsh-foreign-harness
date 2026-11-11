// dsh ↔ Codex 的会话归档同步：全事件驱动（不轮询），引擎即事实源（single source of truth）。
// Codex 的归档物理事实 = rollout-*.jsonl 住在哪边：~/.codex/archived_sessions/ = 已归档（旧的会被压成
// .jsonl.zst），~/.codex/sessions/YYYY/MM/DD/ = 未归档；文件名尾缀就是 threadId。watch 两侧目录的
// rename 事件即可。dsh 侧不养第二份状态：启动时把引擎事实投影进 workspaceRegistry，dsh 上的归档操作
// 则写穿 `codex archive`——两边都走原生入口，dsh 的归档闸门（agent/pre-step、session-stop）和 Codex
// 自己的搬迁流程才都会正常触发。映射不持久化：~/.ai-sdk-harness/.agent-runs/<harnessSessionId>/bridge/
// event-log.ndjson 的 `bridge-thread` 事件就是 threadId，目录名就是 harness sessionId（`<dshSessionId>:codex`）。
// Claude Code 本地会话的归档落点另行处理（见 README）。
import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const RUNS_DIR = join(homedir(), ".ai-sdk-harness", ".agent-runs");
const CODEX_ARCHIVED_DIR = join(homedir(), ".codex", "archived_sessions");
const CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");

const exec = (file, args) => new Promise((ok) => execFile(file, args, { timeout: 15_000 }, (error) => ok(error === null)));

/** 给一对会话算该往哪边推（一致或基线建立中都返回 undefined）。 */
export function syncPlan(prevDsh, prevCodex, dsh, codex) {
  if (prevDsh === undefined || prevCodex === undefined) return undefined;
  if (prevDsh === dsh && prevCodex === codex) return undefined;
  if (prevDsh !== dsh && prevCodex !== codex) return undefined;
  if (prevDsh !== dsh) return dsh ? "archive-codex" : "unarchive-codex";
  return codex ? "archive-dsh" : "unarchive-dsh";
}

const ROLLOUT_THREAD = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(\.zst)?$/;
/** rollout 文件名尾缀即 threadId（.zst 是归档后压缩的旧文件）。 */
export const threadOfRollout = (name) => basename(String(name)).match(ROLLOUT_THREAD)?.[1];

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

/** threadId → dshSessionId：扫引擎会话目录（只认 codex）。 */
async function codexThreadMap(cache) {
  const map = new Map();
  const names = await readdir(RUNS_DIR).catch(() => []);
  for (const name of names) {
    if (!name.endsWith("%3Acodex")) continue;
    const threadId = await threadIdOf(name, cache);
    if (threadId !== undefined) map.set(threadId, decodeURIComponent(name).slice(0, -":codex".length));
  }
  return map;
}

/** archived_sessions 里现存的 threadId 集（文件名尾缀）。 */
async function archivedThreadIds() {
  const ids = new Set();
  for (const name of await readdir(CODEX_ARCHIVED_DIR).catch(() => [])) {
    const threadId = threadOfRollout(name);
    if (threadId !== undefined) ids.add(threadId);
  }
  return ids;
}

/**
 * 启动归档同步：引擎事实先投影进 dsh（启动即对齐），之后全靠事件——
 * rollout 文件搬家（Codex 侧）或 workspace 归档集变化（dsh 侧）各推对侧。
 * @param {object} ctx 插件服务上下文（要拿得到 workspaceRegistry）
 * @returns {() => void} 停止函数（挂在 ctx.effect 上）
 */
export function startArchiveSync(ctx) {
  if (ctx.workspaceRegistry === undefined) return () => {};
  const cache = new Map();
  /** @type {Map<string, { dsh: boolean | undefined, codex: boolean | undefined }>} threadId → 两侧上次值 */
  const prev = new Map();
  /** 归档事实（引擎侧）：住在 archived_sessions 的 threadId。watch 事件维护。 */
  let archivedIds = new Set();

  const apply = async (threadId) => {
    const dshId = (await codexThreadMap(cache)).get(threadId);
    if (dshId === undefined) return;
    const codex = archivedIds.has(threadId);
    const dsh = ctx.workspaceRegistry.archivedSessionIds.some((id) => String(id) === dshId);
    const last = prev.get(threadId) ?? {};
    const plan = syncPlan(last.dsh, last.codex, dsh, codex);
    // 推送成功就乐观更新那一侧：否则自己写入的回声会被当成「对方也动了」而双双跳过。
    let wroteDsh = false;
    let wroteCodex = false;
    if (plan === "archive-codex" || plan === "unarchive-codex") wroteCodex = await exec("codex", [plan === "archive-codex" ? "archive" : "unarchive", threadId]);
    if (plan === "archive-dsh") wroteDsh = await ctx.workspaceRegistry.archiveSession(dshId, { stopActivity: true }).then(() => true, () => false);
    if (plan === "unarchive-dsh") wroteDsh = await ctx.workspaceRegistry.unarchiveSession(dshId).then(() => true, () => false);
    prev.set(threadId, { dsh: wroteDsh ? !dsh : dsh, codex: wroteCodex ? !codex : codex });
  };

  // Codex → dsh：rollout 文件搬进/搬出 archived_sessions。
  const onRollout = (inArchived) => (event, filename) => {
    if (event !== "rename" || filename == null) return;
    const threadId = threadOfRollout(filename);
    if (threadId === undefined) return;
    void (async () => {
      const path = join(inArchived ? CODEX_ARCHIVED_DIR : CODEX_SESSIONS_DIR, String(filename));
      const alive = await stat(path).then(() => true, () => false);
      if (!alive) return;
      if (inArchived) archivedIds.add(threadId); else archivedIds.delete(threadId);
      await apply(threadId);
    })();
  };
  const watchers = [];
  try { watchers.push(watch(CODEX_ARCHIVED_DIR, onRollout(true))); } catch {}
  try { watchers.push(watch(CODEX_SESSIONS_DIR, { recursive: true }, onRollout(false))); } catch {}

  // dsh → Codex：workspace 归档集变化（照抄 WorkspaceFeed 的触发口径）。
  const off = ctx.on("domain/changed", (change) => {
    if (change.domain !== "workspace") return;
    void (async () => {
      for (const threadId of (await codexThreadMap(cache)).keys()) await apply(threadId);
    })();
  });

  // 启动只建基线（引擎事实在 archivedIds/映射里，dsh 事实即 workspaceRegistry）：
  // 历史分歧不追溯翻转——归档状态的事实源在引擎自己的存储里，dsh 这边只是投影/写穿，不养第二份。
  void (async () => {
    archivedIds = await archivedThreadIds();
    for (const [threadId, dshId] of await codexThreadMap(cache)) {
      const dsh = ctx.workspaceRegistry.archivedSessionIds.some((id) => String(id) === dshId);
      prev.set(threadId, { dsh, codex: archivedIds.has(threadId) });
    }
  })();

  return () => { off?.(); for (const watcher of watchers) watcher.close(); };
}
