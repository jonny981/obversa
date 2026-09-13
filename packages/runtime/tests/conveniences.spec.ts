import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, it, expect } from 'vitest';

import {
  LoopError,
  all,
  any,
  approval,
  commandJob,
  createCallbackClient,
  createStoredCallbackClient,
  dag,
  directRouter,
  failed,
  fnJob,
  loop,
  not,
  passed,
  pipeline,
  run,
} from '../src/api.ts';
import type { CallbackClient, CallbackRequest, Job, LoopEvent, Outcome, Sha256Digest } from '../src/api.ts';
import { createApprovalCallbackGate, type ApprovalSubjectInput } from '../src/callback/approval.js';
import { compileGraph } from '../src/graph/type.js';
import { dag as dagGraphType } from '../src/graph-types/dag.js';
import { resolveGraphPlan } from '../src/graph/plan.js';
import { persistRunDefinition } from '../src/runtime/run-definition.js';
import { createLocalRunStorage } from '../src/storage/local.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A run definition in local storage, so a stored callback client has a stream to write to. */
async function storedRun() {
  const root = await mkdtemp(join(tmpdir(), 'obversa-conveniences-'));
  roots.push(root);
  const graph = compileGraph(dagGraphType, {
    id: 'conveniences',
    definitionVersion: 1,
    data: { globalConcurrency: 1, keyedConcurrency: {}, stopOnError: true, retryCapPerNode: 0 },
    nodes: [{ id: 'approve', data: { kind: 'required', key: null } }],
    edges: [],
  });
  const packageIdentity = {
    source: 'npm:@example/conveniences',
    version: '1.0.0',
    digest: `sha256:${'1'.repeat(64)}` as const,
  };
  const storage = createLocalRunStorage({
    directory: join(root, 'storage'),
    namespace: 'conveniences-tests',
    policy: {
      schemaVersion: 1,
      maxEventPayloadBytes: 64_000,
      maxAppendBatchBytes: 128_000,
      maxArtifactBytes: 1_000_000,
      maxTotalArtifactBytesPerRun: 4_000_000,
      retention: 'until-run-delete',
      sensitiveContent: { marked: 'reject', exact: 'reject', freeText: 'redact-before-hash' },
    },
  });
  const runId = 'conveniences-run';
  await persistRunDefinition(storage, {
    runId,
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    graphDefinition: graph.definition,
    resolvedPlan: resolveGraphPlan(graph.describe(), {
      package: packageIdentity,
      admission: {
        package: packageIdentity,
        permissions: [{ name: 'workspace.write', scope: { paths: ['packages/runtime'] } }],
      },
      executionLanes: [],
    }),
    resolvedInputs: {},
    workspaceBinding: null,
    hostBinding: null,
  });
  return { runId, storage };
}

const hash = (digit: string): Sha256Digest => `sha256:${digit.repeat(64)}` as Sha256Digest;

/** A subject-backed question: the bytes a person approves, named in the request. */
const subjectFor = (output: string): ApprovalSubjectInput => ({
  workspaceAnchor: null,
  inputArtifactHashes: { source: hash('5') },
  proofScope: { kind: 'change', paths: ['packages/runtime'] },
  proofArtifact: { schemaVersion: 1, digest: hash('2'), byteLength: 128, mediaType: 'application/json', purpose: 'proof-packet' },
  proposedOutput: new TextEncoder().encode(output),
  effectivePermissions: [{ name: 'workspace.write', scope: { paths: ['packages/runtime'] } }],
});

const subjectGate = (revision: string, subject: ApprovalSubjectInput) => createApprovalCallbackGate({
  gateId: 'apply-change',
  gateVersion: 1,
  decisionText: 'Apply these exact bytes?',
  responseSchema: { type: 'object', properties: { kind: { type: 'string' } }, required: ['kind'] },
  input: { revision },
}, subject);

const node = process.execPath;

describe('fnJob returning a string or nothing', () => {
  it('returns pass with the label as the summary when the function returns nothing', async () => {
    const { outcome } = await run(fnJob('tidy', async () => {}));
    expect(outcome.status).toBe('pass');
    expect(outcome.summary).toBe('tidy');
  });

  it('returns pass with the string as the summary', async () => {
    const { outcome } = await run(fnJob('write', () => 'wrote report.csv'));
    expect(outcome.status).toBe('pass');
    expect(outcome.summary).toBe('wrote report.csv');
  });

  it('turns a throw into a fail that keeps the error', async () => {
    const { outcome } = await run(fnJob('write', () => { throw new Error('disk full'); }));
    expect(outcome.status).toBe('fail');
    expect(outcome.summary).toBe('disk full');
    expect(outcome.error?.message).toBe('disk full');
  });

  it('names a return that is neither an outcome, a string nor nothing', async () => {
    const { outcome } = await run(fnJob('count', () => 42 as unknown as Outcome));
    expect(outcome.status).toBe('fail');
    expect(outcome.summary).toContain('returned a number');
    const nothing = await run(fnJob('count', () => null as unknown as Outcome));
    expect(nothing.outcome.summary).toContain('returned null');
  });

  it('still accepts a full outcome', async () => {
    const { outcome } = await run(fnJob('check', (): Outcome => ({ status: 'fail', summary: 'no header' })));
    expect(outcome).toMatchObject({ status: 'fail', summary: 'no header' });
  });
});

describe('commandJob', () => {
  it('runs a command given as one string and passes on exit 0', async () => {
    const { outcome } = await run(commandJob('ok', `${node} -e 0`));
    expect(outcome.status).toBe('pass');
    expect(outcome.summary).toContain('exited 0');
  });

  it('sends a red command back to its target with the output as the finding', async () => {
    const { outcome } = await run(commandJob(
      'test',
      [node, '-e', 'console.error("add(2, 2) returned 0"); process.exit(1)'],
      { target: 'implement' },
    ));
    expect(outcome.status).toBe('fail');
    expect(outcome.revision?.target).toBe('implement');
    expect(outcome.revision?.findings?.[0]?.evidence).toContain('add(2, 2) returned 0');
    expect(outcome.summary).toContain('add(2, 2) returned 0');
  });

  it('keeps the output out of the summary when capture is off', async () => {
    const { outcome } = await run(commandJob(
      'test',
      [node, '-e', 'console.error("noisy"); process.exit(1)'],
      { capture: false },
    ));
    expect(outcome.status).toBe('fail');
    expect(outcome.summary).not.toContain('noisy');
    expect(outcome.revision).toBeUndefined();
  });

  it('refuses a one-string command that needs quoting', () => {
    expect(() => commandJob('test', `${node} -e "process.exit(1)"`)).toThrow(/array/);
  });

  it('refuses an empty one-string command', () => {
    expect(() => commandJob('nothing', '   ')).toThrow(/needs a command/);
  });

  it('refuses shell syntax in the one-string form, as the validation error the surface throws', () => {
    let caught: unknown;
    try { commandJob('lint', 'pnpm test && pnpm lint'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(LoopError);
    expect((caught as LoopError).code).toBe('VALIDATION');
    expect((caught as LoopError).message).toMatch(/shell/);
  });

  it('reruns the target inside a dag when the command is red', async () => {
    let implementRuns = 0;
    const { outcome } = await run(dag({
      name: 'command-back',
      maxKickbacks: 1,
      nodes: {
        implement: fnJob('implement', () => { implementRuns += 1; return `attempt ${implementRuns}`; }),
        test: {
          needs: 'implement',
          job: commandJob(
            'test',
            [node, '-e', `process.exit(process.env.RUNS === '1' ? 1 : 0)`],
            { target: 'implement', env: { RUNS: '1' } },
          ),
        },
      },
    }));
    // The env pins RUNS=1 both times, so the command stays red and the kickback cap ends the run.
    expect(implementRuns).toBe(2);
    expect(outcome.status).toBe('fail');
  });
});

describe('passed and failed', () => {
  it('choose the branch from a dependency outcome', async () => {
    const ran: string[] = [];
    const { outcome } = await run(dag({
      name: 'branch',
      nodes: {
        size: { optional: true, job: commandJob('size', [node, '-e', 'process.exit(1)']) },
        small: {
          needs: 'size',
          when: passed('size'),
          job: fnJob('small', () => { ran.push('small'); }),
        },
        large: {
          needs: 'size',
          when: failed('size'),
          job: fnJob('large', () => { ran.push('large'); }),
        },
      },
    }));
    expect(outcome.status).toBe('pass');
    expect(ran).toEqual(['large']);
  });

  it('meet neither when the dependency never got to decide', async () => {
    const ran: string[] = [];
    const { outcome } = await run(dag({
      name: 'blocked',
      nodes: {
        implement: fnJob('implement', (): Outcome => ({ status: 'fail', summary: 'no file' })),
        size: { needs: 'implement', optional: true, job: commandJob('size', [node, '-e', '0']) },
        small: { needs: 'size', when: passed('size'), job: fnJob('small', () => { ran.push('small'); }) },
        large: { needs: 'size', when: failed('size'), job: fnJob('large', () => { ran.push('large'); }) },
      },
    }));
    expect(outcome.status).toBe('fail');
    expect(ran).toEqual([]);
  });

  it('count a skipped dependency as passed', async () => {
    const ran: string[] = [];
    const { outcome } = await run(dag({
      name: 'skipped',
      nodes: {
        size: { when: () => false, job: commandJob('size', [node, '-e', 'process.exit(1)']) },
        small: { needs: 'size', when: passed('size'), job: fnJob('small', () => { ran.push('small'); }) },
      },
    }));
    expect(outcome.status).toBe('pass');
    expect(ran).toEqual(['small']);
  });

  it('refuse failed(x) at build time when x is not optional', () => {
    expect(() => dag({
      name: 'unreachable',
      nodes: {
        size: commandJob('size', [node, '-e', 'process.exit(1)']),
        large: { needs: 'size', when: failed('size'), job: fnJob('large', () => {}) },
      },
    })).toThrow(/optional/);
  });

  it('refuse at build time a name that is not a node', () => {
    expect(() => dag({
      name: 'branch',
      nodes: {
        a: fnJob('a', () => {}),
        b: { needs: 'a', when: passed('c'), job: fnJob('b', () => {}) },
      },
    })).toThrow(/"c" is not a node/);
  });

  it('refuse at build time a name the node does not need', () => {
    expect(() => dag({
      name: 'branch',
      nodes: {
        a: fnJob('a', () => {}),
        c: { optional: true, job: fnJob('c', () => {}) },
        b: { needs: 'a', when: failed('c'), job: fnJob('b', () => {}) },
      },
    })).toThrow(/not one of its needs/);
  });

  it('refuse failed(x) on a required x inside an array and inside all()', () => {
    for (const when of [[failed('size')], all(passed('size'), failed('size'))]) {
      expect(() => dag({
        name: 'wrapped',
        nodes: {
          size: commandJob('size', [node, '-e', 'process.exit(1)']),
          large: { needs: 'size', when, job: fnJob('large', () => {}) },
        },
      })).toThrow(/optional/);
    }
  });

  it('accept failed(x) on a required x inside not() and any(), which a branch can reach another way', () => {
    for (const when of [not(failed('size')), any(passed('size'), failed('size'))]) {
      expect(() => dag({
        name: 'reachable',
        nodes: {
          size: commandJob('size', [node, '-e', '0']),
          next: { needs: 'size', when, job: fnJob('next', () => {}) },
        },
      })).not.toThrow();
    }
  });

  it('fire neither branch over a decider that aborted, and none over one that paused', async () => {
    const ran: string[] = [];
    const branches = (decide: Job) => ({
      decide: { optional: true, job: decide },
      yes: { needs: 'decide', when: passed('decide'), job: fnJob('yes', () => { ran.push('yes'); }) },
      no: { needs: 'decide', when: failed('decide'), job: fnJob('no', () => { ran.push('no'); }) },
    });
    const aborted = await run(dag({ name: 'aborted', nodes: branches(fnJob('decide', (): Outcome => ({ status: 'aborted', summary: 'cut short' }))) }));
    expect(aborted.outcome.status).toBe('pass');
    expect(ran).toEqual([]);
    const paused = await run(dag({ name: 'paused', nodes: branches(fnJob('decide', (): Outcome => ({ status: 'paused', summary: 'later' }))) }));
    expect(paused.outcome.status).toBe('paused');
    expect(ran).toEqual([]);
  });

  it('fail the run when passed is used outside a dag', async () => {
    const { outcome } = await run(loop({ name: 'outside', body: fnJob('b', () => {}), until: passed('c'), max: 1 }));
    expect(outcome.status).not.toBe('pass');
    expect(JSON.stringify(outcome)).toContain('not a dependency');
  });
});

describe('approval', () => {
  it('passes when the person approves', async () => {
    const { outcome } = await run(approval('approve', {
      question: 'Ship this change?',
      answer: () => ({ approved: true }),
    }));
    expect(outcome.status).toBe('pass');
    expect(outcome.summary).toBe('approved: Ship this change?');
    expect(outcome.data).toEqual({ approved: true });
  });

  it('fails carrying the note when the person refuses and nothing owns the fix', async () => {
    const { outcome } = await run(approval('approve', {
      question: 'Ship this change?',
      answer: () => ({ approved: false, note: 'not before the header row is in' }),
    }));
    expect(outcome.status).toBe('fail');
    expect(outcome.summary).toBe('not before the header row is in');
    expect(outcome.revision).toBeUndefined();
  });

  it('sends a refusal back to the target with the note as the finding', async () => {
    const { outcome } = await run(approval('approve', {
      question: 'Ship this change?',
      target: 'implement',
      answer: () => ({ approved: false, note: 'add the header row' }),
    }));
    expect(outcome.status).toBe('fail');
    expect(outcome.revision?.target).toBe('implement');
    expect(outcome.revision?.findings?.[0]?.evidence).toBe('add the header row');
  });

  it('pauses the run with the request pending when nobody has answered', async () => {
    const client = createCallbackClient();
    const { outcome } = await run(approval('approve', { question: 'Ship this change?', input: { change: 'abc' } }), {
      callbacks: client,
    });
    expect(outcome.status).toBe('paused');
    const pending = client.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.decisionText).toBe('Ship this change?');
    expect((outcome.data as CallbackRequest).requestId).toBe(pending[0]?.requestId);
  });

  it('pauses with a client of its own when the run names none', async () => {
    const { outcome } = await run(approval('approve', { question: 'Ship this change?' }));
    expect(outcome.status).toBe('paused');
    expect(typeof (outcome.data as CallbackRequest).requestId).toBe('string');
  });

  it('finds the answer on a resume with the same client and carries on', async () => {
    const client = createCallbackClient();
    const job = approval('approve', { question: 'Ship this change?', input: { change: 'abc' } });
    const first = await run(job, { callbacks: client });
    expect(first.outcome.status).toBe('paused');
    const request = client.listPending()[0]!;
    const submitted = await directRouter(client, request, 'a-person', () => ({ approved: true }));
    expect(submitted.ok).toBe(true);
    const second = await run(job, { callbacks: client });
    expect(second.outcome.status).toBe('pass');
    expect(client.listPending()).toHaveLength(0);
  });

  it('asks about what came before, so a change after a kickback is a new question', async () => {
    const asked: string[] = [];
    let implementRuns = 0;
    const { outcome } = await run(pipeline('ship', [
      { name: 'implement', job: fnJob('implement', () => { implementRuns += 1; return `report.csv v${implementRuns}`; }) },
      {
        name: 'approve',
        job: approval('approve', {
          question: 'Ship this change?',
          target: 'implement',
          answer: (request) => {
            asked.push(request.requestId);
            const about = JSON.stringify(request.input);
            return about.includes('v2') ? { approved: true } : { approved: false, note: 'v1 is not enough' };
          },
        }),
      },
    ], { maxKickbacks: 1 }));
    expect(outcome.status).toBe('pass');
    expect(implementRuns).toBe(2);
    expect(new Set(asked).size).toBe(2);
  });

  it('pauses the whole pipeline, and the steps after it do not run', async () => {
    let closed = false;
    const { outcome } = await run(pipeline('ship', [
      { name: 'implement', job: fnJob('implement', () => 'report.csv') },
      { name: 'approve', job: approval('approve', { question: 'Ship this change?' }) },
      { name: 'close', job: fnJob('close', () => { closed = true; }) },
    ]));
    expect(outcome.status).toBe('paused');
    expect(closed).toBe(false);
  });

  it('routes a refusal found on a resume back to the target', async () => {
    const client = createCallbackClient();
    let implementRuns = 0;
    const ship = pipeline('ship', [
      { name: 'implement', job: fnJob('implement', () => { implementRuns += 1; return `report.csv v${implementRuns}`; }) },
      { name: 'approve', job: approval('approve', { question: 'Ship this change?', target: 'implement' }) },
    ], { maxKickbacks: 1 });
    const first = await run(ship, { callbacks: client });
    expect(first.outcome.status).toBe('paused');
    const request = client.listPending()[0]!;
    await directRouter(client, request, 'a-person', () => ({ approved: false, note: 'add the header row' }));
    implementRuns = 0;
    const second = await run(ship, { callbacks: client });
    // The refusal sent the work back once; the second attempt is a new question, pending again.
    expect(implementRuns).toBe(2);
    expect(second.outcome.status).toBe('paused');
    expect(client.listPending()).toHaveLength(1);
    expect(client.listPending()[0]!.requestId).not.toBe(request.requestId);
  });

  it('keeps the newest post live: a question posted again after being superseded is pending', async () => {
    const client = createCallbackClient();
    let n = 0;
    const ship = pipeline('ship', [
      { name: 'implement', job: fnJob('implement', () => (n++ % 2 === 0 ? 'v1' : 'v2')) },
      { name: 'approve', job: approval('approve', { question: 'Ship?' }) },
    ]);
    await run(ship, { callbacks: client }); // asks about v1
    await run(ship, { callbacks: client }); // asks about v2, v1 superseded
    const third = await run(ship, { callbacks: client }); // asks about v1 again
    expect(third.outcome.status).toBe('paused');
    const pending = client.listPending();
    expect(pending).toHaveLength(1);
    expect(JSON.stringify(pending[0]!.input)).toContain('v1');
    const answered = await directRouter(client, pending[0]!, 'a-person', () => ({ approved: true }));
    expect(answered.ok).toBe(true);
  });

  it('fails plainly when its question is neither pending nor answered after the post', async () => {
    const real = createCallbackClient();
    const client: CallbackClient = { ...real, post: () => {} };
    const { outcome } = await run(approval('approve', { question: 'Ship?' }), { callbacks: client });
    expect(outcome.status).toBe('fail');
    expect(outcome.summary).toMatch(/not pending/);
  });

  it('pauses on the stored client and a fresh run over the same store finds the answer', async () => {
    const { runId, storage } = await storedRun();
    const ship = pipeline('ship', [
      { name: 'implement', job: fnJob('implement', () => 'report.csv, header and rows') },
      { name: 'approve', job: approval('approve', { question: 'Ship this change?' }) },
    ]);
    const first = await run(ship, { callbacks: await createStoredCallbackClient(storage, runId) });
    expect(first.outcome.status).toBe('paused');

    const person = await createStoredCallbackClient(storage, runId);
    const [request] = await person.listPending();
    expect(request?.decisionText).toBe('Ship this change?');
    const claim = await person.claim(request!.requestId, 'a-person');
    if (!claim.ok) throw new Error('the person could not claim the question');
    const submitted = await person.submit(request!.requestId, claim.claimToken, 'a-person', request!.digest, { approved: true });
    expect(submitted.ok).toBe(true);

    const second = await run(ship, { callbacks: await createStoredCallbackClient(storage, runId) });
    expect(second.outcome.status).toBe('pass');
  });

  it('releases its claim when the answer throws, so the same client can answer next time', async () => {
    const client = createCallbackClient();
    const asked = { question: 'Ship?', input: { change: 'abc' } };
    const first = await run(approval('approve', { ...asked, answer: () => { throw new Error('walked away'); } }), { callbacks: client });
    expect(first.outcome.status).toBe('fail');
    expect(client.listPending()).toHaveLength(1);
    const second = await run(approval('approve', { ...asked, answer: () => ({ approved: true }) }), { callbacks: client });
    expect(second.outcome.status).toBe('pass');
  });

  it('releases its claim on the stored client too, and the next run over the store can answer', async () => {
    const { runId, storage } = await storedRun();
    const asked = { question: 'Ship?', input: { change: 'abc' } };
    const first = await run(
      approval('approve', { ...asked, answer: () => { throw new Error('walked away'); } }),
      { callbacks: await createStoredCallbackClient(storage, runId) },
    );
    expect(first.outcome.status).toBe('fail');
    const second = await run(
      approval('approve', { ...asked, answer: () => ({ approved: true }) }),
      { callbacks: await createStoredCallbackClient(storage, runId) },
    );
    expect(second.outcome.status).toBe('pass');
  });

  it('re-opens a superseded subject-backed question on the stored client without a second subject', async () => {
    const { runId, storage } = await storedRun();
    const client = await createStoredCallbackClient(storage, runId);
    const subjectA = subjectFor('bytes A');
    const subjectB = subjectFor('bytes B');
    const a = subjectGate('a', subjectA);
    const b = subjectGate('b', subjectB);
    await client.post(a, subjectA);
    await client.post(b, subjectB);
    await client.post(a, subjectA);
    const fresh = await createStoredCallbackClient(storage, runId);
    const pending = await fresh.listPending();
    expect(pending.map((r) => r.requestId)).toEqual([a.requestId]);
    await expect(client.post(a, subjectFor('other bytes'))).rejects.toThrow();
  });

  it('answers on the stored client when the note is undefined', async () => {
    const { runId, storage } = await storedRun();
    const { outcome } = await run(
      approval('approve', { question: 'Ship?', input: { change: 'abc' }, answer: () => ({ approved: true, note: undefined }) }),
      { callbacks: await createStoredCallbackClient(storage, runId) },
    );
    expect(outcome.status).toBe('pass');
  });

  it('releases its claim when submit itself throws, so the next run can answer', async () => {
    const real = createCallbackClient();
    let submits = 0;
    const throwing: CallbackClient = {
      ...real,
      submit: (...args) => { submits += 1; if (submits === 1) throw new Error('the store refused the bytes'); return real.submit(...args); },
    };
    const asked = { question: 'Ship?', input: { change: 'abc' } };
    const first = await run(approval('approve', { ...asked, answer: () => ({ approved: true }) }), { callbacks: throwing });
    expect(first.outcome.status).toBe('fail');
    expect(first.outcome.summary).toContain('the store refused the bytes');
    expect(real.listPending()).toHaveLength(1);
    const second = await run(approval('approve', { ...asked, answer: () => ({ approved: true }) }), { callbacks: throwing });
    expect(second.outcome.status).toBe('pass');
  });

  it('redacts the note on the yes path as it does on the no path', async () => {
    const secret = 'sk-' + 'a'.repeat(40);
    const { outcome } = await run(approval('approve', {
      question: 'Ship?',
      answer: () => ({ approved: true, note: `used ${secret}` }),
    }));
    expect(outcome.status).toBe('pass');
    expect(JSON.stringify(outcome.data)).not.toContain(secret);
  });

  it('turns a throw in the answer into a fail and still ends the job', async () => {
    const events: LoopEvent[] = [];
    const { outcome } = await run(approval('approve', {
      question: 'Ship?',
      answer: () => { throw new Error('the person walked away'); },
    }), { onEvent: (e) => events.push(e) });
    expect(outcome.status).toBe('fail');
    expect(outcome.summary).toContain('the person walked away');
    expect(events.some((e) => e.kind === 'job:end')).toBe(true);
  });

  it('exposes the callbacks client to every job', async () => {
    let seen = false;
    await run(fnJob('look', (ctx) => { seen = ctx.callbacks !== undefined; }));
    expect(seen).toBe(true);
  });
});
