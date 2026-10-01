# @obversa/engine-mastra

## 0.1.0

### Minor Changes

- `mastra(agent)` puts a Mastra agent you already built into a team workflow as one engine. Each attempt is one call to the agent's own `generate`; the agent keeps its tools, memory and workflows, and the engine returns its final text, the usage Mastra reports, and the provider and model the agent is built with.
