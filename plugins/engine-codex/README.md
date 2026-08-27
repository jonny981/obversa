# @obversa/engine-codex

`@obversa/engine-codex` runs Obversa engine requests through a fresh Codex CLI
process.

## Requirements

- Node.js 22.12 or later
- A Codex CLI installation with host authentication

## Use

```ts
import { CodexEngine } from '@obversa/engine-codex';

const engine = new CodexEngine({ defaultModel: 'gpt-5.4' });
```

The engine uses a read-only sandbox unless `permissionMode` is
`bypassPermissions`.
