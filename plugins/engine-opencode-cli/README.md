# @obversa/engine-opencode-cli

`@obversa/engine-opencode-cli` runs one isolated Obversa engine attempt through
a fresh OpenCode CLI process.

## Requirements

- Node.js 22.12 or later
- OpenCode CLI 1.18.23
- Host-selected authentication

## Install

```bash
pnpm add @obversa/engine-opencode-cli
```

## Use

```ts
import { OpenCodeCliEngine } from '@obversa/engine-opencode-cli';

const engine = new OpenCodeCliEngine({
  executable: '/absolute/path/to/opencode',
  version: '1.18.23',
  identity: { provider: 'anthropic', modelFamily: 'claude' },
});
```
