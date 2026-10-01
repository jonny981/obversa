# @obversa/engine-devin-cli

`@obversa/engine-devin-cli` runs Obversa engine requests through a fresh Devin
CLI process.

## Requirements

- Node.js 22.12 or later
- The Devin CLI, installed and signed in with your own account

## Install

```bash
pnpm add @obversa/engine-devin-cli
```

## Use

```ts
import { devin } from '@obversa/engine-devin-cli';

const seat = devin('swe-2-max');
```

Without a model, `devin()` runs the default model from your Devin settings.

Devin runs with your own environment, Devin login and Devin settings. A
read-only step runs with `--permission-mode auto`, and a step that may write
runs with `--permission-mode accept-edits`. Devin has no mode without a
folder and no flag for a list of named tools. The plugin passes
`--respect-workspace-trust false`, because print mode cannot show Devin's
folder trust prompt.

See [Devin CLI Engine](https://docs.obversa.ai/packages/engine-devin-cli).
