/**
 * Resume support for declared graphs (`workflow()` and `dag()`): the anchor
 * identity a dag records at start, and the guard that reuses a finished step
 * or reconciles an interrupted one instead of running it again.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { RECORDED_ENGINE_USAGE, type RecordedEngineUsage } from './job.js';
import { approval, delegateNodeJob } from './approval-job.js';
import type { DagConfig, DagNode, Job, JobContext, Judge, Outcome, RecordedStage, ResumedStageRecords } from './types.js';
import { isJudge } from './judge.js';
import { hasSavedInteraction, interactionDeclaration } from './interaction.js';
import { REBUILD_UNTIL, rebuildUntil, recordedRounds, recordKey, roundsOf, staleUntil } from './context.js';
import type { Writes } from './describe.js';

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

/** The files in `files` that are not in `dir`. */
export function missingFiles(dir: string, files: readonly string[]): string[] {
  return files.filter((file) => !existsSync(join(dir, file)));
}

/** Say why a resume does not reuse a step's recorded result. */
export function missingNote(label: string, missing: readonly string[]): string {
  return `${label} wrote ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} missing from the workspace, so its recorded result does not stand`;
}

/** The files each result a resume reused was recorded as writing: a compact
 * record drops the result data they are otherwise read from. */
const REUSED_WROTE = new WeakMap<Outcome, readonly string[]>();

/** The files the record says a reused result wrote; `undefined` for a
 * result no resume reused. */
export function reusedWrote(outcome: Outcome | undefined): readonly string[] | undefined {
  return outcome === undefined ? undefined : REUSED_WROTE.get(outcome);
}

/** Put back the files a result read from saved rounds wrote: its saved
 * copy drops what they are otherwise read from, so the rounds save them
 * next to it. */
export function restoreWrote(outcome: Outcome | undefined, files: unknown): void {
  if (outcome !== undefined && Array.isArray(files)) REUSED_WROTE.set(outcome, files as string[]);
}

/** Where in the record each result a resume read from it was recorded. A
 * compact record drops a graph's step results from the graph's own result,
 * so a graph reads them back from there. */
const RECORDED_AT = new WeakMap<Outcome, { readonly stages: ReadonlyMap<string, RecordedStage>; readonly key: string }>();

/** The results the record holds for the steps of the graph `name` that ran
 * inside `outcome`, a result read from the record: the last finished run of
 * each step. `undefined` for a result no resume read from the record. */
export function recordedSteps(outcome: Outcome | undefined, name: string): Record<string, Outcome> | undefined {
  const at = outcome === undefined ? undefined : RECORDED_AT.get(outcome);
  if (at === undefined) return undefined;
  const prefix = `${at.key}/${name}/`;
  const last = new Map<string, { key: string; stage: Extract<RecordedStage, { kind: 'completed' }> }>();
  for (const [key, stage] of at.stages) {
    const step = key.startsWith(prefix) ? key.slice(prefix.length).replace(/#\d+$/, '') : '/';
    if (stage.kind !== 'completed' || step.includes('/')) continue;
    const prior = last.get(step);
    if (prior === undefined || prior.stage.line < stage.line) last.set(step, { key, stage });
  }
  return Object.fromEntries([...last].map(([step, { key, stage }]) => {
    RECORDED_AT.set(stage.outcome, { stages: at.stages, key });
    if (stage.wrote !== undefined) REUSED_WROTE.set(stage.outcome, stage.wrote);
    return [step, stage.outcome];
  }));
}

/** The place in the record of the last round the loop `name` ran its body
 * in, inside `outcome`, a result read from the record. `undefined` for a
 * result no resume read from the record. */
export function recordedRound(outcome: Outcome | undefined, name: string): Outcome | undefined {
  const at = outcome === undefined ? undefined : RECORDED_AT.get(outcome);
  if (at === undefined) return undefined;
  const prefix = `${at.key}/`;
  let round = 0;
  for (const key of at.stages.keys()) {
    const [segment = ''] = key.startsWith(prefix) ? key.slice(prefix.length).split('/') : [];
    if (segment === name) round = Math.max(round, 1);
    else if (segment.startsWith(`${name}#`)) round = Math.max(round, Number(segment.slice(name.length + 1)));
  }
  if (round === 0) return undefined;
  const body: Outcome = { status: 'pass' };
  RECORDED_AT.set(body, { stages: at.stages, key: `${at.key}/${name}${round === 1 ? '' : `#${round}`}` });
  return body;
}

/** The key a resume reads the step at `ctx.path` by. */
function stepKey(ctx: Pick<JobContext, 'path'>): string {
  return recordKey(ctx.path, recordedRounds(roundsOf(ctx), ctx.path.length).rounds);
}

function recordedUsage(ctx: Pick<JobContext, 'state'>): readonly RecordedEngineUsage[] {
  const value = ctx.state[RECORDED_ENGINE_USAGE];
  return Array.isArray(value) ? value as readonly RecordedEngineUsage[] : [];
}

/** Put back the model answers the record holds for the step at `ctx.path`,
 * when a resume reuses the step instead of running it. */
export function restoreRecordedUsage(ctx: Pick<JobContext, 'state' | 'path'>): void {
  const priorUsage = (ctx.state[RESUME_RECORDED_USAGE] as ReadonlyMap<string, readonly RecordedEngineUsage[]> | undefined)
    ?.get(stepKey(ctx));
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

/** Reuse a finished step, or reconcile an unsafe interrupted one. The
 * record keeps each step by its path and the round it ran in, so a step is
 * reused only in its own round, in any round. `anchor` is the record's
 * anchor this graph invocation took; without one the step runs. `isolated`
 * marks a step that works in its own worktree and lands only when it
 * finishes: the caller wraps the fork itself, so a reused outcome or the
 * reconciliation question comes before any new worktree exists. A finished
 * step whose recorded files are not all in the workspace runs again when it
 * is retry-safe, and asks a person when it is not. `files` are the files a
 * step waiting on a person declares it writes, as far as its recorded result
 * shows: when they are not all there, one that is not retry-safe asks a
 * person before it continues. A finished step the record holds at or before
 * the line `ctx` marks stale or rebuilt runs again, as does one with
 * `changed`, the steps it needs that ran again after it finished: it runs on
 * their new work, as a send-back's review does. A step that runs again in
 * place of a finished run reuses no step under it from that run. */
export function resumeGuard(
  job: Job,
  identity: string,
  label: string,
  retrySafe: boolean,
  anchor: ResumeAnchor | undefined,
  isolated = false,
  files: Writes = [],
  changed: readonly string[] = [],
): Job {
  const filesOf = (outcome: Outcome | undefined): readonly string[] =>
    typeof files === 'function' ? files(outcome) : files;
  const guarded: Job = async (ctx) => {
    const resumed = ctx.state[RESUME_STAGE_OUTCOMES] as ResumedStageRecords | undefined;
    const matches = anchor?.identity === identity && anchor.workspace === ctx.workspace.dir;
    const recorded = matches ? resumed?.stages.get(stepKey(ctx)) : undefined;
    // The line of the finished run this one replaces, when it replaces one.
    let replaces: number | undefined;
    if (matches && hasSavedInteraction(ctx, ctx.path)) {
      restoreRecordedUsage(ctx);
      // A step waiting on a person whose files are gone would build them
      // again when it continues, so one that is not retry-safe asks first.
      const missing = retrySafe ? [] : missingFiles(ctx.workspace.dir, filesOf(recorded?.kind === 'completed' ? recorded.outcome : undefined));
      if (missing.length) {
        ctx.log(missingNote(`stage "${label}"`, missing), 'warn');
        // Ask the same question again when it is already waiting for an answer.
        const asked = recorded?.kind === 'completed'
          ? recorded.outcome.data as { resumeReconciliation?: boolean; input?: { startLine?: number } } | undefined
          : undefined;
        const line = asked?.resumeReconciliation === true && asked.input?.startLine !== undefined
          ? asked.input.startLine
          : recorded === undefined ? 0 : recorded.kind === 'interrupted' ? recorded.startLine : recorded.line;
        return reconcileInterrupted(ctx, guarded, job, label, identity, anchor!.recordId, line, isolated, missing);
      }
      return delegateNodeJob(ctx, guarded, job, ctx);
    }
    if (recorded !== undefined) {
      if (recorded.kind === 'interrupted') {
        replaces = recorded.rebuilds;
        if (!retrySafe) {
          restoreRecordedUsage(ctx);
          return reconcileInterrupted(ctx, guarded, job, label, identity, anchor!.recordId, recorded.startLine, isolated, undefined, recorded.rebuilds);
        }
        // A step that saved its rounds continues from them, so the model
        // answers of the rounds it does not run again come back too.
        if (hasSavedInteraction(ctx, ctx.path, true)) restoreRecordedUsage(ctx);
      } else if (recorded.outcome.status === 'pass'
          && (recorded.outcome.data as { skipped?: boolean } | undefined)?.skipped !== true) {
        // A record that does not list the files falls back to the files the
        // step declares for its result.
        // A compact record also drops the result data, so a graph reads
        // its steps' results from their own records.
        if (recorded.wrote === undefined) RECORDED_AT.set(recorded.outcome, { stages: resumed!.stages, key: stepKey(ctx) });
        const wrote = recorded.wrote ?? filesOf(recorded.outcome);
        const missing = missingFiles(ctx.workspace.dir, wrote);
        // A result recorded before work it builds on ran again does not stand.
        if (changed.length || recorded.line <= Math.max(staleUntil(ctx), rebuildUntil(ctx))) {
          if (changed.length) ctx.log(`stage "${label}" needs ${changed.join(', ')}, which ran again, so its recorded result does not stand`, 'warn');
        } else if (missing.length === 0) {
          restoreRecordedUsage(ctx);
          REUSED_WROTE.set(recorded.outcome, wrote);
          return recorded.outcome;
        } else {
          ctx.log(missingNote(`stage "${label}"`, missing), 'warn');
          if (!retrySafe) {
            restoreRecordedUsage(ctx);
            return reconcileInterrupted(ctx, guarded, job, label, identity, anchor!.recordId, recorded.line, isolated, missing);
          }
        }
        // A first attempt's start keeps the recorded result in the record,
        // so a crash during the rebuild would reuse it; a later attempt's
        // start already sets it aside.
        if ((ctx.graph?.attempt ?? 1) === 1) startAgain(ctx, label);
        replaces = recorded.line;
      } else if (recorded.outcome.status === 'paused') {
        const request = recorded.outcome.data as {
          requestId?: string;
          resumeReconciliation?: boolean;
          input?: { startLine?: number; missing?: string[]; rebuilds?: number };
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
          return reconcileInterrupted(ctx, guarded, job, label, identity, anchor!.recordId, request.input.startLine, isolated, request.input.missing, request.input.rebuilds);
        }
      }
    }
    return delegateNodeJob(ctx, guarded, job, rebuilding(ctx, replaces));
  };
  return interactionDeclaration(guarded, { identity, label, job });
}

/** `ctx` for a step that runs again in place of its finished run the record
 * holds at `line`: a resume reuses no step under it from that run, so one
 * that wrote a file only the step declares runs again too. */
function rebuilding(ctx: JobContext, line: number | undefined): JobContext & { [REBUILD_UNTIL]?: number } {
  return line === undefined ? ctx : { ...ctx, [REBUILD_UNTIL]: Math.max(rebuildUntil(ctx), line) };
}

/** Record a new start of the step at `ctx.path`, so a crash while it runs
 * again reads as interrupted work, not as the recorded result it replaces. */
function startAgain(ctx: JobContext, label: string): void {
  ctx.emit({
    kind: 'dag:node', ts: Date.now(), path: ctx.path.slice(0, -1), node: label,
    phase: 'start', attempt: (ctx.graph?.attempt ?? 1) + 1, ...recordedRounds(roundsOf(ctx), ctx.path.length),
  });
}

/** Ask a person about an interrupted attempt. A shared-workspace step's work
 * is already in the workspace, so approval continues without running it
 * again and refusal runs it again. An isolated step's work never left its
 * worktree, so approval runs it again in a fresh worktree and refusal stops
 * the run, leaving the old worktree for the person to recover by hand. A
 * step whose files are `missing` has no work to continue from, so approval
 * runs it again and refusal stops the run. `rebuilds` is the line of the
 * finished run the interrupted attempt ran again, when it was a rebuild: a
 * new attempt reuses no step under it from that run either. */
async function reconcileInterrupted(
  ctx: JobContext,
  owner: Job,
  job: Job,
  label: string,
  identity: string,
  recordId: string,
  startLine: number,
  isolated: boolean,
  missing?: readonly string[],
  rebuilds?: number,
): Promise<Outcome> {
  const question = approval(`reconcile ${label}`, {
    question: missing !== undefined
      ? `Stage "${label}" wrote ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} missing from the workspace. Approve to run it again; refuse to stop the run.`
      : isolated
        ? `Stage "${label}" was interrupted. It ran in its own worktree, and none of its work landed. Approve to run it again from the start; refuse to stop the run and recover the work by hand from the leftover worktree.`
        : `Did stage "${label}" finish? Approve to continue without running it again; refuse if it did not finish.`,
    input: {
      identity, workspace: ctx.workspace.dir, stage: label, recordId, startLine,
      ...(missing !== undefined ? { missing: [...missing] } : {}),
      ...(rebuilds !== undefined ? { rebuilds } : {}),
    },
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
  if (isolated || missing !== undefined ? outcome.status === 'pass' : refused) {
    // A crash during this new attempt must not reuse the answer about the old one.
    startAgain(ctx, label);
    return delegateNodeJob(ctx, owner, job, rebuilding(ctx, missing === undefined ? rebuilds : startLine));
  }
  return { ...outcome, data: { ...(outcome.data ?? {}), resumeReconciliation: true } };
}
