/**
 * What one run's record leaves for the next run on the same work: the open
 * findings of its last finished review, the proofs its proof check
 * accepted, its proof check's send-backs, each review panel's rounds, and
 * how the run ended.
 */

import { existsSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { AcceptedProof, CarriedWork, FeedbackFinding, Outcome, OutcomeStatus } from '../core/types.js';
import type { ProofSendBacks } from '../core/proofs.js';
import { reviewRoundsKey, type ReviewRounds } from '../core/review-rounds.js';

export interface RecordCarry extends Omit<CarriedWork, 'record'> {
  /** Each review panel's rounds as its last outcome recorded them, by `reviewRoundsKey`. */
  readonly reviewRounds: Readonly<Record<string, ReviewRounds>>;
  /** The proof check's send-backs as its last outcome recorded them; a resume reads them back. */
  readonly proofSendBacks?: ProofSendBacks;
}

interface RecordLine {
  readonly kind?: string;
  readonly path?: readonly string[];
  readonly node?: string;
  readonly label?: string;
  readonly phase?: string;
  readonly outcome?: Outcome;
  readonly data?: { readonly skipped?: Record<string, readonly { readonly finding?: { readonly evidence?: unknown } }[]> } | null;
}

function lines(file: string): RecordLine[] {
  const parsed: RecordLine[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      parsed.push(JSON.parse(line) as RecordLine);
    } catch {
      // A torn last line from a stopped process says nothing.
    }
  }
  return parsed;
}

function dataOf(outcome: Outcome | undefined): Record<string, unknown> | undefined {
  const data = outcome?.data;
  return data !== null && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
}

function isSendBacks(value: unknown): value is ProofSendBacks {
  const sent = value as Partial<ProofSendBacks> | null;
  return sent !== null && typeof sent === 'object' && typeof sent.count === 'number' && typeof sent.report === 'string';
}

function isProof(value: unknown): value is AcceptedProof {
  const proof = value as Partial<AcceptedProof> | null;
  return proof !== null && typeof proof === 'object'
    && typeof proof.item === 'string' && typeof proof.tree === 'string'
    && Array.isArray(proof.files) && proof.files.every((file) => typeof file === 'string');
}

/** Read what a record leaves for the next run. A missing record leaves nothing. */
export function readCarry(file: string): RecordCarry {
  if (!existsSync(file)) return { openFindings: [], acceptedProofs: [], reviewRounds: {} };
  const events = lines(file);
  // A judge's skipped findings live on the graph's checkpoints, by target.
  const skipped = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'interaction:checkpoint') continue;
    for (const list of Object.values(event.data?.skipped ?? {})) {
      for (const entry of list) {
        if (typeof entry?.finding?.evidence === 'string') skipped.add(entry.finding.evidence);
      }
    }
  }
  let openFindings: FeedbackFinding[] = [];
  let acceptedProofs: AcceptedProof[] = [];
  let proofSendBacks: ProofSendBacks | undefined;
  const reviewRounds: Record<string, ReviewRounds> = {};
  let lastStop: { node: string; outcome: Outcome } | undefined;
  let runEnd: Outcome | undefined;
  for (const event of events) {
    const data = dataOf(event.outcome);
    if (event.kind === 'job:end' && data?.reviewRounds !== undefined && event.label !== undefined) {
      reviewRounds[reviewRoundsKey(event.path ?? [], event.label)] = data.reviewRounds as ReviewRounds;
    }
    if (Array.isArray(data?.acceptedProofs)) acceptedProofs = (data.acceptedProofs as unknown[]).filter(isProof);
    if (isSendBacks(data?.proofSendBacks)) proofSendBacks = data.proofSendBacks;
    if (event.kind === 'dag:node' && event.phase === 'done' && event.outcome !== undefined) {
      const status = event.outcome.status;
      // A step blocked behind a failure records `aborted`; the step that stopped the run is the one before it.
      if (status !== 'pass' && status !== 'aborted' && event.node !== undefined) lastStop = { node: event.node, outcome: event.outcome };
      // The last review that finished: a paused or aborted one never decided.
      if (data?.reviewRound !== undefined && status !== 'paused' && status !== 'aborted') {
        const raised = status === 'pass'
          ? event.outcome.openFindings
          : event.outcome.openFindings ?? event.outcome.revision?.findings ?? (data.findings as FeedbackFinding[] | undefined);
        openFindings = (Array.isArray(raised) ? raised : []).filter((finding) => !skipped.has(finding.evidence));
      }
    }
    if (event.kind === 'run:end' && event.outcome !== undefined) runEnd = event.outcome;
  }
  const ended = runEnd === undefined
    ? lastStop === undefined ? undefined : endedAt(lastStop.node, lastStop.outcome)
    : runEnd.status !== 'pass' && lastStop !== undefined
      ? endedAt(lastStop.node, lastStop.outcome)
      : { status: runEnd.status, reason: runEnd.summary ?? runEnd.status };
  return { openFindings, acceptedProofs, reviewRounds, ...(proofSendBacks === undefined ? {} : { proofSendBacks }), ...(ended === undefined ? {} : { ended }) };
}

function endedAt(node: string, outcome: Outcome): { node: string; status: OutcomeStatus; reason: string } {
  return { node, status: outcome.status, reason: outcome.revision?.reason ?? outcome.summary ?? outcome.status };
}

/**
 * Keep a record a fresh run would write over: it moves beside the new one,
 * with the time it was last written in its name. Returns where it went.
 */
export function keepEarlierRecord(file: string): string | undefined {
  if (!existsSync(file) || statSync(file).size === 0) return undefined;
  const stamp = statSync(file).mtime.toISOString().replace(/[:.]/g, '-');
  const kept = /\.jsonl$/.test(file) ? file.replace(/\.jsonl$/, `-${stamp}.jsonl`) : `${file}-${stamp}`;
  renameSync(file, kept);
  return kept;
}

/** The earlier records `keepEarlierRecord` kept beside `file`, so a run can leave them out of its work. */
export function keptRecords(file: string): string[] {
  const dir = dirname(file);
  const stem = basename(file).replace(/\.jsonl$/, '');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith(`${stem}-`) && /^\d{4}-\d{2}-\d{2}T/.test(name.slice(stem.length + 1)))
    .map((name) => join(dir, name));
}
