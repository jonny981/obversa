# @obversa/engine-codex-cli

`@obversa/engine-codex-cli` runs Obversa engine requests through a fresh Codex CLI
process.

## Requirements

- Node.js 22.12 or later
- A Codex CLI installation with host authentication

## Install

```bash
pnpm add @obversa/engine-codex-cli
```

## Use

```ts
import { CodexEngine } from '@obversa/engine-codex-cli';

const engine = new CodexEngine({ defaultModel: 'gpt-5.4' });
```

The engine uses a read-only sandbox unless `permissionMode` is
`bypassPermissions`.
