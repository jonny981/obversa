# @obversa/engine-openai-agents

## 0.1.0

### Minor Changes

- `openaiAgent(agent)` puts an agent you already built with the OpenAI Agents SDK into a team workflow as one engine. Each attempt is one call to the SDK's runner for the agent; the agent keeps its tools, handoffs and guardrails, the engine passes no session, and the engine returns its final output as text, the usage the SDK reports, and the provider and model the agent is built with.
