# @obversa/engine-claude-cli

`@obversa/engine-claude-cli` runs Obversa engine requests through a fresh
Claude CLI process.

The plugin runs Claude Code the way you run it: with your own login, your
own settings and the repository's instruction files, the same as every
other Obversa engine. It adds only what the step needs, through Claude
Code's own flags: the tools the step may use, and no MCP servers for a step
that only reads or has no workspace.

## Requirements

- Node.js 22.12 or later
- Claude Code, signed in. The plugin accepts any version the CLI reports.
  It was run by hand against Claude Code 2.1.286. Its unit tests use a
  stand-in CLI.

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
