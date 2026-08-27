# @obversa/engine-anthropic-api

`@obversa/engine-anthropic-api` runs Obversa engine requests through the
Anthropic Messages API.

## Requirements

- Node.js 22.12 or later
- An Anthropic API key

## Use

```ts
import { AnthropicApiEngine } from '@obversa/engine-anthropic-api';

const engine = new AnthropicApiEngine({
  defaultModel: 'claude-haiku-4-5-20251001',
  apiKey: process.env.ANTHROPIC_API_KEY,
});
```

Pass the engine instance to an Obversa runtime.

## License

[MIT](LICENSE)
