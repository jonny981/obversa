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

Without a model, Devin runs its own default model, or the one your Devin settings choose with `clean: false`.

Devin runs clean by default: with your own environment and Devin login,
but with an empty config file in place of your Devin settings. Set
`clean: false` to run with your Devin settings too. A
read-only step runs with `--permission-mode auto`, and a step that may write
runs with `--permission-mode accept-edits`. A write step under
`accept-edits` cannot run commands, so a builder that runs its tests needs
`devin('swe-2-max', { permissionMode: 'dangerous' })`. A read step refuses
any mode but `auto`. Devin has no mode without a
folder and no flag for a list of named tools. The plugin passes
`--respect-workspace-trust false`, because print mode cannot show Devin's
folder trust prompt.

See [Devin CLI Engine](https://obversa.ai/docs/packages/engine-devin-cli).
