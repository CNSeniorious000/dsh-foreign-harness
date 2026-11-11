// 每个 dsh 会话一个 AI SDK Harness 会话（Claude Code / Codex CLI）：bridge 端口、工作目录、跨轮复用、dispose 回收。
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createCodex } from "@ai-sdk/harness-codex";
import { createLocalSandbox } from "./sandbox.js";

/** @returns {Promise<number>} */
const freePort = () => new Promise((ok) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close(() => ok(port));
  });
});

/** @type {string | null | undefined} */
let cachedCodexModel;
/** Codex 的 model 取 ~/.codex/config.toml（adapter 默认的 gpt-5.5 不被 ChatGPT 账号接受）。 @returns {string | undefined} */
function codexModel() {
  if (cachedCodexModel === undefined) {
    try {
      cachedCodexModel = readFileSync(join(homedir(), ".codex", "config.toml"), "utf8").match(/^\s*model\s*=\s*["']?([^"'\s#]+)["']?\s*$/m)?.[1] ?? null;
    } catch { cachedCodexModel = null; }
  }
  return cachedCodexModel ?? undefined;
}

export const ENGINES = new Set(["claude-code", "codex"]);
const HARNESSES = { "claude-code": createClaudeCode, codex: createCodex };

/**
 * harness 会话句柄：turn 跑一轮并把流事件回调出来；detach/stop 返回可持久化的 resume state（JSONValue），
 * 下次 createHarnessSession({ sessionId, resumeFrom }) 跨进程接回；destroy 直接销毁。
 * @typedef {object} HarnessHandle
 * @property {string} sessionId
 * @property {(prompt: string, options?: { signal?: AbortSignal, onEvent?: (part: import("ai").TextStreamPart<Record<string, import("ai").Tool>>) => void }) => Promise<{ text: string, usage: import("ai").LanguageModelUsage }>} turn
 * @property {() => Promise<import("@ai-sdk/harness/agent").HarnessAgentResumeSessionState>} detach
 * @property {() => Promise<import("@ai-sdk/harness/agent").HarnessAgentResumeSessionState>} stop
 * @property {() => Promise<void>} destroy
 */

/**
 * @param {{ engine: string, cwd: string, settings?: { codexModel?: string, stripAnthropicEnv?: boolean }, sessionId?: string, resumeFrom?: import("@ai-sdk/harness/agent").HarnessAgentResumeSessionState }} options
 * @returns {Promise<HarnessHandle>}
 */
export async function createHarnessSession({ engine, cwd, settings, sessionId, resumeFrom }) {
  const port = await freePort();
  const sandbox = createLocalSandbox({ root: cwd, port, ...(settings?.stripAnthropicEnv === undefined ? {} : { stripAnthropic: settings.stripAnthropicEnv }) });
  const model = engine === "codex" ? settings?.codexModel ?? codexModel() : undefined;
  const agent = new HarnessAgent({
    id: engine,
    harness: HARNESSES[engine](model === undefined ? {} : { codexConfig: { model } }),
    sandboxConfig: { workDir: "." },
    ...(model === undefined ? {} : { model }),
  });
  const session = await agent.createSession({ sandboxSession: sandbox, ...(sessionId === undefined ? {} : { sessionId }), ...(resumeFrom === undefined ? {} : { resumeFrom }) });
  return {
    sessionId: session.sessionId,
    async turn(prompt, { signal, onEvent } = {}) {
      const result = await agent.stream({ session, prompt, abortSignal: signal });
      for await (const part of result.stream) onEvent?.(part);
      return { text: (await result.text).trim(), usage: await result.usage };
    },
    async detach() { const state = await session.detach(); await sandbox.destroy(); return state; },
    async stop() { const state = await session.stop(); await sandbox.destroy(); return state; },
    async destroy() { await session.destroy?.().catch(() => {}); await sandbox.destroy(); },
  };
}
