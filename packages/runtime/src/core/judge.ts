/**
 * A judge: a seat that answers typed questions about a piece of work and the
 * rounds spent on it so far, in place of a plain review-round count. Used on
 * a `workflow()` stage's `refine` and on a `dag()`'s `maxKickbacks`, between
 * a review's verdict and the send-back.
 *
 * The default question set and the routing rule below are ported from a
 * proven pattern (`obversa-workflows/public-docs-writer`, and its evidence:
 * six real runs where the `stop_reason` choice moved with the rounds while
 * the noul (probability) answers sat flat) — this file makes that pattern a
 * runtime primitive instead of hand-wired DAG nodes.
 */

import { agentJob } from './job.js';
import { normalizeFeedbackSeverity } from './feedback.js';
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
      instructions: 'Are we at the point of diminishing returns? If so, which kind; if not, continue.',
      criteria: {
        holds: `${what} holds for this use case.`,
        over_polishing: 'The remaining findings are taste, nits or edge cases past the bar.',
        not_converging: 'The same class of finding keeps returning, so another round will not fix it.',
        continue: 'Another round is worth it.',
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
export function judge(seat: Judge['seat'], opts: { cap: number; questions?: JudgeQuestions }): Judge {
  if (!Number.isSafeInteger(opts.cap) || opts.cap < 1) {
    throw new TypeError('judge cap must be a positive integer');
  }
  return { kind: 'judge', seat, cap: opts.cap, questions: opts.questions ?? stopQuestions() };
}

export function isJudge(value: unknown): value is Judge {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'judge';
}

/** A finding tagged block, by any reviewer, in this round's findings. */
export function hasBlockFinding(findings: readonly FeedbackFinding[] | undefined): boolean {
  return (findings ?? []).some((finding) => normalizeFeedbackSeverity(finding.severity) === 'block');
}

const SEVERITIES: readonly FeedbackActionSeverity[] = ['block', 'should-fix', 'nice-to-have', 'approve'];

/** Every finding, counted by severity — the judge reads numbers, not a list to recount itself. */
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
}

/**
 * Route on the judge's answers. Evidence from six real runs: the noul
 * (probability) answers sat flat across rounds while the chosen `stop_reason`
 * moved with them — so that choice is read first, and a clear yes/no from
 * `holds`/`worth_doing`/`worth_another_round` is the fallback for when the
 * choice does not parse. Neither the cap nor a block finding is checked
 * here: the caller enforces the cap itself (a loop's own `maxReviewRestarts`,
 * or a dag's own kickback budget), and a block finding never reaches this
 * function — it always goes back without asking the judge.
 */
export function judgeDecision(answers: Readonly<Record<string, JudgeAnswer>>): JudgeDecision {
  const worth = answers.worth_another_round?.noul ?? answers.worth_another_round?.probability;
  const doing = answers.worth_doing?.noul ?? answers.worth_doing?.probability;
  const holds = answers.holds?.noul ?? answers.holds?.probability;
  const reason = answers.stop_reason?.choice ?? 'unknown';
  if (reason !== 'unknown' && reason !== 'continue') {
    return { again: false, reason: `the judge chose ${reason}` };
  }
  if (typeof holds === 'number' && holds >= 0.5) {
    return { again: false, reason: `the judge says it holds (${holds.toFixed(2)})` };
  }
  if (typeof doing === 'number' && doing < 0.5) {
    return { again: false, reason: `the judge says the findings are not worth doing (${doing.toFixed(2)})` };
  }
  if (typeof worth === 'number' && worth < 0.5) {
    return { again: false, reason: `the judge says another round is not worth it (${worth.toFixed(2)})` };
  }
  return {
    again: true,
    reason: `the judge says another round is worth it${typeof worth === 'number' ? ` (${worth.toFixed(2)})` : ''}`,
  };
}

/**
 * Ask the judge, and record its answer. Runs `cfg.seat` as a workspace-mode-
 * none agent turn over `state` and `cfg.questions`, parses the reply as the
 * judge engine's own `{ [question]: JudgeAnswer }` shape, and emits
 * `refine:judge` so a person reading the record sees what it answered and
 * why. A reply that fails to parse becomes an empty answers object —
 * `judgeDecision` reads that as `stop_reason: 'unknown'`, which is not a
 * chosen stop, so the caller's own cap is what ends the rounds.
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
      // Left empty: an unreadable answer routes as "unknown", not a crash.
    }
  }
  const decision = judgeDecision(answers);
  ctx.emit({ kind: 'refine:judge', ts: Date.now(), path: [...path], answers, reason: decision.reason });
  return { answers, decision };
}
