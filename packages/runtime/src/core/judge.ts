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
  JudgeQuestion,
  SkippedFinding,
} from './types.js';

export type { Judge, JudgeAnswer, JudgeQuestion, JudgeQuestions, SkippedFinding } from './types.js';

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
 * and `questions` defaults to `stopQuestions()`. With no `cap`, the rounds
 * end when the judge stops them or the review passes. A `cap` is an
 * optional backstop: after the last review it allows, the judge is asked
 * once more, and only a stop that lets the work stand passes. `perFinding`
 * asks the judge to act on or skip each finding as well; it defaults to true
 * with the default questions and to false with a caller's own.
 */
export function judge(seat: Judge['seat'], opts: { cap?: number; questions?: JudgeQuestions; perFinding?: boolean; interaction?: InteractionBinding } = {}): Judge {
  if (opts.cap !== undefined && (!Number.isSafeInteger(opts.cap) || opts.cap < 1)) {
    throw new TypeError('judge cap must be a positive integer');
  }
  return {
    kind: 'judge', seat, ...(opts.cap !== undefined ? { cap: opts.cap } : {}), questions: opts.questions ?? stopQuestions(),
    perFinding: opts.perFinding ?? opts.questions === undefined,
    ...(opts.interaction ? { interaction: opts.interaction } : {}),
  };
}

/** What `act` and `skip` mean in each per-finding question. */
const FINDING_CRITERIA = {
  act: 'A reader of this kind of work would stumble on, misread or distrust what this finding names, so the builder should fix it.',
  skip: 'It is taste, an edge case, or polish past the bar the use case sets, so fixing it would not change what a reader gets.',
} as const;

/**
 * A finding's id within its round: `finding-1` for the first finding in the
 * round's list, and so on. The list is saved with a pending question, so the
 * ids stay the same after a resume.
 */
export function findingId(index: number): string {
  return `finding-${index + 1}`;
}

/** What `act` and `skip` mean for a finding tagged block: the bar to skip it is higher. */
const BLOCK_CRITERIA = {
  act: 'The case this finding names is part of how the work is really used, so the builder should fix it.',
  skip: 'The case it names is outside how the work is really used, or the same class of finding keeps returning after it was answered.',
} as const;

/** One `choice` question per finding, keyed by the finding's id. A block's question sets the higher bar. */
export function findingQuestions(findings: readonly FeedbackFinding[]): JudgeQuestions {
  const questions: Record<string, JudgeQuestion> = {};
  for (const [index, finding] of findings.entries()) {
    const severity = normalizeFeedbackSeverity(finding.severity);
    const recommendation = finding.recommendation ? ` Recommendation: ${finding.recommendation}` : '';
    const bar = severity === 'block'
      ? 'It is tagged block, so the bar to skip it is higher. Skip it only when the case it names is outside how the work is really used, or the same class of finding keeps returning after it was answered; otherwise act.'
      : 'For this use case, should the builder act on it in another round, or skip it?';
    questions[findingId(index)] = {
      type: 'choice',
      instructions: `Read this one finding. ${bar} Give a one-line reason. Finding [${severity}]: ${finding.evidence}${recommendation}`,
      criteria: severity === 'block' ? BLOCK_CRITERIA : FINDING_CRITERIA,
    };
  }
  return questions;
}

/** The judge's decision on one finding. */
export interface FindingDecision {
  readonly id: string;
  readonly decision: 'act' | 'skip';
  readonly reason: string;
}

export function isJudge(value: unknown): value is Judge {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'judge';
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

/**
 * What the judge sees. `cap` rides along so it can reason about how much
 * room is left; it is absent when the judge has no cap.
 */
export interface JudgeState {
  readonly productFeedback?: readonly InteractionResponse[];
  readonly useCase?: string;
  /** The file being refined, relative to the workspace, when there is one. */
  readonly file?: string;
  /** That file's current content, when there is one. */
  readonly draft?: string;
  readonly latestFindings: readonly FeedbackFinding[];
  /** Findings the judge skipped in earlier rounds, with its reasons. */
  readonly skipped?: readonly SkippedFinding[];
  /** The judge's decision on each finding of the round it sent to a person, so the answer reaches the builder with only the findings worth acting on. */
  readonly decided?: readonly FindingDecision[];
  readonly rounds: readonly JudgeRound[];
  readonly round: number;
  readonly cap?: number;
  /** This round's review is the last one the cap allows: no build round follows it. */
  readonly lastRound?: true;
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
   * asked again only after that round is reviewed. After the last round a
   * cap allows, no round follows the answer and the run fails. Absent when
   * `again` is true.
   */
  readonly stop?: 'ship' | 'fail' | 'product_decision';
  /**
   * The answer that decided the route: the chosen reason (`stop_reason:
   * continue`), the probability answer it fell back to
   * (`worth_another_round: 0.49`), the count of findings acted on and
   * skipped (`findings: 1 act, 2 skip`), or `no clear answer`.
   */
  readonly rule: string;
  /** The decision on each finding, when the judge decides each finding. */
  readonly findings?: readonly FindingDecision[];
}

/**
 * Route on the judge's answers. The chosen `stop_reason` decides when there is
 * one: in use it moves with the rounds while the probability answers stay
 * flat, so it is the answer that discriminates. A chosen `continue` runs
 * another round whatever the probability answers say. A clear yes or no from
 * `holds`, `worth_doing` or `worth_another_round` decides only when there is
 * no choice: a question set without `stop_reason`, or a reply that did not
 * parse. The cap is not checked here: `askJudge` turns a decision after
 * the last review the cap allows into a stop. A block finding is decided
 * here like any other.
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
 *
 * With `findingIds`, the round answer routes as above only to settle
 * `product_decision`; the answer for each finding decides the rest (see
 * `decideEachFinding`). `questions` are the questions each finding was
 * asked; a choice with no reason of its own records the text of the chosen
 * option from its finding's question.
 */
export function judgeDecision(answers: Readonly<Record<string, JudgeAnswer>>, findingIds?: readonly string[], questions?: JudgeQuestions): JudgeDecision {
  const round = roundDecision(answers);
  if (!findingIds?.length) return round;
  return decideEachFinding(answers, findingIds, round, questions);
}

/**
 * Route on the judge's answer for each finding. `product_decision` stands as
 * the round answer gives it. Otherwise any finding the judge acts on runs
 * another round, and a round with none ships as a pass, whatever the round
 * answer says: a chosen `not_converging` does not drop acted findings, and
 * it does not fail a round whose findings are all skipped. A finding the
 * judge did not answer, or answered with neither choice, follows the round
 * answer: it goes back when that answer runs another round, and is skipped
 * when that answer ships. When the judge answered no finding at all, the
 * round answer routes alone, with the same reason and rule as before.
 */
function decideEachFinding(answers: Readonly<Record<string, JudgeAnswer>>, findingIds: readonly string[], round: JudgeDecision, questions?: JudgeQuestions): JudgeDecision {
  const findings = findingIds.map((id): FindingDecision => {
    const answer = answers[id];
    const choice = answer?.choice;
    const reason = typeof answer?.reason === 'string' && answer.reason.trim() ? answer.reason.trim() : undefined;
    if (choice === 'act' || choice === 'skip') {
      const question = questions?.[id];
      const criteria = question?.type === 'choice' ? question.criteria : FINDING_CRITERIA;
      return { id, decision: choice, reason: reason ?? criteria[choice] ?? FINDING_CRITERIA[choice] };
    }
    return { id, decision: round.again ? 'act' : 'skip', reason: `no answer for this finding; ${round.reason}` };
  });
  const answered = findings.some(({ id }) => answers[id]?.choice === 'act' || answers[id]?.choice === 'skip');
  // A judge that answered no finding decided nothing about them: every finding stands, as with whole-round judging.
  if (!answered) return round;
  if (round.stop === 'product_decision') return { ...round, findings };
  const acted = findings.filter((finding) => finding.decision === 'act').length;
  const rule = `findings: ${acted} act, ${findings.length - acted} skip`;
  if (acted) return { again: true, reason: `the judge acts on ${acted} of ${findings.length} findings`, rule, findings };
  return { again: false, stop: 'ship', reason: 'the judge skipped every finding', rule, findings };
}

function roundDecision(answers: Readonly<Record<string, JudgeAnswer>>): JudgeDecision {
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
 * The line the judge reads about the round limit: none with no cap, and the
 * last round when no build round follows this review. Absent otherwise.
 */
function roundLimit(state: JudgeState): string | undefined {
  if (state.cap === undefined) return 'No round limit: the rounds end when you stop them or the review passes.';
  if (state.lastRound) return `This is the last round the cap of ${state.cap} allows: no build round follows, so your answer decides how this ends.`;
  return undefined;
}

/**
 * Ask the judge, and record its answer. Runs `cfg.seat` as a workspace-mode-
 * none agent turn over `state` and `cfg.questions`, parses the reply as the
 * judge engine's own `{ [question]: JudgeAnswer }` shape, and emits
 * `refine:judge` so a person reading the record sees what it answered and
 * why. The state it sends carries `limit`, a line about the round limit,
 * when there is no cap or this is the last round. When the judge decides
 * each finding, the questions also carry one per finding in
 * `state.latestFindings`. A reply that fails to parse becomes an empty
 * answers object, and `judgeDecision` reads that as no clear answer, which
 * runs another round.
 *
 * After the last review the cap allows (`state.lastRound`), only a stop
 * that lets the work stand passes, and it records the open findings; a
 * `product_decision` still asks a person; anything else is a stop that
 * fails, with the cap named in the reason.
 */
export async function askJudge(
  cfg: Judge,
  state: JudgeState,
  ctx: JobContext,
  path: readonly string[],
): Promise<{ answers: Readonly<Record<string, JudgeAnswer>>; decision: JudgeDecision }> {
  const perFinding = cfg.perFinding && state.latestFindings.length > 0;
  const eachFinding = perFinding ? findingQuestions(state.latestFindings) : undefined;
  const limit = roundLimit(state);
  const judgeJob = agentJob({
    label: 'refine:judge',
    engine: cfg.seat.engine,
    model: cfg.seat.identity.model,
    workspaceMode: 'none',
    tools: [],
    leaf: true,
    prompt: JSON.stringify({
      state: limit === undefined ? state : { ...state, limit },
      questions: eachFinding ? { ...cfg.questions, ...eachFinding } : cfg.questions,
    }),
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
  const decided = judgeDecision(answers, eachFinding ? Object.keys(eachFinding) : undefined, eachFinding);
  const decision: JudgeDecision = state.lastRound && decided.stop !== 'ship' && decided.stop !== 'product_decision'
    ? { ...decided, again: false, stop: 'fail', reason: `${decided.reason}; this was the last round the cap of ${state.cap} allows` }
    : decided;
  const status = decision.stop === 'ship' ? 'pass' : decision.stop === 'fail' ? 'fail' : undefined;
  ctx.emit({
    kind: 'refine:judge', ts: Date.now(), path: [...path], answers, reason: decision.reason,
    route: decision.again ? 'again' : 'stop', rule: decision.rule, ...(status ? { status } : {}),
    ...(decision.findings ? { findings: decision.findings } : {}),
    ...(state.lastRound && decision.stop === 'ship' ? { openFindings: state.latestFindings } : {}),
  });
  return { answers, decision };
}

/**
 * Ask the judge, or resume its pending product question. When the judge
 * chooses `product_decision`, a person is asked, and their answer comes back
 * as `answer` for the caller to send to the builder; the judge is not asked
 * again until that round has been built and reviewed. After the last review
 * the cap allows, the person is still asked, and the caller records their
 * answer and fails, since no build round follows (`lastRoundAnswered`).
 */
export async function consultJudge(
  cfg: Judge,
  state: JudgeState,
  ctx: JobContext,
  path: readonly string[],
  options: { readonly identity: string; readonly pending: boolean; readonly save: (state: JudgeState) => void },
): Promise<{ state: JudgeState; decision: JudgeDecision } | { state: JudgeState; paused: Outcome } | { state: JudgeState; answer: InteractionResponse }> {
  let asked = state;
  if (!options.pending) {
    const { decision } = await askJudge(cfg, state, ctx, path);
    if (decision.stop !== 'product_decision') return { state, decision };
    // Kept with the question, so a resumed run still knows which findings the judge would act on.
    if (decision.findings) asked = { ...state, decided: decision.findings };
  }
  options.save(asked);
  const answer = await requestInteraction(cfg.interaction ?? DEFAULT_INTERACTION,
    'What product decision should guide this review?', jsonSnapshot({
      requester: { path, identity: options.identity, engine: cfg.seat.identity, round: state.round },
      material: asked,
    }), ctx);
  if ('paused' in answer) return { state: asked, paused: answer.paused };
  return { state: { ...asked, productFeedback: [...(asked.productFeedback ?? []), answer.response] }, answer: answer.response };
}

/**
 * Why the run stops when a person answers a product decision after the last
 * review the cap allows: their answer is recorded here, and no build round
 * follows to apply it.
 */
export function lastRoundAnswered(state: JudgeState, answer: InteractionResponse): string {
  return `the judge requested a product decision after the last round the cap of ${state.cap} allows; a person answered "${answer.prompt}", and no build round follows to apply it`;
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

/**
 * What the judge's decisions on a round's findings send on: the findings it
 * acts on, each carrying its reason, and the skipped list grown by this
 * round's skips. A round the judge did not decide each finding of sends
 * every finding and skips none.
 */
export function judgedFindings(
  findings: readonly FeedbackFinding[],
  decision: Pick<JudgeDecision, 'findings'>,
  skipped: readonly SkippedFinding[],
  round: number,
): { acted: FeedbackFinding[]; skipped: SkippedFinding[] } {
  if (!decision.findings) return { acted: [...findings], skipped: [...skipped] };
  const acted: FeedbackFinding[] = [];
  const next = [...skipped];
  for (const [index, finding] of findings.entries()) {
    const item = decision.findings[index]!;
    if (item.decision === 'act') acted.push({ ...finding, judgeReason: item.reason });
    else if (!next.some((entry) => entry.finding.evidence === finding.evidence)) next.push({ round, finding, reason: item.reason });
  }
  return { acted, skipped: next };
}
