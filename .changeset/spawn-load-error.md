---
"@obversa/core": patch
"@obversa/engine-claude-cli": patch
"@obversa/engine-codex-cli": patch
"@obversa/engine-devin-cli": patch
"@obversa/engine-grok-cli": patch
"@obversa/engine-opencode-cli": patch
---

A CLI that the system refuses to start under load is no longer reported as a missing CLI. When starting the process fails with `EAGAIN`, `EMFILE` or `ENOMEM`, the Claude, Codex, Devin, Grok and OpenCode engines fail with a `transient` error, which can be tried again, and the message names the code, for example `the system refused to start the Claude process (EAGAIN)`. A missing executable still fails as `missing-cli`. `OwnedCommandError` and `RunChildError` carry the system error code of a process that could not start as `spawnCode`.
