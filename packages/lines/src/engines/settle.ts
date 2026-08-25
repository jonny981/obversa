/**
 * Bound an execa subprocess await to process EXIT rather than stream close.
 *
 * execa settles its result promise only when every stdio stream has ended. An
 * engine CLI that spawns helpers which inherit its stdio (an MCP transport
 * worker, a hook-spawned process) can leave an orphan holding the pipe write
 * ends after the engine process exits — and in that state the promise never
 * settles: execa's `timeout` and `cancelSignal` both fire, kill an
 * already-dead child, then block re-awaiting the same pinned streams while
 * constructing the result. A completed turn never resolves back to the loop.
 *
 * The escape is one execa itself sanctions: destroying the parent-side pipe
 * readers after exit registers as a benign premature close, and the promise
 * resolves with everything buffered up to that point. Engine protocol output
 * is written before exit, so a short post-exit drain preserves it; bytes an
 * orphan writes after the engine exited are not the engine's output and are
 * dropped. stdin does not pin the settle in this state, so only the readers
 * are released.
 */

/** Post-exit window for buffered protocol output to finish draining. Paid only
 *  when the streams are still open after exit — a clean engine run settles on
 *  the first race and never waits. */
export const EXIT_DRAIN_MS = 1000;

interface SettleableSubprocess<R> extends PromiseLike<R> {
  once(event: 'exit', listener: () => void): unknown;
  stdout?: { destroy(): void } | null;
  stderr?: { destroy(): void } | null;
}

export async function settleOnExit<R>(
  sub: SettleableSubprocess<R>,
  drainMs: number = EXIT_DRAIN_MS,
): Promise<R> {
  const settled = sub.then((r) => ({ done: true as const, r }));
  const exited = new Promise<{ done: false }>((resolve) => {
    sub.once('exit', () => resolve({ done: false }));
  });

  const first = await Promise.race([settled, exited]);
  if (first.done) return first.r;

  // Exited but not settled: either the last buffered bytes are still
  // draining, or an orphan is holding the pipes open. Give the drain a
  // bounded window…
  const drained = new Promise<{ done: false }>((resolve) => {
    const timer = setTimeout(() => resolve({ done: false }), drainMs);
    timer.unref?.();
  });
  const second = await Promise.race([settled, drained]);
  if (second.done) return second.r;

  // …then release the pinned readers. execa swallows the premature close on
  // output readables and resolves with the output buffered so far.
  sub.stdout?.destroy();
  sub.stderr?.destroy();
  return await sub;
}
