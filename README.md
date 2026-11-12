---
description: "Run foreign coding agents (Claude Code, Codex) as the DeepSeek Harness agent loop, rendering their tool calls as native dsh cards."
kind: "package-reference"
---

# dsh-foreign-harness

English | [中文](README.zh.md)

## Summary

`dsh-foreign-harness` lets foreign coding agents drive dsh turns: dsh owns sessions, UI and events; Claude Code / Codex (through the AI SDK harness adapters) own thinking and tool use. Tool calls are translated into `tool/call` + `tool/result` events, so the web UI renders them with dsh's own tool cards.

The integration is a **step override, not a loop replacement**: the plugin subclasses the stock `@deepseek-ai/dsh-agent-loop` (no vendored copies) and swaps each agent's `step()` method for a per-step router — engine presets run a harness round, everything else falls through to the untouched stock step. Inbox, turn/step orchestration, events and preset plugins are all upstream's own code, and per-step routing makes mode switches and cold resumes route correctly; each engine keeps its own thread (see below).

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Understand the implementation](#understand-the-implementation)
- [Tests](#tests)
- [Known Limitations](#known-limitations)

## Use this package

Engine choice rides on the mode (preset) selector: the preset id is recorded in the session log and the step reads it back per step.

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
| `stripAnthropicEnv` | `DSH_CC_STRIP_ANTHROPIC=1` | `false` | strip `ANTHROPIC_*` variables from the engine's environment (default inherits the host env, same as running `claude` in a terminal) |

## Understand the implementation

- `src/index.js` — `ForeignHarnessLoop` (stock `AgentLoop` subclass): patches each created/resumed agent's `step()` with the engine router; engine sessions stop through `disposeEngineSession` at owner teardown
- `src/engine-step.js` — one engine round: user messages → harness round → live `agent/assistant-stream` frames → durable `assistant/message` (with compact stream) + `tool/call` + `tool/result`; engine sessions persist their resume state as `plugin:dsh-foreign-harness/state` records, so the conversation continues across processes. Engine-internal `start-step`/`finish-step` boundaries become top-level dsh `step/start`/`step/end` pairs; the stock loop's outer orchestration step is filtered out for engine turns, so released logs keep sequential steps and the UI step count matches the engine's real sub-steps
- `src/harness.js` — one harness session per dsh session (bridge port, `workDir: "."`, `detach`/`stop` resume states, dispose)
- `src/sandbox.js` — a local directory as `HarnessV1NetworkSandboxSession` (no isolation; wired to the dsh workspace)
- `src/stream-attempt.js` — the live assistant stream frame protocol (start → chunk* → end with monotonic revisions) implemented on dsh-llm's public primitives

Each engine keeps its own native thread. Switching engines starts the new engine with a text-only history fallback; switching back resumes that engine's thread without the turns handled by the other engine.

Contracts the client projection requires (violating any of them breaks rendering):

- `assistant/message` must carry an iterable `stream` frame array — built with dsh's own `AssistantStreamAccumulator`
- tool cards read name/arguments from `tool/call` events; `tool/result` points back via `sourceEventSeqs`
- `usage` must be plain JSON (AI SDK usage carries `undefined` fields)
- Claude's `Task` tool is wired as `Agent`; the UI only recognizes `subagent*`, so it is renamed on the way in

## Tests

`bun test` covers the sandbox adapter round-trips, archive sync planning, engine step event ordering (including released-log validation), and the stream attempt lifecycle. The engine paths are also exercised against a live profile:

```sh
DSH_CC_ENGINE=claude-code dsh --profile <p> --patch ./patch.yml "收到请回复收到"
```

## Known Limitations

- Image/file attachments are projected to dsh's deterministic handle text (`textOnlyImageText` / `fileHandleText`) — the engines never see the bytes.
- Background subagents don't report back; there is no child agent tree in the UI yet.
- Session archive syncs both ways with Codex only; Claude Code sessions have no engine-side archive at all, so their archive state simply lives in dsh. Sync is change-driven from plugin startup — divergences that predate it stay put.
