/**
 * Provider-limit plumbing shared by the engines and the runner.
 *
 * Engines classify a backend throttle/allowance signal into a `RATE_LIMIT` or
 * `QUOTA` `LoopError` carrying the reset hint they could extract (`retryAfterMs`
 * or `resetAt`). The runner reads that hint back through `waitMsFor` to decide
 * whether to wait, pause, or fail (see `onLimit`).
 *
 * Keeping the reset-time math in one place means every engine and the policy
 * agree on what "a known, bounded wait" means.
 */

import type { LoopError, LoopErrorCode } from './errors.js';

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

/**
 * Parse a `Retry-After` header value to ms. The HTTP spec allows two forms: a
 * number of seconds, or an HTTP-date. Returns `undefined` for anything we can't
 * read, so the caller falls back to other reset hints.
 */
export function retryAfterHeaderToMs(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const when = Date.parse(trimmed);
  if (!Number.isNaN(when)) return Math.max(0, when - now);
  return undefined;
}
