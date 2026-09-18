import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { RecordedEngineUsage } from '../core/job.js';
import type { LoopEvent, Outcome } from '../core/types.js';

const NOISE: ReadonlySet<LoopEvent['kind']> = new Set([
  'engine:text',
  'engine:thinking',
]);

interface RecorderOptions {
  thin?: boolean;
  /** Append to the existing record instead of truncating it. */
  resume?: boolean;
}

export type RecordedStage =
  | { readonly kind: 'interrupted'; readonly startLine: number }
  | { readonly kind: 'completed'; readonly outcome: Outcome };

export interface ResumedStageRecords {
  readonly anchors: ReadonlyMap<string, { readonly identity: string; readonly workspace: string; readonly recordId: string }>;
  readonly stages: ReadonlyMap<string, RecordedStage>;
}

/** Read the latest stage state and the engine answers recorded for each stage.
 * A missing record has no stage state, so resume starts fresh. */
export function readResumeRecord(path: string): {
  readonly outcomes: ResumedStageRecords;
  readonly usage: ReadonlyMap<string, readonly RecordedEngineUsage[]>;
} {
  const anchors = new Map<string, { identity: string; workspace: string; recordId: string }>();
  const stages = new Map<string, RecordedStage>();
  const usage = new Map<string, RecordedEngineUsage[]>();
  const started = new Set<string>();
  if (!existsSync(path)) return { outcomes: { anchors, stages }, usage };
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (const [lineNumber, line] of lines.entries()) {
    if (!line) continue;
    let event: LoopEvent;
    try {
      event = JSON.parse(line) as LoopEvent;
    } catch {
      continue;
    }
    if (event.kind === 'workflow:start') {
      const key = event.path.join('/');
      const prior = anchors.get(key);
      if (prior?.identity !== event.identity || prior.workspace !== event.workspace) {
        const prefix = key ? `${key}/` : '';
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
      const key = [...event.path, event.node].join('/');
      started.add(key);
      if (event.phase === 'start') {
        const prior = stages.get(key);
        if (!(event.attempt === 1 && prior?.kind === 'completed' && prior.outcome.status === 'pass')) {
          stages.set(key, { kind: 'interrupted', startLine: lineNumber });
        }
      } else if (event.outcome !== undefined) {
        stages.set(key, { kind: 'completed', outcome: event.outcome });
      }
    } else if (event.kind === 'engine:usage' && event.role !== undefined && event.stage !== undefined) {
      for (let index = event.path.length; index > 0; index -= 1) {
        if (event.path[index - 1] !== event.stage) continue;
        const key = event.path.slice(0, index).join('/');
        if (!started.has(key)) continue;
        const answers = usage.get(key) ?? [];
        answers.push({ model: event.model, path: event.path, role: event.role, stage: event.stage });
        usage.set(key, answers);
        break;
      }
    }
  }
  return { outcomes: { anchors, stages }, usage };
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
    try {
      appendFileSync(
        path,
        `${JSON.stringify(options.thin ? thinEvent(event) : event)}\n`,
      );
    } catch {
      // Recording is best-effort until the durable event store arrives in D3.
    }
  };
}

function thinEvent(event: LoopEvent): unknown {
  switch (event.kind) {
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
  return thin;
}

function thinProofArtifact(
  artifact: Extract<LoopEvent, { kind: 'proof' }>['artifact'],
): Extract<LoopEvent, { kind: 'proof' }>['artifact'] {
  if (artifact.data === undefined) return artifact;
  const { data: _data, ...rest } = artifact;
  return rest;
}
