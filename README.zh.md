---
description: "把外来编码智能体（Claude Code、Codex）接成 DeepSeek Harness 的 agent loop，工具调用渲染为 dsh 原生卡片。"
kind: "package-reference"
---

# dsh-foreign-harness

[English](README.md) | 中文

## 概述

`dsh-foreign-harness` 替换 stock 的 `dsh-agent-loop`，让每个 dsh step 由外来编码智能体驱动，而不是裸模型请求：dsh 负责会话、界面和事件；Claude Code / Codex（经 AI SDK harness 适配器）负责思考和动手。工具调用被翻译成 `tool/call` + `tool/result` 事件，于是 web 里用的是 dsh 自己的工具卡。

stock loop 以 vendored 副本保留（`vendor/agent-loop.js`，0.2.2-rc.1），只有两处改动：`setClaudeStep()` 和 `ReactLoopAgent.step()` 开头的分流点。模式（preset）不是我们这两个时返回 `undefined`，走未动过的 stock 逻辑。

## 目录

- [使用](#使用)
- [配置](#配置)
- [实现结构](#实现结构)
- [测试](#测试)
- [已知限制](#已知限制)

## 使用

dsh 没有「每个会话挑一个 agent loop」的选择器——loop 是单一工厂槽。引擎选择因此挂在模式（preset）选择器上：preset 的 id 记进会话日志，step 再读回来。

```yaml
# profile 的 cordis.patch.yml
- id: agent-loop
  disabled: true
- insert:
    - id: foreign-harness
      name: dsh-foreign-harness

    # preset 的 config.id 就是引擎名（见 src/harness.js 的 ENGINES）
    - id: preset-cc-claude
      name: '@deepseek-ai/dsh-agent-preset'
      config: { id: claude-code, name: Claude Code, order: 5, plugins: [] }
    - id: preset-cc-codex
      name: '@deepseek-ai/dsh-agent-preset'
      config: { id: codex, name: Codex, order: 6, plugins: [] }
```

完整示例见 `examples/web-engines.patch.yml`。headless 没有 preset 注册表，用 `DSH_CC_ENGINE=claude-code|codex` 选引擎；不设就是 stock。

```sh
dsh plugin --profile <p> add link:$PWD
dsh --profile <p> --patch ./patch.yml "看一下 note.txt"
```

`bun install` 之后，把 `node_modules/@deepseek-ai` 重建为指向真正跑 dsh 的那份 `@deepseek-ai` 目录的符号链接。宿主包必须与宿主加载的是**同一实例**（cordis 的 `Service` 身份），私有副本做不到。

## 配置

设置项就是插件行的 `config`，volatile 字段会出现在 dsh 的设置表单里（见 `src/index.js`）。环境变量显式设置时优先，供 headless/调试用。

| config | env | 默认 | 含义 |
| --- | --- | --- | --- |
| `codexModel` | `DSH_CC_CODEX_MODEL` | `~/.codex/config.toml` 的 `model` | Codex 引擎的模型（adapter 默认的 `gpt-5.5` 不被 ChatGPT 账号接受） |
| `keepSessions` | `DSH_CC_SESSION_KEEP=1` | `false` | 跨 step 保留 harness 会话（web 用）；headless 每轮回收，进程才能退出 |
| `stripAnthropicEnv` | `DSH_CC_STRIP_ANTHROPIC=1` | `false` | 给引擎剥离 `ANTHROPIC_*` 环境变量（默认继承宿主 env，和终端里跑 `claude` 一致） |

## 实现结构

- `src/index.js` —— 导出 `ForeignHarnessLoop`（stock `AgentLoop` 子类）并注册 step 分流点
- `src/claude-step.js` —— 一个 step：读 preset → 只用用户的话拼 prompt → 跑 harness 一轮 → 落 `assistant/message`（带回放帧）+ `tool/call` + `tool/result`
- `src/harness.js` —— 每个 dsh 会话一个 harness 会话（bridge 端口、`workDir: "."`、跨 step 复用、dispose 回收）
- `src/sandbox.js` —— 把本地目录实现成 `HarnessV1NetworkSandboxSession`（无隔离，接的就是 dsh 的 workspace）

客户端投影的硬契约（违反任何一条渲染就坏）：

- `assistant/message` 必须带可迭代的 `stream` 帧数组——用 dsh 自己的 `AssistantStreamAccumulator` 生成
- 工具卡的名字和参数取自 `tool/call` 事件；`tool/result` 用 `sourceEventSeqs` 指回它
- `usage` 必须是纯 JSON（AI SDK 的 usage 带 `undefined` 字段）
- Claude 的 `Task` 工具 wire 上叫 `Agent`；界面只认 `subagent*`，所以进来时改名

## 测试

`bun test` 跑 `test/sandbox.test.js`（sandbox 适配器的文件/进程往返）。引擎路径拿真实 profile 验证：

```sh
DSH_CC_ENGINE=claude-code dsh --profile <p> --patch ./patch.yml "收到请回复收到"
```

## 已知限制

- 图片/文件附件只投影成 dsh 的确定性 handle 文本（`textOnlyImageText` / `fileHandleText`），引擎拿不到字节。
- 多轮历史每 step 摊平成一条 user 消息（只取 `source.kind === "user"` 的内容）。
- 后台子智能体不会回报，界面上也还没有子智能体树。
