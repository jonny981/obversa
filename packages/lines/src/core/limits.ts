/**
 * Provider-limit plumbing shared by the engines and the runner.
 *
 * Engines report a provider-neutral `EngineError`. The runtime maps rate-limit
 * and quota failures to a `LoopError` while preserving `retryAfterMs` and
 * `resetAt`. The runner reads that hint through `waitMsFor` to decide whether
 * to wait, pause, or fail (see `onLimit`).
 *
 * Keeping the reset-time math in one place means every engine and the policy
 * agree on what "a known, bounded wait" means.
 */

import type { LoopError, LoopErrorCode } from './errors.js';

export { retryAfterHeaderToMs } from '@obversa/engine';

/** The error codes the limit policy reacts to: provider limits + the budget. */
const LIMIT_CODES: ReadonlySet<LoopErrorCode> = new Set([
  'RATE_LIMIT',
  'QUOTA',
  'BUDGET',
]);

/** True when an error is one the `onLimit` policy governs. */
export function isLimitError(error: LoopError | undefined): error is LoopError {
  return !!error && LIMIT_CODES.has(error.code);
}

/**
 * The wait a limit error implies, in ms, or `undefined` when no reset is known.
 * Prefers an explicit `retryAfterMs`; falls back to `resetAt - now` (floored at
 * 0 so an already-passed reset waits nothing rather than going negative). BUDGET
 * never refreshes within a run, so it never yields a wait.
 */
export function waitMsFor(
  error: LoopError,
  now: number = Date.now(),
): number | undefined {
  if (error.code === 'BUDGET') return undefined;
  if (typeof error.retryAfterMs === 'number' && error.retryAfterMs >= 0)
    return error.retryAfterMs;
  if (typeof error.resetAt === 'number')
    return Math.max(0, error.resetAt - now);
  return undefined;
}
