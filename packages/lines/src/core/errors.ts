/**
 * Structured, classified errors so the exit report can say what failed, where in
 * the loop tree, and why, instead of dumping a stack.
 */

export type LoopErrorCode =
  | 'ENGINE' // the backend (SDK/CLI/API) threw or returned an error
  | 'TIMEOUT' // a step exceeded its time budget
  | 'ABORTED' // an early-exit signal interrupted the work
  | 'VALIDATION' // a condition/validator could not produce a verdict
  | 'CONFIG' // the loop definition or CLI input was invalid
  | 'BUDGET' // the run's token budget was exhausted
  | 'RATE_LIMIT' // the provider throttled the call (resets on its own)
  | 'QUOTA' // an account/usage allowance was hit (may or may not reset)
  | 'BODY' // the step body threw
  | 'UNKNOWN';

export type LoopPhase =
  | 'start'
  | 'body'
  | 'until'
  | 'stopOn'
  | 'review'
  | 'engine';

export interface LoopErrorInit {
  code: LoopErrorCode;
  message: string;
  phase?: LoopPhase;
  path?: readonly string[];
  iteration?: number;
  cause?: unknown;
  retryable?: boolean;
  /** Suggested wait before retry, in ms (e.g. a `retry-after` header). */
  retryAfterMs?: number;
  /** When the limit resets, as epoch ms. The wait policy prefers this. */
  resetAt?: number;
}

export class LoopError extends Error {
  readonly code: LoopErrorCode;
  readonly phase?: LoopPhase;
  readonly path?: readonly string[];
  readonly iteration?: number;
  readonly retryable: boolean;
  /** Suggested wait before retry, in ms (e.g. a `retry-after` header). */
  readonly retryAfterMs?: number;
  /** When the limit resets, as epoch ms. The wait policy prefers this. */
  readonly resetAt?: number;

  constructor(init: LoopErrorInit) {
    super(
      init.message,
      init.cause !== undefined ? { cause: init.cause } : undefined,
    );
    this.name = 'LoopError';
    this.code = init.code;
    this.phase = init.phase;
    this.path = init.path;
    this.iteration = init.iteration;
    this.retryAfterMs = init.retryAfterMs;
    this.resetAt = init.resetAt;
    this.retryable = init.retryable ?? defaultRetryable(init);
  }

  /** Wrap an arbitrary thrown value, preserving a `LoopError` as-is. */
  static from(
    value: unknown,
    fallback: Omit<LoopErrorInit, 'message' | 'cause'>,
  ): LoopError {
    if (value instanceof LoopError) return value;
    const message = value instanceof Error ? value.message : String(value);
    return new LoopError({ ...fallback, message, cause: value });
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      phase: this.phase,
      path: this.path,
      iteration: this.iteration,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
      resetAt: this.resetAt,
    };
  }
}

const INFRASTRUCTURE_ERROR_CODES = new Set<LoopErrorCode>([
  'ENGINE',
  'TIMEOUT',
  'RATE_LIMIT',
  'QUOTA',
  'BUDGET',
]);

export function isInfrastructureError(
  error: unknown,
): error is LoopError {
  return error instanceof LoopError && INFRASTRUCTURE_ERROR_CODES.has(error.code);
}

export function isEngineExecutionError(
  error: unknown,
): error is LoopError {
  return isInfrastructureError(error);
}

/**
 * Default `retryable` by code. ENGINE/TIMEOUT and RATE_LIMIT always refresh on
 * their own, so they retry. QUOTA retries only when a reset is known (a reset
 * the wait policy can act on); a quota with no parseable reset is fatal until
 * the allowance refreshes out of band. BUDGET never refreshes within a run.
 */
function defaultRetryable(init: LoopErrorInit): boolean {
  switch (init.code) {
    case 'ENGINE':
    case 'TIMEOUT':
    case 'RATE_LIMIT':
      return true;
    case 'QUOTA':
      return init.resetAt != null || init.retryAfterMs != null;
    default:
      return false;
  }
}
