<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/public/logo-dark.svg">
    <img src="docs/public/logo-light.svg" alt="Obversa" width="280">
  </picture>
</p>

<p align="center">
  <strong>Model how your team really works.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="license: MIT">
  <img src="https://img.shields.io/badge/node-%3E%3D22.12-3c873a" alt="node >=22.12">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6" alt="TypeScript strict">
</p>

Agent frameworks give you one clever session. When it dies, it starts over.
Workflow engines give you durable steps and a server to run them on. Neither
gives you a team: named roles, a review that returns work to whoever owns it, a
vote when one opinion is not enough, and a person to answer to.

That is the layer Obversa owns. You describe the work the way you would describe
it to people, and the runtime runs it one bounded engine call at a time.

Every step appends events to a file on disk, with its artifacts beside them.
That record is the whole story: no server, no database. Kill a recorded run and
start it again and it reads its own events, then picks up at the step that was
running.

```bash
npm install @obversa/runtime   # Node >= 22.12
```

## A feature, as one file

Five named stages. The review is a panel of three, and a reviewer that fails a
step names the stage that must fix it, so the work goes back to the stage that
owns it rather than starting the run again.

```ts
import { pipeline, reviewPanel, kickback, createCallbackGate } from '@obversa/runtime';

const review = reviewPanel({
  label: 'review',
  reviewers: [
    { name: 'correctness', job: checks.correctness },
    { name: 'safety', job: checks.safety },
    { name: 'scope', job: checks.scope },
  ],
  pass: 2, // two of three agree and the step passes
});

export const featureDelivery = pipeline(
  'feature-delivery',
  [
    { name: 'analyse', job: analyse },
    { name: 'implement', job: implement },
    { name: 'test', job: testStage },
    { name: 'review', job: review },
    { name: 'approve', job: approve }, // createCallbackGate: a person answers
  ],
  { maxKickbacks: 2 },
);
```

A reviewer sends work back with one call, naming the stage and the reason:

```ts
kickback('implement', 'The export is missing its header row.');
```

Run the whole thing, offline and without a model:

```bash
pnpm example:feature
```

## Engines

An engine binding names the adapter, the provider, the model family and the
model. A review seat can be required to differ from the writer, so the model
that wrote the work is not the model that grades it.

| package | drives | needs |
| --- | --- | --- |
| `@obversa/engine-claude-cli` | the Claude CLI, one process per attempt | Claude CLI, host auth |
| `@obversa/engine-codex` | the Codex CLI | Codex CLI, host auth |
| `@obversa/engine-grok-cli` | the Grok CLI | Grok CLI 1.0.5 |
| `@obversa/engine-opencode-cli` | the OpenCode CLI | OpenCode CLI 1.18.23 |
| `@obversa/engine-anthropic-api` | the Anthropic API | an API key |
| `@obversa/engine-agent-sdk` | the Claude Agent SDK | host Claude auth |

Write your own against the engine contract; it must pass the conformance kit.

## Where to go

- **Site:** [obversa.ai](https://obversa.ai)
- **Docs:** [docs.obversa.ai](https://docs.obversa.ai)
- **Your first run:** [get started](https://docs.obversa.ai/get-started/first-run)
- **Contributing:** [AGENTS.md](AGENTS.md)

## What is in this repository

Fourteen publishable packages. `packages/` holds the six that define the
product: `@obversa/runtime` is the runtime and its public contract,
`@obversa/runner` supervises stored runs, `@obversa/engine` and `@obversa/memory`
are the engine and memory contracts, and `@obversa/surfacer` and
`@obversa/source` are the local review surface. `plugins/` holds the eight
adapters: the six engines above and two memories, one in process and one in
private Git references. `hosts/` holds the terminal host, which is not
published.

## Requirements

- Node.js 22.12 or later
- pnpm 10.15.1

## Install the workspace

From an Obversa checkout, run:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

The install activates this repository's commit hooks for the checkout. See
[AGENTS.md](AGENTS.md) for what the hooks need before your first commit.

## Run the offline process

The first example uses deterministic function jobs. It does not use a model or
network service.

```bash
pnpm example:offline
```

The full form, if the shortcut is not available:

```bash
pnpm --filter @obversa/runtime exec tsx ../../examples/production-lines/offline-review.line.ts
```

Expected result:

```json
{
  "status": "pass",
  "attempts": 2,
  "summary": "config is complete"
}
```

## Define an outside graph type

The graph contract lets a package define a pure graph type without importing
runtime implementation modules. It validates a graph definition, reduces
recorded events, makes graph commands, and describes a stable plan for a host.

Run the checked-in example from the workspace root:

```bash
pnpm example:graph
```

The example is `examples/packages/custom-graph.ts`. It defines a graph type,
checks it with the public conformance kit, and prints its resolved plan bounds.

`validateGraphDescription(unknown)` returns a frozen valid description or
throws `GraphValidationError`. The conformance kit checks repeatable graph
behavior from independent compiled instances.

Read [the graph contract](docs/public/graphs/contract.mdx) and
[plan admission](docs/public/graphs/plan-admission.mdx) before a host uses a
graph package.

## Store events and artifacts

The runtime storage ports keep small JSON events separate from larger byte
content. Run the offline local-storage example from the workspace root:

```bash
pnpm example:storage
```

The example writes one large synthetic artifact, appends one small reference,
reopens the stores through a fresh binding, folds the same state, and runs the
event-store and artifact-store conformance kits.

Read [Events and artifacts](docs/public/storage/events-and-artifacts.mdx) for
the storage contract, limits, secret handling, conflict behavior, and integrity
checks. This storage layer does not execute graph work or recover a stopped
run.

## Run safe node attempts

The runtime adapters run one fresh CLI process for one bounded node attempt. The
offline example uses scripted Grok and OpenCode executables, validates both
structured results, keeps missing usage as `unknown`, and removes its temporary
fixture files.

```bash
pnpm example:attempt
```

Read [Safe node attempts](docs/public/runtime/node-attempts.mdx) for result
parts, declared capabilities, workspace access, fallback, and cleanup limits.

## Documentation

The public documentation is in [`docs/public`](docs/public). It includes the
first-run guide, the memory contract, graph and storage guides, the process
bank, [cmux host setup](docs/public/hosts/cmux.mdx), and
[reviewing a diff in a host pane](docs/public/hosts/review.mdx).

Validate the documentation from the workspace root:

```bash
pnpm docs:validate
```

## Development

```bash
pnpm typecheck
pnpm typecheck:ts6
pnpm test
pnpm build
```

## License

Obversa uses the [MIT License](LICENSE). Report security problems as described
in the [security policy](SECURITY.md).
