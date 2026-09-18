# @obversa/api

`@obversa/api` defines the shared contracts and validation used by Obversa
runtimes and plugins. It includes the engine, memory, and workspace ports
and their conformance kits. The runtime still runs graphs and writes records.

## Requirements

- Node.js 22.12 or later

## Build from the workspace

From the workspace root, run:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @obversa/api build
```

## Contract

An engine runs one fresh agent attempt:

```ts
import type { Engine } from '@obversa/api';

declare const engine: Engine;

const result = await engine.run(
  { prompt: 'Review this change.' },
  () => {},
  new AbortController().signal,
);
```

## Adapter conformance

Import the framework-free conformance runner from `@obversa/api/testing`
and the offline mock from `@obversa/core/testing`.

## Command adapters

Import owned-process execution and inspection from `@obversa/core/command`.
The command runner bounds time, retained output, and process-tree memory.

## License

[MIT](LICENSE)
