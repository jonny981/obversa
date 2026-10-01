# @obversa/engine-mastra

`@obversa/engine-mastra` puts an agent you built with Mastra into an Obversa
team as one engine. Build the agent in Mastra. Put it on a team with Obversa.

## Requirements

- Node.js 22.13 or later, which `@mastra/core` needs
- `@mastra/core` 1.74 or a later 1.x release, installed beside this package

## Install

```bash
pnpm add @obversa/engine-mastra @mastra/core
```

## Use

```ts
import { Agent } from '@mastra/core/agent';
import { mastra } from '@obversa/engine-mastra';

const agent = new Agent({
  id: 'writer',
  name: 'Writer',
  instructions: 'You write short, plain pages.',
  model: 'anthropic/claude-sonnet-4-5',
});

const writer = mastra(agent);
```

Give `writer` a role in a `workflow()`, as you would a `claude()` seat.

## What crosses the boundary

Each attempt is one call to the agent's own `generate`. The engine sends:

- the request's prompt
- the request's system text, when there is some, as Mastra's `system`
  option, or as its `instructions` option when the request replaces the
  system prompt
- an abort signal that follows the run's signal and the request's timeout

The engine returns the agent's final text as the result, the usage Mastra
reports, or `unknown` when Mastra reports none, and the identity of the seat.

## What stays Mastra's

The agent's tools, memory and any Mastra workflow inside it stay Mastra's.
The engine does not turn Mastra tools into Obversa tools, and it passes no
working directory to the agent.

So a step's declared Obversa tools and read-only mode do not limit a Mastra
agent. It uses the tools it was built with, wherever those tools act. The
review, send-back, pause, resume and record around it work as for any engine.

A Mastra seat declares no Obversa tools, so the runtime does not accept it
as a reviewer: a reviewer must declare a tool that reads the workspace.

## Identity

- adapter: `mastra`
- provider and model: read from the model the agent is built with. A
  `provider/model` string, a language model object, an OpenAI-compatible
  config and a fallback list are read; a fallback list gives its first
  enabled entry.
- model family: the model name after its last `/`, up to its first hyphen,
  read by the shared `modelIdentity` helper. `claude-sonnet-4-5` is the
  family `claude`.

When the agent chooses its model with a function, name the model yourself:
`mastra(agent, { model: 'openai/gpt-5' })`.

## Errors

A thrown Mastra or provider error becomes an engine failure. A 429 status is
a rate limit, and a `retry-after` header is kept. Other errors go through the
shared classification, so a quota, authentication or billing message is
typed as one.

## License

[MIT](LICENSE)
