# @obversa/engine-anthropic-api

`@obversa/engine-anthropic-api` runs Obversa engine requests through the
Anthropic Messages API.

## Requirements

- Node.js 22.12 or later
- An Anthropic API key

## Install

```bash
pnpm add @obversa/engine-anthropic-api
```

## Use

```ts
import { AnthropicApiEngine } from '@obversa/engine-anthropic-api';

const engine = new AnthropicApiEngine({
  defaultModel: 'claude-haiku-4-5-20251001',
  apiKey: process.env.ANTHROPIC_API_KEY,
});
```

Pass the engine instance to an Obversa runtime.

## Input limit and login errors

This engine declares no input limit, so the runtime treats it as having none.

A call the API refuses for its key is an `auth` failure, read from the API's error. The runtime then runs the same seat once more, then the seat's next candidate.

## License

[MIT](LICENSE)
