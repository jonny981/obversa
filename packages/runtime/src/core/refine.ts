/**
 * The node owns its refinement. `review()` builds the `refine` a `dag()`
 * node carries: the checks, goal check, reviewers, judge and round limits of
 * the work it does, which govern the send-backs later nodes declare to it
 * as well as the node's own reviews.
 *
 * The same machinery a reviewed `workflow()` stage runs on lives here, so
 * the two public surfaces take the same rounds, judges and verdicts: a
 * `workflow()` stage's `refine`/`reviewedBy` compiles to the same fields a
 * `dag()` node declares.
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { modelIdentity, type SeatChoice } from '@obversa/api';

import { INVALID_TEAM_DECISION, outcomeFromAgentText, withDecisionRetry } from './agent-response.js';
import { commandJob, predicate } from './condition.js';
import { copyJobMeta, declaredWrites, declareWrites, jobMeta } from './describe.js';
import { LoopError } from './errors.js';
import { isLimitError } from './limits.js';
import { assertDistinctChoices, seatIdentity, seatList } from './seat.js';
import { revisionFromOutcome } from './feedback.js';
import { reviewPanel } from './synthesis.js';
import {
  consultJudge,
  goalVerdicts,
  isJudge,
  judgedFindings,
  judgeRound,
  judgeState,
  minorFindings,
  productDecisionFeedback,
  readJudgedWork,
  type JudgeCheck,
  type JudgeState,
} from './judge.js';
import { agentJob, RECORDED_ENGINE_USAGE, type RecordedEngineUsage } from './job.js';
import { loop } from './loop.js';
import { answeredFindingIds, watchRoundChange } from './round-change.js';
import {
  checkpointInteraction,
  hasSavedInteraction,
  interactionIdentity,
  jsonSnapshot,
  outcomeSnapshot,
  savedInteraction,
} from './interaction.js';
import { roundRule } from './rounds.js';
import { TARGET_ROUNDS, type TargetRounds } from './context.js';
import type {
  DagConfig,
  DagNode,
  Job,
  JobContext,
  Judge,
  Outcome,
  Review,
  ReviewConfig,
  ReviewerSeat,
} from './types.js';

/* ------------------------------------------------------------------ */
/* Seats                                                               */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* File guards                                                         */
/* ------------------------------------------------------------------ */

interface FileSnapshot {
  exists: boolean;
  hash: string | null;
}

async function snapshotFile(path: string): Promise<FileSnapshot> {
  try {
    const details = await stat(path);
    if (!details.isFile()) return { exists: true, hash: null };
    const contents = await readFile(path);
    return { exists: true, hash: createHash('sha256').update(contents).digest('hex') };
  } catch {
    return { exists: false, hash: null };
  }
}

export function requireNonEmptyFiles(
  label: string,
  job: Job,
  workspace: string,
  files: readonly string[],
): Job {
  return async (ctx) => {
    const outcome = await job(ctx);
    if (outcome.status !== 'pass') return outcome;
    for (const file of files) {
      const path = join(workspace, file);
      const missing = await stat(path).then((details) => !details.isFile() || details.size === 0).catch(() => true);
      if (missing) {
        // The step claims the work is done but left nothing to review: a
        // retryable failure, so a round's until gate or check budget sends
        // it back rather than the run ending on it.
        const summary = `${label} did not produce a non-empty file: ${file}`;
        return {
          status: 'fail',
          summary,
          error: new LoopError({ code: 'VALIDATION', phase: 'body', retryable: true, message: summary }),
        };
      }
    }
    return outcome;
  };
}

export function requireNoFiles(
  label: string,
  job: Job,
  workspace: string,
  files: readonly string[],
  phase: 'body' | 'review' = 'review',
): Job {
  const wrapper: Job = async (ctx) => {
    const before = new Map<string, FileSnapshot>();
    for (const file of files) {
      before.set(file, await snapshotFile(join(workspace, file)));
    }
    const outcome = await job(ctx);
    const changed: string[] = [];
    for (const file of files) {
      const after = await snapshotFile(join(workspace, file));
      const previous = before.get(file)!;
      if (
        previous.exists !== after.exists
        || previous.hash !== after.hash
      ) {
        changed.push(file);
      }
    }
    if (changed.length) {
      const summary = `${label} wrote, changed or removed the implementation before its step completed: ${changed.join(', ')}`;
      return {
        status: 'fail',
        summary,
        error: new LoopError({ code: 'WRITE_BOUNDARY', phase, message: summary }),
      };
    }
    return outcome;
  };
  return copyJobMeta(wrapper, job);
}

/* ------------------------------------------------------------------ */
/* The review() builder                                                */
/* ------------------------------------------------------------------ */

export function isReview(value: unknown): value is Review {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'review';
}

/** A named reviewer entry. A bare `{ seat, candidates }` alternatives shape
 * also carries `seat`, so the name is what marks the entry: only it
 * discriminates the two, never the `seat` field. */
function isReviewerEntry(value: unknown): value is ReviewerSeat {
  return typeof value === 'object' && value !== null && 'seat' in (value as object) && 'name' in (value as object);
}

function isCommand(value: unknown): value is string | readonly string[] {
  if (typeof value === 'string') return value.trim().length > 0;
  return Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === 'string' && part.length > 0);
}

/** The reviewers `review()` named by position: a node's panel names them `<node>-N`, the workflow stage convention. */
const autoNamed = new WeakSet<ReviewerSeat>();

/**
 * Build the `refine` a `dag()` node carries. `checks` are commands run
 * through `commandJob` as it ships; `goal` is the job `goalCheck()` returns;
 * `reviewers` are seats (or named seats with a scope) run as one panel;
 * `judge` is the value `judge()` returns. `rounds` bounds the review rounds
 * after the first build when there is no judge, and is required then;
 * `checkRounds` bounds how often a failed check or a missing file sends the
 * work back (default 3). `fixer` names the seat that repairs the work on
 * the kept findings; the node's own `agent` is the default.
 */
export function review(config: ReviewConfig): Review {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('review() takes its options in one object');
  }
  const checks = config.checks === undefined ? [] : (() => {
    if (!Array.isArray(config.checks) || config.checks.some((command) => !isCommand(command))) {
      throw new TypeError('review() checks must be commands: a non-empty string or an argv array of strings');
    }
    return [...config.checks];
  })();
  if (config.goal !== undefined && typeof config.goal !== 'function') {
    throw new TypeError('review() goal takes the job goalCheck() returns');
  }
  const reviewers = config.reviewers === undefined ? undefined : (() => {
    if (!Array.isArray(config.reviewers) || !config.reviewers.length) {
      throw new TypeError('review() reviewers must be a non-empty list of seats');
    }
    return config.reviewers.map((entry, index): ReviewerSeat => {
      const declared = isReviewerEntry(entry);
      // `candidates` next to the reviewer's name is not part of a named
      // entry: the rebuild below keeps only `name`, `seat` and `scope`, so
      // the alternatives would be dropped without a word. Refuse it.
      if (declared && 'candidates' in entry) {
        throw new TypeError(
          `review() reviewers[${index}] takes its seat's alternatives on the seat, not next to the reviewer's name: { name, seat: { seat, candidates } }`,
        );
      }
      const definition = declared
        ? entry
        : { name: `reviewer-${index + 1}`, seat: entry as SeatChoice };
      seatList(definition.seat);
      if (definition.scope !== undefined && (typeof definition.scope !== 'string' || !definition.scope.trim())) {
        throw new TypeError(`review() reviewers[${index}] scope must be a non-empty string`);
      }
      const built: ReviewerSeat = { name: definition.name, seat: definition.seat, ...(definition.scope === undefined ? {} : { scope: definition.scope }) };
      if (!declared) autoNamed.add(built);
      return built;
    });
  })();
  if (reviewers !== undefined) assertDistinctChoices(reviewers.map((definition) => definition.seat));
  const pass = config.pass === undefined ? 'all' : (() => {
    if (config.pass === 'all') return 'all' as const;
    if (reviewers === undefined) throw new TypeError('review() pass needs reviewers');
    if (!Number.isSafeInteger(config.pass) || config.pass < 1 || config.pass > reviewers.length) {
      throw new TypeError(`review() pass must be 'all' or between 1 and ${reviewers.length}`);
    }
    return config.pass;
  })();
  if (config.pass !== undefined && reviewers === undefined) {
    throw new TypeError('review() pass needs reviewers');
  }
  if (config.synthesise !== undefined && config.synthesise !== true) {
    seatIdentity(config.synthesise);
    if (reviewers === undefined) throw new TypeError('review() synthesise needs reviewers');
  }
  if (config.synthesise !== undefined && reviewers === undefined) {
    throw new TypeError('review() synthesise needs reviewers');
  }
  if (config.judge !== undefined && !isJudge(config.judge)) {
    throw new TypeError('review() judge takes the value judge() returns');
  }
  if (config.judge !== undefined && config.rounds !== undefined) {
    throw new TypeError('review() takes rounds or judge, not both: the judge and its cap decide the rounds');
  }
  if (config.judge === undefined && config.rounds === undefined) {
    throw new TypeError('review() needs rounds or a judge: with no judge, rounds bounds the send-backs');
  }
  if (config.rounds !== undefined && (!Number.isSafeInteger(config.rounds) || config.rounds < 0)) {
    throw new TypeError('review() rounds must be a whole number, 0 or more');
  }
  if (config.checkRounds !== undefined && (!Number.isSafeInteger(config.checkRounds) || config.checkRounds < 0)) {
    throw new TypeError('review() checkRounds must be a whole number, 0 or more');
  }
  if (config.fixer !== undefined) seatIdentity(config.fixer);
  return {
    kind: 'review',
    checks,
    ...(config.goal === undefined ? {} : { goal: config.goal }),
    ...(reviewers === undefined ? {} : { reviewers }),
    pass,
    ...(config.synthesise === undefined ? {} : { synthesise: config.synthesise }),
    ...(config.judge === undefined ? {} : { judge: config.judge }),
    ...(config.rounds === undefined ? {} : { rounds: config.rounds }),
    checkRounds: config.checkRounds ?? 3,
    ...(config.fixer === undefined ? {} : { fixer: config.fixer }),
  };
}

/** The node's send-back policy: `rounds` or the judge's cap (none when the judge is uncapped). */
export function refinePolicy(refine: Review): number | Judge {
  return refine.judge ?? refine.rounds!;
}

/** Whether the node's refine runs its own review each round, past a plain round limit. */
export function ownReviews(refine: Review): boolean {
  return refine.checks.length > 0 || refine.goal !== undefined || refine.reviewers !== undefined;
}

/** A node's `writes` as a file list: none for 'workspace' or a read-only node. */
export function writeList(writes: DagNode['writes']): string[] {
  if (writes === undefined || writes === 'workspace') return [];
  return typeof writes === 'string' ? [writes] : [...writes];
}

/** The files a node's work is judged by: its `writes` list and its `file`. */
export function nodeFiles(node: DagNode): string[] {
  return [...new Set([...writeList(node.writes), ...(node.file === undefined ? [] : [node.file])])];
}

/** The scope a node's reviewers judge: its named files, or the whole workspace when `writes` is 'workspace'. */
function reviewFiles(node: DagNode): string[] {
  return node.writes === 'workspace' ? [] : nodeFiles(node);
}

/* ------------------------------------------------------------------ */
/* The rounds machinery shared by dag() nodes and workflow() stages    */
/* ------------------------------------------------------------------ */

/**
 * Why a judged review stopped the rounds, by the error it threw to end its
 * loop: the review's failure, with its findings and the judge's reason. A
 * check that sent the work back once too often stops the same way.
 */
export const roundStops = new WeakMap<LoopError, Outcome>();

/**
 * What one run of a judged stage keeps between its rounds. The graph keeps
 * the count of builds, the judge's history and the draft the last round
 * reviewed, shared with the send-backs to the stage.
 */
export interface JudgedRun {
  readonly shared: TargetRounds;
  /** The stage's builds after its first, before this run of it. */
  readonly base: number;
  /** The rounds this run counted toward the review budget, so far. */
  readonly reviewed: () => number;
}

/** What one run of `refinedRounds` knows about the work under review. */
export interface RefinedWork {
  readonly name: string;
  /** The brief or ticket text the work answers, digested into the rounds' resume identity. */
  readonly brief: unknown;
  /** The declared shape the rounds' resume identity digests. */
  readonly config: unknown;
  /** The files the work declares it writes, for the builds' declared writes. */
  readonly writes: readonly string[];
  /** The round policy: N refinements after the first build, or a judge. */
  readonly refine: number | Judge;
}

/** The numeric cap, whichever shape the policy was given; none for a judge with no cap. */
function refineCap(refine: number | Judge): number | undefined {
  return isJudge(refine) ? refine.cap : refine;
}

/** A refine loop's build round, followed by a record of what it changed. */
export function recordRoundChange(job: Job): Job {
  return declareWrites(copyJobMeta(async (ctx) => {
    const recordChange = await watchRoundChange(ctx);
    const outcome = await job(ctx);
    await recordChange?.({ path: ctx.path, round: ctx.iteration, findings: answeredFindingIds(ctx.lastReview) });
    return outcome;
  }, job), (outcome) => declaredWrites(job, outcome));
}

/**
 * A review with a judge between its verdict and the send-back, for every
 * finding, a block included. The judge's history, the findings it skipped
 * and a person's product answers live in `run`, which belongs to one run of
 * the graph. The judge reads what the graph gives a judge of this work
 * (`shared.work`: the brief, the use case, the node's `desc` and `gate`,
 * its file and the workspace when the work began), this round's checks
 * and goal check verdicts (`shared.evidence()`), the latest findings, the
 * findings it skipped before, and every round so far. Its answer either lets the review
 * stand (a synthesised pass), sends it back with its reasoning folded into
 * the existing rejection, or stops the rounds with the review's failure.
 * When it decides each finding, the send-back carries only the findings it
 * calls impactful, and the findings it holds back go to the next round's
 * reviewers as `ctx.skippedFindings`. `before`, when set, runs ahead of the review each
 * round, and a result that is not a pass is the round's outcome with no
 * review and no judge.
 */
export function judgedReview(work: RefinedWork, cfgJudge: Judge, review: Job, run: JudgedRun, before?: Job): Job {
  const shared = run.shared;
  const judgedWork = shared.work;
  const identity = interactionIdentity({ brief: work.brief, config: work.config, cfgJudge });
  return async (ctx) => {
    const checkpointPath = [...ctx.path, '@judge-review'];
    let saved = savedInteraction(ctx, checkpointPath, identity);
    let { draft, changedLines, tree } = await readJudgedWork(ctx.workspace.dir, judgedWork, { draft: shared.previousDraft, tree: shared.rounds.at(-1)?.tree }, ctx.fingerprintExcludePaths);
    const savedState = saved?.state as unknown as JudgeState | undefined;
    // The checkpoint stands only for the draft it saved: the saved draft's
    // hash against the draft read fresh, so a draft that changed since the
    // pause is judged as it is now, and one that did not keeps the saved
    // panel. A saved state without a draft stands only when none is read.
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    if (saved && (savedState?.draft === undefined
      ? draft !== undefined
      : draft === undefined || hash(savedState.draft) !== hash(draft))) saved = undefined;
    if (saved) {
      shared.rounds = savedState!.rounds;
      shared.productFeedback = savedState!.productFeedback ?? [];
      shared.skipped = savedState!.skipped ?? [];
    }
    // A saved question means `before` passed in this round: it does not run again.
    if (!saved && before) {
      const checked = await before(ctx);
      if (checked.status !== 'pass') return checked;
      // Only a goal check leaves verdicts to record; an artifact or command
      // `before` has none, and writing an empty goals entry is just noise.
      const verdicts = goalVerdicts(checked);
      if (verdicts !== undefined) shared.goal = verdicts;
      // A check can write or update the file the judge reads, the way a
      // build produces it: read the work again so the judge and the round
      // the record keeps describe the bytes it left.
      ({ draft, changedLines, tree } = await readJudgedWork(ctx.workspace.dir, judgedWork, { draft: shared.previousDraft, tree: shared.rounds.at(-1)?.tree }, ctx.fingerprintExcludePaths));
    }
    const reviewOutcome: Outcome = saved ? saved.panel as unknown as Outcome : await review({
      ...ctx,
      ...(shared.skipped.length ? { skippedFindings: shared.skipped } : {}),
    });
    // Only a refusal goes to the judge: a pass stands, and a review still
    // waiting for a person pauses the run before the judge is asked. A pass
    // still carries the findings the earlier rounds held back: the list a
    // person reads before the work lands.
    if (reviewOutcome.status !== 'fail') {
      const minors = reviewOutcome.status === 'pass' ? minorFindings(shared.skipped) : [];
      return minors.length ? { ...reviewOutcome, minorFindings: minors } : reviewOutcome;
    }
    const findings = revisionFromOutcome(reviewOutcome)?.findings ?? [];
    // The round is the work's build in this run: its builds before this
    // run of it, and the rounds this one counted toward the review budget.
    // A round a red check sent back does not count toward it.
    const round = roundRule(run.base + run.reviewed(), cfgJudge.cap);
    // A judge paused on a failed call, like a pending product decision, is
    // asked again over the state it saved: the same draft, findings and
    // evidence its first call read. `judgeRetry` on the checkpoint is what
    // tells the two apart: only a product decision waits on a person.
    const state: JudgeState = saved !== undefined ? savedState! : judgeState({
      work: judgedWork, draft, tree, ...shared.evidence(), productFeedback: shared.productFeedback, latestFindings: findings, skipped: shared.skipped, rounds: shared.rounds, round: round.judge,
    });
    const result = await consultJudge(cfgJudge, state, ctx, ctx.path, {
      target: work.name, identity, pending: saved !== undefined && saved.judgeRetry !== true,
      save: (questionState, retry) => checkpointInteraction(ctx, checkpointPath, identity, jsonSnapshot({
        state: questionState, panel: outcomeSnapshot(reviewOutcome),
        ...(retry === true ? { judgeRetry: true } : {}),
      })),
    });
    // A pause inside this round leaves the count the round consumed, so a
    // resume numbers the next round after it.
    if ('paused' in result) {
      ctx.interactionCheckpoint?.(true);
      return result.paused;
    }
    checkpointInteraction(ctx, checkpointPath, identity, null);
    shared.productFeedback = result.state.productFeedback ?? [];
    shared.rounds = [...shared.rounds, judgeRound(state, changedLines, result)];
    shared.previousDraft = draft;
    // The review's failure stands, with its findings and why the rounds
    // stopped. A thrown error is the only way a review ends a loop with a
    // fail; the caller reads the outcome back from `roundStops`.
    const stop = (why: string): never => {
      const revision = revisionFromOutcome(reviewOutcome);
      const summary = `${reviewOutcome.summary ?? revision?.reason ?? 'the review did not pass'} (${why})`;
      const error = new LoopError({ code: 'VALIDATION', phase: 'review', path: ctx.path, message: summary });
      roundStops.set(error, {
        status: 'fail',
        summary,
        ...(revision ? { revision: { ...revision, reason: `${revision.reason} (${why})` } } : {}),
      });
      throw error;
    };
    // A person's answer goes back to the builder as the next round; the
    // judge sees the result only after that round has been reviewed.
    if ('answer' in result) {
      // An answered product decision buys the round that applies it, on
      // every past-cap review it lands, each time one is asked and answered:
      // the person answering is the bound.
      // The judge decided each finding before asking: the answer goes with the findings those decisions send back.
      const answered = judgedFindings(findings, { findings: result.state.decided }, result.state.skipped ?? [], state.round);
      shared.skipped = answered.skipped;
      return productDecisionFeedback(result.answer, answered.acted, { granted: round.lastRound });
    }
    const { decision } = result;
    const judged = judgedFindings(findings, decision, result.state.skipped ?? [], state.round);
    shared.skipped = judged.skipped;
    if (!decision.again) {
      // Not converging, or any answer but a ship after the last round the
      // cap allows: the stage stops here, and the review's failure stands.
      if (decision.stop === 'fail') stop(decision.reason);
      const minors = minorFindings(judged.skipped);
      return {
        status: 'pass', confidence: reviewOutcome.confidence, summary: decision.reason, data: reviewOutcome.data,
        ...(round.lastRound ? { openFindings: findings } : {}),
        ...(minors.length ? { minorFindings: minors } : {}),
      };
    }
    // The review's own summary lists every finding; when the judge decided
    // each one, the one-line reason stands in for it so the builder reads
    // only the findings it acts on. `converging` marks the round a spent cap
    // granted because the acted-on count fell, so the rounds rule lets it
    // through.
    const revision = revisionFromOutcome(reviewOutcome);
    return {
      ...reviewOutcome,
      summary: `${decision.findings && revision ? revision.reason : reviewOutcome.summary} (${decision.reason})`,
      ...(revision ? { revision: { ...revision, findings: judged.acted } } : {}),
      ...(decision.converging === true ? { converging: true as const } : {}),
    };
  };
}

/**
 * A refined node's rounds. Its own reviews and the send-backs to it from
 * later nodes share one count of builds and one judge history for the run:
 * the graph keeps both, so a send-back after the node's own reviews gets
 * only the refinements left, and a judge reads every round so far. `before`,
 * when set, runs ahead of the review each round, and a result that is not a
 * pass is the round's outcome with no review; `checkCap` bounds how often
 * that happens before the rounds stop with the check's failure. A stop the
 * judge decides, or the check cap ends, becomes the node's outcome. The
 * builds this run of the node started from are saved whenever anything in
 * it pauses for a person or its rounds advance, and a resume starts from
 * them. Each rejected round that another build follows saves the rounds so
 * far with its feedback, so a resume after a pause, an abort or a crash
 * runs the node again from the next round, with the judge's history, the
 * findings it skipped and the draft it last read.
 */
export function refinedRounds(
  rounds: (body: Job, review: Job, max: number | undefined) => Job,
  body: Job,
  work: RefinedWork,
  review: Job,
  before?: Job,
  checkCap?: number,
): Job {
  const refine = work.refine;
  const refinements = refineCap(refine);
  // A failed check sends the work straight back, bounded by `checkCap`
  // across the run (its own rounds and the send-backs to it, one count in
  // `shared.checkBacks`). The rounds stop with the check's failure; no
  // judge or vote can waive it.
  const guardedBefore: Job | undefined = before === undefined ? undefined : async (ctx) => {
    const checked = await before(ctx);
    const shared = (ctx as JobContext & { [TARGET_ROUNDS]?: TargetRounds })[TARGET_ROUNDS];
    if (checked.status !== 'fail' || checkCap === undefined || shared === undefined) return checked;
    // An unmet goal is a verdict like a reviewer's rejection — its outcome
    // carries the revision the requirements became — so it counts as a
    // review round, the same round a standalone goal check's send-back
    // counts as. Only a red check or a missing file draws on `checkRounds`.
    if (revisionFromOutcome(checked) !== undefined) return checked;
    shared.checkBacks += 1;
    if (shared.checkBacks > checkCap) {
      const summary = checked.summary ?? 'the checks did not pass';
      const error = new LoopError({
        code: 'VALIDATION',
        phase: 'review',
        path: ctx.path,
        message: `${summary} (the checks sent the work back ${checkCap} times)`,
      });
      roundStops.set(error, { status: 'fail', summary: error.message });
      throw error;
    }
    return checked;
  };
  const plain: Job = guardedBefore === undefined ? review : async (ctx) => {
    const checked = await guardedBefore(ctx);
    return checked.status === 'pass' ? review(ctx) : checked;
  };
  const identity = interactionIdentity({ brief: work.brief, config: work.config, cfgJudge: refine });
  // The files a resume asks this node about: what the work declares, and
  // what the job it wraps declared, as far as its outcome shows.
  const declared = (outcome: Outcome | undefined) => [...new Set([...work.writes, ...declaredWrites(body, outcome)])];
  return declareWrites(copyJobMeta(async (ctx: JobContext) => {
    const shared = (ctx as JobContext & { [TARGET_ROUNDS]: TargetRounds })[TARGET_ROUNDS];
    if (shared === undefined) return body(ctx);
    const checkpointPath = [...ctx.path, '@judge-rounds'];
    const saved = savedInteraction(ctx, checkpointPath, identity) as { base?: number } | undefined;
    // The count this run counts on from: the graph's committed count, which a
    // send-back it accepted advanced, or the count a paused run had consumed
    // when it stopped, whichever is further on.
    const base = Math.max(saved?.base ?? 0, shared.builds);
    // The rounds the review budget pays for: a round counts when its review
    // ran, when a failed check has no separate check budget to draw on, and
    // when an unmet goal sends the work back — a goal's verdict is a review
    // round in every form.
    let reviewed = 0;
    // The error of the body's last call, when a retryable failure it
    // carried could have gone back unanswered: a next body call is the
    // proof the loop retried it without the round's gates, a gate or the
    // review running in between the proof it reached them.
    let unreviewed: LoopError | undefined;
    const countedBefore: Job | undefined = guardedBefore === undefined ? undefined : async (roundCtx: JobContext) => {
      unreviewed = undefined;
      shared.failed = 0;
      const outcome = await guardedBefore(roundCtx);
      if (outcome.status === 'fail' && (checkCap === undefined || revisionFromOutcome(outcome) !== undefined)) reviewed += 1;
      return outcome;
    };
    // A round counts once its review has an answer: a pause inside it is the
    // same round still in flight, and a resume counts it when it ends.
    const countedReview = (job: Job): Job => copyJobMeta(async (roundCtx: JobContext) => {
      unreviewed = undefined;
      shared.failed = 0;
      const outcome = await job(roundCtx);
      if (outcome.status !== 'paused' && outcome.status !== 'aborted') reviewed += 1;
      return outcome;
    }, job);
    const countedPlain: Job = countedBefore === undefined ? countedReview(review) : async (roundCtx: JobContext) => {
      const checked = await countedBefore(roundCtx);
      return checked.status === 'pass' ? countedReview(review)(roundCtx) : checked;
    };
    const run: JudgedRun = { shared, base, reviewed: () => reviewed };
    // A body outcome that names a send-back route leaves the rounds now: the
    // graph routes it. Any other failure ends the rounds with the body's own
    // failure — it is not the work the reviewers judge, and no feedback
    // reaches it to build again. The error ends the loop before this round's
    // checks and reviewers take it for a rejection of the work. A retryable
    // failure the round's gates do not take goes back unanswered — the
    // review and the judge never see it — so the loop's own retry draws on
    // the same bound `checkRounds` sets, defaulting to 3 where a node
    // declares no check budget of its own. Only a judged node's rounds need
    // it: they have no bound of their own, while `rounds: N` spends each
    // failed build from `max`. A failure the until gate sends to the
    // round's checks draws on the check budget, not this one.
    const failBound = checkCap ?? 3;
    const unrunnable = (error: LoopError): Outcome => ({
      status: 'fail',
      summary: `${error.message} (the build's failures sent the work back ${failBound} times before its review could run)`,
      error: new LoopError({
        code: error.code, message: error.message, phase: error.phase, path: error.path,
        iteration: error.iteration, cause: error.cause, retryable: false,
        retryAfterMs: error.retryAfterMs, resetAt: error.resetAt, resetProven: error.resetProven,
      }),
    });
    const routed = (job: Job): Job => copyJobMeta(async (roundCtx: JobContext) => {
      // A body call after a retryable failure is the send-back no gate saw.
      // The count bounds only a judged node: its rounds have no bound of
      // their own, while `rounds: N` spends each failed build from its own
      // `max` the way it always has. A gate or the review running between
      // the calls cleared it instead, and resets the count it counts.
      if (unreviewed !== undefined) {
        const error = unreviewed;
        unreviewed = undefined;
        if (isJudge(refine) && (shared.failed += 1) > failBound) return unrunnable(error);
      }
      let outcome: Outcome;
      try {
        outcome = await job(roundCtx);
      } catch (e) {
        // A thrown failure goes back unreviewed the way a returned one
        // does: the loop retries it under its own policy, on no bound the
        // rounds set. A limit error keeps its own policy — the run waits it
        // out or pauses on it.
        const error = LoopError.from(e, { code: 'BODY', phase: 'body', path: roundCtx.path });
        if (!isLimitError(error)) unreviewed = error;
        throw e;
      }
      if (outcome.status === 'fail' && outcome.error?.retryable === true && !isLimitError(outcome.error)) {
        unreviewed = outcome.error;
        return outcome;
      }
      if (outcome.status !== 'fail' || outcome.error !== undefined) return outcome;
      const routes = revisionFromOutcome(outcome)?.target !== undefined;
      const error = new LoopError({
        code: 'VALIDATION',
        phase: 'body',
        path: roundCtx.path,
        message: outcome.summary ?? 'the work failed',
      });
      if (routes) roundStops.set(error, outcome);
      return { ...outcome, error };
    }, job);
    // A rejected round that another build follows, an unmet requirement
    // included: the graph saves the rounds so far, so a resume after a pause,
    // an abort or a crash builds the next round with this feedback. When the
    // review budget runs out, the failure stands as the outcome.
    const saveRejected = (job: Job): Job => copyJobMeta(async (roundCtx: JobContext) => {
      const outcome = await job(roundCtx);
      if (outcome.status === 'fail' && revisionFromOutcome(outcome)?.target === undefined) {
        const round = base + reviewed;
        // Each answered product decision past the cap buys its round, and
        // the spent cap grants a round while the findings the judge acts on
        // are still falling: both are marked on the send-back they bought.
        const granted = refinements !== undefined && round > refinements
          && (outcome.productDecision === true || outcome.converging === true);
        if (roundRule(round, refinements).another || granted) {
          shared.builds = round;
          shared.save(outcome);
        } else {
          const error = new LoopError({
            code: 'VALIDATION',
            phase: 'review',
            path: roundCtx.path,
            message: `review rejected round ${round} with no refinements left: ${outcome.summary ?? 'no reason given'}`,
          });
          roundStops.set(error, { ...outcome, summary: error.message });
          throw error;
        }
      }
      return outcome;
    }, job);
    // The loop's bound is the most builds one invocation of it can make:
    // a first build and the review rounds `rounds` allows, plus the
    // check-backs `checkRounds` allows when the node has checks. A judge
    // sets no bound here: past the cap, `saveRejected` and the judge's own
    // routing decide each round, a product answer or a still-falling count
    // grants one and a pause waits on a person, so the count cannot be fixed
    // ahead of the rounds. It stays the same whatever `base` the run counts
    // on from, so the loop's saved checkpoint matches it on a resume. A red
    // check past `checkCap` ends the rounds in `guardedBefore`.
    const max = refinements === undefined || isJudge(refine) ? undefined : refinements + 1 + (guardedBefore === undefined ? 0 : (checkCap ?? 0));
    let checkpointed = saved !== undefined;
    const outcome = await rounds(declareWrites(routed(body), declared), saveRejected(isJudge(refine) ? judgedReview(work, refine, countedReview(review), run, countedBefore) : countedPlain), max)({
      ...ctx,
      interactionCheckpoint(progress) {
        ctx.interactionCheckpoint?.(progress);
        checkpointed = true;
        checkpointInteraction(ctx, checkpointPath, identity, jsonSnapshot({ base: base + reviewed }), progress === true);
      },
    });
    if (outcome.status === 'paused' || outcome.status === 'aborted') return outcome;
    // A node that passed keeps the count it passed with, so a resume that
    // runs it again, because its file is gone, can build the round it passed
    // in again.
    if (checkpointed) checkpointInteraction(ctx, checkpointPath, identity, outcome.status === 'pass' ? jsonSnapshot({ base: base + Math.max(0, reviewed - 1) }) : null, outcome.status === 'pass');
    shared.builds = base + Math.max(0, reviewed - 1);
    const stop = outcome.status === 'fail' && outcome.error ? roundStops.get(outcome.error) : undefined;
    return stop ? { ...outcome, ...stop } : outcome;
  }, rounds(body, plain, refinements === undefined || isJudge(refine) ? undefined : refinements + 1 + (guardedBefore === undefined ? 0 : (checkCap ?? 0)))), declared);
}

/* ------------------------------------------------------------------ */
/* The recorded-family gate                                            */
/* ------------------------------------------------------------------ */

/**
 * The family a recorded answer belongs to, read through the one derivation
 * every harness that runs other providers' models shares. A model string the
 * derivation refuses (no family, or the `unknown` placeholder) is unreadable
 * here, and an unreadable family refuses the review rather than passing it.
 */
function recordedFamilyOf(model: string): string | undefined {
  try {
    return modelIdentity(model).modelFamily;
  } catch {
    return undefined;
  }
}

function recordedUsage(ctx: JobContext): readonly RecordedEngineUsage[] {
  const value = ctx.state[RECORDED_ENGINE_USAGE];
  return Array.isArray(value) ? value as readonly RecordedEngineUsage[] : [];
}

/** Refuse a panel when a recorded answer contradicts the distinct-family
 * requirement: an answer whose recorded family equals a family it must
 * differ from, or an answer whose family cannot be read at all. Every
 * recorded answer up to the panel is read, never the first per seat. The
 * refusal names the seats, their declared families and the answers, so a
 * reader can act on it without reading source. Fail closed on identity,
 * never pass in silence. */
function assertRecordedFamilies(
  records: readonly RecordedEngineUsage[],
  opposing: readonly { readonly label: string; readonly family: string }[],
): void {
  const declared = opposing.map((seat) => `${seat.label} declares ${seat.family}`).join('; ');
  for (const record of records) {
    const family = recordedFamilyOf(record.model);
    if (family === undefined) {
      throw new LoopError({
        code: 'BODY',
        phase: 'review',
        message: `recorded model family is unknown: the answer ${record.model} carries no readable family, and ${declared}; a panel that requires distinct families refuses an unreadable answer`,
      });
    }
    const collision = opposing.find((seat) => seat.family === family);
    if (collision !== undefined) {
      throw new LoopError({
        code: 'BODY',
        phase: 'review',
        message: `recorded model family collision: the answer ${record.model} belongs to the family ${family}, and ${collision.label} declares ${collision.family}; the panel requires the recorded answers to differ from it (${declared})`,
      });
    }
  }
}

/** The gate around a review panel: before the reviewers run, every recorded
 * answer from the work this panel must differ from is compared against
 * the reviewers' declared families; after the reviewers run, their own
 * recorded answers are compared against the families they must differ
 * from. Tagged writer and reviewer answers are checked; untagged advisor
 * and agentCheck answers are outside this gate. An unreadable family on
 * either tagged side is a refusal, never a pass. */
export function recordedFamilyGate(
  panel: Job,
  reviewers: readonly SeatChoice[],
  writers: readonly { readonly stage: string; readonly family: string }[],
  writerRunsInsidePanel: boolean,
): Job {
  const writerStageNames = [...new Set(writers.map((writer) => writer.stage))];
  // Every candidate a reviewer seat can resolve to declares its family:
  // a recorded writer answer must differ from all of them, not only the
  // primary's.
  const reviewerDeclarations = reviewers.flatMap((choice) =>
    seatList(choice).map((seat) => ({
      label: `reviewer seat ${seat.identity.model}`,
      family: seat.identity.modelFamily,
    })),
  );
  const writerDeclarations = writers.map(({ stage, family }) => ({
    label: `writer stage ${stage}`,
    family,
  })).filter((entry) => entry.family !== '');
  return declareWrites(async (ctx) => {
    try {
      const all = recordedUsage(ctx);
      const beforeLength = all.length;
      // A resume that continues the stage from its saved rounds may not run
      // the writer again: its recorded answers came back with the rounds.
      const resumingInteraction = hasSavedInteraction(ctx, ctx.path, true);
      const writerSide = (records: readonly RecordedEngineUsage[]) => records.filter(
        (record) => record.role === 'writer'
          && record.stage !== undefined
          && writerStageNames.includes(record.stage),
      );
      const panelStage = ctx.graph?.node ?? ctx.path.at(-1) ?? 'panel';
      // Every recorded writer answer up to the panel keeps the reviewers'
      // declared difference. Records are compared by role and stage, never
      // by path.
      const beforeWriters = writerSide(all.slice(0, beforeLength));
      assertRecordedFamilies(beforeWriters, reviewerDeclarations);
      const outcome = await panel(ctx);
      if (outcome.status !== 'pass') return outcome;
      const current = recordedUsage(ctx);
      const after = current.slice(beforeLength);
      const afterWriters = writerSide(after);
      if (writerRunsInsidePanel && afterWriters.length === 0 && !resumingInteraction) {
        throw new LoopError({
          code: 'BODY',
          phase: 'review',
          message: `recorded model family missing: writer stage ${writerStageNames.join(', ')} has no recorded answer in stage ${panelStage}`,
        });
      }
      assertRecordedFamilies(afterWriters, reviewerDeclarations);
      const reviewerSide = (resumingInteraction ? current : after).filter((record) => record.role === 'reviewer' && record.stage === panelStage);
      if (reviewerSide.length === 0) {
        throw new LoopError({
          code: 'BODY',
          phase: 'review',
          message: `recorded model family missing: reviewer stage ${panelStage} has no recorded answer`,
        });
      }
      assertRecordedFamilies(reviewerSide, writerDeclarations);
      // The two recorded sides themselves must be disjoint: two declared
      // differences mean nothing when one family answered both.
      const writerAnswerFamilies = new Set(
        writerSide(current).map((record) => recordedFamilyOf(record.model)).filter(
          (family): family is string => family !== undefined,
        ),
      );
      for (const record of reviewerSide) {
        const family = recordedFamilyOf(record.model);
        if (family === undefined) {
          throw new LoopError({
            code: 'BODY',
            phase: 'review',
            message: `recorded model family is unknown: the answer ${record.model} carries no readable family, and the panel requires the two recorded sides to differ`,
          });
        }
        if (writerAnswerFamilies.has(family)) {
          throw new LoopError({
            code: 'BODY',
            phase: 'review',
            message: `recorded model family collision: the answer ${record.model} belongs to the family ${family}, and a writer stage's recorded answer belongs to the same family; the panel requires the two recorded sides to be disjoint`,
          });
        }
      }
      return outcome;
    } catch (error) {
      if (error instanceof LoopError && error.message.startsWith('recorded model family')) {
        return { status: 'fail' as const, summary: error.message, error };
      }
      throw error;
    }
  }, (outcome) => declaredWrites(panel, outcome));
}

/* ------------------------------------------------------------------ */
/* Compiling a dag() node's agent and refine                           */
/* ------------------------------------------------------------------ */

/** The declared shape a refined node's rounds digest: the node's own words and its refine. */
function nodeRefineIdentity(node: DagNode): Record<string, unknown> {
  return {
    ...(node.desc === undefined ? {} : { desc: node.desc }),
    ...(node.gate === undefined ? {} : { gate: node.gate }),
    ...(node.file === undefined ? {} : { file: node.file }),
    refine: node.refine,
  };
}

/** How the node tells its agent where the work may go when it returns `revise`. */
function sendLine(routes: readonly string[]): string | undefined {
  if (routes.length === 0) return undefined;
  if (routes.length === 1) {
    return `When the work belongs to the earlier node "${routes[0]}", return "revise" to send it back there.`;
  }
  return `When the work belongs to an earlier node, return "revise" with "target" naming one of: ${routes.map((route) => `"${route}"`).join(', ')}.`;
}

/** The prompt a node's agent is built with, assembled once per run. */
function nodePrompt(
  config: DagConfig,
  name: string,
  node: DagNode,
  routes: readonly string[],
  again = false,
): (ctx: JobContext) => string {
  const writes = node.writes;
  const writeLine = writes === undefined
    ? 'This node reads but does not write.'
    : writes === 'workspace'
      ? 'This node may write anywhere in the workspace.'
      : `This node may write only: ${(Array.isArray(writes) ? writes : [writes]).join(', ')}.`;
  return (ctx) => [
    config.brief === undefined ? undefined : `Work brief:\n${config.brief}`,
    `Node: ${name}`,
    node.desc === undefined ? undefined : `Task: ${node.desc}`,
    node.gate === undefined ? undefined : `Gate: ${node.gate}`,
    writeLine,
    sendLine(routes),
    again ? 'Your previous response was not a valid decision. Return only the required JSON object.' : undefined,
    `Return one JSON object: {"status":"pass"|"revise","summary":"...","findings":[{"evidence":"...","severity":"block|should-fix|nice-to-have"}]${routes.length > 1 ? ',"target":"<node>"' : ''}}`,
  ].filter((line): line is string => line !== undefined).join('\n\n');
}

/**
 * A node's `agent` seat as a job: an `agentJob` whose prompt is assembled
 * from the graph's brief and the node's `desc`, `gate` and `writes`, whose
 * feedback the kept send-backs carry in, and whose `revise` replies send
 * the work to a route `sendsBackTo` declares.
 */
function seatBuilder(
  name: string,
  seat: SeatChoice,
  node: DagNode,
  config: DagConfig,
  routes: readonly string[],
): Job {
  const seats = seatList(seat);
  const primary = seats[0]!;
  const alternatives = seats.slice(1);
  const identity = primary.identity;
  const writes = node.writes;
  const writeFiles = writeList(writes);
  const ask = (again: boolean) => agentJob({
    label: name,
    engine: primary.engine,
    model: identity.model,
    identity,
    ...(alternatives.length === 0 ? {} : { candidates: alternatives }),
    tools: [...identity.tools],
    allowedTools: [...identity.tools],
    workspaceMode: writes === undefined ? 'read' : 'write',
    ...(writes === 'workspace' ? { writes: 'workspace' as const } : writeFiles.length ? { writes: writeFiles } : {}),
    consumeFeedback: true,
    prompt: nodePrompt(config, name, node, routes, again),
    outcome: (text) => outcomeFromAgentText(text, routes),
    recordAs: { role: 'writer', stage: name },
  });
  // A reply in prose is not a failed round: the seat is asked once more.
  return withDecisionRetry(ask(false), ask(true));
}

/** The files in `files` absent from `dir`; an empty file counts as written unless `nonEmpty` is set. */
async function missingWrites(dir: string, files: readonly string[], nonEmpty = false): Promise<string[]> {
  const missing: string[] = [];
  for (const file of files) {
    try {
      const details = await stat(join(dir, file));
      if (!details.isFile() || (nonEmpty && details.size === 0)) missing.push(file);
    } catch {
      missing.push(file);
    }
  }
  return missing;
}

/**
 * What runs ahead of the reviewers each round: the node's own `checks` in
 * order, then the `file` the build must produce, then its `goal` check. The
 * file is looked for after the checks so a check that builds it, the way
 * `pnpm build` produces its output, gets to run first. A result that is not
 * a pass is the round's outcome — no reviewers and no judge that round. A
 * red check or a missing file draws on `checkRounds`; an unmet goal counts
 * as a review round, the same round a standalone goal check's send-back
 * counts as. Each check's result is kept on the shared rounds so the judge
 * reads it ahead of the graph's own check steps. A `goal` covers a missing
 * `file`: its verdicts already say what is not there.
 */
function nodeBefore(name: string, node: DagNode, refine: Review): Job | undefined {
  const checks = refine.checks.map((command, index) => commandJob(`${name}-check-${index + 1}`, command));
  const artifact = node.file === undefined || refine.goal !== undefined ? undefined
    : async (ctx: JobContext): Promise<Outcome> =>
      (await missingWrites(ctx.workspace.dir, [node.file!])).length
        ? { status: 'fail', summary: `${name} did not write: ${node.file}` }
        : { status: 'pass' };
  if (artifact === undefined && !checks.length && refine.goal === undefined) return undefined;
  return async (ctx) => {
    const shared = (ctx as JobContext & { [TARGET_ROUNDS]?: TargetRounds })[TARGET_ROUNDS];
    const collected: JudgeCheck[] = [];
    for (const check of checks) {
      const meta = jobMeta(check);
      const outcome = await check({ ...ctx, depth: ctx.depth + 1, path: [...ctx.path, String(meta?.name ?? 'check')] });
      collected.push({
        name: String(meta?.name ?? 'check'),
        ...(typeof meta?.command === 'string' ? { command: meta.command } : {}),
        status: outcome.status,
        ...(outcome.status === 'pass' ? {} : { output: outcome.summary ?? 'the check did not pass' }),
      });
      if (outcome.status !== 'pass') {
        if (shared !== undefined) shared.checks = collected;
        return outcome;
      }
    }
    if (shared !== undefined) shared.checks = collected;
    if (artifact !== undefined) {
      const missing = await artifact(ctx);
      if (missing.status !== 'pass') return missing;
    }
    if (refine.goal === undefined) return { status: 'pass' };
    const files = nodeFiles(node);
    const required = node.file === undefined ? [] : [node.file];
    const goalCtx = {
      ...ctx,
      depth: ctx.depth + 1,
      path: [...ctx.path, `${name}-goal`],
      // The goal check's round is this refinement round: `graph.attempt`
      // counts the node's runs of the graph, which do not change inside its
      // rounds; `ctx.iteration` is the round.
      ...(ctx.graph === undefined ? {} : { graph: { ...ctx.graph, attempt: ctx.iteration } }),
    };
    const outcome = await requireNoFiles(`${name}-goal`, refine.goal, ctx.workspace.dir, files)(goalCtx);
    // A verdict aimed at the node itself is this round's send-back, not a
    // route the graph reads: without the target the round counts and saves
    // like a failed check's.
    const revision = revisionFromOutcome(outcome);
    const routed = revision?.target === name
      ? { ...outcome, revision: (({ target: _t, rerun: _r, ...rest }) => rest)(revision) }
      : outcome;
    if (routed.status !== 'pass') return routed;
    const missing = await missingWrites(ctx.workspace.dir, required, true);
    return missing.length
      ? { status: 'fail', summary: `${name} did not write: ${missing.join(', ')}` }
      : routed;
  };
}

/** One reviewer of the node's panel: a read seat asked for the same decision JSON the workflow panel reads. */
function reviewerJob(
  name: string,
  definition: ReviewerSeat,
  node: DagNode,
  config: DagConfig,
): Job {
  const seats = seatList(definition.seat);
  const primary = seats[0]!;
  const alternatives = seats.slice(1);
  const identity = primary.identity;
  const target = reviewFiles(node);
  const instructions = [
    `Review target: ${target.length ? target.join(', ') : 'the work the node did'}.`,
    node.desc === undefined ? undefined : `Task: ${node.desc}`,
    node.gate === undefined ? undefined : `Gate: ${node.gate}`,
    'Judge only that target against this node gate; do not require files from another node.',
    definition.scope === undefined ? undefined : `Scope: ${definition.scope}`,
  ].filter((line): line is string => line !== undefined).join('\n');
  // The job's label names the node and the reviewer, the way a workflow
  // stage's panel jobs are `<stage>-N`; a name that already carries the
  // node's prefix is used as it is.
  const label = definition.name.startsWith(`${name}-`) ? definition.name : `${name}-${definition.name}`;
  const ask = (again: boolean) => agentJob({
    label,
    engine: primary.engine,
    model: identity.model,
    identity,
    ...(alternatives.length === 0 ? {} : { candidates: alternatives }),
    tools: [...identity.tools],
    allowedTools: [...identity.tools],
    workspaceMode: 'read',
    prompt: (ctx) => [
      config.brief === undefined ? undefined : `Work brief:\n${config.brief}`,
      `Work in the supplied cwd.\n${instructions}`,
      again ? 'Your previous response was not a valid decision. Return only the required JSON object.' : undefined,
      'Return one JSON object: {"status":"pass"|"revise","summary":"...","findings":[{"evidence":"...","severity":"block|should-fix|nice-to-have"}]}',
    ].filter((line): line is string => line !== undefined).join('\n\n'),
    outcome: (text) => outcomeFromAgentText(text),
    recordAs: { role: 'reviewer', stage: name },
  });
  const asked = withDecisionRetry(ask(false), ask(true));
  return async (ctx) => {
    const outcome = await asked(ctx);
    if (outcome.status !== 'fail' || outcome.summary !== INVALID_TEAM_DECISION) return outcome;
    const summary = `reviewer ${definition.name} returned no decision`;
    return {
      status: 'fail',
      summary,
      error: new LoopError({ code: 'ENGINE', phase: 'review', message: summary }),
    };
  };
}

/** The node's reviewers as one panel; a pass when there are none. */
function nodePanel(
  name: string,
  node: DagNode,
  refine: Review,
  config: DagConfig,
): Job {
  // A reviewer named only by position is named after the node, the way a
  // workflow stage names its panel `<stage>-N`; an explicit name stands.
  const definitions = (refine.reviewers ?? []).map((definition, index) => autoNamed.has(definition)
    ? { ...definition, name: `${name}-${index + 1}` }
    : definition);
  if (!definitions.length) return async () => ({ status: 'pass' });
  const panel = reviewPanel({
    label: name,
    pass: refine.pass,
    ...(refine.synthesise === undefined ? {} : {
      synthesise: refine.synthesise,
      context: [
        config.brief === undefined ? undefined : `Work brief: ${config.brief}`,
        `Review target: ${reviewFiles(node).join(', ') || 'the work the node did'}.`,
        node.desc === undefined ? undefined : `Task: ${node.desc}`,
      ].filter((line): line is string => line !== undefined).join('\n'),
    }),
    reviewers: definitions.map((definition) => ({
      name: definition.name,
      ...(definition.scope === undefined ? {} : { scope: definition.scope }),
      seat: definition.seat,
      job: async (ctx) => reviewerJob(name, definition, node, config)(ctx),
    })),
  });
  // Review events use a child path. The jobs' role tags, not their paths,
  // separate the recorded sides. The outcome passes through.
  return async (ctx) => panel({
    ...ctx,
    depth: ctx.depth + 1,
    path: [...ctx.path, 'review-panel'],
  });
}

/**
 * Compile a `dag()` node to the job it runs. `agent` seats become agent
 * jobs whose feedback the kept send-backs carry; `refine` wraps the build
 * in the shared rounds machinery: its own checks, goal check and reviewers
 * each round, and the `rounds` or `judge` policy the send-backs to it share.
 * A `fixer` seat, when declared, repairs the work on the kept findings; the
 * node's own agent is the default.
 */
export function compileNodeJob(
  name: string,
  node: DagNode,
  config: DagConfig,
  routes: readonly string[],
): Job {
  const builder = node.agent === undefined
    ? node.job!
    : declareWrites(seatBuilder(name, node.agent, node, config, routes), node.file === undefined ? [] : [node.file]);
  const refine = node.refine;
  if (refine === undefined) return builder;
  // The panel rule workflow() enforces when it is built holds for a dag()
  // node too, decided here with the graph: no reviewer sits in the builder's
  // or the fixer's model family.
  const reviewerSeats = (refine.reviewers ?? []).map((definition) => definition.seat);
  if (reviewerSeats.length) {
    for (const writerSeat of [node.agent, refine.fixer] as const) {
      // Every candidate either side can resolve to counts: no reachable
      // combination of writer and reviewer may share a model family.
      if (writerSeat !== undefined) assertDistinctChoices([writerSeat, ...reviewerSeats]);
    }
  }
  const fixer = refine.fixer;
  const base = fixer === undefined
    ? builder
    : declareWrites(
      async (ctx: JobContext) => (ctx.lastReview === undefined ? builder : seatBuilder(name, fixer, node, config, routes))(ctx),
      (outcome) => declaredWrites(builder, outcome),
    );
  if (!ownReviews(refine)) return base;
  const before = nodeBefore(name, node, refine);
  const reviewJob = nodePanel(name, node, refine, config);
  // The files a passing build must leave behind for a resume to reuse its
  // result: the node's `file`. `writes` is a scope, not a required list.
  const files = node.file === undefined ? [] : [node.file];
  const rounds = (body: Job, reviewStage: Job, max: number | undefined) => loop({
    name: `${name}-review`,
    body,
    review: reviewStage,
    // A stopped body reaches the round's checks when its `file` is what it
    // left missing, or when a goal check stands to name what the work
    // lacks. Any other retryable failure retries the body, unanswered by
    // the round's gates.
    ...(refine.goal === undefined && node.file === undefined ? {} : {
      until: predicate(async (ctx, last) =>
        last?.status === 'pass'
        || (last?.status === 'fail' && (refine.goal !== undefined
          || (await missingWrites(ctx.workspace.dir, [node.file!])).length > 0)),
        `${name} writes`),
    }),
    max,
  });
  const wrapped = refinedRounds(
    rounds,
    recordRoundChange(base),
    {
      name,
      brief: config.brief,
      config: nodeRefineIdentity(node),
      writes: files,
      refine: refinePolicy(refine),
    },
    reviewJob,
    before,
    refine.checkRounds,
  );
  const writerSeat = node.agent ?? fixer;
  if (!reviewerSeats.length || writerSeat === undefined) return wrapped;
  return copyJobMeta(
    recordedFamilyGate(
      wrapped,
      reviewerSeats,
      seatList(writerSeat).map((seat) => ({ stage: name, family: seat.identity.modelFamily })),
      node.agent !== undefined,
    ),
    wrapped,
  );
}
