import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createCallbackClient,
  directRouter,
  fnJob,
  kickback,
  pipeline,
  run,
  type AgentRequest,
  type CallbackClient,
  type LoopEvent,
} from '@obversa/runtime';

import { improveWorkflow } from '../src/index.js';
import { pass, revise, scriptedEngine, seat } from './scripted-engine.js';

const FINDING = 'the summary does not name the ticket';

/** The workflow file a run names as its source. The run below is built in the test; this is the file it ran from. */
const WORKFLOW = [
  "import { fnJob, kickback, pipeline } from '@obversa/runtime';",
  '',
  "const brief = 'Summarise the ticket in three lines.';",
  '',
  'export const summary = pipeline(\'summary\', [',
  "  { name: 'draft', job: fnJob('draft', () => brief) },",
  "  { name: 'check', job: fnJob('check', () => kickback('draft', 'the summary does not name the ticket')), acceptsKickbackTo: ['draft'] },",
  '], { maxKickbacks: 3 });',
  '',
].join('\n');

/** Name the ticket in the brief: the change the record asks for. */
const BRIEF_DIFF = [
  '--- a/summary.workflow.ts',
  '+++ b/summary.workflow.ts',
  '@@ -3,1 +3,1 @@',
  "-const brief = 'Summarise the ticket in three lines.';",
  "+const brief = 'Summarise the ticket in three lines. Start with the ticket number.';",
  '',
].join('\n');

/** Drop the check: a change the rule forbids. */
const NO_CHECK_DIFF = [
  '--- a/summary.workflow.ts',
  '+++ b/summary.workflow.ts',
  '@@ -6,2 +6,1 @@',
  "   { name: 'draft', job: fnJob('draft', () => brief) },",
  "-  { name: 'check', job: fnJob('check', () => kickback('draft', 'the summary does not name the ticket')), acceptsKickbackTo: ['draft'] },",
  '',
].join('\n');

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

let dir: string;
let workflowFile: string;
let recordFile: string;

/** One run whose draft fails the check on the same finding three times, then passes. */
async function recordedRun(): Promise<void> {
  let drafts = 0;
  const job = pipeline('summary', [
    { name: 'draft', job: fnJob('draft', () => { drafts += 1; return `draft ${drafts}`; }) },
    {
      name: 'check',
      job: fnJob('check', () => (drafts <= 3 ? kickback('draft', FINDING) : 'the summary names the ticket')),
      acceptsKickbackTo: ['draft'],
    },
  ], { maxKickbacks: 3 });
  const result = await run(job, { cwd: dir, recordTo: recordFile, source: workflowFile });
  expect(result.outcome.status).toBe('pass');
}

async function events(path: string): Promise<LoopEvent[]> {
  return (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as LoopEvent);
}

/** The record's line numbers, from 1, of the send-backs to the draft. */
async function kickbackLines(): Promise<number[]> {
  return (await events(recordFile))
    .map((event, index) => ({ event, line: index + 1 }))
    .filter(({ event }) => event.kind === 'dag:kickback' && event.to === 'draft' && event.reason === FINDING)
    .map(({ line }) => line);
}

/** A stand-in proposer: it cites every send-back to the draft it finds in the numbered record. */
function proposer(diff: string) {
  return scriptedEngine('proposer', [(request: AgentRequest) => {
    const lines = [...request.prompt.matchAll(/^(\d+): .*"kind":"dag:kickback".*"to":"draft"/gm)].map((match) => Number(match[1]));
    return JSON.stringify({
      diff,
      reason: `The check sent the draft back ${lines.length} times on the same finding: the brief does not ask for the ticket number.`,
      evidence: lines.map((line, index) => ({ line, note: `round ${index + 1} of the draft sent back: ${FINDING}` })),
    });
  }]);
}

/** A stand-in reviewer: it refuses a diff that removes a line with a check in it, and passes anything else. */
function reviewer() {
  return scriptedEngine('reviewer', [(request: AgentRequest) => {
    if (!request.prompt.includes('must not remove or weaken a review, a check')) return revise('no rule', 'the prompt did not state the rule');
    return /^-.*check/m.test(request.prompt)
      ? revise('the change removes the check', 'the diff deletes the check step, which the rule forbids')
      : pass('the change keeps every check, and lines of the record show the three send-backs');
  }]);
}

function improve(proposerEngine: ReturnType<typeof proposer>, reviewerEngine: ReturnType<typeof reviewer>) {
  return improveWorkflow({
    record: recordFile,
    workflow: workflowFile,
    proposer: seat(proposerEngine, 'proposer-family'),
    reviewer: seat(reviewerEngine, 'reviewer-family'),
  });
}

/** Run until the question is asked, so the test can answer it as a person would. */
async function askedRun(callbacks: CallbackClient, improveRecord: string) {
  const proposerEngine = proposer(BRIEF_DIFF);
  const reviewerEngine = reviewer();
  const job = improve(proposerEngine, reviewerEngine);
  const first = await run(job, { cwd: dir, callbacks, recordTo: improveRecord });
  expect(first.outcome.status).toBe('paused');
  const pending = callbacks.listPending();
  expect(pending).toHaveLength(1);
  return { job, request: pending[0]!, proposerEngine, reviewerEngine };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'obversa-improve-workflow-'));
  workflowFile = join(dir, 'summary.workflow.ts');
  recordFile = join(dir, 'summary.jsonl');
  await writeFile(workflowFile, WORKFLOW);
  await recordedRun();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('improveWorkflow', () => {
  it('proposes a change that cites the rounds where the draft failed on the same finding', async () => {
    const lines = await kickbackLines();
    expect(lines).toHaveLength(3);
    const callbacks = createCallbackClient();
    const { request, proposerEngine } = await askedRun(callbacks, join(dir, 'improve.jsonl'));

    expect(proposerEngine.calls[0]!.prompt).toContain(WORKFLOW);
    const recordText = (await readFile(recordFile, 'utf8')).trim().split('\n');
    const input = request.input as { diff: string; reason: string; evidence: { line: number; event: string }[]; sha256: string };
    expect(input.diff).toBe(BRIEF_DIFF);
    expect(input.reason).toContain('3 times on the same finding');
    expect(input.evidence.map(({ line }) => line)).toEqual(lines);
    expect(input.evidence.map(({ event }) => event)).toEqual(lines.map((line) => recordText[line - 1]));
    expect(input.sha256).toBe(sha256(WORKFLOW));
    // Nothing is applied while the question waits.
    expect(await readFile(workflowFile, 'utf8')).toBe(WORKFLOW);
  });

  it('fails a proposal that removes a check at the reviewing seat, and asks nobody', async () => {
    const callbacks = createCallbackClient();
    const reviewerEngine = reviewer();
    const result = await run(improve(proposer(NO_CHECK_DIFF), reviewerEngine), { cwd: dir, callbacks });

    expect(result.outcome.status).toBe('fail');
    expect(reviewerEngine.calls[0]!.prompt).toContain(NO_CHECK_DIFF);
    const nodes = result.outcome.data as { review?: { summary?: string } };
    expect(nodes.review?.summary).toBe('the change removes the check');
    expect(callbacks.history()).toHaveLength(0);
    expect(await readFile(workflowFile, 'utf8')).toBe(WORKFLOW);
  });

  it('refuses a workflow file that changed since the run, naming both hashes', async () => {
    const edited = WORKFLOW.replace('three lines', 'two lines');
    await writeFile(workflowFile, edited);
    const proposerEngine = proposer(BRIEF_DIFF);
    const result = await run(improve(proposerEngine, reviewer()), { cwd: dir });

    expect(result.outcome.status).toBe('fail');
    const nodes = result.outcome.data as { read?: { summary?: string } };
    expect(nodes.read?.summary).toContain(`the record has SHA-256 ${sha256(WORKFLOW)}`);
    expect(nodes.read?.summary).toContain(`the file has SHA-256 ${sha256(edited)}`);
    expect(proposerEngine.calls).toHaveLength(0);
  });

  it('applies the diff on a yes and records the proposal and the decision with both hashes', async () => {
    const callbacks = createCallbackClient();
    const improveRecord = join(dir, 'improve.jsonl');
    const { job, request, proposerEngine } = await askedRun(callbacks, improveRecord);
    const submitted = await directRouter(callbacks, request, 'person', () => ({ approved: true }));
    expect(submitted.ok).toBe(true);

    const second = await run(job, { cwd: dir, callbacks, recordTo: improveRecord, resume: true });
    expect(second.outcome.status).toBe('pass');
    const improved = WORKFLOW.replace('three lines.', 'three lines. Start with the ticket number.');
    expect(await readFile(workflowFile, 'utf8')).toBe(improved);
    expect(proposerEngine.calls).toHaveLength(1);

    const done = (await events(improveRecord)).filter((event) => event.kind === 'dag:node' && event.phase === 'done');
    const proposal = done.find((event) => event.kind === 'dag:node' && event.node === 'propose');
    expect(proposal?.kind === 'dag:node' && proposal.outcome?.data).toMatchObject({ diff: BRIEF_DIFF });
    const decision = done.filter((event) => event.kind === 'dag:node' && event.node === 'approve').at(-1);
    expect(decision?.kind === 'dag:node' && decision.outcome?.data).toEqual({
      decision: 'applied',
      record: recordFile,
      workflow: workflowFile,
      sha256Before: sha256(WORKFLOW),
      sha256After: sha256(improved),
      diff: BRIEF_DIFF,
      reason: 'The check sent the draft back 3 times on the same finding: the brief does not ask for the ticket number.',
    });
  });

  it('leaves the file untouched on a no and records the reason', async () => {
    const callbacks = createCallbackClient();
    const improveRecord = join(dir, 'improve.jsonl');
    const { job, request } = await askedRun(callbacks, improveRecord);
    await directRouter(callbacks, request, 'person', () => ({ approved: false, note: 'the ticket number is in the title already' }));

    const second = await run(job, { cwd: dir, callbacks, recordTo: improveRecord, resume: true });
    expect(second.outcome.status).toBe('pass');
    expect(await readFile(workflowFile, 'utf8')).toBe(WORKFLOW);
    const decision = (await events(improveRecord))
      .filter((event) => event.kind === 'dag:node' && event.phase === 'done' && event.node === 'approve').at(-1);
    expect(decision?.kind === 'dag:node' && decision.outcome?.data).toMatchObject({
      decision: 'refused',
      record: recordFile,
      workflow: workflowFile,
      sha256Before: sha256(WORKFLOW),
      sha256After: sha256(WORKFLOW),
      note: 'the ticket number is in the title already',
    });
  });

  it('applies nothing when the file changed while the question waited', async () => {
    const callbacks = createCallbackClient();
    const improveRecord = join(dir, 'improve.jsonl');
    const { job, request } = await askedRun(callbacks, improveRecord);
    const edited = `${WORKFLOW}// edited while the question waited\n`;
    await writeFile(workflowFile, edited);
    await directRouter(callbacks, request, 'person', () => ({ approved: true }));

    const second = await run(job, { cwd: dir, callbacks, recordTo: improveRecord, resume: true });
    expect(second.outcome.status).toBe('fail');
    expect(await readFile(workflowFile, 'utf8')).toBe(edited);
  });

  it('records the hash the file has on a no, when the file changed while the question waited', async () => {
    const callbacks = createCallbackClient();
    const improveRecord = join(dir, 'improve.jsonl');
    const { job, request } = await askedRun(callbacks, improveRecord);
    const edited = `${WORKFLOW}// edited while the question waited\n`;
    await writeFile(workflowFile, edited);
    await directRouter(callbacks, request, 'person', () => ({ approved: false, note: 'not now' }));

    const second = await run(job, { cwd: dir, callbacks, recordTo: improveRecord, resume: true });
    expect(second.outcome.status).toBe('pass');
    expect(await readFile(workflowFile, 'utf8')).toBe(edited);
    const decision = (await events(improveRecord))
      .filter((event) => event.kind === 'dag:node' && event.phase === 'done' && event.node === 'approve').at(-1);
    expect(decision?.kind === 'dag:node' && decision.outcome?.data).toMatchObject({
      decision: 'refused',
      sha256Before: sha256(WORKFLOW),
      sha256After: sha256(edited),
      note: 'not now',
    });
    expect(decision?.kind === 'dag:node' && decision.outcome?.summary).toContain('the file changed while the question waited');
  });
});
