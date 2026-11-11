// 把一个本地目录包成 HarnessV1NetworkSandboxSession。
// 不是安全边界：没有隔离、没有网络策略；它只是把文件/进程操作接到 dsh 的 workspace 上。
import { spawn as spawnProcess } from "node:child_process";
import { mkdir, readFile, writeFile as writeFileToDisk, stat as statPath, readdir, unlink } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

/** @param {string | Uint8Array | Blob} content @returns {Promise<Buffer>} */
const bytesOf = async (content) => (typeof content === "string" ? Buffer.from(content) : content instanceof Uint8Array ? Buffer.from(content) : Buffer.from(await new Response(content).arrayBuffer()));

// 全局表只服务进程退出钩子：dsh 直接退出时 effect 清理不跑，bridge 会活下来占端口。dsh 宿主接了 SIGTERM/SIGINT 并走
// 优雅退出（exit 钩子会跑），所以这里不用再抢信号。destroy() 只杀自己会话的子进程——并发会话各有 bridge，全局收割会误杀别人的回合。
const survivors = new Set();
process.once("exit", () => { for (const child of survivors) child.kill("SIGKILL"); });

/**
 * @param {{ root: string, port: number, stripAnthropic?: boolean, env?: Record<string, string> }} options stripAnthropic：给引擎剥离 ANTHROPIC_* 网关变量（默认继承宿主 env，和终端里跑 claude 一致）；env 合进每个子进程的基础环境（认证/模型变量要能到 CLI 手里）
 * @returns {import("@ai-sdk/harness").HarnessV1NetworkSandboxSession}
 */
export function createLocalSandbox({ root, port, stripAnthropic = process.env.DSH_CC_STRIP_ANTHROPIC === "1", env: extraEnv }) {
  const at = (p) => resolve(root, p);
  const children = new Set();
  const reap = () => { for (const child of children) child.kill("SIGKILL"); children.clear(); };
  const host = stripAnthropic ? Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ANTHROPIC_"))) : process.env;
  const baseEnv = extraEnv === undefined ? host : { ...host, ...extraEnv };

  /** @param {{ command: string, workingDirectory?: string, env?: Record<string, string>, abortSignal?: AbortSignal }} options @param {boolean} wantsStdin @param {boolean} detach 长跑子进程（bridge）才 unref——unref 过的 stdio 在 node 下不再吐数据，run() 这种要读完输出的不能碰 */
  const start = (options, wantsStdin, detach) => {
    const child = spawnProcess(options.command, {
      cwd: options.workingDirectory ? at(options.workingDirectory) : root,
      env: { ...baseEnv, ...options.env },
      shell: true,
      stdio: [wantsStdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    children.add(child);
    survivors.add(child);
    // 记账和 wait 都等 exit：unref 过的 stdio 永远不 EOF，close 事件不会来。
    child.on("exit", () => { children.delete(child); survivors.delete(child); });
    if (detach) {
      // headless 跑完一轮后进程要能退出：bridge 是长跑子进程，别让它把事件循环焊住。
      child.unref();
      child.stdout?.unref?.();
      child.stderr?.unref?.();
      child.stdin?.unref?.();
    }
    options.abortSignal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
    const handle = {
      pid: child.pid,
      stdout: Readable.toWeb(child.stdout),
      stderr: Readable.toWeb(child.stderr),
      wait: () => new Promise((ok, fail) => {
        // exit 事件而非 close：unref 过的 stdio 永远不 EOF。已退出要立即返回，晚注册的监听者收不到历史事件。
        if (child.exitCode !== null || child.signalCode !== null) return ok({ exitCode: child.exitCode ?? 0 });
        child.on("exit", (code) => ok({ exitCode: code ?? 0 }));
        child.on("error", fail);
      }),
      kill: async () => { child.kill("SIGKILL"); },
    };
    if (wantsStdin) handle.stdin = Writable.toWeb(child.stdin);
    return handle;
  };

  /** @param {{ path: string, content: string | Uint8Array | Blob }} file */
  const write = async ({ path, content }) => { await mkdir(dirname(at(path)), { recursive: true }); await writeFileToDisk(at(path), await bytesOf(content)); };

  const restricted = {
    description: `Local machine directory ${root}.`,
    readFile: async ({ path }) => { try { return Readable.toWeb(Readable.from(await readFile(at(path)))); } catch { return null; } },
    readBinaryFile: async ({ path }) => { try { return new Uint8Array(await readFile(at(path))); } catch { return null; } },
    readTextFile: async ({ path, encoding = "utf-8", startLine = 1, endLine }) => {
      try {
        const lines = (await readFile(at(path), encoding)).split("\n");
        return lines.slice(startLine - 1, endLine ?? lines.length).join("\n");
      } catch { return null; } },
    writeFile: write,
    writeBinaryFile: write,
    writeTextFile: async ({ path, content, encoding = "utf-8" }) => { await mkdir(dirname(at(path)), { recursive: true }); await writeFileToDisk(at(path), content, encoding); },
    stat: async ({ path }) => { try { const s = await statPath(at(path)); return { type: s.isFile() ? "file" : s.isDirectory() ? "directory" : "other", size: s.size }; } catch { return null; } },
    listDirectory: async ({ path }) => {
      try {
        const entries = await readdir(at(path), { withFileTypes: true });
        return entries.map((e) => ({ name: e.name, type: e.isFile() ? "file" : e.isDirectory() ? "directory" : e.isSymbolicLink() ? "symlink" : "other" }));
      } catch { return null; } },
    deleteFile: async ({ path }) => { try { await unlink(at(path)); return true; } catch { return false; } },
    spawn: async (options) => start(options, options.stdin === true, true),
    run: async (options) => {
      const child = start(options, false, false);
      const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const { exitCode } = await child.wait();
      return { exitCode, stdout, stderr };
    },
  };

  return {
    id: randomUUID(),
    defaultWorkingDirectory: root,
    ports: [port],
    getPortEndpoint: async () => ({ url: `ws://127.0.0.1:${port}` }),
    getPortUrl: async () => `http://127.0.0.1:${port}`,
    stop: async () => {},
    destroy: async () => reap(),
    // bridge 启动阶段会直接在外层对象上调 run/spawn，所以方法既挂 restricted() 也铺一份。
    restricted: () => restricted,
    ...restricted,
  };
}
