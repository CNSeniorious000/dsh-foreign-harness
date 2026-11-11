---
description: "Run foreign coding agents (Claude Code, Codex) as the DeepSeek Harness agent loop, rendering their tool calls as native dsh cards."
kind: "package-reference"
---

# dsh-foreign-harness

English | [中文](README.zh.md)

## Summary

`dsh-foreign-harness` replaces the stock `dsh-agent-loop` so that every dsh step is driven by a foreign coding agent instead of a raw model request: dsh owns sessions, UI and events; Claude Code / Codex (through the AI SDK harness adapters) own thinking and tool use. Tool calls are translated into `tool/call` + `tool/result` events, so the web UI renders them with dsh's own tool cards.

The stock loop is vendored (`vendor/agent-loop.js`, 0.2.2-rc.1) with exactly two touches: `setClaudeStep()` and an intercept at the top of `ReactLoopAgent.step()`. Any preset that is not one of ours returns `undefined` and runs the untouched stock logic.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Understand the implementation](#understand-the-implementation)
- [Tests](#tests)
- [Known Limitations](#known-limitations)

## Use this package

dsh has no per-session agent-loop selector — the loop is a single factory slot. Engine choice therefore rides on the mode (preset) selector: the preset id is recorded in the session log and the step reads it back.

```yaml
# in the profile's cordis.patch.yml
- id: agent-loop
  disabled: true
- insert:
    - id: foreign-harness
      name: dsh-foreign-harness

    # preset config.id is the engine name (see src/harness.js ENGINES).
    - id: preset-cc-claude
      name: '@deepseek-ai/dsh-agent-preset'
      config: { id: claude-code, name: Claude Code, order: 5, plugins: [] }
    - id: preset-cc-codex
      name: '@deepseek-ai/dsh-agent-preset'
      config: { id: codex, name: Codex, order: 6, plugins: [] }
```

A full example lives in `examples/web-engines.patch.yml`. Headless runs have no preset registry — pick the engine with `DSH_CC_ENGINE=claude-code|codex`; unset means stock.

```sh
dsh plugin --profile <p> add link:$PWD
dsh --profile <p> --patch ./patch.yml "看一下 note.txt"
```

After `bun install`, re-create `node_modules/@deepseek-ai` as a symlink to the `@deepseek-ai` directory of the dsh install that runs this plugin. The host packages must be the *same instances* the host loads (cordis `Service` identity), which a private copy cannot provide.

## Configuration

Settings are the plugin row's `config`, exposed in dsh's settings form as volatile fields (see `src/index.js`). Environment variables win when explicitly set, for headless and debugging.

| config | env | default | meaning |
| --- | --- | --- | --- |
| `codexModel` | `DSH_CC_CODEX_MODEL` | `~/.codex/config.toml` `model` | model for the Codex engine (the adapter default `gpt-5.5` is rejected by ChatGPT accounts) |
| `keepSessions` | `DSH_CC_SESSION_KEEP=1` | `false` | keep the harness session across steps (web); headless disposes after every round so the process can exit |
| `stripAnthropicEnv` | `DSH_CC_STRIP_ANTHROPIC=1` | `false` | strip `ANTHROPIC_*` variables from the engine's environment (default inherits the host env, same as running `claude` in a terminal) |

## Understand the implementation

- `src/index.js` — exports `ForeignHarnessLoop` (stock `AgentLoop` subclass) and registers the step intercept
- `src/claude-step.js` — one step: read the preset → build the prompt from user words only → run a harness round → settle `assistant/message` (with replay frames) + `tool/call` + `tool/result`
- `src/harness.js` — one harness session per dsh session (bridge port, `workDir: "."`, reuse across steps, dispose)
- `src/sandbox.js` — a local directory as `HarnessV1NetworkSandboxSession` (no isolation; wired to the dsh workspace)

Contracts the client projection requires (violating any of them breaks rendering):

- `assistant/message` must carry an iterable `stream` frame array — built with dsh's own `AssistantStreamAccumulator`
- tool cards read name/arguments from `tool/call` events; `tool/result` points back via `sourceEventSeqs`
- `usage` must be plain JSON (AI SDK usage carries `undefined` fields)
- Claude's `Task` tool is wired as `Agent`; the UI only recognizes `subagent*`, so it is renamed on the way in

## Tests

`bun test` runs `test/sandbox.test.js` (file/process round-trips of the sandbox adapter). The engine paths are exercised against a live profile:

```sh
DSH_CC_ENGINE=claude-code dsh --profile <p> --patch ./patch.yml "收到请回复收到"
```

## Known Limitations

- Image/file attachments are projected to dsh's deterministic handle text (`textOnlyImageText` / `fileHandleText`) — the engines never see the bytes.
- Multi-turn history is flattened into one user message per step (only `source.kind === "user"` content).
- Background subagents don't report back; there is no child agent tree in the UI yet.
