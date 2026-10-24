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

## Input limit and login errors

This engine declares an input limit of 1,048,576 characters, the most the Codex CLI accepts in one input. A review step sizes the change it reads to fit, and a step whose input is still larger pauses before the call.

An attempt ends when the `codex` process exits. A failed call whose error names a login problem is an `auth` failure. The runtime then runs the same seat once more, then the seat's next candidate.
