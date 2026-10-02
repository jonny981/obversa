/**
 * A judge: a seat that answers typed questions about a piece of work and the
 * rounds spent on it so far, in place of a plain review-round count. Used on
 * a `workflow()` stage's `refine` and on a `dag()`'s `maxKickbacks`, between
 * a review's verdict and the send-back.
 *
 * The default question set and the routing rule below make a loop that was
 * first hand-wired as dag nodes into a runtime primitive.
 */

import { agentJob } from './job.js';
import { DEFAULT_INTERACTION, jsonSnapshot, requestInteraction, type InteractionBinding, type InteractionResponse } from './interaction.js';
import type { Outcome } from './types.js';
import { normalizeFeedbackSeverity, revisionRequest } from './feedback.js';
import type {
  FeedbackActionSeverity,
  FeedbackFinding,
  Judge,
  JudgeAnswer,
  JudgeQuestions,
  JobContext,
} from './types.js';

export type { Judge, JudgeAnswer, JudgeQuestion, JudgeQuestions } from './types.js';

/**
 * The default question set: does the work hold for this use case, are the
 * latest findings worth doing, is another round worth it, and why stop. A
 * caller's own set replaces this wholesale (e.g. for a use case this
 * wording doesn't fit); `what` names the thing being judged in the wording.
 */
export function stopQuestions(what = 'the draft'): JudgeQuestions {
  return {
    holds: {
      type: 'noul',
      instructions: `For this use case, does ${what} hold as it stands?`,
      criteria: {
        true: 'The latest findings are nits, taste or nothing, and a reader of this kind of work would not notice what remains.',
        false: 'The latest findings include a block, or shoulds a reader of this kind of work would notice.',
      },
    },
    worth_doing: {
      type: 'noul',
      instructions: 'Read the latest findings themselves. For this use case, are they worth acting on?',
      criteria: {
        true: 'They name things a reader of this kind of work would stumble on, misread or distrust.',
        false: 'They are taste, edge cases, or polish past the bar the use case sets; acting on them would not change what a reader gets.',
      },
    },
    worth_another_round: {
      type: 'noul',
      instructions: 'Given the whole history and whether the latest findings are worth doing, is another round worth it?',
      criteria: {
        true: 'The findings are worth doing, and the rounds so far have fixed what was found, so one more pass would land them.',
        false: 'The findings are not worth doing for this use case; or the same class of finding keeps returning; or the change between rounds is small; or the work is being polished past the bar.',
      },
    },
    stop_reason: {
      type: 'choice',
      instructions: 'If a person must settle a product decision, choose product_decision. Otherwise, are we at the point of diminishing returns? If so, which kind; if not, continue.',
      criteria: {
        holds: `${what} holds for this use case.`,
        over_polishing: 'The remaining findings are taste, nits or edge cases past the bar.',
        not_converging: 'The same class of finding keeps returning, so another round will not fix it.',
        continue: 'Another round is worth it.',
        product_decision: 'A person must settle a product decision before this review can continue.',
      },
    },
  };
}

/**
 * A judge for `refine` or `maxKickbacks`: `seat` runs with workspace mode
 * none (it reads no file itself; everything it needs rides in the prompt),
 * `cap` is the hard backstop on rounds regardless of what the judge says,
 * and `questions` defaults to `stopQuestions()`.
 */
export function judge(seat: Judge['seat'], opts: { cap: number; questions?: JudgeQuestions; interaction?: InteractionBinding }): Judge {
  if (!Number.isSafeInteger(opts.cap) || opts.cap < 1) {
    throw new TypeError('judge cap must be a positive integer');
  }
  return { kind: 'judge', seat, cap: opts.cap, questions: opts.questions ?? stopQuestions(), ...(opts.interaction ? { interaction: opts.interaction } : {}) };
}

export function isJudge(value: unknown): value is Judge {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'judge';
}

/** A finding tagged block, by any reviewer, in this round's findings. */
export function hasBlockFinding(findings: readonly FeedbackFinding[] | undefined): boolean {
  return (findings ?? []).some((finding) => normalizeFeedbackSeverity(finding.severity) === 'block');
}

const SEVERITIES: readonly FeedbackActionSeverity[] = ['block', 'should-fix', 'nice-to-have', 'approve'];

/** Every finding, counted by severity, the judge reads numbers, not a list to recount itself. */
export function countBySeverity(findings: readonly FeedbackFinding[]): Record<FeedbackActionSeverity, number> {
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as Record<FeedbackActionSeverity, number>;
  for (const finding of findings) counts[normalizeFeedbackSeverity(finding.severity)] += 1;
  return counts;
}

/** One round of the work the judge is watching converge. */
export interface JudgeRound {
  readonly round: number;
  readonly findings: readonly FeedbackFinding[];
  readonly counts: Readonly<Record<FeedbackActionSeverity, number>>;
  /** Lines added or removed since the previous round, when the target is a file. */
  readonly changedLines?: number;
}

/** What the judge sees. `cap` rides along so it can reason about how much room is left. */
export interface JudgeState {
  readonly productFeedback?: readonly InteractionResponse[];
  readonly useCase?: string;
  /** The file being refined, relative to the workspace, when there is one. */
  readonly file?: string;
  /** That file's current content, when there is one. */
  readonly draft?: string;
  readonly latestFindings: readonly FeedbackFinding[];
  readonly rounds: readonly JudgeRound[];
  readonly round: number;
  readonly cap: number;
}

export interface JudgeDecision {
  /** Send the work back for another round. */
  readonly again: boolean;
  /** Always names the judge, so a kickback or a stop is traceable to it. */
  readonly reason: string;
  /**
   * What a stop means, when `again` is false. `ship`: the work holds as it
   * is, so it stands as a pass carrying the judge's reason. `fail`: another
   * round will not fix it, so the run stops there and the requesting side's
   * own failure stands. `product_decision` asks a person, then sends the work
   * back to the builder with their answer as another round; the judge is
   * asked again only after that round is reviewed. Absent when `again` is
   * true.
   */
  readonly stop?: 'ship' | 'fail' | 'product_decision';
  /**
   * The answer that decided the route: the chosen reason (`stop_reason:
   * continue`), the probability answer it fell back to
   * (`worth_another_round: 0.49`), or `no clear answer`.
   */
  readonly rule: string;
}

/**
 * Route on the judge's answers. The chosen `stop_reason` decides when there is
 * one: in use it moves with the rounds while the probability answers stay
 * flat, so it is the answer that discriminates. A chosen `continue` runs
 * another round whatever the probability answers say. A clear yes or no from
 * `holds`, `worth_doing` or `worth_another_round` decides only when there is
 * no choice: a question set without `stop_reason`, or a reply that did not
 * parse. Neither the cap nor a block finding is checked here: the caller
 * enforces the cap itself (a loop's own `maxReviewRestarts`, or a dag's own
 * kickback budget), and a block finding never reaches this function, it
 * always goes back without asking the judge.
 *
 * `product_decision` pauses for a person's answer, which goes to the builder
 * as the next round. For a terminal stop, `holds` and `over_polishing` say
 * the work is good enough as it stands, so it ships as a pass; other stops, including
 * `not_converging` and any choice a custom question set invents of its own,
 * says the run should not ship silently, so it stops there and the
 * requesting side's failure stands. The same split applies to the
 * probability fallback: a clear `holds` or a clear "not worth doing" ships
 * the work; an unclear "another round is not worth it" fails instead of
 * shipping, since its own criteria already blend polish with a stall and
 * cannot tell the two apart.
 */
export function judgeDecision(answers: Readonly<Record<string, JudgeAnswer>>): JudgeDecision {
  const worth = answers.worth_another_round?.noul ?? answers.worth_another_round?.probability;
  const doing = answers.worth_doing?.noul ?? answers.worth_doing?.probability;
  const holds = answers.holds?.noul ?? answers.holds?.probability;
  const choice = answers.stop_reason?.choice;
  if (choice !== undefined) {
    const rule = `stop_reason: ${choice}`;
    if (choice === 'continue') return { again: true, reason: 'the judge chose continue', rule };
    if (choice === 'product_decision') return { again: false, stop: 'product_decision', reason: 'the judge requested a product decision', rule };
    return { again: false, stop: choice === 'holds' || choice === 'over_polishing' ? 'ship' : 'fail', reason: `the judge chose ${choice}`, rule };
  }
  if (typeof holds === 'number' && holds >= 0.5) {
    return { again: false, stop: 'ship', reason: `the judge says it holds (${holds.toFixed(2)})`, rule: `holds: ${holds.toFixed(2)}` };
  }
  if (typeof doing === 'number' && doing < 0.5) {
    return { again: false, stop: 'ship', reason: `the judge says the findings are not worth doing (${doing.toFixed(2)})`, rule: `worth_doing: ${doing.toFixed(2)}` };
  }
  if (typeof worth === 'number' && worth < 0.5) {
    return { again: false, stop: 'fail', reason: `the judge says another round is not worth it (${worth.toFixed(2)})`, rule: `worth_another_round: ${worth.toFixed(2)}` };
  }
  return {
    again: true,
    reason: `the judge says another round is worth it${typeof worth === 'number' ? ` (${worth.toFixed(2)})` : ''}`,
    rule: typeof worth === 'number' ? `worth_another_round: ${worth.toFixed(2)}` : 'no clear answer',
  };
}

/**
 * Ask the judge, and record its answer. Runs `cfg.seat` as a workspace-mode-
 * none agent turn over `state` and `cfg.questions`, parses the reply as the
 * judge engine's own `{ [question]: JudgeAnswer }` shape, and emits
 * `refine:judge` so a person reading the record sees what it answered and
 * why. A reply that fails to parse becomes an empty answers object ,
 * `judgeDecision` reads that as no clear answer, which runs another round,
 * so the caller's own cap is what ends the rounds.
 */
export async function askJudge(
  cfg: Judge,
  state: JudgeState,
  ctx: JobContext,
  path: readonly string[],
): Promise<{ answers: Readonly<Record<string, JudgeAnswer>>; decision: JudgeDecision }> {
  const judgeJob = agentJob({
    label: 'refine:judge',
    engine: cfg.seat.engine,
    model: cfg.seat.identity.model,
    workspaceMode: 'none',
    tools: [],
    leaf: true,
    prompt: JSON.stringify({ state, questions: cfg.questions }),
  });
  const outcome = await judgeJob({ ...ctx, depth: ctx.depth + 1, path: [...path, 'refine-judge'] });
  let answers: Record<string, JudgeAnswer> = {};
  if (outcome.status === 'pass') {
    try {
      const parsed: unknown = JSON.parse(String(outcome.data ?? ''));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        answers = parsed as Record<string, JudgeAnswer>;
      }
    } catch {
      // Left empty: an unreadable answer routes as no clear answer, not a crash.
    }
  }
  const decision = judgeDecision(answers);
  const status = decision.stop === 'ship' ? 'pass' : decision.stop === 'fail' ? 'fail' : undefined;
  ctx.emit({
    kind: 'refine:judge', ts: Date.now(), path: [...path], answers, reason: decision.reason,
    route: decision.again ? 'again' : 'stop', rule: decision.rule, ...(status ? { status } : {}),
  });
  return { answers, decision };
}

/**
 * Ask the judge, or resume its pending product question. When the judge
 * chooses `product_decision`, a person is asked, and their answer comes back
 * as `answer` for the caller to send to the builder; the judge is not asked
 * again until that round has been built and reviewed. With `roundLeft`
 * false, no builder round remains for an answer, so the person is not asked
 * and the `product_decision` decision comes back as it is.
 */
export async function consultJudge(
  cfg: Judge,
  state: JudgeState,
  ctx: JobContext,
  path: readonly string[],
  options: { readonly identity: string; readonly pending: boolean; readonly roundLeft?: boolean; readonly save: (state: JudgeState) => void },
): Promise<{ state: JudgeState; decision: JudgeDecision } | { state: JudgeState; paused: Outcome } | { state: JudgeState; answer: InteractionResponse }> {
  if (!options.pending) {
    const { decision } = await askJudge(cfg, state, ctx, path);
    if (decision.stop !== 'product_decision' || options.roundLeft === false) return { state, decision };
  }
  options.save(state);
  const answer = await requestInteraction(cfg.interaction ?? DEFAULT_INTERACTION,
    'What product decision should guide this review?', jsonSnapshot({
      requester: { path, identity: options.identity, engine: cfg.seat.identity, round: state.round },
      material: state,
    }), ctx);
  if ('paused' in answer) return { state, paused: answer.paused };
  return { state: { ...state, productFeedback: [...(state.productFeedback ?? []), answer.response] }, answer: answer.response };
}

/**
 * The next round's feedback after a person answers a product decision: it
 * says it is their decision, quotes their prompt, lists the review findings
 * it answers, and carries their whole response as structured feedback.
 */
export function productDecisionFeedback(
  answer: InteractionResponse,
  findings: readonly FeedbackFinding[],
  over: { readonly target?: string; readonly source?: string } = {},
): Outcome {
  const reason = `A person made a product decision about the findings below. Apply it in this round. Their decision: "${answer.prompt}"`;
  return revisionRequest({ ...over, reason, findings: [...findings] }, { data: answer });
}
