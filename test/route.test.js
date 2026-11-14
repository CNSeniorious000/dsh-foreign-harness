// route 的协议守门：claude-code 引擎只接 anthropic-messages 协议的 provider，
// 别的 wire（openai-responses 等）就地拒绝——否则 CLI 打出去 404/400 伪装成网络问题。
import { test, expect } from "bun:test";
import { engineRoute } from "../src/route.js";

const ctxWith = (provider) => ({
  get: (name) => {
    if (name === "configEditor") return { entries: () => [{ options: { id: "llm-pi-ai" }, fiber: { config: { providers: { p: provider } } } }] };
    return undefined;
  },
});
const agent = { model: { current: () => ({ provider: "p", model: "m" }) } };

test("claude-code rejects providers speaking another wire protocol", async () => {
  const run = (api) => engineRoute(ctxWith({ api, baseURL: "https://x", apiKeyEnv: "K" }), agent, "claude-code", {});
  await expect(run("openai-responses")).rejects.toThrow(/anthropic-messages protocol/);
  await expect(run("azure-openai-responses")).rejects.toThrow(/anthropic-messages protocol/);
  // anthropic 系（含别名形态）放行，且带出 ANTHROPIC_* 环境。
  const env = await run("anthropic-messages");
  expect(env.authEnv.ANTHROPIC_BASE_URL).toBe("https://x");
});

test("provider without an api declaration passes through", async () => {
  const env = await engineRoute(ctxWith({ baseURL: "https://x", apiKeyEnv: "K" }), agent, "claude-code", {});
  expect(env.authEnv.ANTHROPIC_BASE_URL).toBe("https://x");
});

test("empty settings strings are treated as unconfigured", async () => {
  // 清空输入框是 "" 不是 undefined——不能穿透成 ANTHROPIC_BASE_URL=""（CLI 会解析出相对地址）。
  const env = await engineRoute(ctxWith({ baseURL: "https://x", apiKeyEnv: "K" }), agent, "claude-code", { anthropicBaseUrl: "", anthropicModel: "" });
  expect(env.authEnv.ANTHROPIC_BASE_URL).toBe("https://x");
  expect(env.authEnv.ANTHROPIC_MODEL).toBe("m");
});
