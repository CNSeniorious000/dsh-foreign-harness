// dsh ↔ Codex 的会话归档同步：全事件驱动（不轮询），引擎即事实源（single source of truth）。
// Codex 的归档物理事实 = rollout-*.jsonl 住在哪边：~/.codex/archived_sessions/ = 已归档（旧的会被压成
// .jsonl.zst），~/.codex/sessions/YYYY/MM/DD/ = 未归档；文件名尾缀就是 threadId。watch ~/.codex 的
// rename 事件即可，归档事实每次对齐现读磁盘（不维护内存镜像，天然没有 TOCTOU）。dsh 侧不养第二份状态：
// dsh 上的归档操作写穿 `codex archive`，Codex 侧的搬家投影回 workspaceRegistry——两边都走原生入口，
// dsh 的归档闸门（agent/pre-step、session-stop）和 Codex 自己的搬迁流程才都会正常触发。映射不持久化：
// ~/.ai-sdk-harness/.agent-runs/<harnessSessionId>/bridge/event-log.ndjson 的 `bridge-thread` 事件就是
// threadId，目录名就是 harness sessionId（`<dshSessionId>:codex`）。
// Claude Code 本地会话的归档落点另行处理（见 README）。
import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const RUNS_DIR = join(homedir(), ".ai-sdk-harness", ".agent-runs");
const CODEX_ARCHIVED_DIR = join(homedir(), ".codex", "archived_sessions");

const exec = (file, args) => new Promise((ok) => execFile(file, args, { timeout: 15_000 }, (error) => ok(error === null)));

/** 给一对会话算该往哪边推（一致或基线建立中都返回 undefined）；target = 对侧要达到的归档态。 */
export function syncPlan(prevDsh, prevCodex, dsh, codex) {
  if (prevDsh === undefined || prevCodex === undefined) return undefined;
  if (prevDsh === dsh && prevCodex === codex) return undefined;
  if (prevDsh !== dsh && prevCodex !== codex) return undefined;
  if (prevDsh !== dsh) return { side: "codex", target: dsh };
  return { side: "dsh", target: codex };
}

const ROLLOUT_THREAD = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(\.zst)?$/;
/** rollout 文件名尾缀即 threadId（.zst 是归档后压缩的旧文件）。 */
export const threadOfRollout = (name) => basename(String(name)).match(ROLLOUT_THREAD)?.[1];

/** 引擎侧会话 id：codex 是 bridge-thread 事件的 threadId，claude-code 是 finish 事件 harnessMetadata
 * 里的 sessionId——都取最后一次（会话可能换过线程/重启过）。尺寸没变就用缓存。 */
async function cliIdsOf(name, cache) {
  const path = join(RUNS_DIR, name, "bridge", "event-log.ndjson");
  const info = await stat(path).catch(() => undefined);
  if (info === undefined) return {};
  const cached = cache.get(name);
  if (cached?.size === info.size) return cached.ids;
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return {};
  // 逐行 JSON 解析而不是匹配序列化形态：键序/字段增减会静默弄丢 id（resume 从此永久断掉还不报错）。
  let threadId;
  let claudeSessionId;
  for (const line of text.split("\n")) {
    try {
      const event = JSON.parse(line);
      if (event.type === "bridge-thread") threadId = event.threadId;
      const claude = event.harnessMetadata?.["claude-code"];
      if (claude?.sessionId !== undefined) claudeSessionId = claude.sessionId;
    } catch {}
  }
  const ids = { threadId, claudeSessionId };
  cache.set(name, { size: info.size, ids });
  return ids;
}

const cliIdCache = new Map();

/** 引擎侧会话 id。finish 部件的 providerMetadata 里有就直接用（免读日志），否则刮引擎自己的事件日志。 */
export async function engineCliId(harnessSessionId, hint) {
  if (hint !== undefined) return hint;
  const ids = await cliIdsOf(encodeURIComponent(harnessSessionId), cliIdCache);
  return ids.threadId ?? ids.claudeSessionId;
}

/** threadId → dshSessionId：扫引擎会话目录（只认 codex）。 */
async function codexThreadMap(cache) {
  const map = new Map();
  const names = await readdir(RUNS_DIR).catch(() => []);
  for (const name of names) {
    if (!name.endsWith("%3Acodex")) continue;
    const { threadId } = await cliIdsOf(name, cache);
    if (threadId !== undefined) map.set(threadId, decodeURIComponent(name).slice(0, -":codex".length));
  }
  return map;
}

/** archived_sessions 里现存的 threadId 集（文件名尾缀）——归档事实的唯一读口。 */
async function archivedThreadIds() {
  const ids = new Set();
  for (const name of await readdir(CODEX_ARCHIVED_DIR).catch(() => [])) {
    const threadId = threadOfRollout(name);
    if (threadId !== undefined) ids.add(threadId);
  }
  return ids;
}

/**
 * 启动归档同步：启动只建基线（历史分歧不追溯翻转），之后全靠事件——rollout 文件搬家（Codex 侧）
 * 或 workspace 归档集变化（dsh 侧）各推对侧。
 * @param {object} ctx 插件服务上下文（要拿得到 workspaceRegistry）
 * @returns {() => void} 停止函数（挂在 ctx.effect 上）
 */
export function startArchiveSync(ctx) {
  // cordis 的服务属性访问要求 static inject 声明；ctx.get 是免声明通道（route.js 同款）。
  const registry = ctx.get("workspaceRegistry");
  if (registry === undefined) return () => {};
  const cache = new Map();
  /** @type {Map<string, { dsh: boolean | undefined, codex: boolean | undefined }>} threadId → 两侧上次值 */
  const prev = new Map();

  // 串行链：任何一节抛错都放行下一节，否则一次异常就让同步永久静默死掉。catch 兜住 job 自身的抛错——
  // 尾链节的 rejection 没有下一个 later() 接，安静期会被 Node 当 unhandled rejection 杀进程。
  let chain = Promise.resolve();
  const later = (job) => (chain = chain.then(job, job).catch(() => {}));

  /** 批量对齐：pairs = [[threadId, dshId], ...]，单侧变化往另一侧推。 */
  const retries = new Map();
  const reconcile = (pairs) => later(async () => {
    const truth = await archivedThreadIds();
    const dshNow = new Set(registry.archivedSessionIds.map(String));
    for (const [threadId, dshId] of pairs) {
      const codex = truth.has(threadId);
      const dsh = dshNow.has(dshId);
      const last = prev.get(threadId) ?? {};
      const plan = syncPlan(last.dsh, last.codex, dsh, codex);
      // 推送成功就记目标值；对侧已到位就直接算成功——codex 的 archive/unarchive 非幂等（对已到位状态报错），打了反而把状态卡死。
      let wrote = false;
      if (plan?.side === "codex") wrote = codex === plan.target || (await exec("codex", [plan.target ? "archive" : "unarchive", threadId]));
      if (plan?.side === "dsh") wrote = dsh === plan.target || (plan.target ? await registry.archiveSession(dshId, { stopActivity: true }).then(() => true, () => false) : await registry.unarchiveSession(dshId).then(() => true, () => false));
      if (plan !== undefined && !wrote) {
        // transient 失败（bridge 持 rollout 时 codex 报 active writer）没有自然的下一次事件会触发它。
        ctx.logger.warn(`foreign-harness: archive sync ${plan.side}→${plan.target} failed for ${threadId} / ${dshId}, scheduling retry`);
        scheduleRetry([threadId, dshId]);
        continue;
      }
      clearTimeout(retries.get(threadId)?.timer); retries.delete(threadId);
      prev.set(threadId, { dsh: plan?.side === "dsh" && wrote ? plan.target : dsh, codex: plan?.side === "codex" && wrote ? plan.target : codex });
    }
  });
  // 失败重试：teardown 清得掉、每段失败串有上限（永久失败不无限打转），带上现成 pair（不过 queue 全量反查）。
  // 放弃时把预算也清掉：计数留着会让这对从此永久放弃（一次 transient 抖动就永久断掉自动对齐）。
  const scheduleRetry = (pair) => {
    const [threadId] = pair;
    const entry = retries.get(threadId) ?? { attempts: 0 };
    entry.attempts += 1;
    clearTimeout(entry.timer);
    if (entry.attempts > 5) { retries.delete(threadId); ctx.logger.warn(`foreign-harness: archive sync gave up on ${threadId} after ${entry.attempts} attempts`); return; }
    entry.timer = setTimeout(() => void reconcile([pair]), 30_000);
    retries.set(threadId, entry);
  };

  // Codex → dsh：rollout 文件搬进/搬出 archived_sessions。一次搬家会来两个 rename 事件，攒 100ms 批处理。
  const pending = new Set();
  let flushTimer;
  const queue = (threadId) => {
    pending.add(threadId);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      const ids = [...pending];
      pending.clear();
      void (async () => {
        const map = await codexThreadMap(cache);
        await reconcile(ids.map((threadId) => [threadId, map.get(threadId)]).filter(([, dshId]) => dshId !== undefined));
      })();
    }, 100);
  };
  const onRollout = (event, filename) => {
    if (event !== "rename" || filename == null) return;
    const threadId = threadOfRollout(filename);
    if (threadId !== undefined) queue(threadId);
  };
  // 单个 ~/.codex 递归 watch：两侧目录缺一个（新机器没归档过）也不失明。
  let watcher;
  try { watcher = watch(join(homedir(), ".codex"), { recursive: true }, onRollout); } catch (error) {
    ctx.logger.warn(`foreign-harness: cannot watch ~/.codex, codex → dsh archive sync is disabled: ${String(error)}`);
  }

  // dsh → Codex：workspace 归档集变化（照抄 WorkspaceFeed 的触发口径）。
  const off = ctx.on("domain/changed", (change) => {
    if (change.domain !== "workspace") return;
    void (async () => reconcile([...(await codexThreadMap(cache))]))();
  });

  // 启动基线也走串行链：扫描期发生的变更排在它后面，不会被当历史分歧吞掉。
  void later(async () => {
    const truth = await archivedThreadIds();
    const dshNow = new Set(registry.archivedSessionIds.map(String));
    for (const [threadId, dshId] of await codexThreadMap(cache)) {
      prev.set(threadId, { dsh: dshNow.has(dshId), codex: truth.has(threadId) });
    }
  });

  return () => { off?.(); clearTimeout(flushTimer); for (const { timer } of retries.values()) clearTimeout(timer); watcher?.close(); };
}
