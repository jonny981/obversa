/**
 * A token-denominated budget for a whole run, threaded through the JobContext so
 * every engine call site can refuse to spend past the cap. Where `max` and depth
 * bound the count of calls, this bounds their cost.
 *
 * The runner feeds `add()` from each `engine:usage` event, so `spent()` is live.
 * `assertBudget(ctx)` runs before an engine call; once the cap is reached it
 * throws a non-retryable BUDGET error (hard mode, terminates the run) or logs
 * and continues (soft mode, for exploratory runs).
 */

import type { JobContext } from './types.js';
import { LoopError } from './errors.js';

export interface BudgetConfig {
  /** Cap on total tokens (input + output) for the whole run. */
  limit: number;
  /**
   * Refuse a new engine call once `spent + headroom >= limit`, i.e. stop with
   * room to spare rather than only after the cap is already blown. Default 0.
   */
  headroom?: number;
  /** Warn and continue instead of refusing when the cap is hit. Default false. */
  soft?: boolean;
}

export class Budget {
  readonly limit: number;
  readonly headroom: number;
  readonly soft: boolean;
  private tokens = 0;

  constructor(config: BudgetConfig) {
    this.limit = config.limit;
    this.headroom = config.headroom ?? 0;
    this.soft = config.soft ?? false;
  }

  /** Record consumed tokens. Non-finite or non-positive values are ignored. */
  add(tokens: number): void {
    if (Number.isFinite(tokens) && tokens > 0) this.tokens += tokens;
  }

  spent(): number {
    return this.tokens;
  }

  remaining(): number {
    return Math.max(0, this.limit - this.tokens);
  }

  /** True once the next call would breach the cap (accounting for headroom). */
  exceeded(): boolean {
    return this.tokens + this.headroom >= this.limit;
  }
}

/**
 * Guard an engine call against the run budget. No-op when no budget is set or
 * the cap is not yet reached. In `soft` mode a breach warns and continues; in
 * hard mode it throws a non-retryable BUDGET error that terminates the run.
 */
export function assertBudget(ctx: JobContext): void {
  const budget = ctx.budget;
  if (!budget || !budget.exceeded()) return;
  if (budget.soft) {
    ctx.log(
      `token budget reached (${budget.spent()}/${budget.limit}) — continuing (soft)`,
      'warn',
    );
    return;
  }
  throw new LoopError({
    code: 'BUDGET',
    phase: 'engine',
    message: `token budget exhausted: ${budget.spent()}/${budget.limit} tokens spent`,
  });
}
