# @obversa/lines

`@obversa/lines` is a standalone TypeScript runtime. Obversa is one consumer;
any host can use the public package API. The package also defines a pure graph
contract for graph types outside this package.

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

## Define an outside graph type

Use `GraphType` with `compileGraph` to define a pure graph type. The graph type
validates a graph definition, reduces recorded events, returns graph commands,
and describes a plan. The contract gives it frozen data and graph lookups, not
file, model, process, clock, or storage services.

An outside graph type is trusted package code. It can import and use effects by
itself. The public conformance kit checks behavior. It does not stop effects.

The host resolves the description with `resolveGraphPlan`. The host admission
record must admit the package identity and every requested permission. The
resolved plan records known bounds or an explicit unknown bound. Its frozen
snapshot and digest identify the fixed package, permissions, lanes, policies,
and bounds for one run.

`validateGraphDescription(unknown)` validates a description without compiling
a graph. It returns a frozen valid description or throws `GraphValidationError`.
Each node must appear in one phase, and its `phaseId` must name that phase.
Description nodes preserve definition node declaration order. The compiler
supplies description edges in definition edge declaration order.

The public conformance kit checks the initial state and command, then every
event-prefix state and command. It uses separate compiled instances and
repeated calls. It also checks the declared bounds. The kit counts dispatches
across the supplied trace and the largest dispatch set in one decision. Known
dispatch and fan-out maximums cannot be below those observed values. It does
not infer runtime concurrency from a decision trace.
Each expected decision contains only new requests. The kit rejects a dispatch
position reused in a later expected decision. D5 applies the same rule to
durable dispatch events before execution.
When the final expected decision is exactly `complete`, the observed total must
meet a known dispatch minimum; partial, empty, paused, and failed endings do not
prove a minimum.

A graph decision contains zero or more dispatch commands, or exactly one
pause, complete, or fail command. Dispatches ask the executor to start new
work. An empty decision starts no work. D5 accepts it only while a recorded
attempt remains in flight; otherwise the executor fails instead of spinning.
Each `position` is the stable logical identity and location of one requested
node occurrence. Positions must be unique within one decision, so the same
node can appear more than once at different positions. After an occurrence is
recorded, the graph does not emit it again. A later event can make the same
node dispatchable as a new occurrence with its own position.

`run(job, { params })` accepts a JSON object. If `params` is `undefined`, it
uses a frozen empty object. `null`, arrays, and other invalid roots fail before
work or environment setup starts. A valid object is cloned and frozen. Every
child job receives the same frozen object as `ctx.params`. A later caller
change cannot change that object. JSON nested more than 256 levels fails with
`JsonValueError`.

Run the checked-in example from the workspace root:

```bash
pnpm example:graph
```

The example is `examples/packages/custom-graph.ts`. It uses only public exports
and runs the public graph conformance kit.

This graph contract does not schedule nodes, store runs, provide built-in
graph forms, or execute work on another machine.

## Documentation

The workspace `docs/public` directory contains the first-run guide, graph
guides, and the production-line bank.

Run the offline production line from the workspace root:

```bash
pnpm example:offline
```

## License

[MIT](LICENSE)
