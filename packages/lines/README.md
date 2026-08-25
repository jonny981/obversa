# @obversa/lines

`@obversa/lines` is a standalone TypeScript graph runtime. Obversa is one
consumer; any host can use the public package API. A job, a loop graph, and a
directed acyclic graph use the same `Job` contract.

## Requirements

- Node.js 22.12 or later

## Build from the workspace

From the workspace root, run:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @obversa/lines build
```

## Usage

```ts
import { agentJob, run } from '@obversa/lines';
import { MockEngine } from '@obversa/lines/testing';

const engine = new MockEngine(() => 'ready');

const result = await run(
  agentJob({
    label: 'prepare-item',
    engine: 'offline',
    prompt: 'Prepare the item.',
  }),
  {
    engine: 'offline',
    engines: { offline: engine },
  },
);

console.log(result.outcome.status);
```

Expected output:

```text
pass
```

This package exposes the programmatic API. It does not expose a command.

## Memory

Pass a `Memory` instance in the run options when a job uses memory:

```ts
await run(job, { memory });
```

Lines imports the `@obversa/memory` port. Your program selects the storage
adapter.

With the Agent SDK engine, passing memory makes its one in-process memory tool
available and automatically approved. Other tool settings do not change.

## Documentation

The workspace `docs/public` directory contains the first-run guide and the
production-line bank.

Run the offline production line from the workspace root:

```bash
pnpm example:offline
```

## License

[MIT](LICENSE)
