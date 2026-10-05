import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { UsageReceipt } from '../engines/engine.js';
import type { RecordedEngineUsage } from '../core/job.js';
import type { JsonObject } from '../graph/value.js';
import { cloneFrozenJson } from '../graph/value.js';
import type { LoopEvent, Outcome, RecordedStage, ResumedStageRecords } from '../core/types.js';
import { recordKey } from '../core/context.js';
import type { RestoredEvent } from './record-totals.js';

export type { RecordedStage, ResumedStageRecords } from '../core/types.js';

const NOISE: ReadonlySet<LoopEvent['kind']> = new Set([
  'engine:text',
  'engine:thinking',
]);

interface RecorderOptions {
  thin?: boolean;
  /** Append to the existing record instead of truncating it. */
  resume?: boolean;
  /** Stamp every line with this session number. */
  session?: number;
}

/** Read the latest stage state and the engine answers recorded for each stage.
 * A missing record has no stage state, so resume starts fresh. */
export function readResumeRecord(path: string): {
  readonly receipts: readonly UsageReceipt[];
  /** Every engine call the record holds, with the cost it recorded, the loop rounds and dag nodes they ran in, and where each session began. */
  readonly calls: readonly RestoredEvent[];
  readonly outcomes: ResumedStageRecords;
  readonly usage: ReadonlyMap<string, readonly RecordedEngineUsage[]>;
  /** How many sessions the record holds: one per `run:start`. */
  readonly sessions: number;
} {
  const receipts: UsageReceipt[] = [];
  const calls: RestoredEvent[] = [];
  const interactions = new Map<string, { identity: string; workspace: string; data: JsonObject; progress?: boolean; line: number; progressLine?: number }>();
  const anchors = new Map<string, { identity: string; workspace: string; recordId: string }>();
  const stages = new Map<string, RecordedStage>();
  const usage = new Map<string, RecordedEngineUsage[]>();
  const started = new Set<string>();
  let sessions = 0;
  if (!existsSync(path)) return { outcomes: { anchors, stages, interactions }, usage, receipts, calls, sessions };
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (const [lineNumber, line] of lines.entries()) {
    if (!line) continue;
    let event: LoopEvent;
    try {
      event = JSON.parse(line) as LoopEvent;
    } catch {
      continue;
    }
    if (event.kind === 'engine:usage') {
      if (event.failed === undefined || event.usage.kind === 'reported') receipts.push(event.usage);
      calls.push(event);
    }
    if (event.kind === 'run:start' || event.kind === 'loop:iteration' || event.kind === 'workflow:start' || event.kind === 'dag:start' || event.kind === 'dag:node') calls.push(event);
    if (event.kind === 'run:start') sessions += 1;
    if (event.kind === 'interaction:checkpoint') {
      const key = recordKey(event.path, event.rounds);
      const progressLine = event.progress === true ? lineNumber : interactions.get(key)?.progressLine;
      if (event.data === null) interactions.delete(key);
      else interactions.set(key, { identity: event.identity, workspace: event.workspace, data: cloneFrozenJson(event.data), ...(event.progress === true ? { progress: true } : {}), line: lineNumber, ...(progressLine === undefined ? {} : { progressLine }) });
    } else if (event.kind === 'workflow:start') {
      const key = recordKey(event.path, event.rounds);
      const prior = anchors.get(key);
      if (prior?.identity !== event.identity || prior.workspace !== event.workspace) {
        const prefix = key ? `${key}/` : '';
        for (const stage of interactions.keys()) {
          if (stage.startsWith(prefix)) interactions.delete(stage);
        }
        for (const stage of stages.keys()) {
          if (stage.startsWith(prefix)) stages.delete(stage);
        }
        for (const stage of usage.keys()) {
          if (stage.startsWith(prefix)) usage.delete(stage);
        }
        for (const stage of started) {
          if (stage.startsWith(prefix)) started.delete(stage);
        }
      }
      anchors.set(key, { identity: event.identity, workspace: event.workspace, recordId: event.recordId });
    } else if (event.kind === 'dag:node') {
      const key = recordKey([...event.path, event.node], event.rounds);
      started.add(key);
      if (event.phase === 'start') {
        const prior = stages.get(key);
        const safeCompletion = prior?.kind === 'completed'
          && (prior.outcome.status === 'paused'
            || (prior.outcome.status === 'pass'
              && (prior.outcome.data as { skipped?: boolean } | undefined)?.skipped !== true));
        if (event.attempt !== 1 || !safeCompletion) {
          // A finished step that runs again, or one a person said to run
          // again because its files were gone or its rebuild did not
          // finish, stays a rebuild until it finishes, however many times
          // it starts.
          const asked = prior?.kind === 'completed' ? prior.outcome.data as { input?: { missing?: unknown; rebuilds?: unknown } } | undefined : undefined;
          const rebuilds = prior?.kind === 'interrupted'
            ? prior.rebuilds
            : prior?.kind === 'completed' && event.attempt !== 1 && (prior.outcome.status === 'pass' || asked?.input?.missing !== undefined)
              ? prior.line
              : event.attempt !== 1 && typeof asked?.input?.rebuilds === 'number'
                ? asked.input.rebuilds
                : undefined;
          stages.set(key, { kind: 'interrupted', startLine: lineNumber, ...(rebuilds === undefined ? {} : { rebuilds }) });
        }
      } else if (event.outcome !== undefined) {
        // A skipped step wrote nothing. Its event says it was skipped, even
        // where a compact record dropped the mark from its result.
        const outcome = event.phase === 'skip'
          ? { ...event.outcome, data: { ...(event.outcome.data as JsonObject | undefined), skipped: true } }
          : event.outcome;
        // A pass that follows the pass the record holds, with no start that
        // set it aside, is a resume repeating that pass. It keeps the line
        // of the work it repeats, so the steps that need it still read as
        // newer.
        const prior = stages.get(key);
        const repeats = event.phase === 'done' && outcome.status === 'pass'
          && (outcome.data as { skipped?: boolean } | undefined)?.skipped !== true
          && prior?.kind === 'completed' && prior.outcome.status === 'pass'
          && (prior.outcome.data as { skipped?: boolean } | undefined)?.skipped !== true;
        stages.set(key, { kind: 'completed', outcome, line: repeats ? prior.line : lineNumber, ...(event.wrote === undefined ? {} : { wrote: event.wrote }) });
      }
    } else if (event.kind === 'engine:usage' && event.failed === undefined && event.role !== undefined && event.stage !== undefined) {
      for (let index = event.path.length; index > 0; index -= 1) {
        if (event.path[index - 1] !== event.stage) continue;
        const key = recordKey(event.path.slice(0, index), event.rounds);
        if (!started.has(key)) continue;
        const answers = usage.get(key) ?? [];
        answers.push({ model: event.model, path: event.path, role: event.role, stage: event.stage });
        usage.set(key, answers);
        break;
      }
    }
  }
  return { outcomes: { anchors, stages, interactions }, usage, receipts, calls, sessions };
}

function ensureDir(path: string): void {
  const dir = dirname(path);
  if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
}

/** Append every durable event as one JSON line. */
export function makeRecorder(
  path: string,
  options: RecorderOptions = {},
): (event: LoopEvent) => void {
  ensureDir(path);
  if (options.resume !== true) writeFileSync(path, '');
  return (event) => {
    if (NOISE.has(event.kind)) return;
    const line = options.thin ? thinEvent(event) : event;
    try {
      appendFileSync(
        path,
        `${JSON.stringify(options.session === undefined ? line : { ...(line as object), session: options.session })}\n`,
      );
    } catch {
      // Recording is best-effort until the durable event store arrives in D3.
    }
  };
}

function thinEvent(event: LoopEvent): unknown {
  switch (event.kind) {
    case 'run:end':
    case 'job:end':
    case 'loop:end':
    case 'loop:review':
    case 'dag:end':
      return { ...event, outcome: thinOutcome(event.outcome) };
    case 'dag:node':
      return event.outcome
        ? { ...event, outcome: thinOutcome(event.outcome) }
        : event;
    case 'proof':
      return { ...event, artifact: thinProofArtifact(event.artifact) };
    case 'loop:condition':
    case 'condition:result':
      return {
        ...event,
        result:
          event.result.output === undefined
            ? event.result
            : { ...event.result, output: '[omitted from compact record]' },
      };
    default:
      return event;
  }
}

function thinOutcome(outcome: Outcome): Outcome {
  const thin: Outcome = { status: outcome.status };
  if (outcome.confidence !== undefined) thin.confidence = outcome.confidence;
  if (outcome.late !== undefined) thin.late = outcome.late;
  if (outcome.summary !== undefined) thin.summary = outcome.summary;
  if (outcome.error !== undefined) thin.error = outcome.error;
  if (outcome.stall !== undefined) thin.stall = outcome.stall;
  if (outcome.revision !== undefined) thin.revision = outcome.revision;
  if (outcome.discarded !== undefined) thin.discarded = outcome.discarded;
  if (outcome.openFindings !== undefined) thin.openFindings = outcome.openFindings;
  // A resume reads the question it asked about a step back from the record,
  // so it waits for the answer instead of running the step.
  const asked = outcome.data as { requestId?: string; resumeReconciliation?: boolean; input?: JsonObject } | undefined;
  if (outcome.status === 'paused' && asked?.resumeReconciliation === true) {
    thin.data = { requestId: asked.requestId, resumeReconciliation: true, input: asked.input };
  }
  // A skipped step keeps its mark, so a resume never looks for its files.
  if ((outcome.data as { skipped?: boolean } | undefined)?.skipped === true) thin.data = { skipped: true };
  if (outcome.command !== undefined) thin.command = outcome.command;
  return thin;
}

function thinProofArtifact(
  artifact: Extract<LoopEvent, { kind: 'proof' }>['artifact'],
): Extract<LoopEvent, { kind: 'proof' }>['artifact'] {
  if (artifact.data === undefined) return artifact;
  const { data: _data, ...rest } = artifact;
  return rest;
}
