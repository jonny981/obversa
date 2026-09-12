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

export interface ContextOverride {
  depth: number;
  path: readonly string[];
  iteration?: number;
  lastOutcome?: Outcome;
  lastReview?: Outcome;
  lastGate?: ConditionResult;
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
): JobContext {
  return {
    engine: parent.engine,
    resolveEngine: parent.resolveEngine,
    signal: parent.signal,
    runId: parent.runId,
    fingerprintExcludePaths: parent.fingerprintExcludePaths,
    emit: parent.emit,
    params: parent.params,
    state: parent.state,
    memory: parent.memory,
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
    // Not inherited: a nested job sees its own dag node's needs, never an ancestor's.
    needs: over.needs,
  };
}
