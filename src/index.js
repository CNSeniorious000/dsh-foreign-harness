// 把 Claude Code / Codex 接成 dsh 的 agent loop；引擎由模式（preset 的 config.id）选择。
import z from "@deepseek-ai/schemastery";
import { AgentLoop, setClaudeStep } from "../vendor/agent-loop.js";
import { claudeStep } from "./claude-step.js";

setClaudeStep(claudeStep);

// 设置项：volatile 字段进 dsh 的设置表单；DSH_CC_* 环境变量显式设置时优先（headless/调试用）。
// schema 必须是扁平 z.object：volatile 字段要求固定对象路径，z.intersect 会被 cordis 的 resolveConfig 拒掉。
// 前两项和 vendor/agent-loop.js 的 AgentLoop.Config 保持一致，改 vendor 时同步这里。
class ForeignHarnessLoop extends AgentLoop {
  static Config = z.object({
    maxParallelToolCalls: z.number().step(1).min(1).default(10).volatile(),
    agents: z.array(z.object({
      id: z.string().required(),
      sessionId: z.string().min(1),
      provider: z.string(),
      model: z.string(),
      reasoningEffort: z.string().min(1),
      maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
      cwd: z.string(),
      resumeSessionId: z.string(),
    })).default([]),
    codexModel: z.string().volatile(),
    keepSessions: z.boolean().default(false).volatile(),
    stripAnthropicEnv: z.boolean().default(false).volatile(),
  });

  constructor(ctx, config) {
    super(ctx, config);
    /** 原始配置行：volatile 字段是 .get() 取值器，由 claudeStep 的 settingsOf 读取。 */
    this.foreign = config;
  }
}

export default ForeignHarnessLoop;
export { ForeignHarnessLoop, ForeignHarnessLoop as AgentLoop };
