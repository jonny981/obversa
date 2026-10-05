import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import {
  agentJob,
  approval,
  dag,
  fnJob,
  type AgentJobConfig,
  type Job,
  type JsonValue,
  type Outcome,
} from '@obversa/runtime';
import { outcomeFromAgentText } from '@obversa/runtime/workflow-support';

import { assertDistinctSeats, seatIdentity } from './team-utils.js';
import type { ImproveWorkflowConfig, TeamSeat } from './types.js';

/** The rule both seats read, and the reviewing seat holds the proposal to. */
const OFF_LIMITS = 'The change must not remove or weaken a review, a check, a goal check, a judge, an approval or a guard.';

const TARGETS = [
  'a step that fails its first round on the same kind of finding: change its prompt or brief',
  'a reviewer whose findings the judge always skips: change its instructions',
  'a cap or an effort that costs more than it returns',
  'a check that runs late and sends work back after an expensive step: run it earlier',
];

interface RecordSource {
  readonly record: string;
  readonly workflow: string;
  readonly sha256: string;
}

interface Evidence {
  readonly line: number;
  readonly note: string;
  /** The record line itself, as the person reads it in the question. */
  readonly event: string;
}

interface Proposal {
  readonly diff: string;
  readonly reason: string;
  readonly evidence: readonly Evidence[];
}

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The record's lines, numbered from 1 as the proposal cites them. */
async function recordLines(path: string): Promise<string[]> {
  const lines = (await readFile(path, 'utf8')).split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function numbered(lines: readonly string[]): string {
  return lines.map((line, index) => `${index + 1}: ${line}`).join('\n');
}

/** Check the record names this file, at the bytes it ran with. */
async function readSource(config: ImproveWorkflowConfig): Promise<RecordSource> {
  const record = resolve(config.record);
  const workflow = resolve(config.workflow);
  let source: { path?: unknown; sha256?: unknown } | undefined;
  for (const [index, line] of (await recordLines(record)).entries()) {
    let event: { kind?: unknown; source?: { path?: unknown; sha256?: unknown } };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      throw new Error(`line ${index + 1} of the record ${record} is not JSON`);
    }
    // A resumed record has one run:start per session; the last one ran last.
    if (event.kind === 'run:start' && event.source !== undefined) source = event.source;
  }
  if (typeof source?.path !== 'string' || typeof source.sha256 !== 'string') {
    throw new Error(`the record ${record} names no workflow file; run the workflow with the source option to record one`);
  }
  if (source.path !== workflow) {
    throw new Error(`the record ${record} names the workflow file ${source.path}, not ${workflow}`);
  }
  const current = sha256(await readFile(workflow));
  if (current !== source.sha256) {
    throw new Error(`the workflow file ${workflow} has changed since the run: the record has SHA-256 ${source.sha256}, the file has SHA-256 ${current}`);
  }
  return { record, workflow, sha256: current };
}

interface Hunk {
  readonly oldStart: number;
  readonly oldLines: readonly string[];
  readonly newLines: readonly string[];
}

/** One file's unified diff, as hunks. Throws with what is wrong with it. */
function parseDiff(diff: string, workflow: string): Hunk[] {
  const lines = diff.replace(/\n$/, '').split('\n');
  const first = lines.findIndex((line) => line.startsWith('@@'));
  if (first === -1) throw new Error('the diff has no hunk');
  const header = lines.slice(0, first);
  const from = header.filter((line) => line.startsWith('--- '));
  const to = header.filter((line) => line.startsWith('+++ '));
  if (from.length !== 1 || to.length !== 1) throw new Error('the diff must name one file, with one --- line and one +++ line');
  const paths = [from[0]!, to[0]!].map((line) => line.slice(4).split('\t')[0]!.trim());
  if (paths.includes('/dev/null')) throw new Error('the diff must change the workflow file, not create or delete one');
  for (const path of paths) {
    if (basename(path) !== basename(workflow)) throw new Error(`the diff names ${path}, not the workflow file ${basename(workflow)}`);
  }
  const hunks: Hunk[] = [];
  let current: { oldStart: number; oldLines: string[]; newLines: string[] } | undefined;
  for (let index = first; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (!match) throw new Error(`line ${index + 1} of the diff is not a hunk header: ${line}`);
      current = { oldStart: Number(match[1]), oldLines: [], newLines: [] };
      hunks.push(current);
    } else if (line.startsWith('diff ') || (line.startsWith('--- ') && lines[index + 1]?.startsWith('+++ '))) {
      throw new Error('the diff must change one file only');
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file": the applied file keeps its own ending.
    } else if (line.startsWith('-')) {
      current!.oldLines.push(line.slice(1));
    } else if (line.startsWith('+')) {
      current!.newLines.push(line.slice(1));
    } else if (line.startsWith(' ') || line === '') {
      current!.oldLines.push(line.slice(1));
      current!.newLines.push(line.slice(1));
    } else {
      throw new Error(`line ${index + 1} of the diff is not a diff line: ${line}`);
    }
  }
  return hunks;
}

function matchesAt(lines: readonly string[], block: readonly string[], at: number): boolean {
  if (at < 0 || at + block.length > lines.length) return false;
  return block.every((line, offset) => lines[at + offset] === line);
}

/**
 * Apply the diff to the text. Each hunk's lines must match the file exactly;
 * a hunk whose line number is off is found at the nearest place it matches,
 * after the hunk before it.
 */
function applyDiff(text: string, diff: string, workflow: string): string {
  const endsWithNewline = text.endsWith('\n');
  const lines = (endsWithNewline ? text.slice(0, -1) : text).split('\n');
  let shift = 0;
  let floor = 0;
  for (const [index, hunk] of parseDiff(diff, workflow).entries()) {
    const expected = hunk.oldLines.length === 0 ? hunk.oldStart + shift : hunk.oldStart - 1 + shift;
    let at = -1;
    search: for (let distance = 0; distance <= lines.length; distance += 1) {
      for (const candidate of [expected - distance, expected + distance]) {
        if (candidate >= floor && matchesAt(lines, hunk.oldLines, candidate)) {
          at = candidate;
          break search;
        }
      }
    }
    if (at === -1) throw new Error(`hunk ${index + 1} of the diff does not match the workflow file`);
    lines.splice(at, hunk.oldLines.length, ...hunk.newLines);
    shift += hunk.newLines.length - hunk.oldLines.length;
    floor = at + hunk.newLines.length;
  }
  const applied = lines.join('\n') + (endsWithNewline ? '\n' : '');
  if (applied === text) throw new Error('the diff changes nothing');
  return applied;
}

/** The proposing seat's reply as a proposal that applies, or what is wrong with it. */
function parseProposal(text: string, lines: readonly string[], workflowText: string, workflow: string): Proposal {
  // The reply is the object, perhaps inside a code fence or after a line of prose.
  let value: { diff?: unknown; reason?: unknown; evidence?: unknown } | undefined;
  try {
    value = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as typeof value;
  } catch {
    // Reported below.
  }
  if (value === null || typeof value !== 'object') throw new Error('the reply is not one JSON object');
  if (typeof value.diff !== 'string' || !value.diff.trim()) throw new Error('the proposal has no diff');
  if (typeof value.reason !== 'string' || !value.reason.trim()) throw new Error('the proposal has no reason');
  if (!Array.isArray(value.evidence) || value.evidence.length === 0) throw new Error('the proposal cites no line of the record');
  const evidence = value.evidence.map((item: unknown): Evidence => {
    const { line, note } = (item ?? {}) as { line?: unknown; note?: unknown };
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1 || line > lines.length) {
      throw new Error(`the proposal cites line ${String(line)}, and the record has lines 1 to ${lines.length}`);
    }
    if (typeof note !== 'string' || !note.trim()) throw new Error(`the proposal cites line ${line} with no note`);
    return { line, note, event: lines[line - 1]! };
  });
  applyDiff(workflowText, value.diff, workflow);
  return { diff: value.diff, reason: value.reason, evidence };
}

function evidenceText(evidence: readonly Evidence[]): string {
  return evidence.map(({ line, note, event }) => `- line ${line}: ${note}\n  ${event}`).join('\n');
}

function seatJob(label: string, seat: TeamSeat): Omit<AgentJobConfig, 'prompt'> {
  const identity = seatIdentity(seat);
  return {
    label,
    engine: seat.engine,
    model: identity.model,
    tools: [...identity.tools],
    allowedTools: [...identity.tools],
    workspaceMode: 'read',
  };
}

function sourceOf(outcome: Outcome | undefined): RecordSource {
  return outcome!.data as unknown as RecordSource;
}

/**
 * Propose one change to a workflow from the record of one of its runs, have a
 * seat from another model family check it, and ask a person. A yes applies
 * the diff to the file; a no writes nothing. The run records the
 * proposal, the evidence and the decision, with the file's SHA-256 before and
 * after.
 */
export function improveWorkflow(config: ImproveWorkflowConfig) {
  if (!config.record.trim()) throw new TypeError('record must not be empty');
  if (!config.workflow.trim()) throw new TypeError('workflow must not be empty');
  assertDistinctSeats([config.proposer, config.reviewer]);

  const read = fnJob('read', async (): Promise<Outcome> => {
    try {
      const source = await readSource(config);
      return {
        status: 'pass',
        summary: `the record ${source.record} ran ${source.workflow} at SHA-256 ${source.sha256}`,
        data: { ...source },
      };
    } catch (error) {
      return { status: 'fail', summary: error instanceof Error ? error.message : String(error) };
    }
  });

  const propose = agentJob({
    ...seatJob('propose', config.proposer),
    prompt: async (ctx) => {
      const { record, workflow } = sourceOf(ctx.needs?.read);
      return [
        'You improve one workflow from the record of one of its runs.',
        `Propose exactly one change to the workflow file ${workflow}, as a unified diff against the file below. Do not edit any file.`,
        'Look for one of these:',
        ...TARGETS.map((target) => `- ${target}`),
        OFF_LIMITS,
        'Give a short reason that cites the record: which events, which rounds, and what they cost. Cite each event by its line number.',
        'Return one JSON object: {"diff":"...","reason":"...","evidence":[{"line":1,"note":"what this event shows"}]}',
        '',
        `The workflow file ${workflow}:`,
        await readFile(workflow, 'utf8'),
        '',
        `The record ${record}, one event per line, each after its line number:`,
        numbered(await recordLines(record)),
      ].join('\n');
    },
    outcome: async (text, ctx) => {
      const { record, workflow, sha256: before } = sourceOf(ctx.needs?.read);
      try {
        const bytes = await readFile(workflow);
        if (sha256(bytes) !== before) {
          throw new Error(`the workflow file ${workflow} changed while the change was proposed; nothing is proposed from a file the record did not run`);
        }
        const proposal = parseProposal(text, await recordLines(record), bytes.toString('utf8'), workflow);
        return { status: 'pass', summary: proposal.reason, data: { ...proposal } as unknown as JsonValue };
      } catch (error) {
        return { status: 'fail', summary: error instanceof Error ? error.message : String(error), data: { response: text } };
      }
    },
  });

  const review = agentJob({
    ...seatJob('review', config.reviewer),
    prompt: async (ctx) => {
      const { record, workflow } = sourceOf(ctx.needs?.read);
      const proposal = ctx.needs?.propose?.data as unknown as Proposal;
      return [
        'You check one proposed change to a workflow file before a person is asked to apply it.',
        `The rule: ${OFF_LIMITS}`,
        'Check the diff against the rule. Check the evidence: each cited line of the record must show what the reason says it shows.',
        'Return revise when the change breaks the rule or the record does not support the reason; otherwise return pass.',
        'Return one JSON object: {"status":"pass"|"revise","summary":"...","findings":[{"evidence":"..."}]}',
        '',
        `The proposed diff to ${workflow}:`,
        proposal.diff,
        '',
        `The reason: ${proposal.reason}`,
        '',
        'The evidence:',
        evidenceText(proposal.evidence),
        '',
        `The workflow file ${workflow} before the change:`,
        await readFile(workflow, 'utf8'),
        '',
        `The record ${record}, one event per line, each after its line number:`,
        numbered(await recordLines(record)),
      ].join('\n');
    },
    outcome: (text) => outcomeFromAgentText(text),
  });

  const approve: Job = async (ctx) => {
    const { record, workflow, sha256: before } = sourceOf(ctx.needs?.read);
    const proposal = ctx.needs?.propose?.data as unknown as Proposal;
    const asked = await approval('approve', {
      question: `Apply this change to ${workflow}?`,
      input: { record, workflow, sha256: before, diff: proposal.diff, reason: proposal.reason, evidence: proposal.evidence.map((item) => ({ ...item })) },
    })(ctx);
    const answer = asked.data as { approved?: unknown; note?: unknown } | undefined;
    const decided = { record, workflow, sha256Before: before, diff: proposal.diff, reason: proposal.reason };
    if (asked.status === 'fail' && answer?.approved === false) {
      // Someone may have edited the file while the question waited: record the hash it has.
      const after = sha256(await readFile(workflow));
      const file = after === before
        ? `the file is unchanged at SHA-256 ${before}`
        : `the file changed while the question waited: SHA-256 ${before} before, ${after} after`;
      return {
        status: 'pass',
        summary: `refused, the change was not applied; ${file}: ${String(answer.note)}`,
        data: { decision: 'refused', ...decided, sha256After: after, note: String(answer.note) },
      };
    }
    if (asked.status !== 'pass') return asked;
    // The file must still be the one the record ran and the person read.
    const text = await readFile(workflow, 'utf8');
    if (sha256(text) !== before) {
      return {
        status: 'fail',
        summary: `the workflow file ${workflow} changed after the question was asked: the record has SHA-256 ${before}, the file has SHA-256 ${sha256(text)}; nothing is applied`,
      };
    }
    const applied = applyDiff(text, proposal.diff, workflow);
    await writeFile(workflow, applied);
    const after = sha256(applied);
    return {
      status: 'pass',
      summary: `applied the change to ${workflow}: SHA-256 ${before} before, ${after} after`,
      data: {
        decision: 'applied',
        ...decided,
        sha256After: after,
        ...(typeof answer?.note === 'string' ? { note: answer.note } : {}),
      },
    };
  };

  return dag({
    name: 'improve-workflow',
    stopOnError: true,
    nodes: {
      read: {
        job: read,
        desc: 'Read the record and check that the workflow file is the one the run used.',
        gate: "The workflow file's SHA-256 matches the one the record names.",
        needs: [],
      },
      propose: {
        job: propose,
        desc: 'Propose one change to the workflow file, with a reason that cites the record.',
        gate: 'One diff that applies to the workflow file, and at least one cited line of the record.',
        needs: ['read'],
      },
      review: {
        job: review,
        desc: 'A seat from another model family checks the change against the rule and the evidence.',
        gate: 'The change removes and weakens no review, check, goal check, judge, approval or guard, and the record supports the reason.',
        needs: ['read', 'propose'],
      },
      approve: {
        job: approve,
        desc: 'Ask a person to apply the change, and apply it only on a yes.',
        gate: "A person's answer is recorded, with the file's SHA-256 before and after.",
        needs: ['read', 'propose', 'review'],
      },
    },
  });
}
