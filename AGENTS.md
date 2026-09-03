# AGENTS.md

This guide is for anyone who wants to change this repository. It covers
what the repository is, how to set it up, how to run the checks, and the
rules that apply to every change.

## What this repository is

Obversa is a runtime for reliable agent work. You describe work as a
graph: steps, dependencies, and review gates. The runtime runs the graph
one bounded engine call at a time.
It records every step as an event. It can restart a run after a crash
without lost work. You can replace the engines (Claude, Codex, Grok,
OpenCode, or one you add). You can replace the memory. You can write your
own workflow shape without knowledge of the runtime internals.

## Setting up from source

You need Node.js 22.12 or later and pnpm 10.15.1. If you do not have
pnpm, Corepack brings the right version:

```bash
corepack enable
```

Then, from your fork's root:

```bash
pnpm install --frozen-lockfile
pnpm --recursive --if-present run build
```

The workspace builds every package. To work on one package, build just
it, for example the runtime:

```bash
pnpm --filter @obversa/runtime build
```

After the first install, the package store is on your machine. The
install again works without a network connection.

## Running the checks

Before you say that your change is complete, run:

```bash
pnpm build         # every package (run this first)
pnpm typecheck     # TypeScript (tsc)
pnpm typecheck:ts6 # TypeScript (tsc6)
pnpm test          # the full unit suite
```

Five checks fail changes that look correct. Run `pnpm build` first,
because two of them read the packed output:

```bash
pnpm check:boundaries   # package boundaries and dependency direction
pnpm check:graph-purity # the graph kernel stays pure
pnpm check:tarballs     # the packed files match the expected list
pnpm check:consumer     # a clean project can use the packed packages
pnpm docs:validate      # the documentation site builds
```

The docs check needs the Mintlify CLI. Install it globally:

```bash
npm install --global mintlify
```

The `verify:d1`, `verify:d2`, and later `verify:` scripts chain these checks in the
order the release uses them. Run the chain that is closest to what you
touched. Tests are the source of truth: a change is not done until the
relevant suites pass, and a red test is always worth understanding before
you push past it.

## The rules every change follows

**Commits.** Use [Conventional Commits](https://www.conventionalcommits.org):
`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, and more, with the why in
the body. Commits are signed. Configure Git with an SSH signing key
before your first contribution. Do not add AI attribution, co-author
trailers, or generated-by text. The author of a change is you.

**Boundaries, in plain words.**

- **The runtime imports no adapter.** Engine and memory adapters live in
  `plugins/` and are given as instances at run time. Nothing inside
  `packages/runtime` goes out to find them.
- **The graph kernel stays pure.** Graph code works on frozen data and
  decides; it never touches files, engines, processes, clocks, or storage.
  `pnpm check:graph-purity` enforces this.
- **Hosts drive, they do not reach in.** A host (`hosts/`) starts and
  supervises runs through the public APIs. It never parses private output
  or imports runtime internals.
- **Memory adapters implement the port.** They import `@obversa/memory`
  and nothing else from this repository.
- **Engines are keyed by exactly what runs.** An engine binding names the
  adapter, provider, model family, and model. It never names a lane. A
  declared substitute can thus come from another adapter.

**Tests are the source of truth.** Fix a bug by writing the test that
reproduces it first. A suite that cannot fail proves nothing.

## Adding an engine plugin

An engine plugin is one small package in `plugins/` that turns engine
requests into calls to a CLI or API and returns structured results. Each
plugin pins the executable it expects. Each plugin records the identity it
serves, with the provider and the model family, so that a review panel can
ask for a second opinion from a different provider.

Start from an existing one. `plugins/engine-grok-cli` is a good size.
Read its README and its tests before you write yours.
Your plugin must pass the engine conformance kit. Your plugin must run one
attempt per fresh process, so that no state leaks between attempts.

## Adding a workflow shape

The runtime ships a pipeline, and you can add your own form over the
public contract without a fork of the runtime.
Graph forms are plain packages over the public contract: you compile a
definition, fold events into state, and decide what runs next. The
contract page at `docs/public/graphs/contract.mdx` defines the surface,
and the built-in pipeline form is the worked example.
Your form must pass the graph conformance kit. The built-in forms use the
same kit.

## Opening a pull request

1. Fork, then branch from `main` with a short, descriptive name.
2. Make your change, with tests, and run the checks above.
3. Commit with a Conventional Commit message that explains why.
4. Open the pull request against `main`. Say what a user gets from the
   change.

Send small, complete pull requests. If a change needs a bigger
conversation, open an issue first.
