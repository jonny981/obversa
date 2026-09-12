import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, it, expect } from 'vitest';

import {
  LoopError,
  approval,
  commandJob,
  createCallbackClient,
  createStoredCallbackClient,
  dag,
  directRouter,
  failed,
  fnJob,
  passed,
  pipeline,
  run,
} from '../src/api.ts';
import type { CallbackClient, CallbackRequest, LoopEvent, Outcome } from '../src/api.ts';
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
    expect(outcome.summary).toContain('not an outcome');
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

  it('fail the run when the named node is not a dependency', async () => {
    const { outcome } = await run(dag({
      name: 'branch',
      nodes: {
        a: fnJob('a', () => {}),
        b: { needs: 'a', when: passed('c'), job: fnJob('b', () => {}) },
      },
    }));
    expect(outcome.status).toBe('fail');
    const nodes = outcome.data as Record<string, Outcome>;
    expect(nodes.b?.summary).toContain('"c" is not a dependency of this node');
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
