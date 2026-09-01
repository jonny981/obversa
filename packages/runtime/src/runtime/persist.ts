import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { LoopEvent, Outcome } from '../core/types.js';

const NOISE: ReadonlySet<LoopEvent['kind']> = new Set([
  'engine:text',
  'engine:thinking',
]);

interface RecorderOptions {
  thin?: boolean;
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
  writeFileSync(path, '');
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
