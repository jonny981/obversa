# @obversa/memory-simple

`@obversa/memory-simple` stores memory in one process. Use it for tests, short
runs, and examples without durable storage.


## Install

```bash
pnpm add @obversa/memory-simple
```
## Requirements

- Node.js 22.12 or later

## Build from the workspace

From the workspace root, run:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @obversa/memory-simple build
```

## Usage

```ts
import { createSimpleMemory } from '@obversa/memory-simple';

const memory = createSimpleMemory({ scope: 'example-run' });

await memory.execute({
  command: 'create',
  path: '/memories/notes.md',
  text: 'Keep the result small.\n',
});

const result = await memory.execute({
  command: 'view',
  path: '/memories/notes.md',
});
```

The default storage limit is 1,048,576 bytes per scope and 256 files. The
adapter discards its data when its process exits.

## Runnable example

From the workspace root, run:

```bash
pnpm --filter @obversa/memory-simple exec tsx ../../examples/memory-simple.ts
```

## License

[MIT](LICENSE)
