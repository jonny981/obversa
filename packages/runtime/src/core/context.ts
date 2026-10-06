/**
 * Build a child `JobContext` from a parent, overriding only the per-scope
 * fields. One helper shared by `loop()` and `dag()` so the next field added to
 * `JobContext` is threaded in exactly one place.
 */

import type {
  ConditionResult,
  GraphPosition,
  JobContext,
  Outcome,
  Workspace,
} from './types.js';
import type { EnvHandle } from '../env/environment.js';

/** Internal context key: the file the dag node that runs this job declares
 * it builds (the node's `file`). A writer with no `writes` of its own checks
 * this file alone for unchanged work. A child context keeps it, so a writer
 * inside a `loop()` or a team checks its node's file too; each dag node sets
 * or clears it. Not exported from the package. */
export const NODE_FILE = Symbol('obversa:node-file');

/** Internal context key: the round each loop or graph step on `ctx.path`
 * runs in, by its position in the path, kept only past round 1. A child
 * context keeps it, so a step's record names every round it ran in. Not
 * exported from the package. */
export const ROUNDS = Symbol('obversa:rounds');

export type Rounds = Readonly<Record<number, number>>;

export function roundsOf(ctx: object): Rounds {
  return (ctx as { [ROUNDS]?: Rounds })[ROUNDS] ?? {};
}

/** The rounds on the first `length` segments of a path, for an event that a
 * resume reads: absent when each of them ran in round 1, so a run with one
 * round records what it always did. */
export function recordedRounds(rounds: Rounds, length: number): { rounds?: Record<string, number> } {
  const kept = Object.entries(rounds).filter(([index]) => Number(index) < length);
  return kept.length ? { rounds: Object.fromEntries(kept) } : {};
}

/** The key a resume reads a recorded step by: its path, with the round of
 * each loop or step on it that ran past round 1. */
export function recordKey(path: readonly string[], rounds: Readonly<Record<string, number>> = {}): string {
  return path.map((segment, index) => rounds[index] === undefined ? segment : `${segment}#${rounds[index]}`).join('/');
}

/** Internal context key: a resume reuses no finished step under this
 * context's path that the record holds at or before this line, because work
 * the path builds on ran again after it. `Infinity` when that work ran in
 * this run, so nothing the record holds under the path stands. A child
 * context keeps it. Not exported from the package. */
export const STALE_UNTIL = Symbol('obversa:stale-until');

export function staleUntil(ctx: object): number {
  return (ctx as { [STALE_UNTIL]?: number })[STALE_UNTIL] ?? 0;
}

/** Internal context key: a step on this context's path runs again because a
 * file it wrote is gone, so a resume reuses no finished step under it that
 * the record holds at or before this line. Unlike `STALE_UNTIL`, the rounds
 * a loop or graph under it saved still stand, so it rebuilds in the round it
 * finished in. A child context keeps it. Not exported from the package. */
export const REBUILD_UNTIL = Symbol('obversa:rebuild-until');

export function rebuildUntil(ctx: object): number {
  return (ctx as { [REBUILD_UNTIL]?: number })[REBUILD_UNTIL] ?? 0;
}

export interface ContextOverride {
  depth: number;
  path: readonly string[];
  /** The round the last segment of `path` runs in: a loop's iteration, or
   * which run of a graph step this is. */
  round?: number;
  /** A record line the child reuses nothing at or before, past the parent's. */
  staleUntil?: number;
  iteration?: number;
  lastOutcome?: Outcome;
  lastReview?: Outcome;
  lastGate?: ConditionResult;
  /** The findings a judge skipped, for the review that sent the work back. */
  skippedFindings?: JobContext['skippedFindings'];
  /** The outcomes of a dag node's `needs`, set by the dag for that node only. */
  needs?: Readonly<Record<string, Outcome>>;
  /** Override the workspace (a worktree fork at a concurrency boundary). */
  workspace?: Workspace;
  /** Override the environment (a per-team env at a concurrency boundary). */
  environment?: EnvHandle;
  /** Override the pinned env vars (a `withEnv` wrapper layering its overlay). */
  envOverlay?: Record<string, string>;
  /** Override the DAG graph position for a node. */
  graph?: GraphPosition;
  /** Set or clear the acceptance criterion visible to a stage reviewer. */
  reviewerGate?: string | null;
  /** Carry the nearest DAG node's acceptance criterion through nested jobs. */
  stageGate?: string | null;
  /** Override the inherited timeout for jobs in this scope. */
  timeoutMs?: number;
  /** Override the inherited timeout grace for jobs in this scope. */
  timeoutGraceMs?: number;
}

/** Resolve the criterion for the reviewer context currently being evaluated. */
export function criterionFor(
  ctx: Pick<JobContext, 'reviewerGate' | 'stageGate' | 'graph'>,
): string | undefined {
  if (ctx.stageGate !== undefined) return ctx.stageGate ?? undefined;
  if (ctx.reviewerGate !== undefined) return ctx.reviewerGate ?? undefined;
  return ctx.graph?.gate;
}

export function childContext(
  parent: JobContext,
  over: ContextOverride,
): JobContext & { [NODE_FILE]?: string; [ROUNDS]: Rounds; [STALE_UNTIL]: number; [REBUILD_UNTIL]: number } {
  const rounds: Record<number, number> = { ...roundsOf(parent) };
  if (over.round !== undefined) {
    if (over.round > 1) rounds[over.path.length - 1] = over.round;
    else delete rounds[over.path.length - 1];
  }
  return {
    [NODE_FILE]: (parent as JobContext & { [NODE_FILE]?: string })[NODE_FILE],
    [ROUNDS]: rounds,
    [STALE_UNTIL]: Math.max(staleUntil(parent), over.staleUntil ?? 0),
    [REBUILD_UNTIL]: rebuildUntil(parent),
    engine: parent.engine,
    resolveEngine: parent.resolveEngine,
    signal: parent.signal,
    runId: parent.runId,
    fingerprintExcludePaths: parent.fingerprintExcludePaths,
    emit: parent.emit,
    params: parent.params,
    state: parent.state,
    memory: parent.memory,
    callbacks: parent.callbacks,
    interactionCheckpoint: parent.interactionCheckpoint,
    onCallback: parent.onCallback,
    // A child inherits the parent's workspace by default; a concurrency
    // boundary forks it into an isolated worktree by passing `workspace`.
    workspace: over.workspace ?? parent.workspace,
    environment: over.environment ?? parent.environment,
    // Inherited, not override-only: pinning deliberately survives the dag
    // worktree boundary, where a node ctx REPLACES `environment` with a
    // per-team handle. An explicit `withEnv` wins over a per-team stack's vars.
    envOverlay: over.envOverlay ?? parent.envOverlay,
    budget: parent.budget,
    onLimit: parent.onLimit,
    maxWaitMs: parent.maxWaitMs,
    judgeContextLimit: parent.judgeContextLimit,
    log: parent.log,
    depth: over.depth,
    path: over.path,
    graph: over.graph ?? parent.graph,
    reviewerGate:
      over.reviewerGate !== undefined
        ? over.reviewerGate
        : parent.reviewerGate,
    stageGate: over.stageGate !== undefined ? over.stageGate : parent.stageGate,
    timeoutMs: over.timeoutMs ?? parent.timeoutMs,
    timeoutGraceMs: over.timeoutGraceMs ?? parent.timeoutGraceMs,
    // Inherit the enclosing iteration by default. A `loop` always passes one
    // explicitly; a `dag`/`sequence` does not, so without this a node nested in a
    // loop would reset to 0, the "Attempt 0" confound where a retry body could not
    // see which attempt it was on. A top-level dag still gets 0 (the root's value).
    iteration: over.iteration ?? parent.iteration,
    lastOutcome: over.lastOutcome,
    lastReview: over.lastReview,
    lastGate: over.lastGate,
    // Inherited, so every reviewer inside the review that sent work back
    // hears what the judge skipped.
    skippedFindings: over.skippedFindings ?? parent.skippedFindings,
    // Not inherited: a nested job sees its own dag node's needs, never an ancestor's.
    needs: over.needs,
  };
}
