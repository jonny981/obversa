# @obversa/engine-grok-cli

`@obversa/engine-grok-cli` runs one Obversa engine attempt through a fresh
Grok CLI process.

The plugin runs Grok the way you run it: with your own home folder, your
Grok login and your Grok settings. Grok has no clean mode, so it doesn't
run clean by default the way the other command-line engines do. Grok loads the repository's instruction files under its own rules, such as
whether you trust the project. The plugin adds only what the step needs,
through Grok's own flags: the tools and permission rules the step declares,
read-only enforcement where the step only reads, subagents only when the
step asks for them, and structured output.

## Requirements

- Node.js 22.12 or later
- Grok CLI 1.0.44, the version the plugin is tested with
- Grok signed in with `grok login`, or a login file passed as `authFile`

## Install

```bash
pnpm add @obversa/engine-grok-cli
```

## Use

```ts
import { grok } from '@obversa/engine-grok-cli';

const seat = grok('grok-4', { executable: '/absolute/path/to/grok' });
```

`grok(model, options)` is the seat a workflow role takes. It reads with
`read_file`, `grep` and `list_dir` unless you pass `tools`, and takes
`version` and `effort` too. The engine on its own:

```ts
import { GrokCliEngine } from '@obversa/engine-grok-cli';

const engine = new GrokCliEngine({
  executable: '/absolute/path/to/grok',
  version: '1.0.44',
  identity: { provider: 'xai', modelFamily: 'grok-4' },
  permissionMode: 'dontAsk',
});
```
