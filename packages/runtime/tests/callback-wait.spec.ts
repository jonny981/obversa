import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defineBudgetChain } from '../../../test-support/budget-chain.mjs';
import {
  approval,
  createCallbackClient,
  createStoredCallbackClient,
  dag,
  run,
  stage,
  withEnv,
  workflow,
} from '../src/api.ts';
import type { CallbackRequest, Job, LoopEvent, RunCallbacks, RunOptions, RunResult } from '../src/api.ts';
import { readResumeRecord } from '../src/runtime/persist.ts';
import { delivery, deployment, publicGate } from './callback-wait-delivery-fixture.ts';
import { createStoredRunFixture, type StoredRunFixture } from './stored-run-fixture.ts';

const WAIT_PROOF = defineBudgetChain('callback wait', 90_000, {
  setup: 20_000,
  phases: [['question', 20_000], ['answer', 20_000], ['completion', 20_000]],
  cleanup: 20_000,
});

let cwd: string;
const active: Array<{ controller: AbortController; result: Promise<RunResult> }> = [];
const stores: StoredRunFixture[] = [];

beforeEach(async () => {
  cwd = await WAIT_PROOF.run('setup', () => mkdtemp(join(tmpdir(), 'obversa-callback-wait-')));
});

afterEach(async () => {
  for (const running of active) running.controller.abort();
  try {
    await WAIT_PROOF.run('cleanup', async () => {
      for (const running of active.splice(0)) {
        const result = await running.result;
        await result.monitor?.close();
      }
    });
  } finally {
    await WAIT_PROOF.run('cleanup', async () => {
      for (const store of stores.splice(0)) await store.close();
      await rm(cwd, { recursive: true, force: true });
    });
  }
});

function start(job: Job, options: RunOptions) {
  const controller = new AbortController();
  const result = run(job, { ...options, cwd, signal: controller.signal });
  const running = { controller, result };
  active.push(running);
  return running;
}

async function stored() {
  const fixture = await createStoredRunFixture('callback-wait');
  stores.push(fixture);
  return fixture;
}

/** Observe a real pending history read; never supply or change its events. */
function observeQuestion(client: RunCallbacks, afterPoll = false) {
  let historyReads = 0;
  let sawQuestion!: (request: CallbackRequest) => void;
  const question = new Promise<CallbackRequest>((resolve) => { sawQuestion = resolve; });
  const observed: RunCallbacks = {
    ...client,
    async history(requestId) {
      const events = await client.history(requestId);
      historyReads += 1;
      const requested = events.find((event) => event.kind === 'callback-requested');
      if (requested?.kind === 'callback-requested'
          && !events.some((event) => event.kind === 'callback-submitted')
          && (!afterPoll || historyReads >= 3)) {
        sawQuestion(requested.request);
      }
      return events;
    },
  };
  return { client: observed, question };
}

async function waitingForQuestion(
  observed: ReturnType<typeof observeQuestion>,
  running: ReturnType<typeof start>,
) {
  return WAIT_PROOF.run('question', () => Promise.race([
    observed.question,
    running.result.then((result) => {
      throw new Error(`run returned ${result.outcome.status} instead of waiting for its question`);
    }),
  ]));
}

async function answer(client: RunCallbacks, request: CallbackRequest, approved = true) {
  await WAIT_PROOF.run('answer', async () => {
    const claim = await client.claim(request.requestId, 'person');
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error(`claim refused: ${claim.kind}`);
    const submitted = await client.submit(request.requestId, claim.claimToken, 'person', request.digest, {
      approved,
      note: approved ? 'Ready to send.' : 'Fix the heading.',
    });
    expect(submitted.ok).toBe(true);
  });
}

async function assertOneQuestion(client: RunCallbacks, requestId: string) {
  const requests = (await client.history()).filter((event) => event.kind === 'callback-requested');
  expect(requests.map((event) => event.request.requestId)).toEqual([requestId]);
}

async function killWaitingChild(
  fixture: StoredRunFixture,
  recordTo: string,
  options: { signal: NodeJS.Signals; resume?: boolean; job?: 'deploy' | 'public-gate' | 'env-gate' },
): Promise<CallbackRequest> {
  const child = fork(new URL('./callback-wait-crash-fixture.ts', import.meta.url), [
    fixture.directory, fixture.runId, recordTo, cwd, String(options.resume === true), options.job ?? 'delivery',
  ], { cwd, execArgv: ['--import', import.meta.resolve('tsx')], silent: true });
  let errors = '';
  child.stderr!.on('data', (chunk) => { errors += String(chunk); });
  const closed = once(child, 'close');
  try {
    const [message] = await WAIT_PROOF.run('question', () => Promise.race([
      once(child, 'message'),
      closed.then(([code]) => { throw new Error(`waiting child exited ${code}: ${errors}`); }),
    ]));
    const request = (message as { waiting: CallbackRequest }).waiting;
    expect(child.kill(options.signal)).toBe(true);
    expect(await WAIT_PROOF.run('completion', () => closed)).toEqual([null, options.signal]);
    // Kill even when the checkpoint is missing: the mutation must exercise
    // an actual interrupted process, not fail waiting for an event it removed.
    expect((message as { checkpoint: unknown }).checkpoint).toMatchObject({
      kind: 'dag:node', phase: 'done',
      outcome: { status: 'paused', data: { requestId: request.requestId } },
    });
    return request;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await WAIT_PROOF.run('cleanup', () => closed);
  }
}

describe('waiting for a callback in the run', () => {
  it.each([false, true])('keeps a user-authored approval node paused across Ctrl-C withEnv=%s', async (wrapped) => {
    const fixture = await WAIT_PROOF.run('setup', stored);
    const recordTo = join(cwd, 'public-gate.jsonl');
    const request = await killWaitingChild(fixture, recordTo, { signal: 'SIGINT', job: wrapped ? 'env-gate' : 'public-gate' });
    expect(readResumeRecord(recordTo).outcomes.stages.get('public-gate/approve')).toMatchObject({
      kind: 'completed', outcome: { status: 'paused', data: { requestId: request.requestId } },
    });
    await expect(readFile(join(cwd, 'sent.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const client = await createStoredCallbackClient(fixture.reopen(), fixture.runId);
    const observed = observeQuestion(client);
    const resumed = start(publicGate(wrapped), { callbacks: observed.client, recordTo, resume: true, onCallback: 'wait' });
    expect((await waitingForQuestion(observed, resumed)).requestId).toBe(request.requestId);
    await assertOneQuestion(client, request.requestId);
    await answer(client, request);
    expect((await WAIT_PROOF.run('completion', () => resumed.result)).outcome.status).toBe('pass');
    expect(await readFile(join(cwd, 'sent.txt'), 'utf8')).toBe('sent\n');
  }, WAIT_PROOF.budgetMs);

  it.each([false, true])('does not mistake approval inside when for completion of an interrupted command withEnv=%s', async (wrapped) => {
    const fixture = await WAIT_PROOF.run('setup', stored);
    const client = await createStoredCallbackClient(fixture.storage, fixture.runId);
    const observed = observeQuestion(client, true);
    const recordTo = join(cwd, 'conditional-deploy.jsonl');
    const job = workflow('conditional-deploy', {
      brief: 'Ask before deploying.', roles: {},
      stages: [stage('deploy', {
        when: async (ctx) => {
          const gate = approval('allow-deploy', { question: 'Deploy?' });
          return (await (wrapped ? withEnv({ CALLBACK_TEST: 'condition' }, gate) : gate)(ctx)).status === 'pass';
        },
        run: [process.execPath, '-e', "require('node:fs').appendFileSync('deployments.txt', 'deployed\\n')"],
      })],
    });
    const first = start(job, { callbacks: observed.client, recordTo, onCallback: 'wait' });
    await answer(client, await waitingForQuestion(observed, first));
    expect((await WAIT_PROOF.run('completion', () => first.result)).outcome.status).toBe('pass');
    const lines = (await readFile(recordTo, 'utf8')).trim().split('\n');
    const startLine = lines.findIndex((line) => {
      const event = JSON.parse(line) as LoopEvent;
      return event.kind === 'dag:node' && event.node === 'deploy' && event.phase === 'start';
    });
    expect(startLine).toBeGreaterThanOrEqual(0);
    // The command ran, but its completion was not saved before the process died.
    await writeFile(recordTo, `${lines.slice(0, startLine + 1).join('\n')}\n`);
    const resumed = start(job, { callbacks: client, recordTo, resume: true });
    expect((await WAIT_PROOF.run('completion', () => resumed.result)).outcome.status).toBe('paused');
    expect(await readFile(join(cwd, 'deployments.txt'), 'utf8')).toBe('deployed\n');
    const [recovery] = await client.listPending();
    expect(recovery!.decisionText).toContain('Did stage "deploy" finish?');
    await answer(client, recovery!);
    expect((await WAIT_PROOF.run('completion', () => start(job, { callbacks: client, recordTo, resume: true }).result))
      .outcome.status).toBe('pass');
    expect(await readFile(join(cwd, 'deployments.txt'), 'utf8')).toBe('deployed\n');
  }, WAIT_PROOF.budgetMs);

  it.each([false, true])('does not inherit checkpoint authority in a nested call (spread=%s) but delegates workflow input', async (spread) => {
    const client = createCallbackClient();
    const observed = observeQuestion(client, true);
    const events: LoopEvent[] = [];
    const job = dag({ name: 'wrapped', nodes: {
      deploy: async (ctx) => {
        const decision = await approval('allow-deploy', { question: 'Deploy?' })(spread ? { ...ctx } : ctx);
        if (decision.status !== 'pass') return decision;
        await writeFile(join(ctx.workspace.dir, 'deployments.txt'), 'deployed\n');
        return { status: 'pass' };
      },
    } });
    const running = start(job, { callbacks: observed.client, onCallback: 'wait', onEvent: (event) => events.push(event) });
    await answer(client, await waitingForQuestion(observed, running));
    expect((await WAIT_PROOF.run('completion', () => running.result)).outcome.status).toBe('pass');
    expect(events.filter((event) => event.kind === 'dag:node' && event.outcome?.status === 'paused')).toEqual([]);
    expect(await readFile(join(cwd, 'deployments.txt'), 'utf8')).toBe('deployed\n');

    let sawPause!: (event: Extract<LoopEvent, { kind: 'dag:node' }>) => void;
    const paused = new Promise<Extract<LoopEvent, { kind: 'dag:node' }>>((resolve) => { sawPause = resolve; });
    const delegated = start(delivery(), {
      callbacks: client, onCallback: 'wait',
      onEvent(event) {
        if (event.kind === 'dag:node' && event.node === 'approve' && event.outcome?.status === 'paused') sawPause(event);
      },
    });
    const event = await WAIT_PROOF.run('question', () => Promise.race([
      paused,
      delegated.result.then(() => { throw new Error('workflow ended without reporting its waiting input'); }),
    ]));
    const [request] = client.listPending();
    expect(event).toMatchObject({ outcome: { data: { requestId: request!.requestId } } });
    await answer(client, request!);
    expect((await WAIT_PROOF.run('completion', () => delegated.result)).outcome.status).toBe('pass');
  }, WAIT_PROOF.budgetMs);

  it.each([
    { signal: 'SIGINT', onCallback: 'exit', approved: true },
    { signal: 'SIGINT', onCallback: 'wait', approved: false },
    { signal: 'SIGKILL', onCallback: 'exit', approved: false },
    { signal: 'SIGKILL', onCallback: 'wait', approved: true },
  ] as const)('keeps the original gate after $signal and resumes in $onCallback mode', async ({ signal, onCallback, approved }) => {
    const fixture = await WAIT_PROOF.run('setup', stored);
    const recordTo = join(cwd, 'delivery.jsonl');
    const original = await killWaitingChild(fixture, recordTo, { signal });
    expect(original.decisionText).toBe('Send the prepared result?');
    await expect(readFile(join(cwd, 'sent.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const client = await createStoredCallbackClient(fixture.reopen(), fixture.runId);
    const observed = observeQuestion(client);
    const resumed = start(delivery(), {
      callbacks: observed.client, recordTo, resume: true, onCallback,
    });
    let pending: CallbackRequest;
    if (onCallback === 'wait') {
      pending = await waitingForQuestion(observed, resumed);
    } else {
      expect((await WAIT_PROOF.run('completion', () => resumed.result)).outcome.status).toBe('paused');
      pending = (await client.listPending())[0]!;
    }
    expect(pending.requestId).toBe(original.requestId);
    expect(pending.decisionText).toBe('Send the prepared result?');
    await assertOneQuestion(client, original.requestId);
    await answer(client, original, approved);
    const finished = onCallback === 'wait' ? resumed : start(delivery(), {
      callbacks: client, recordTo, resume: true, onCallback,
    });
    expect((await WAIT_PROOF.run('completion', () => finished.result)).outcome.status)
      .toBe(approved ? 'pass' : 'fail');
    expect(await readFile(join(cwd, 'prepared.txt'), 'utf8')).toBe('prepared\n');
    if (approved) expect(await readFile(join(cwd, 'sent.txt'), 'utf8')).toBe('sent\n');
    else await expect(readFile(join(cwd, 'sent.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await assertOneQuestion(client, original.requestId);
  }, WAIT_PROOF.budgetMs);

  it('emits and records the paused stage before waiting without ending the run', async () => {
    const client = createCallbackClient();
    const recordTo = join(cwd, 'delivery.jsonl');
    const events: LoopEvent[] = [];
    let sawPause!: (event: Extract<LoopEvent, { kind: 'dag:node' }>) => void;
    const paused = new Promise<Extract<LoopEvent, { kind: 'dag:node' }>>((resolve) => { sawPause = resolve; });
    const running = start(delivery(), {
      callbacks: client, recordTo, onCallback: 'wait',
      onEvent(event) {
        events.push(event);
        if (event.kind === 'dag:node' && event.node === 'approve' && event.outcome?.status === 'paused') sawPause(event);
      },
    });
    const event = await WAIT_PROOF.run('question', () => Promise.race([
      paused,
      running.result.then(() => { throw new Error('run ended before the pause was observed'); }),
    ]));
    const [request] = client.listPending();
    expect(event).toMatchObject({
      path: ['delivery'], node: 'approve', phase: 'done', attempt: 1,
      outcome: { status: 'paused', data: { requestId: request!.requestId } },
    });
    expect((await readFile(recordTo, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)))
      .toContainEqual(event);
    expect(events.some((entry) => entry.kind === 'dag:end')).toBe(false);
    await expect(readFile(join(cwd, 'sent.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await answer(client, request!);
    expect((await WAIT_PROOF.run('completion', () => running.result)).outcome.status).toBe('pass');
    expect(events.filter((entry) => entry.kind === 'dag:end')).toHaveLength(1);
  }, WAIT_PROOF.budgetMs);

  it('keeps a standalone process alive until an outside answer arrives', async () => {
    const child = fork(new URL('./callback-wait-child-fixture.ts', import.meta.url), [], {
      cwd,
      execArgv: ['--import', import.meta.resolve('tsx')],
      silent: true,
    });
    let output = '';
    let errors = '';
    child.stdout!.on('data', (chunk) => { output += String(chunk); });
    child.stderr!.on('data', (chunk) => { errors += String(chunk); });
    const closed = once(child, 'close');
    try {
      const [message] = await WAIT_PROOF.run('question', () => Promise.race([
        once(child, 'message'),
        closed.then(([code]) => { throw new Error(`waiting child exited ${code}: ${errors}`); }),
      ]));
      expect(message).toEqual({ waiting: true });
      child.send('approve');
      expect(await WAIT_PROOF.run('completion', () => closed)).toEqual([0, null]);
      expect(output.trim()).toBe('pass');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await WAIT_PROOF.run('cleanup', () => closed);
    }
  }, WAIT_PROOF.budgetMs);

  it('keeps the monitor running until its real answer route approves the question', async () => {
    const observed = observeQuestion(createCallbackClient());
    const events: LoopEvent[] = [];
    const running = start(approval('approve', { question: 'Send?' }), {
      callbacks: observed.client,
      onCallback: 'wait',
      monitor: true,
      onEvent: (event) => events.push(event),
    });
    const request = await waitingForQuestion(observed, running);
    const monitor = events.find((event) => event.kind === 'monitor');
    if (monitor?.kind !== 'monitor') throw new Error('monitor URL was not emitted');
    await WAIT_PROOF.run('answer', async (signal) => {
      const state = await (await fetch(`${monitor.url}state`, { signal })).json();
      expect(state.status).toBe('running');
      expect(state.pending.map((entry: { requestId: string }) => entry.requestId)).toEqual([request.requestId]);
      const reply = await fetch(`${monitor.url}answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: request.requestId, response: { approved: true } }),
        signal,
      });
      expect(reply.status).toBe(200);
    });
    expect((await WAIT_PROOF.run('completion', () => running.result)).outcome.status).toBe('pass');
    await assertOneQuestion(observed.client, request.requestId);
  }, WAIT_PROOF.budgetMs);

  it('continues the same call when another stored client answers', async () => {
    const fixture = await WAIT_PROOF.run('setup', stored);
    const observed = observeQuestion(await createStoredCallbackClient(fixture.storage, fixture.runId));
    const running = start(approval('approve', { question: 'Send?' }), {
      callbacks: observed.client,
      onCallback: 'wait',
    });
    const request = await waitingForQuestion(observed, running);
    const router = await createStoredCallbackClient(fixture.reopen(), fixture.runId);
    await answer(router, request);
    expect((await WAIT_PROOF.run('completion', () => running.result)).outcome.status).toBe('pass');
    await assertOneQuestion(router, request.requestId);
  }, WAIT_PROOF.budgetMs);

  it('keeps a refusal and its revision target when the answer arrives while waiting', async () => {
    const observed = observeQuestion(createCallbackClient());
    const running = start(approval('approve', { question: 'Send?', target: 'prepare' }), {
      callbacks: observed.client,
      onCallback: 'wait',
    });
    const request = await waitingForQuestion(observed, running);
    await answer(observed.client, request, false);
    const { outcome } = await WAIT_PROOF.run('completion', () => running.result);
    expect(outcome.status).toBe('fail');
    expect(outcome.revision?.target).toBe('prepare');
    expect(outcome.revision?.reason).toBe('Fix the heading.');
  }, WAIT_PROOF.budgetMs);

  it('resumes an exit-mode record in wait mode without preparing or posting twice', async () => {
    const fixture = await WAIT_PROOF.run('setup', stored);
    const client = await createStoredCallbackClient(fixture.storage, fixture.runId);
    const recordTo = join(cwd, 'delivery.jsonl');
    const first = start(delivery(), { callbacks: client, recordTo, onCallback: 'exit' });
    expect((await WAIT_PROOF.run('completion', () => first.result)).outcome.status).toBe('paused');
    const [request] = await client.listPending();
    expect(request).toBeDefined();

    const observed = observeQuestion(await createStoredCallbackClient(fixture.reopen(), fixture.runId));
    const second = start(delivery(), { callbacks: observed.client, recordTo, resume: true, onCallback: 'wait' });
    expect((await waitingForQuestion(observed, second)).requestId).toBe(request!.requestId);
    await answer(client, request!);
    expect((await WAIT_PROOF.run('completion', () => second.result)).outcome.status).toBe('pass');
    expect(await readFile(join(cwd, 'prepared.txt'), 'utf8')).toBe('prepared\n');
    expect(await readFile(join(cwd, 'sent.txt'), 'utf8')).toBe('sent\n');
    await assertOneQuestion(client, request!.requestId);
    const anchors = (await readFile(recordTo, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as LoopEvent)
      .filter((event) => event.kind === 'workflow:start');
    expect(anchors).toHaveLength(2);
    expect(anchors[1]!.recordId).toBe(anchors[0]!.recordId);
  }, WAIT_PROOF.budgetMs);

  it('resumes a normally cancelled wait in exit mode with the same unanswered question', async () => {
    const fixture = await WAIT_PROOF.run('setup', stored);
    const client = await createStoredCallbackClient(fixture.storage, fixture.runId);
    const observed = observeQuestion(client);
    const recordTo = join(cwd, 'delivery.jsonl');
    const first = start(delivery(), { callbacks: observed.client, recordTo, onCallback: 'wait' });
    const request = await waitingForQuestion(observed, first);
    first.controller.abort();
    expect((await WAIT_PROOF.run('completion', () => first.result)).outcome.status).toBe('aborted');
    const records = (await readFile(recordTo, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as LoopEvent);
    expect(records).toContainEqual(expect.objectContaining({
      kind: 'dag:node',
      node: 'approve',
      phase: 'done',
      outcome: expect.objectContaining({ status: 'paused', data: expect.objectContaining({ requestId: request.requestId }) }),
    }));

    const fresh = await createStoredCallbackClient(fixture.reopen(), fixture.runId);
    const second = start(delivery(), { callbacks: fresh, recordTo, resume: true, onCallback: 'exit' });
    expect((await WAIT_PROOF.run('completion', () => second.result)).outcome.status).toBe('paused');
    expect((await fresh.listPending()).map((pending) => pending.requestId)).toEqual([request.requestId]);
    await answer(fresh, request);
    const third = start(delivery(), { callbacks: fresh, recordTo, resume: true, onCallback: 'exit' });
    expect((await WAIT_PROOF.run('completion', () => third.result)).outcome.status).toBe('pass');
    expect(await readFile(join(cwd, 'prepared.txt'), 'utf8')).toBe('prepared\n');
    await assertOneQuestion(fresh, request.requestId);
  }, WAIT_PROOF.budgetMs);

  it('returns the answerable pause when a bare approval wait is cancelled', async () => {
    const client = createCallbackClient();
    const observed = observeQuestion(client);
    const job = approval('approve', { question: 'Send?' });
    const waiting = start(job, { callbacks: observed.client, onCallback: 'wait' });
    const request = await waitingForQuestion(observed, waiting);
    waiting.controller.abort();
    const result = await WAIT_PROOF.run('completion', () => waiting.result);
    expect(result.outcome.status).toBe('paused');
    expect(result.outcome.data).toEqual(request);
    await answer(client, request);
    expect((await WAIT_PROOF.run('completion', () => start(job, { callbacks: client }).result))
      .outcome.status).toBe('pass');
    await assertOneQuestion(client, request.requestId);
  }, WAIT_PROOF.budgetMs);

  it.each([
    { approved: true, executions: 'deployed\n', killed: false },
    { approved: false, executions: 'deployed\ndeployed\n', killed: false },
    { approved: true, executions: 'deployed\n', killed: true },
    { approved: false, executions: 'deployed\ndeployed\n', killed: true },
  ])('waits on a saved recovery question before acting on approved=$approved, killed=$killed', async ({ approved, executions, killed }) => {
    const fixture = await WAIT_PROOF.run('setup', stored);
    const client = await createStoredCallbackClient(fixture.storage, fixture.runId);
    const recordTo = join(cwd, 'deploy.jsonl');
    const job = deployment();
    expect((await WAIT_PROOF.run('completion', () => start(job, { callbacks: client, recordTo }).result))
      .outcome.status).toBe('pass');
    const lines = (await readFile(recordTo, 'utf8')).trim().split('\n');
    const startLine = lines.findIndex((line) => {
      const event = JSON.parse(line) as LoopEvent;
      return event.kind === 'dag:node' && event.node === 'deploy' && event.phase === 'start';
    });
    expect(startLine).toBeGreaterThanOrEqual(0);
    // The real record stopped after dispatch: completion is unknown on resume.
    await writeFile(recordTo, `${lines.slice(0, startLine + 1).join('\n')}\n`);
    expect((await WAIT_PROOF.run('completion', () => start(job, {
      callbacks: client, recordTo, resume: true,
    }).result)).outcome.status).toBe('paused');
    const [request] = await client.listPending();
    expect(request!.decisionText).toContain('Did stage "deploy" finish?');

    if (killed) {
      expect((await killWaitingChild(fixture, recordTo, { signal: 'SIGKILL', resume: true, job: 'deploy' })).requestId)
        .toBe(request!.requestId);
    }

    const observed = observeQuestion(client);
    const waiting = start(job, { callbacks: observed.client, recordTo, resume: true, onCallback: 'wait' });
    expect((await waitingForQuestion(observed, waiting)).requestId).toBe(request!.requestId);
    expect(await readFile(join(cwd, 'deployments.txt'), 'utf8')).toBe('deployed\n');
    await answer(client, request!, approved);
    expect((await WAIT_PROOF.run('completion', () => waiting.result)).outcome.status).toBe('pass');
    expect(await readFile(join(cwd, 'deployments.txt'), 'utf8')).toBe(executions);
    await assertOneQuestion(client, request!.requestId);
  }, WAIT_PROOF.budgetMs);

  it.each(['memory', 'stored'] as const)('exits by default with the %s client', async (kind) => {
    const fixture = kind === 'stored' ? await WAIT_PROOF.run('setup', stored) : undefined;
    const client = fixture === undefined
      ? createCallbackClient()
      : await createStoredCallbackClient(fixture.storage, fixture.runId);
    const running = start(approval('approve', { question: 'Send?' }), { callbacks: client });
    expect((await WAIT_PROOF.run('completion', () => running.result)).outcome.status).toBe('paused');
    expect(await client.listPending()).toHaveLength(1);
  }, WAIT_PROOF.budgetMs);

  it.each(['wait', 'exit'] as const)('keeps the supplied answer function working in %s mode', async (onCallback) => {
    const running = start(approval('approve', { question: 'Send?', answer: async () => ({ approved: true }) }), {
      onCallback,
    });
    expect((await WAIT_PROOF.run('completion', () => running.result)).outcome.status).toBe('pass');
  }, WAIT_PROOF.budgetMs);
});
