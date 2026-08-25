# @obversa/memory

`@obversa/memory` defines a storage-neutral memory contract. The package also
supplies a conformance kit for memory adapters.

## Requirements

- Node.js 22.12 or later

## Build from the workspace

From the workspace root, run:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @obversa/memory build
```

## Contract

A memory adapter has one scope and one method:

```ts
import type { Memory } from '@obversa/memory';

declare const memory: Memory;

const result = await memory.execute({
  command: 'view',
  path: '/memories/notes.md',
});
```

The command set is `view`, `create`, `str_replace`, `insert`, `delete`, and
`rename`. Every result is a typed success or a typed failure.

## Adapter conformance

Import the public conformance kit from `@obversa/memory/testing`. The kit has
no dependency on a unit-test framework. Its factory can return a memory
adapter or a promise that opens one.

## Memory mechanics

The package exports three mechanics:

- `ground` reads declared sources into one bounded prompt.
- `curate` calls one supplied function to select grounded sources.
- `consolidate` calls one supplied function and writes one validated result.

Each prompt marks memory as untrusted data. The mechanics do not select an
engine or a storage adapter.

Only one caller can consolidate a target at a time. The mechanic does not lock
a target across processes.

## Runnable example

From the workspace root, run:

```bash
pnpm --filter @obversa/memory exec tsx ../../examples/packages/memory.ts
```

## License

[MIT](LICENSE)
