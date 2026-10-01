# @obversa/engine-opencode-cli

`@obversa/engine-opencode-cli` runs one Obversa engine attempt through a
fresh OpenCode CLI process.

The plugin runs OpenCode the way you run it: with your own home folder,
your OpenCode config folder, your OpenCode login and your OpenCode
settings, the same as every other Obversa engine. It adds only what the
step needs, through OpenCode's own config: the tools and permission rules
the step declares, with every other tool turned off, no autoupdate and no
sharing.

## Requirements

- Node.js 22.12 or later
- OpenCode CLI 1.18.23, the version the plugin is tested with
- OpenCode signed in to your model's provider, or login data passed as `auth`
- A model on a paid login: OpenCode's free models refuse any run that turns
  a tool off, and the plugin turns off every tool a step doesn't declare

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
