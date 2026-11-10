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
function codexModel() {
  if (process.env.DSH_CC_CODEX_MODEL) return process.env.DSH_CC_CODEX_MODEL;
  try {
    return readFileSync(join(homedir(), ".codex", "config.toml"), "utf8").match(/^model\s*=\s*"([^"]+)"/m)?.[1];
  } catch {}
}

const HARNESSES = {
  "claude-code": (settings) => createClaudeCode(settings),
  codex: (settings) => createCodex({ codexConfig: { model: codexModel(), ...settings.codexConfig }, ...settings }),
};

export async function createHarnessSession({ engine = "claude-code", cwd, sandboxConfig = { workDir: "." }, settings = {} }) {
  const port = await freePort();
  const sandbox = createLocalSandbox({ root: cwd, port });
  const agent = new HarnessAgent({
    id: engine,
    harness: HARNESSES[engine](settings),
    sandboxConfig,
    // codex adapter 的 model 要挂在 agent 上；设置里的 codexConfig.model 只进 CLI 配置，turn 请求会覆盖它。
    ...(engine === "codex" && codexModel() !== undefined ? { model: codexModel() } : {}),
  });
  const session = await agent.createSession({ sandboxSession: sandbox });
  return {
    port,
    session,
    /** 跑一轮，返回最终文本与这一轮的事件摘要。 */
    async turn(prompt, { onEvent } = {}) {
      const result = await agent.stream({ session, prompt });
      const events = [];
      let text = "";
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") text += part.text ?? part.textDelta ?? "";
        if (part.type === "tool-call" || part.type === "tool-result" || part.type === "tool-error" || part.type === "finish-step" || part.type === "finish") events.push(part);
        onEvent?.(part);
      }
      return { text: text.trim(), events };
    },
    async dispose() {
      await session.destroy?.().catch(() => {});
      await sandbox.destroy();
    },
  };
}
