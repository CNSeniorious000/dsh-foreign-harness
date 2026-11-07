// dsh-cc-agent-loop：把 Claude Code 接成 dsh 的一个 agent（当前阶段：cc_agent 工具形态）。
// 每一步的最终形态是接管 ctx.agents.setFactory，让工具调用变成 dsh 原生事件。
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createClaudeSession } from "./harness.js";

export const name = "dsh-cc-agent-loop";
export const inject = ["tools", "workingDirectory"];

/** dsh session id → Claude 会话；同一会话跨轮复用，保持上下文连续。 */
const sessions = new Map();

async function sessionFor(ctx, agent) {
  const id = agent.session.id;
  const existing = sessions.get(id);
  if (existing !== undefined) return existing;

  const created = await createClaudeSession({ cwd: ctx.workingDirectory.get(agent.session) });
  sessions.set(id, created);
  await ctx.effect(() => async () => {
    sessions.delete(id);
    await created.dispose();
  }, `dsh-cc-agent-loop.session(${id})`);
  return created;
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: "cc_agent",
    description: "Delegate a self-contained task to Claude Code running in this workspace. Claude keeps its own loop, tools, skills and hooks; its final answer is returned as text.",
    parameters: {
      prompt: { type: "string", required: true, description: "The task for Claude Code." },
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    execute: async ({ prompt }, exec) => {
      const session = await sessionFor(ctx, exec.agent);
      const { text, events } = await session.turn(prompt);
      const tools = events.filter((e) => e.type === "tool-call").map((e) => `${e.toolName}(${JSON.stringify(e.input).slice(0, 120)})`);
      return tools.length > 0 ? `${text}\n\n---\nclaude 执行了 ${tools.length} 次工具调用：\n${tools.join("\n")}` : text;
    },
  }));
}
