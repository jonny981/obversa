/**
 * The one round rule every form follows: a reviewed `workflow()` stage, a
 * `dag()` send-back and a `loop()` review all ask it whether another build
 * may follow a review.
 *
 * A round is one build and the review of it; round 1 is the first build.
 * `refinements` is how many more builds the policy allows after the first:
 * `refine: N`, `maxKickbacks: { target: N }` and a judge's `cap: N` all allow
 * N, so N+1 builds in all. A bare `maxKickbacks: N` is N send-backs in the
 * whole graph, not N per target. With no limit (a judge with no cap),
 * another build may always follow, and the judge or a passing review ends the
 * rounds.
 */

/** What the rule decides for one round. */
export interface RoundDecision {
  /** Another build may follow this round's review. */
  readonly another: boolean;
  /** This round is the last the limit allows: no build follows its review. */
  readonly lastRound: boolean;
  /** The round fields a judge reads about this round. */
  readonly judge: { readonly round: number; readonly cap?: number; readonly lastRound?: true };
}

export function roundRule(round: number, refinements: number | undefined): RoundDecision {
  const lastRound = refinements !== undefined && round > refinements;
  return {
    another: !lastRound,
    lastRound,
    judge: {
      round,
      ...(refinements !== undefined ? { cap: refinements } : {}),
      ...(lastRound ? { lastRound: true as const } : {}),
    },
  };
}
