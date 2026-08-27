# @obversa/engine

`@obversa/engine` defines the provider-neutral engine contract used by Obversa
runtimes and engine plugins. It also supplies a conformance kit and safe tools
for command-backed adapters.

## Requirements

- Node.js 22.12 or later

## Build from the workspace

From the workspace root, run:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @obversa/engine build
```

## Contract

An engine runs one fresh agent attempt:

```ts
import type { Engine } from '@obversa/engine';

declare const engine: Engine;

const result = await engine.run(
  { prompt: 'Review this change.' },
  () => {},
  new AbortController().signal,
);
```

## Adapter conformance

Import the framework-free conformance runner and offline mock from
`@obversa/engine/testing`.

## Command adapters

Import owned-process execution and inspection from `@obversa/engine/command`.
The command runner bounds time, retained output, and process-tree memory before
it returns.

## License

[MIT](LICENSE)
