# Obversa

Obversa is a TypeScript workspace for reliable agent production lines.

Status: In build. Public docs in `docs/public/`.

This workspace contains four packages:

- `@obversa/lines` runs nestable jobs, loop graphs, and directed acyclic graphs.
- `@obversa/memory` defines a small memory contract.
- `@obversa/memory-simple` stores memory in one process.
- `@obversa/memory-git` stores memory in private Git references.

Lines is the runtime. A production line is a complete program that composes
Lines jobs, graph forms, policies, and adapters.

Two workstreams run in parallel. Workstream 1 builds `@obversa/lines` in
`packages/lines`. Workstream 2 builds host glue in `hosts/`, then the Surfacer
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

The install activates this repository's commit-policy hooks for the checkout.

## Run the offline production line

The first example uses deterministic function jobs. It does not use a model or
network service.

```bash
pnpm --filter @obversa/lines exec tsx ../../examples/production-lines/offline-review.line.ts
```

Expected result:

```json
{
  "status": "pass",
  "attempts": 2,
  "summary": "config is complete"
}
```

## Documentation

The public documentation is in [`docs/public`](docs/public). It includes the
first-run guide, the memory contract, the production-line bank, and
[cmux host setup](docs/public/hosts/cmux.mdx).

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
