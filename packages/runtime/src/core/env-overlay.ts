/**
 * Env-var pinning for a job subtree. `withEnv` wraps any `Job` so everything beneath
 * it (gate commands, judge calls, and the subprocesses agent leaves spawn) sees the
 * given variables, without mutating the global `process.env`.
 *
 * Precedence (most specific wins):
 *   process.env
 *     < ctx.environment.env    (the Environment interface's live-stack vars)
 *     < ctx.envOverlay         (withEnv; nested wrappers merge inner-over-outer)
 *     < explicit per-call env  (commandSucceeds `opts.env` / agentJob `config.env`)
 *
 * Non-goals: this is pinning, not a lifecycle. Unlike the Environment interface, an
 * overlay has no `down()` and never touches the Environment handle. It cannot unset
 * an inherited var: the process helper merges env over `process.env`, so an overlay only adds or
 * shadows values.
 */

import type { Job, JobContext } from './types.js';
import { childContext } from './context.js';
import { LoopError } from './errors.js';
import { jobMeta, setMeta } from './describe.js';

/**
 * Layer env sources least- to most-specific into one record for a subprocess.
 * Returns `undefined` when every layer is absent or empty, so call sites keep
 * their exact no-env behavior (`env: undefined`, never `{}`). Internal: the public
 * surface is `withEnv`; per-call layers ride `opts.env` / `config.env`.
 */
export function mergeEnv(
  ...layers: (Record<string, string> | undefined)[]
): Record<string, string> | undefined {
  let merged: Record<string, string> | undefined;
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      // Null-prototype accumulator: on a plain `{}` a key named `__proto__`
      // hits the inherited accessor and the set is a silent no-op, so the
      // entry would vanish from the child env (the process helper accepts null-prototype
      // env objects; spreading one works too).
      (merged ??= Object.create(null) as Record<string, string>)[k] = v;
    }
  }
  return merged;
}

/**
 * The layered env for one engine/subprocess call, least → most specific: the
 * running environment's vars, then the `withEnv` overlay, then the per-call
 * layer (`commandSucceeds` `opts.env` / `agentJob` `config.env`). The process helper (and
 * the SDK adapter) merge the result over `process.env`, completing the
 * precedence chain in the header. One helper so a new call site cannot forget
 * a layer and silently break `withEnv`'s "everything beneath it" contract.
 */
export function resolveEnv(
  ctx: JobContext,
  perCall?: Record<string, string>,
): Record<string, string> | undefined {
  return mergeEnv(ctx.environment?.env, ctx.envOverlay, perCall);
}

/** Pin env vars for `job` and everything beneath it (see the header above). */
export function withEnv(overlay: Record<string, string>, job: Job): Job {
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) {
    throw new LoopError({
      code: 'CONFIG',
      message: `withEnv requires a plain object of string values (got ${
        Array.isArray(overlay) ? 'an array' : typeof overlay
      })`,
    });
  }
  for (const [k, v] of Object.entries(overlay)) {
    // An empty key, or one containing '=', would silently set a different variable
    // in the child (the envp entry for a key 'SAFE=PATH' reads 'SAFE=PATH=value',
    // i.e. variable SAFE); reject loudly instead.
    if (!k || k.includes('=')) {
      throw new LoopError({
        code: 'CONFIG',
        message: `withEnv key ${JSON.stringify(k)} is not a valid env var name (empty, or contains "=")`,
      });
    }
    // A number or undefined smuggled in would become the string 'undefined'
    // (or '3000') in a child process env; reject loudly instead.
    if (typeof v !== 'string') {
      throw new LoopError({
        code: 'CONFIG',
        message: `withEnv value for "${k}" must be a string (got ${typeof v})`,
      });
    }
  }
  const wrapper: Job = (ctx) =>
    job(
      // Transparent: same depth and path (no new tree segment, no events of
      // its own), and the loop-feedback fields are carried through so wrapping
      // a loop body does not hide the previous iteration from it.
      childContext(ctx, {
        depth: ctx.depth,
        path: ctx.path,
        lastOutcome: ctx.lastOutcome,
        lastReview: ctx.lastReview,
        lastGate: ctx.lastGate,
        envOverlay: { ...ctx.envOverlay, ...overlay },
      }),
    );
  // Carry the wrapped job's meta so `describe`/`validate` show the inner shape.
  const meta = jobMeta(job);
  return meta ? setMeta(wrapper, meta) : wrapper;
}
