# Obversa

Obversa is a TypeScript workspace for running real-world processes with
agents.

Status: In build. Public docs in `docs/public/`.

This workspace contains seven packages, plus engine plugins:

- `@obversa/runtime` provides a runtime API and a pure contract for outside graph types.
- `@obversa/memory` defines a small memory contract.
- `@obversa/memory-simple` stores memory in one process.
- `@obversa/memory-git` stores memory in private Git references.
- `@obversa/surfacer` runs one secure local surface session: one loopback server, one opaque result, host-native placement.
- `@obversa/engine` defines the engine contract: one bounded call, typed failures, and structured results.
- `@obversa/source` is the review surface: it opens a git diff for inline review and returns the annotations.

The `plugins/` directory holds the engine adapters (Claude CLI, Codex, Grok CLI, Anthropic API, Agent SDK, OpenCode CLI) and the memory adapters (in-process and Git).

`@obversa/runtime` is the runtime. A process is a complete program that
composes runtime jobs, graph forms, policies, and adapters.

Two workstreams run in parallel. Workstream 1 builds `@obversa/runtime` in
`packages/runtime`. Workstream 2 builds host glue in `hosts/`, then the Surfacer
and review surfaces. Full Obversa implementation starts after the runtime
reaches version 1.0.0.

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
