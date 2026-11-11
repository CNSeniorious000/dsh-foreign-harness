// 把一个本地目录包成 HarnessV1NetworkSandboxSession。
// 不是安全边界：没有隔离、没有网络策略；它只是把文件/进程操作接到 dsh 的 workspace 上。
import { spawn as spawnProcess } from "node:child_process";
import { mkdir, readFile, writeFile as writeFileToDisk, stat as statPath, readdir, unlink } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const bytesOf = async (content) => (typeof content === "string" ? Buffer.from(content) : content instanceof Uint8Array ? Buffer.from(content) : Buffer.from(await new Response(content).arrayBuffer()));

// 所有 sandbox 共享一个子进程表和一个退出钩子：dsh 直接退出时 effect 清理不跑，bridge 会活下来占端口。
const children = new Set();
process.once("exit", () => { for (const child of children) child.kill("SIGKILL"); });
const reap = () => { for (const child of children) child.kill("SIGKILL"); children.clear(); };

// 引擎继承宿主 env（和终端里跑 claude 一致）。想让它用别的凭据时用 DSH_CC_STRIP_ANTHROPIC=1 剥掉网关变量。
const baseEnv = process.env.DSH_CC_STRIP_ANTHROPIC === "1" ? Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ANTHROPIC_"))) : process.env;

export function createLocalSandbox({ root, port }) {
  const at = (p) => resolve(root, p);

  const start = (options, wantsStdin) => {
    const child = spawnProcess(options.command, {
      cwd: options.workingDirectory ? at(options.workingDirectory) : root,
      env: { ...baseEnv, ...options.env },
      shell: true,
      stdio: [wantsStdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    children.add(child);
    child.on("close", () => children.delete(child));
    // headless 跑完一轮后进程要能退出：bridge 是长跑子进程，别让它把事件循环焊住。
    child.unref();
    child.stdout?.unref?.();
    child.stderr?.unref?.();
    child.stdin?.unref?.();
    options.abortSignal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
    const handle = {
      pid: child.pid,
      stdout: Readable.toWeb(child.stdout),
      stderr: Readable.toWeb(child.stderr),
      wait: () => new Promise((ok, fail) => { child.on("close", (code) => ok({ exitCode: code ?? 0 })); child.on("error", fail); }),
      kill: async () => { child.kill("SIGKILL"); },
    };
    if (wantsStdin) handle.stdin = Writable.toWeb(child.stdin);
    return handle;
  };

  const write = async ({ path, content }) => { await mkdir(dirname(at(path)), { recursive: true }); await writeFileToDisk(at(path), await bytesOf(content)); };

  const restricted = {
    description: `Local machine directory ${root}.`,
    readFile: async ({ path }) => { try { return Readable.toWeb(Readable.from(await readFile(at(path)))); } catch { return null; } },
    readBinaryFile: async ({ path }) => { try { return new Uint8Array(await readFile(at(path))); } catch { return null; } },
    readTextFile: async ({ path, encoding = "utf-8", startLine = 1, endLine }) => {
      try {
        const lines = (await readFile(at(path), encoding)).split("\n");
        return lines.slice(startLine - 1, endLine ?? lines.length).join("\n");
      } catch { return null; }
    },
    writeFile: write,
    writeBinaryFile: write,
    writeTextFile: async ({ path, content, encoding = "utf-8" }) => { await mkdir(dirname(at(path)), { recursive: true }); await writeFileToDisk(at(path), content, encoding); },
    stat: async ({ path }) => { try { const s = await statPath(at(path)); return { type: s.isFile() ? "file" : s.isDirectory() ? "directory" : "other", size: s.size }; } catch { return null; } },
    listDirectory: async ({ path }) => {
      try {
        const entries = await readdir(at(path), { withFileTypes: true });
        return entries.map((e) => ({ name: e.name, type: e.isFile() ? "file" : e.isDirectory() ? "directory" : e.isSymbolicLink() ? "symlink" : "other" }));
      } catch { return null; }
    },
    deleteFile: async ({ path }) => { try { await unlink(at(path)); return true; } catch { return false; } },
    spawn: async (options) => start(options, options.stdin === true),
    run: async (options) => {
      const child = start(options, false);
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
