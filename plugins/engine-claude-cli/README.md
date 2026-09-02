# @obversa/engine-claude-cli

`@obversa/engine-claude-cli` runs Obversa engine requests through a fresh
Claude CLI process.

## Requirements

- Node.js 22.12 or later
- A Claude CLI installation with host authentication

## Install

```bash
pnpm add @obversa/engine-claude-cli
```

## Use

```ts
import { ClaudeCliEngine } from '@obversa/engine-claude-cli';

const engine = new ClaudeCliEngine({
  defaultModel: 'claude-sonnet-4-5',
});
```

Pass the engine instance to an Obversa runtime.

## License

[MIT](LICENSE)
