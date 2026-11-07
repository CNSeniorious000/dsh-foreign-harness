// 一个 workspace 对应一个 Claude 会话：分配 bridge 端口、建 agent/session、turn 结束后保留会话以便续聊。
import { createServer } from "node:net";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createLocalSandbox } from "./sandbox.js";

const freePort = () => new Promise((ok, fail) => {
  const server = createServer();
  server.once("error", fail);
  server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => ok(port)); });
});

export async function createClaudeSession({ cwd, sandboxConfig = { workDir: "." }, settings = {} }) {
  const port = await freePort();
  const sandbox = createLocalSandbox({ root: cwd, port });
  const agent = new HarnessAgent({
    id: "claude-code",
    harness: createClaudeCode(settings),
    sandboxConfig,
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
