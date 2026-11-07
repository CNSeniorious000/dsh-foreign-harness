# dsh-cc-agent-loop

把 Claude Code 接成 DeepSeek Harness 的一个 agent。当前阶段是**工具形态**（`cc_agent`）：dsh 的 loop 调这个工具，工具里由 AI SDK Harness 驱动真正的 Claude Code 进程，产物以文本回到 dsh。

最终形态是接管 `ctx.agents.setFactory`，让 Claude 的每次工具调用变成 dsh 原生事件（原生卡片、子代理树、上下文计量）。

## 结构

- `src/sandbox.js` —— 把一个本地目录实现成 `HarnessV1NetworkSandboxSession`（无隔离，接的是 dsh 的 workspace）
- `src/harness.js` —— 每个 dsh 会话一个 Claude 会话：分配 bridge 端口、`workDir: "."`、跨轮复用、dispose 时回收子进程
- `src/index.js` —— cordis 插件：注册 `cc_agent` 工具

## 本地验证

```sh
dsh --profile ccspike --from-default-profile headless --dump-config
dsh plugin --profile ccspike add link:$PWD
# 需要 profile 里有可用的模型 provider（patch 里覆盖 llm-pi-ai + agent-default-model）
dsh --profile ccspike --patch ./patch.yml "请调用 cc_agent ..."
```

本机开发时，包内 `node_modules/@deepseek-ai` 必须符号链接到 `~/.dsh/profiles/node_modules/@deepseek-ai`，否则 `link:` 进来的包 import 不到 dsh 的包。

## 已知坑

- `defineTool` 的 `output.render` 是必填，缺了会静默注册失败。
- harness 需要一个真实 TCP 端口（bridge），必须给 `ports: [port]`。
- 不给 `sandboxConfig.workDir: "."` 时，会话 cwd 会变成 `<workspace>/<harnessId>-<sessionId>`。
- bridge 子进程会活过宿主进程，靠 sandbox 记录的子进程表在 `destroy()` 里回收。
