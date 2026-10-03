---
"@obversa/api": patch
"@obversa/runtime": patch
"@obversa/engine-anthropic-api": patch
"@obversa/engine-claude-agent-sdk": patch
"@obversa/engine-claude-cli": patch
"@obversa/engine-codex-cli": patch
"@obversa/engine-devin-cli": patch
"@obversa/engine-grok-cli": patch
"@obversa/engine-jev-api": patch
"@obversa/engine-mastra": patch
"@obversa/engine-opencode-cli": patch
---

Every engine takes `effort`, the reasoning level a step runs at, under that one name: on the engine, on an `agentJob`, on a workflow agent stage, and on each request. An engine whose tool has a setting passes the level through it unchanged; an engine whose tool has none refuses the option with a clear error instead of ignoring it. The level a step asked for is recorded with its identity, so a record shows the effort each attempt ran at.
