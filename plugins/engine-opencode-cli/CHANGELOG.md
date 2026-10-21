# @obversa/engine-opencode-cli

## 0.1.8

### Patch Changes

- 7c0a425: Accept OpenRouter model names through the OpenCode engine, such as `openrouter/anthropic/claude-sonnet-4.5`. Record `openrouter` as the provider and derive the family from the final model name, so a Claude model remains in the Claude family across providers. Refuse OpenRouter routers such as `openrouter/openrouter/auto`, which cannot declare a fixed family.
- 1d951ce: A limit the provider reports through its own response fields — a `retry-after` or rate-limit-reset header — now marks the reset it carries as proven. A run's availability store only remembers a billing or quota failure whose reset is proven: one a header or structured field stated, never one parsed out of error text.
- cd3afb5: The OpenCode engine's workspace check no longer fails a run when a folder or symlink disappears while it is being checked, such as a lock folder or a build's temporary output. A symlink that still exists but resolves nowhere is still refused.
- fd3a11d: A CLI that the system refuses to start under load is no longer reported as a missing CLI. When starting the process fails with `EAGAIN`, `EMFILE` or `ENOMEM`, the Claude, Codex, Devin, Grok and OpenCode engines fail with a `transient` error, which can be tried again, and the message names the code, for example `the system refused to start the Claude process (EAGAIN)`. A missing executable still fails as `missing-cli`. `OwnedCommandError` and `RunChildError` carry the system error code of a process that could not start as `spawnCode`.
- Updated dependencies [eee9606]
- Updated dependencies [56a7020]
- Updated dependencies [a6f95ac]
- Updated dependencies [7c0a425]
- Updated dependencies [f1b183a]
- Updated dependencies [1d951ce]
- Updated dependencies [fd3a11d]
- Updated dependencies [9027c75]
  - @obversa/core@0.3.0
  - @obversa/api@0.3.0

## 0.1.7

### Patch Changes

- 229276b: A run's record now holds what you need to tell whether a workflow got better or worse between two runs. Each engine call records what it cost in US dollars: the engine's own figure, an estimate from a price table the runtime ships (which you can override with the `prices` run option, with no new release), or unknown. Each call also records whether it ran on the person's own plan or on an API key, and the result an engine returns to a job carries the same figure. `run:end` (across every session of a resumed record), each `dag:node` done line and each review round carry their total tokens and dollars, and name the models with no figure. A call that failed is counted too, each engine a `fallbackEngine` chain tried included, and marked `failed`, an API engine's failed call names the model it called and `api` billing, and the Claude CLI, Codex, Grok, OpenCode, Mastra and OpenAI Agents engines keep the tokens a failed call had reported; the token budget counts the tokens a failed call reported and leaves out a failed call with no tokens, so a refused call does not stop a fallback route. The calls of a merge an agent resolves count too. The `source` run option records the workflow file's path and SHA-256 on `run:start`. A SIGINT or SIGTERM writes `run:abort` before the process stops, and a `heartbeat` line every minute shows roughly when a killed run died. Each job and node records how long it took, and a `commandJob` outcome records the command, its arguments, its exit code and its duration. Every line carries the number of the session that wrote it. In a git workspace, each refine round and each node run a kickback causes records the files and lines it changed (in the node's own worktree when it has one, pass or fail), and the ids of the findings it was sent back to answer.
- Updated dependencies [229276b]
  - @obversa/api@0.2.12
  - @obversa/core@0.2.12

## 0.1.6

### Patch Changes

- b534c6d: OpenCode's free models, such as `opencode/big-pickle`, run a step. The plugin sets each tool a step doesn't declare to `ask` instead of turning it off, and `opencode run` turns down every `ask`, so the tool still never runs. A step's declared tools also work on every model: OpenCode applied the plugin's catch-all rule after the step's own rules, which blocked even a declared `read`. A call to an undeclared tool that OpenCode turned down does not fail the step; the model is told and carries on.

## 0.1.5

### Patch Changes

- 909029f: Every engine takes `effort`, the reasoning level a step runs at, under that one name: on the engine, on an `agentJob`, on a workflow agent stage, and on each request. An engine whose tool has a setting passes the level through it unchanged; an engine whose tool has none refuses the option with a clear error instead of ignoring it. The level a step asked for is recorded with its identity, so a record shows the effort each attempt ran at.
- Updated dependencies [909029f]
  - @obversa/api@0.2.5
  - @obversa/core@0.2.5

## 0.1.4

### Patch Changes

- 14f9f24: Engines run clean by default: your login and the repository's own setup stay in, and your own user-level settings, hooks, plugins, skills and MCP servers stay out, so a workflow behaves the same for everyone who runs it. Set `clean: false` to run the tool exactly as you run it. Grok has no clean mode and always runs on your setup; `clean: true` there throws with the reason. The engine conformance kit lets an engine declare clean mode unsupported, and a reduced declaration passes.
- Updated dependencies [14f9f24]
  - @obversa/api@0.2.4
  - @obversa/core@0.2.4

## 0.1.3

### Patch Changes

- 768c936: Every engine now runs its CLI the way you run it: with your own login and settings, and the repository's `AGENTS.md` and `CLAUDE.md` read as the CLI normally reads them. A step still adds only what it needs through the CLI's own flags: the tools it may use and read-only mode where it only reads. The Grok and OpenCode engines no longer refuse a repository that holds instruction files, and use your normal Grok and OpenCode login; Grok works with the current Grok CLI. Read-only Claude steps load your settings like any other Claude Code run. `opencode()` accepts `auth` as an explicit override.
  - @obversa/api@0.2.3
  - @obversa/core@0.2.3

## 0.1.2

### Patch Changes

- Require the compatible core release in the published package dependencies.
- Updated dependencies
  - @obversa/api@0.2.1
  - @obversa/core@0.2.1

## 0.1.1

### Patch Changes

- Tool events name their target: the file for a read or an edit, the first two words of a command, the URL of a fetch, the pattern of a search. The built-in teams use the runtime's `refine` field.
- Updated dependencies
  - @obversa/api@0.2.0
  - @obversa/core@0.2.0
