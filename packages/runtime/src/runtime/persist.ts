import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { LoopEvent, Outcome } from '../core/types.js';

const NOISE: ReadonlySet<LoopEvent['kind']> = new Set([
  'engine:text',
  'engine:thinking',
]);

interface RecorderOptions {
  thin?: boolean;
  /** Append to the existing record instead of truncating it, and return
   * the stage outcomes it already holds so a resuming run can skip
   * completed work. */
  resume?: boolean;
}

/** The stage outcomes a record already holds, keyed by the job path that
 * produced them. Built from the job:end events of a prior run. */
export type ResumedStageOutcomes = ReadonlyMap<string, Outcome>;

/** Read a record's job:end events into a path-keyed outcome map. A record
 * that does not exist, or one with no job:end events, yields an empty map:
 * resume over nothing is a fresh run. */
export function readStageOutcomes(path: string): ResumedStageOutcomes {
  if (!existsSync(path)) return new Map();
  const outcomes = new Map<string, Outcome>();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    let event: LoopEvent;
    try {
      event = JSON.parse(line) as LoopEvent;
    } catch {
      continue;
    }
    if (event.kind === 'job:end') {
      outcomes.set(event.path.join('/'), event.outcome);
    } else if (event.kind === 'dag:node' && event.outcome !== undefined) {
      // The dag records the node job's own return, which carries the
      // workflow's resume identity when the declarative guard attached it.
      outcomes.set([...event.path, event.node].join('/'), event.outcome);
    }
  }
  return outcomes;
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
