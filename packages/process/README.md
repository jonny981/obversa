# @obversa/process

Run one child process with a deadline, and get a result you can read
whatever the child did: finished, hung, filled a pipe, or ignored a signal.

```bash
npm install @obversa/process
```

Node.js 22.12 or later. No dependencies.

## Why it exists

A child process is the one thing in a workflow that can wait forever. A
`git` call that reads from standard input until it is closed, a model CLI
that never exits, a command that fills its output pipe and stalls: each of
these has hung a proof on a real machine, and each looked like nothing at
all, because a hang carries no error. `runChild` makes every one of them
end, at a deadline, with a typed result.

## What you get

- **A deadline that always means timeout.** When `timeoutMs` passes, the
  child is stopped and the result says `timedOut: true`, even when the
  stopped child reports no exit code. With `detached: true`, its process group
  is stopped too.
- **No pipe can stall it.** Standard input is closed after the optional
  input is written, and both output streams are drained until they close
  or for a short grace after the child exits, under one combined byte cap.
  A helper the child left behind holding its pipe cannot hold your result;
  the exit is the result, and the pipes are a bounded extra.
- **A result, not a race.** Exit code, output bytes, and the timed-out and
  aborted flags come from facts the helper recorded, never from whichever
  callback fired first.

## Use it

```ts
import { runChild } from '@obversa/process';

const result = await runChild({
  executable: process.execPath,
  args: ['-e', 'process.stdout.write("ready")'],
  cwd: process.cwd(),
  env: {},
  stdin: '',
  timeoutMs: 30_000,
  killGraceMs: 5_000,
  maxOutputBytes: 1_024 * 1_024,
});
```

`result.exitCode` is the child's exit code, or `null` when a signal stopped
it. `result.stdout` and `result.stderr` are the captured bytes. `timedOut`
and `aborted` say which limit, if any, ended the run.

## When your process dies

Children the helper started are stopped when your process exits or is
interrupted, by the same rule the signal-exit library uses: on exit every
live child gets a terminate signal, and on an interrupt the helper kills
its children, removes its own handler, and re-raises the signal so your
process ends the way it would have anyway. If you install your own handler
for a signal, you own that decision and the helper stays out of it.

By default a child sits in your process group, so an interrupt at the
terminal reaches it directly. Pass `detached: true` when a caller needs
the child in its own group, as the engine command runner does for its sweep.

## Things that catch people out

- **The output cap is combined.** `maxOutputBytes` bounds standard output
  and standard error together; a child that writes more ends with a
  `RunChildError` whose code is `OUTPUT_LIMIT`, after both pipes are
  drained.
- **The environment is merged.** `env` is laid over the parent's
  environment; pass `inheritParentEnv: false` to send only what you name.
- **A child that will not die.** After the deadline the child gets
  `killGraceMs` to stop; if it does not, the error is
  `TEARDOWN_INCOMPLETE`, and that is your signal to look at what it spawned.
- **Starting can fail too.** An executable that cannot start throws
  `RunChildError` with code `SPAWN_FAILED` before any timer runs.

## Where it is used

The engine command runner, the runtime's git and command sites, and the Git
memory adapter all run their children through this package, so a hang in any
of them ends the same way.

## License

MIT.
