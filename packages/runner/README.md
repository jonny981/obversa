# @obversa/runner

`@obversa/runner` starts, supervises, inspects, resumes, and stops bounded Obversa runs.
It uses the public runtime and engine APIs. Hosts supply the engines and memory;
the runner does not discover adapters.

## Requirements

- **Node.js:** 22.12 or later.

## Build from the workspace

From the workspace root:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

## Usage

Run the offline example from the workspace root:

```bash
pnpm --filter @obversa/runner exec tsx ../../examples/supervised-run.ts
```

See the [runner guide](https://docs.obversa.ai/runtime/runner) for the start,
status, resume, and stop APIs, host module contract, and stored run bounds.

## Limits

- **Process cleanup:** Linux discovery by inherited run owner is best-effort:
  its implementation has tests, but the Linux-specific tests have not run on
  Linux for this release. On macOS a helper that moves into a new session before
  the watchdog samples it is not swept. The run record reports the cleanup capability.
- **Watchdog lifetime:** Cleanup requires a live watchdog. Killing the watchdog
  removes that guarantee.
- **Host identity:** The host entry file digest does not cover its transitive
  imports.
- **Storage failures:** A failed start can retain artifacts or run-start evidence.
  The runner reports the storage failure; it does not roll back storage writes.
  Engine response parts share the run's artifact size and quota limits; known
  secrets are refused, not redacted. A refused parts write fails the node even
  after engine success. See the runner guide for the caller-visible outcomes.
- **Usage:** Recorded receipts preserve engine evidence. They do not enforce a
  global token budget.

## License

[MIT](LICENSE)
