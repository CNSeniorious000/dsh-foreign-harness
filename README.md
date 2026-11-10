# dsh-cc-agent-loop

把 Claude Code 接成 DeepSeek Harness 的 **agent loop**：dsh 负责会话、界面和事件，Claude Code 负责思考和动手。dsh 的每个 step 交给 AI SDK Harness 跑一轮 Claude，过程中的工具调用被翻译成 dsh 原生事件，于是 web 里用的是 dsh 自己的工具卡。

代价是 vendored 了一份 stock `dsh-agent-loop`（`vendor/agent-loop.js`，0.2.2-rc.1），只在 `ReactLoopAgent.step()` 开头加了一个分流点。

## 结构

- `vendor/agent-loop.js` —— stock loop 的副本，改动：import `createToolResultMessage`、加 `setClaudeStep()`、`step()` 里 `if (claudeStepRunner) return claudeStepRunner(...)`
- `src/index.js` —— 设置分流点并导出 `AgentLoop`
- `src/claude-step.js` —— 一个 step：把这轮消息写进会话 → 跑 Claude → 把文本/工具调用写成 `assistant/message` + `tool/call` + `tool/result`
- `src/harness.js` —— 每个 dsh 会话一个 Claude 会话（bridge 端口、`workDir: "."`、跨轮复用、dispose 回收）
- `src/sandbox.js` —— 把本地目录实现成 `HarnessV1NetworkSandboxSession`（无隔离，接的就是 dsh 的 workspace）

## 选择引擎

dsh 没有「每个会话挑一个 agent loop」的选择器——loop 是 agent 注册表上的**单工厂槽**。能做的是把「模式（preset）」当引擎开关：preset 的 id 会记进会话日志，`claudeStep` 从日志里读它。

`examples/web-engines.patch.yml` 插入了两个 preset，于是模式菜单里多出：

- **标准模式** / PTC / 极简 / 创造 → 交回 stock loop（vendored 副本里的 stock 逻辑）
- **Claude Code** → `@ai-sdk/harness-claude-code`
- **Codex** → `@ai-sdk/harness-codex`

headless 没有 preset 注册表，用 `DSH_CC_ENGINE=claude-code|codex` 选；不设就是 stock。

Codex 的 model 取 `~/.codex/config.toml` 里的 `model`（adapter 默认的 `gpt-5.5` 不被 ChatGPT 账号接受），可用 `DSH_CC_CODEX_MODEL` 覆盖。

## 接线

profile 里把 stock loop 换成这一行（`agent-loop` 是单工厂槽，不能并存）：

```yaml
- id: agent-loop
  disabled: true
- insert:
    - id: cc-agent-loop
      name: dsh-cc-agent-loop
```

```sh
dsh plugin --profile ccspike add link:$PWD
dsh --profile ccspike --patch ./patch.yml "看一下 note.txt"
```

`link:` 进来的包必须在包内建 `node_modules/@deepseek-ai` 符号链接（指向真正跑 dsh 的那份），否则 import 不到 `@deepseek-ai/dsh-llm`。

## 已知坑

- harness 需要一个真实 TCP 端口（bridge），必须给 `ports: [port]`；bridge 子进程会活过宿主进程，sandbox 里用子进程表在 `destroy()` 和 `process.once("exit")` 回收。
- 不给 `sandboxConfig.workDir: "."` 时，会话 cwd 会变成 `<workspace>/<harnessId>-<sessionId>`。
- `assistant/message` 必须带可迭代的 `stream` 帧，否则整段历史投影失败（`stream is not iterable`），界面连正文都不显示。
- 只写 `assistant/message` 的 `tool-call` 块不够：客户端的卡片从 `tool/call` 事件取名字和参数，`tool/result` 要用 `sourceEventSeqs` 指回那条 `tool/call`，否则卡片只剩裸 `callId`。
- Claude 的 `Task` 工具在 wire 上叫 `Agent`；dsh 只把 `subagent` / `subagent_*` 认成子代理委托，所以翻译时改名为 `subagent`，界面才会显示「已协调子智能体」而不是普通工具卡。
- `usage` 必须显式挑字段，AI SDK 的 usage 含 `undefined`，会被 `isJsonValue` 拒绝。
- headless 一轮就结束：默认销毁 Claude 会话和 bridge，否则进程退不出去（web 里设 `DSH_CC_SESSION_KEEP=1` 保留）。
