# @obversa/engine-mastra

## 0.1.1

### Patch Changes

- 909029f: Every engine takes `effort`, the reasoning level a step runs at, under that one name: on the engine, on an `agentJob`, on a workflow agent stage, and on each request. An engine whose tool has a setting passes the level through it unchanged; an engine whose tool has none refuses the option with a clear error instead of ignoring it. The level a step asked for is recorded with its identity, so a record shows the effort each attempt ran at.
- Updated dependencies [909029f]
  - @obversa/api@0.2.5
  - @obversa/core@0.2.5

## 0.1.0

### Minor Changes

- `mastra(agent)` puts a Mastra agent you already built into a team workflow as one engine. Each attempt is one call to the agent's own `generate`; the agent keeps its tools, memory and workflows, and the engine returns its final text, the usage Mastra reports, and the provider and model the agent is built with.
