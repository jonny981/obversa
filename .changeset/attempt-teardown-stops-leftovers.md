---
"@obversa/api": patch
"@obversa/core": patch
"@obversa/runtime": patch
"@obversa/runner": patch
"@obversa/engine-claude-cli": patch
"@obversa/engine-codex-cli": patch
"@obversa/engine-devin-cli": patch
"@obversa/engine-grok-cli": patch
"@obversa/engine-opencode-cli": patch
---

A run record now shows what an engine attempt's command teardown stopped.

`runOwnedCommand` records every process its teardown sent a signal to as `stoppedProcesses`, on `OwnedCommandResult` after a normal exit, a timeout or an abort, and on `OwnedCommandError` after an output limit, a memory limit, an inspection failure or an incomplete teardown. A process that exits on the first signal is still listed, and a signalled process still running appears on `stoppedProcesses` and `remainingProcesses` both. A process first found while teardown is already running gets the graceful signal before the forced one. On Windows each owned target gets `taskkill` by its own process id, graceful before `/F`; on macOS each teardown pass also re-finds a helper still holding the command's output pipes.

On a `MEMORY_LIMIT` stop the error's `countedProcesses` lists every process the last measure counted: its pid, its parent's pid, its command line scrubbed and cut to 200 characters, its resident bytes, and whether it counted as the root, a descendant, a group member or an earlier-observed process. `OwnedCommandError` gains `stoppedProcesses` and `countedProcesses` as optional fields after `spawnCode`.

Each engine plugin carries the stopped list onto its `AgentResult` and the `EngineError` it throws through the new optional `stoppedProcesses` field on both; the runner's `engine-completed` and `engine-failed` records keep it, and the run's terminal record keeps it when the worker command fails.
