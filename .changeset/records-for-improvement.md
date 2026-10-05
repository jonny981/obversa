---
"@obversa/api": patch
"@obversa/core": patch
"@obversa/runtime": patch
"@obversa/engine-anthropic-api": patch
"@obversa/engine-claude-agent-sdk": patch
"@obversa/engine-claude-cli": patch
"@obversa/engine-codex-cli": patch
"@obversa/engine-grok-cli": patch
"@obversa/engine-jev-api": patch
"@obversa/engine-mastra": patch
"@obversa/engine-openai-agents": patch
"@obversa/engine-opencode-cli": patch
---

A run's record now holds what you need to tell whether a workflow got better or worse between two runs. Each engine call records what it cost in US dollars: the engine's own figure, an estimate from a price table the runtime ships (which you can override with the `prices` run option, with no new release), or unknown. Each call also records whether it ran on the person's own plan or on an API key, and the result an engine returns to a job carries the same figure. `run:end` (across every session of a resumed record), each `dag:node` done line and each review round carry their total tokens and dollars, and name the models with no figure. A call that failed is counted too, each engine a `fallbackEngine` chain tried included, and marked `failed`, an API engine's failed call names the model it called and `api` billing, and the Claude CLI, Codex, Grok, OpenCode, Mastra and OpenAI Agents engines keep the tokens a failed call had reported; the token budget counts the tokens a failed call reported and leaves out a failed call with no tokens, so a refused call does not stop a fallback route. The calls of a merge an agent resolves count too. The `source` run option records the workflow file's path and SHA-256 on `run:start`. A SIGINT or SIGTERM writes `run:abort` before the process stops, and a `heartbeat` line every minute shows roughly when a killed run died. Each job and node records how long it took, and a `commandJob` outcome records the command, its arguments, its exit code and its duration. Every line carries the number of the session that wrote it. In a git workspace, each refine round and each node run a kickback causes records the files and lines it changed (in the node's own worktree when it has one, pass or fail), and the ids of the findings it was sent back to answer.
