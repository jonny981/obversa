# Obversa

**Model how your team really works.** Obversa gives your agents the shape of a
real team: named roles, reviews that send work back to whoever owns the step, a
vote when one opinion is not enough, and a person to answer to.

It runs on the engines you already use, and it keeps its whole record in plain
files, so there is no server to stand up and no database to migrate.

```ts
// a reviewer fails a step and names the stage that must fix it
kickback('implement', 'The export is missing its header row.');

// a panel passes when enough seats agree, and you set the number
reviewPanel({ reviewers, pass: 2 });
```

Every step a run takes appends events to a file on disk, with its artifacts
beside them. Kill a recorded run and start it again: it reads its own events and
picks up at the step that was running.

- **Site:** [obversa.ai](https://obversa.ai)
- **Docs:** [docs.obversa.ai](https://docs.obversa.ai)
- **Start here:** [your first run](https://docs.obversa.ai/get-started/first-run)

## What is in this repository

Fourteen publishable packages. `packages/` holds the six that define the
product: `@obversa/runtime` is the runtime and its public contract,
`@obversa/runner` supervises stored runs, `@obversa/engine` and `@obversa/memory`
are the engine and memory contracts, and `@obversa/surfacer` and
`@obversa/source` are the local review surface. `plugins/` holds the eight
adapters: six engines, for Claude Code, Codex, Grok, OpenCode, the Anthropic API
and the Agent SDK, and two memories, one in process and one in private Git
references. `hosts/` holds the terminal host, which is not published.

A page for every package is under
[docs/public/packages](docs/public/packages), and [AGENTS.md](AGENTS.md) is the
contributor guide.

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
