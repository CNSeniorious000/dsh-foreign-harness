// 引擎的模型与认证都从 dsh 来：模型 = 模型选择器里选的那个，认证 = 所选 provider 的路由配置与凭据
// （走官方 configEditor / credentials / launchEnvironment 服务）。这样「裸启动」的 dsh——不带任何环境变量——
// 也能用引擎；显式设置项优先，最后才退回宿主环境（终端里跑 claude 的老路径）。
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";

export const readField = (field) => (typeof field?.get === "function" ? field.get() : field);
export const defined = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

/** provider 的路由配置（baseURL + 凭据引用）在 llm-pi-ai 的 provider 行里，经 configEditor 官方入口读。 */
function providerProfile(ctx, provider) {
  if (provider === undefined) return undefined;
  const entry = ctx.get("configEditor")?.entries?.().find((e) => e.options?.id === "llm-pi-ai" || e.options?.name === "@deepseek-ai/dsh-llm-pi-ai");
  // fiber.config 是插件正在跑的配置；options.config 只有显式 patch 层，做兜底。
  const config = entry?.fiber?.config ?? entry?.options?.config;
  return readField(config?.providers)?.[provider];
}

/**
 * 解析一个引擎回合该用的模型和认证环境。
 * @param {object} ctx 插件服务上下文——agent.ctx 是 createScope 的隔离 scope，取不到 credentials/configEditor
 * @param {object} agent stock machine（有 model）
 * @param {string} engine
 * @param {object} settings 插件设置项（显式覆盖）
 * @returns {Promise<{ model: string | undefined, authEnv: Record<string, string> | undefined }>}
 */
export async function engineRoute(ctx, agent, engine, settings) {
  const selection = agent.model.current();
  const profile = providerProfile(ctx, selection?.provider);
  const keyRef = profile?.apiKeyEnv;
  // 和 dsh-llm-pi-ai 的 resolveApiKey 同一条解析链：credentials（存储优先于环境）→ launchEnvironment 兜底。
  // 存储读失败不炸回合，按「未配置」落回下一级（空值同义）。
  const credentials = ctx.get("credentials");
  const resolved = await Promise.resolve(keyRef === undefined ? undefined : credentials?.resolve?.(keyRef)).catch(() => undefined);
  const storedKey = resolved?.value || (keyRef === undefined ? undefined : launchEnvironmentOf(ctx).get(keyRef)?.value);

  // 模型语义：dsh 里选的那个就是引擎用的那个（设置项是显式覆盖）；codex 沿用自己的模型体系。空字符串视同未配置（与 apiKey 同口径）。
  const model = engine === "codex"
    ? settings.codexModel || undefined
    : settings.anthropicModel || selection?.model;

  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (key.startsWith("ANTHROPIC_") && value) env[key] = value;
  if (engine === "claude-code") {
    // CLI 只会说 Anthropic Messages 协议：provider 若声明了别的 wire（openai-responses 等），
    // 打出去只会 404/400 伪装成网络问题——协议不匹配就地拒绝。
    const api = readField(profile?.api);
    if (api !== undefined && !String(api).includes("anthropic")) throw new Error(`provider "${selection.provider}" speaks "${api}", but the claude-code engine talks the anthropic-messages protocol — pick an anthropic-protocol provider or front it with a converting gateway`);
    // 空字符串视同未配置（credentials seam 同一口径），继续落回下一级。
    const apiKey = settings.anthropicApiKey || storedKey || undefined;
    Object.assign(env, defined({
      ANTHROPIC_BASE_URL: settings.anthropicBaseUrl || profile?.baseURL,
      ANTHROPIC_MODEL: model,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      // CLI 内部（子代理、后台小任务）会用别名模型名；钉到选的模型，免得把 claude-haiku-* 打到第三方端点上。
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      CLAUDE_CODE_SUBAGENT_MODEL: model,
    }));
    // 认证头用 Bearer（AUTH_TOKEN）：CLI 的优先级里 OAuth 文件压过 ANTHROPIC_API_KEY，只有 AUTH_TOKEN 能赢；
    // 网关侧 Bearer 与 x-api-key 都认。有解析出的 key 就别留宿主的 API_KEY 抢头。
    if (apiKey !== undefined) delete env.ANTHROPIC_API_KEY;
  }

  // 会话绑定的 LLM 配置快照（无秘密：凭据只存引用名，值每次现解析）——dsh 侧唯一留存的轻量元数据。
  const llm = defined({ provider: selection?.provider, model, baseURL: profile?.baseURL, apiKeyEnv: profile?.apiKeyEnv });
  return { model, llm, authEnv: Object.keys(env).length > 0 ? env : undefined };
}
