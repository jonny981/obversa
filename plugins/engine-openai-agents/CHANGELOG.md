# @obversa/engine-openai-agents

## 0.1.1

### Patch Changes

- 909029f: Every engine takes `effort`, the reasoning level a step runs at, under that one name: on the engine, on an `agentJob`, on a workflow agent stage, and on each request. An engine whose tool has a setting passes the level through it unchanged; an engine whose tool has none refuses the option with a clear error instead of ignoring it. The level a step asked for is recorded with its identity, so a record shows the effort each attempt ran at.
- Updated dependencies [909029f]
  - @obversa/api@0.2.5
  - @obversa/core@0.2.5

## 0.1.0

### Minor Changes

- `openaiAgent(agent)` puts an agent you already built with the OpenAI Agents SDK into a team workflow as one engine. Each attempt is one call to the SDK's runner for the agent; the agent keeps its tools, handoffs and guardrails, the engine passes no session, and the engine returns its final output as text, the usage the SDK reports, and the provider and model the agent is built with.
