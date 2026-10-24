/**
 * The review rounds a panel with a send-back target keeps: the last round
 * it finished, what each reviewer found in the last round it answered and
 * the tree it read, and a round that paused with blocks from the reviewers
 * that answered. Kept on the run's state, and on each panel outcome's
 * `data.reviewRounds`, so a resumed run reads them back from the record.
 */

import type { FeedbackFinding, JobContext } from './types.js';

/** Run-owned state key: the review rounds of every panel, by `reviewRoundsKey`. */
export const REVIEW_ROUNDS = 'obversa:review-rounds';

export interface ReviewerRound {
  readonly round: number;
  readonly tree?: string;
  readonly findings: readonly FeedbackFinding[];
}

export interface ReviewRounds {
  /** The last finished round; 0 before the first. */
  readonly round: number;
  readonly reviewers: Readonly<Record<string, ReviewerRound>>;
  /** A round that paused after some reviewers answered with blocks. */
  readonly paused?: {
    readonly round: number;
    readonly tree?: string;
    readonly findings: readonly FeedbackFinding[];
    readonly answered: readonly string[];
    readonly missing: readonly string[];
  };
}

/** The key a panel's rounds are kept by: its step path and label. */
export function reviewRoundsKey(path: readonly string[], label: string): string {
  return JSON.stringify([...path, label]);
}

function table(ctx: Pick<JobContext, 'state'>): Record<string, ReviewRounds> {
  const value = ctx.state[REVIEW_ROUNDS];
  if (value !== null && typeof value === 'object') return value as Record<string, ReviewRounds>;
  const created: Record<string, ReviewRounds> = {};
  ctx.state[REVIEW_ROUNDS] = created;
  return created;
}

export function reviewRoundsOf(ctx: Pick<JobContext, 'state'>, key: string): ReviewRounds {
  return table(ctx)[key] ?? { round: 0, reviewers: {} };
}

export function saveReviewRounds(ctx: Pick<JobContext, 'state'>, key: string, rounds: ReviewRounds): void {
  table(ctx)[key] = rounds;
}
