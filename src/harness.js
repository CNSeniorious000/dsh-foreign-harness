// 一个 workspace 对应一个 harness 会话（Claude Code 或 Codex）：分配 bridge 端口、建 agent/session、跨轮复用。
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createCodex } from "@ai-sdk/harness-codex";
import { createLocalSandbox } from "./sandbox.js";

const freePort = () => new Promise((ok, fail) => {
  const server = createServer();
  server.once("error", fail);
  server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => ok(port)); });
});

// adapter 默认写死 gpt-5.5，ChatGPT 账号不认；沿用本机 codex 自己配的 model。
let cachedCodexModel;
function codexModel() {
  if (process.env.DSH_CC_CODEX_MODEL) return process.env.DSH_CC_CODEX_MODEL;
  if (cachedCodexModel === undefined) {
    try { cachedCodexModel = readFileSync(join(homedir(), ".codex", "config.toml"), "utf8").match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? null; } catch { cachedCodexModel = null; }
  }
  return cachedCodexModel ?? undefined;
}

export const ENGINES = new Set(["claude-code", "codex"]);
const HARNESSES = { "claude-code": createClaudeCode, codex: createCodex };

export async function createHarnessSession({ engine, cwd }) {
  const port = await freePort();
  const sandbox = createLocalSandbox({ root: cwd, port });
  const model = engine === "codex" ? codexModel() : undefined;
  // codex 的 model 要挂在 agent 上；settings 里的 codexConfig.model 只进 CLI 配置，turn 请求会覆盖它。
  const agent = new HarnessAgent({
    id: engine,
    harness: HARNESSES[engine](model === undefined ? {} : { codexConfig: { model } }),
    sandboxConfig: { workDir: "." },
    ...(model === undefined ? {} : { model }),
  });
  const session = await agent.createSession({ sandboxSession: sandbox });
  return {
    /** 跑一轮，返回最终文本与用量。 */
    async turn(prompt, { signal, onEvent } = {}) {
      const result = await agent.stream({ session, prompt, abortSignal: signal });
      for await (const part of result.fullStream) onEvent?.(part);
      return { text: (await result.text).trim(), usage: await result.totalUsage };
    },
    async dispose() {
      await session.destroy?.().catch(() => {});
      await sandbox.destroy();
    },
  };
}
