# @obversa/engine-openai-agents

`@obversa/engine-openai-agents` puts an agent you built with the OpenAI
Agents SDK into an Obversa team as one engine. Build the agent with the
OpenAI Agents SDK. Put it on a team with Obversa.

## Requirements

- Node.js 22.12 or later
- `@openai/agents` 0.18, installed beside this package, with `zod` 4, which
  the SDK needs beside it

## Install

```bash
pnpm add @obversa/engine-openai-agents @openai/agents zod
```

## Use

```ts
import { Agent } from '@openai/agents';
import { openaiAgent } from '@obversa/engine-openai-agents';

const agent = new Agent({
  name: 'Writer',
  instructions: 'You write short, plain pages.',
  model: 'gpt-5',
});

const writer = openaiAgent(agent);
```

Give `writer` a role in a `workflow()`, as you would a `claude()` seat.

## What crosses the boundary

Each attempt is one call to the SDK's runner for the agent. The engine sends:

- the request's prompt
- the request's system text, when there is some, as one system message
  before the prompt, or as the instructions of a copy of the agent when the
  request replaces the system prompt
- an abort signal that follows the run's signal and the request's timeout

The engine returns the agent's final output as the result, the usage the
SDK reports, or `unknown` when the SDK counted no model request, and the
identity of the seat. A final output that is not text is returned as JSON.

By default the engine calls the SDK's own `run`. To run the agent with a
`Runner` you configured, pass it: `openaiAgent(agent, { runner })`.

## What stays the SDK's

The agent's tools, handoffs and guardrails stay the SDK's. The engine does
not turn the agent's tools into Obversa tools, and it passes no working
directory to the agent.

The engine passes no session. The SDK takes a session as an option of each
run, not as part of the agent, so each attempt starts without session
history. To give the agent a session, pass a runner that adds it to the
options the engine gives:
`openaiAgent(agent, { runner: { run: (a, input, options) => run(a, input, { ...options, session }) } })`,
with `run` from `@openai/agents`.

So a step's declared Obversa tools and read-only mode do not limit the
agent. It uses the tools it was built with, wherever those tools act. An
agent that hands off to another agent is still one engine attempt. The
review, send-back, pause, resume and record around it work as for any
engine.

An OpenAI agent seat declares no Obversa tools, so the runtime does not
accept it as a reviewer: a reviewer must declare a tool that reads the
workspace.

## Identity

- adapter: `openai-agents`
- provider and model: read from the model name the agent is built with. The
  SDK sends a model name to its default model provider, OpenAI, so the
  provider is `openai`. An agent with no model has the SDK's default model.
- model family: the model name up to its first hyphen, read by the shared
  `modelIdentity` helper. `gpt-5` is the family `gpt`.

When the agent holds a model object, the SDK does not expose the model's
name, and `openaiAgent()` throws. Name the model yourself:
`openaiAgent(agent, { model: 'openai/gpt-5' })`. Do the same when the model
is set somewhere else, such as on a `Runner`.

## Errors

A thrown SDK or provider error becomes an engine failure. A 429 status is a
rate limit, and a `retry-after` header is kept. A 429 with the error code
`insufficient_quota` is a quota. Other errors go through the shared
classification, so an authentication or billing message is typed as one.

A run that stops to wait for a tool approval fails as `invalid-config`: the
engine cannot give the approval.

## License

[MIT](LICENSE)
