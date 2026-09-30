/**
 * Resume support for declared graphs (`workflow()` and `dag()`): the anchor
 * identity a dag records at start, and the guard that reuses a finished step
 * or reconciles an interrupted one instead of running it again.
 */

import { createHash } from 'node:crypto';

import { RECORDED_ENGINE_USAGE, type RecordedEngineUsage } from './job.js';
import { approval, delegateNodeJob } from './approval-job.js';
import type { DagConfig, DagNode, Job, JobContext, Judge, Outcome, ResumedStageRecords } from './types.js';
import { isJudge } from './judge.js';
import { hasSavedInteraction, interactionDeclaration } from './interaction.js';

/** Run-owned keys holding the graph state read from its record. */
export const RESUME_STAGE_OUTCOMES = 'obversa:resumed-stage-outcomes';
export const RESUME_RECORDED_USAGE = 'obversa:resumed-recorded-usage';

/** Internal config key: the resume identity `workflow()` gives its compiled
 * dag in place of the dag's own digest, so it also covers the brief and the
 * roles. Not exported from the package. */
export const RESUME_IDENTITY = Symbol('obversa:resume-identity');

/** The resume anchor a graph invocation read from the record. */
export type ResumeAnchor = { readonly identity: string; readonly workspace: string; readonly recordId: string };

/** A digestable view of a declared value: primitives pass through, plain
 * objects sort their keys, functions serialize as their source, so a changed
 * predicate changes the digest. */
function canonicalForDigest(value: unknown): unknown {
  if (typeof value === 'function') return `fn:${value.toString()}`;
  if (Array.isArray(value)) return value.map(canonicalForDigest);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).sort().map((key) => [
        key,
        canonicalForDigest((value as Record<string, unknown>)[key]),
      ]),
    );
  }
  return value;
}

/** The dag's resume identity: a digest over the declared shape: name,
 * concurrency, kickback budget (a judge digests as its cap and questions;
 * the seat is excluded), the default `isolation`, and each node's needs,
 * `when`, `optional` and effective isolation (the node's `isolate`, else the
 * dag's `isolation`). Node `job` functions are excluded for the same reason
 * engine instances are excluded in `workflow()`: they carry state a digest
 * cannot match. */
export function dagResumeIdentity(config: DagConfig): string {
  const kickbacks = config.maxKickbacks === undefined
    ? null
    : typeof config.maxKickbacks === 'number'
      ? config.maxKickbacks
      : Object.fromEntries(
        Object.keys(config.maxKickbacks).sort().map((target) => {
          const limit = (config.maxKickbacks as Record<string, number | Judge>)[target]!;
          return [target, isJudge(limit)
            ? { judge: { cap: limit.cap, questions: canonicalForDigest(limit.questions) } }
            : limit];
        }),
      );
  const declared = {
    name: config.name,
    concurrency: config.concurrency ?? null,
    isolation: config.isolation ?? null,
    maxKickbacks: kickbacks,
    nodes: Object.fromEntries(
      Object.keys(config.nodes).sort().map((name) => {
        const node = config.nodes[name]!;
        const declaredNode: Partial<DagNode> = typeof node === 'function' ? {} : node;
        const needs = declaredNode.needs === undefined
          ? []
          : typeof declaredNode.needs === 'string'
            ? [declaredNode.needs]
            : [...declaredNode.needs];
        return [name, {
          needs,
          optional: declaredNode.optional === true,
          isolate: declaredNode.isolate ?? config.isolation === 'worktree',
          when: canonicalForDigest(declaredNode.when ?? null),
        }];
      }),
    ),
  };
  return createHash('sha256').update(JSON.stringify(declared)).digest('hex');
}

function recordedUsage(ctx: JobContext): readonly RecordedEngineUsage[] {
  const value = ctx.state[RECORDED_ENGINE_USAGE];
  return Array.isArray(value) ? value as readonly RecordedEngineUsage[] : [];
}

function restoreRecordedUsage(ctx: JobContext): void {
  const priorUsage = (ctx.state[RESUME_RECORDED_USAGE] as ReadonlyMap<string, readonly RecordedEngineUsage[]> | undefined)
    ?.get(ctx.path.join('/'));
  if (priorUsage?.length) {
    const current = recordedUsage(ctx);
    const key = (record: RecordedEngineUsage) => JSON.stringify([record.path, record.role, record.model]);
    const present = new Map<string, number>();
    for (const record of current) {
      const identity = key(record);
      present.set(identity, (present.get(identity) ?? 0) + 1);
    }
    const missing = priorUsage.filter((record) => {
      const identity = key(record);
      const count = present.get(identity) ?? 0;
      if (count === 0) return true;
      present.set(identity, count - 1);
      return false;
    });
    if (missing.length) ctx.state[RECORDED_ENGINE_USAGE] = [...current, ...missing];
  }
}

/** Reuse a completed first attempt, or reconcile an unsafe interrupted one.
 * `anchor` is the record's anchor this graph invocation took; without one
 * the step runs. `isolated` marks a step that works in its own worktree and lands only when
 * it finishes: the caller wraps the fork itself, so a reused outcome or the
 * reconciliation question comes before any new worktree exists. */
export function resumeGuard(
  job: Job,
  identity: string,
  label: string,
  retrySafe: boolean,
  anchor: ResumeAnchor | undefined,
  isolated = false,
): Job {
  const guarded: Job = async (ctx) => {
    const resumed = ctx.state[RESUME_STAGE_OUTCOMES] as ResumedStageRecords | undefined;
    const recorded = anchor?.identity === identity && anchor.workspace === ctx.workspace.dir
      ? resumed?.stages.get(ctx.path.join('/'))
      : undefined;
    if (anchor?.identity === identity && anchor.workspace === ctx.workspace.dir && hasSavedInteraction(ctx, ctx.path)) {
      restoreRecordedUsage(ctx);
      return delegateNodeJob(ctx, guarded, job, ctx);
    }
    if (ctx.graph?.attempt === 1 && recorded !== undefined) {
      if (recorded.kind === 'interrupted') {
        if (!retrySafe) {
          restoreRecordedUsage(ctx);
          return reconcileInterrupted(ctx, guarded, job, label, identity, anchor!.recordId, recorded.startLine, isolated);
        }
      } else if (recorded.outcome.status === 'pass'
          && (recorded.outcome.data as { skipped?: boolean } | undefined)?.skipped !== true) {
        restoreRecordedUsage(ctx);
        return recorded.outcome;
      } else if (recorded.outcome.status === 'paused') {
        const request = recorded.outcome.data as {
          requestId?: string;
          resumeReconciliation?: boolean;
          input?: { startLine?: number };
        } | undefined;
        const pending = ctx.callbacks === undefined
          ? []
          : await ctx.callbacks.listPending();
        if (ctx.onCallback !== 'wait' && request?.requestId !== undefined
            && pending.some((candidate) => candidate.requestId === request.requestId)) {
          return recorded.outcome;
        }
        if (request?.resumeReconciliation === true && request.input?.startLine !== undefined) {
          restoreRecordedUsage(ctx);
          return reconcileInterrupted(ctx, guarded, job, label, identity, anchor!.recordId, request.input.startLine, isolated);
        }
      }
    }
    return delegateNodeJob(ctx, guarded, job, ctx);
  };
  return interactionDeclaration(guarded, { identity, label, job });
}

/** Ask a person about an interrupted attempt. A shared-workspace step's work
 * is already in the workspace, so approval continues without running it
 * again and refusal runs it again. An isolated step's work never left its
 * worktree, so approval runs it again in a fresh worktree and refusal stops
 * the run, leaving the old worktree for the person to recover by hand. */
async function reconcileInterrupted(
  ctx: JobContext,
  owner: Job,
  job: Job,
  label: string,
  identity: string,
  recordId: string,
  startLine: number,
  isolated: boolean,
): Promise<Outcome> {
  const question = approval(`reconcile ${label}`, {
    question: isolated
      ? `Stage "${label}" was interrupted. It ran in its own worktree, and none of its work landed. Approve to run it again from the start; refuse to stop the run and recover the work by hand from the leftover worktree.`
      : `Did stage "${label}" finish? Approve to continue without running it again; refuse if it did not finish.`,
    input: { identity, workspace: ctx.workspace.dir, stage: label, recordId, startLine },
  });
  const outcome = await delegateNodeJob(ctx, owner, question, {
    ...ctx,
    emit(event) {
      // A crash during the wait must keep the recovery question, not rerun the stage.
      ctx.emit(event.kind === 'dag:node' && event.outcome?.status === 'paused'
        ? { ...event, outcome: {
          ...event.outcome,
          data: { ...(event.outcome.data ?? {}), resumeReconciliation: true },
        } }
        : event);
    },
  });
  const refused = outcome.status === 'fail' && (outcome.data as { approved?: boolean } | undefined)?.approved === false;
  if (isolated ? outcome.status === 'pass' : refused) {
    // A crash during this new attempt must not reuse the answer about the old one.
    ctx.emit({
      kind: 'dag:node', ts: Date.now(), path: ctx.path.slice(0, -1), node: label,
      phase: 'start', attempt: (ctx.graph?.attempt ?? 1) + 1,
    });
    return delegateNodeJob(ctx, owner, job, ctx);
  }
  return { ...outcome, data: { ...(outcome.data ?? {}), resumeReconciliation: true } };
}
