---
description: "把外来编码智能体（Claude Code、Codex）接成 DeepSeek Harness 的 agent loop，工具调用渲染为 dsh 原生卡片。"
kind: "package-reference"
---

# dsh-foreign-harness

[English](README.md) | 中文

## 概述

`dsh-foreign-harness` 让外来编码智能体驱动 dsh 的回合：dsh 负责会话、界面和事件；Claude Code / Codex（经 AI SDK harness 适配器）负责思考和动手。工具调用被翻译成 `tool/call` + `tool/result` 事件，于是 web 里用的是 dsh 自己的工具卡。

集成方式是 **替换 step，而不是替换 loop**：插件子类化 stock 的 `@deepseek-ai/dsh-agent-loop`（无 vendored 副本），把每个 agent 的 `step()` 实例方法换成按 preset 路由——引擎 preset 跑 harness 回合，其余原样走未动过的 stock step。inbox、turn/step 编排、事件、preset 插件全是上游原装，逐 step 路由让换模式、冷恢复、任意切换顺序都天然正确。

## 目录

- [使用](#使用)
- [配置](#配置)
- [实现结构](#实现结构)
- [测试](#测试)
- [已知限制](#已知限制)

## 使用

引擎选择挂在模式（preset）选择器上：preset 的 id 记进会话日志，每个 step 再读回来。

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
| `stripAnthropicEnv` | `DSH_CC_STRIP_ANTHROPIC=1` | `false` | 给引擎剥离 `ANTHROPIC_*` 环境变量（默认继承宿主 env，和终端里跑 `claude` 一致） |

## 实现结构

- `src/index.js` —— `ForeignHarnessLoop`（stock `AgentLoop` 子类）：给每个创建/恢复的 agent 打上 step 引擎路由；引擎会话在 owner teardown 时经 `disposeEngineSession` 停掉
- `src/engine-step.js` —— 一个引擎回合：用户消息 → harness 回合 → 实时 `agent/assistant-stream` 帧 → durable `assistant/message`（带紧凑 stream）+ `tool/call` + `tool/result`；引擎会话的 resume state 以 `plugin:dsh-foreign-harness/state` 记录持久化，对话可跨进程接续
- `src/harness.js` —— 每个 dsh 会话一个 harness 会话（bridge 端口、`workDir: "."`、`detach`/`stop` resume state、dispose）
- `src/sandbox.js` —— 把本地目录实现成 `HarnessV1NetworkSandboxSession`（无隔离，接的就是 dsh 的 workspace）
- `src/stream-attempt.js` —— 实时 assistant 流的帧协议（start → chunk* → end，revision 单调），用 dsh-llm 的公开原语实现

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
- 后台子智能体不会回报，界面上也还没有子智能体树。
- 会话归档只与 Codex 双向同步；Claude Code 会话在引擎侧没有归档概念，归档状态就存在 dsh。同步是增量驱动——插件启动之前就存在的分歧不会被追溯抹平。
