// 插件入口：ForeignHarnessLoop 是 stock AgentLoop（官方 @deepseek-ai/dsh-agent-loop，不 vendor）的子类。
// 不替换 loop，只替换 step：每个创建/恢复出来的 agent，其 step() 实例方法被换成「按 preset 路由」——
// 引擎 preset（claude-code/codex）跑 harness 回合，其它走原生 step。inbox/turn/事件/插件机械全是上游原装，
// 逐 step 路由意味着空白会话换模式、冷恢复、任意切换顺序都天然正确。
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import { ENGINES } from "./harness.js";
import { runEngineStep, disposeEngineSession } from "./engine-step.js";

const readField = (field) => (typeof field?.get === "function" ? field.get() : field);
const envFlag = (name, fallback) => (process.env[name] !== undefined ? process.env[name] === "1" : fallback ?? false);

/** preset id 就是引擎名；无 preset 记录（headless）才看 DSH_CC_ENGINE。 */
export function engineOfSession(session) {
  for (let seq = session.seq - 1; seq >= 0; seq--) {
    const event = session.eventAt(seq);
    if (event?.type === "agent-preset/selected") {
      const preset = event.data.agentPreset;
      return ENGINES.has(preset) ? preset : undefined;
    }
  }
  const env = process.env.DSH_CC_ENGINE;
  return ENGINES.has(env) ? env : undefined;
}

/** 把一个 stock agent 的 step() 换成引擎路由；handle.dispose 时顺带停引擎会话。 */
function patchAgent(ownerCtx, handle, settings) {
  const agent = handle.agent;
  const stockStep = agent.step.bind(agent);
  agent.step = async function (decision) {
    const engine = engineOfSession(this.session);
    if (engine === undefined) return stockStep(decision);
    const signal = this.phase.abort.signal;
    try {
      return await runEngineStep(this, decision, { turn: this.phase.turn, step: this.phase.step, signal, engine, settings });
    } finally {
      await decision.toolSet?.dispose?.();
    }
  };
  const dispose = async () => {
    await disposeEngineSession(agent).catch(() => {});
    await handle.dispose();
  };
  // headless / web 的调用方都丢弃 handle.dispose，teardown 只能挂在 owner ctx 的收尾上（否则 bridge 把进程焊住）。
  ownerCtx.effect(() => () => dispose(), `foreignHarness.session(${agent.id})`);
  return { agent, dispose };
}

export class ForeignHarnessLoop extends AgentLoop {
  // schema 必须是扁平 z.object：volatile 字段要求固定对象路径，z.intersect 会被 cordis 的 resolveConfig 拒掉。
  // 前两项和 stock AgentLoop.Config 保持一致（super 的构造和 init 要用），改上游时同步这里。
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
    stripAnthropicEnv: z.boolean().default(false).volatile(),
    // 引擎认证：显式配置后经 harness 的 auth 注入，不依赖启动 dsh 的 shell 环境（CLI 会退回过期 OAuth 刷新报 400）。
    anthropicApiKey: z.string().role("secret").volatile(),
    anthropicBaseUrl: z.string().volatile(),
    anthropicModel: z.string().volatile(),
  });

  constructor(ctx, config) {
    super(ctx, config);
    /** 原始配置行：volatile 字段是 .get() 取值器。 */
    this.foreign = config;
  }

  async [Service.init]() {
    await super[Service.init]();
  }

  get foreignSettings() {
    return {
      codexModel: process.env.DSH_CC_CODEX_MODEL ?? readField(this.foreign.codexModel),
      stripAnthropicEnv: envFlag("DSH_CC_STRIP_ANTHROPIC", readField(this.foreign.stripAnthropicEnv)),
      anthropicApiKey: readField(this.foreign.anthropicApiKey),
      anthropicBaseUrl: readField(this.foreign.anthropicBaseUrl),
      anthropicModel: readField(this.foreign.anthropicModel),
    };
  }

  async createAgent(ownerCtx, options) {
    return patchAgent(ownerCtx, await super.createAgent(ownerCtx, options), this.foreignSettings);
  }

  async resume(ownerCtx, options) {
    return patchAgent(ownerCtx, await super.resume(ownerCtx, options), this.foreignSettings);
  }
}

export default ForeignHarnessLoop;
