import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createStoredCallbackClient, run } from '../src/api.ts';
import type { CallbackRequest, Outcome, RunCallbacks } from '../src/api.ts';
import { judgeDecision, stopQuestions } from '../src/core/judge.ts';
import { productCalls, productDecisionJob, type ProductCaller, type ProductScenario } from './judge-product-decision-fixture.ts';
import { createStoredRunFixture, type StoredRunFixture } from './stored-run-fixture.ts';

const dirs: string[] = [];
const stores: StoredRunFixture[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup() {
  const cwd = await mkdtemp(join(tmpdir(), 'judge-product-decision-'));
  dirs.push(cwd);
  const store = await createStoredRunFixture('judge-product-decision');
  stores.push(store);
  const callbacks = await createStoredCallbackClient(store.storage, store.runId);
  return { cwd, store, callbacks, recordTo: join(cwd, 'record.jsonl') };
}
async function answer(callbacks: RunCallbacks, request: CallbackRequest, decision: string) {
  const claim = await callbacks.claim(request.requestId, 'person');
  expect(claim.ok).toBe(true);
  if (!claim.ok) throw new Error(`claim refused: ${claim.kind}`);
  expect(await callbacks.submit(request.requestId, claim.claimToken, 'person', request.digest, { feedback: { audience: decision, annotations: [{ quote: 'one audience', note: 'Make this choice explicit.' }] }, prompt: decision }))
    .toMatchObject({ ok: true });
}
async function worker(kind: ProductCaller, fixture: Awaited<ReturnType<typeof setup>>, scenario: ProductScenario, resume: boolean, killWaiting = false): Promise<Outcome | CallbackRequest> {
  const child = fork(new URL('./judge-product-decision-fixture.ts', import.meta.url), [
    '--product-decision-worker', kind, fixture.store.directory, fixture.store.runId,
    fixture.cwd, fixture.recordTo, String(resume), String(killWaiting), JSON.stringify(scenario),
  ], { cwd: fixture.cwd, execArgv: ['--import', import.meta.resolve('tsx')], silent: true });
  let errors = '';
  child.stderr!.on('data', (data) => { errors += String(data); });
  const closed = once(child, 'close');
  try {
    const [message] = await Promise.race([
      once(child, 'message'),
      closed.then(([code]) => { throw new Error(`product worker exited ${code}: ${errors}`); }),
    ]);
    if (killWaiting) {
      expect(message).toHaveProperty('waiting');
      child.kill('SIGKILL');
      expect(await closed).toEqual([null, 'SIGKILL']);
      return (message as { waiting: CallbackRequest }).waiting;
    }
    expect(await closed).toEqual([0, null]);
    return (message as { outcome: Outcome }).outcome;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
}
function choices(cwd: string) { return productCalls(cwd).map((call) => call.kind); }
function judgeStates(cwd: string) {
  return productCalls(cwd).filter((call) => call.kind === 'judge').map((call) => JSON.parse(call.prompt!).state);
}

describe('the judge can request a product decision', () => {
  it('offers the choice and recognises it before ordinary stop rules', () => {
    expect(stopQuestions().stop_reason!.criteria).toHaveProperty('product_decision');
    expect(judgeDecision({ stop_reason: { choice: 'product_decision' }, holds: { noul: 0.99 } }))
      .toMatchObject({ again: false, stop: 'product_decision' });
  });

  describe.each(['workflow', 'dag'] as const)('%s caller', (kind) => {
    it('sends one answer to the builder before the judge is asked again, even when the judge always asks', async () => {
      const fixture = await setup();
      // A workflow stage's cap of 3 allows three writer rounds; a dag's
      // kickback cap of 2 allows the first run plus two kickbacks.
      const scenario = { choices: ['product_decision'], cap: kind === 'workflow' ? 3 : 2 };
      expect(await worker(kind, fixture, scenario, false)).toMatchObject({ status: 'paused' });
      const [first] = await fixture.callbacks.listPending();
      await answer(fixture.callbacks, first!, 'Write for new users.');
      expect(await worker(kind, fixture, scenario, true)).toMatchObject({ status: 'paused' });
      expect(choices(fixture.cwd)).toEqual(['writer', 'reviewer', 'judge', 'writer', 'reviewer', 'judge']);
      const builder = productCalls(fixture.cwd)[3]!.prompt!;
      expect(builder).toContain("A person made a product decision");
      expect(builder).toContain('"Write for new users."');
      expect(builder).toContain('The page must choose one audience.');
      expect(builder).toContain('"audience":"Write for new users."');
      const [second] = await fixture.callbacks.listPending();
      expect(second!.requestId).not.toBe(first!.requestId);
      const states = judgeStates(fixture.cwd);
      expect(states[1].round).toBe(states[0].round + 1);
      expect(states[1].productFeedback).toMatchObject([{ feedback: { audience: 'Write for new users.' }, prompt: 'Write for new users.' }]);
      await answer(fixture.callbacks, second!, 'Assume they have no account yet.');
      // The answer reaches the writer in the last round the cap allows. The
      // judge is asked about that round's review too, and asks a person again.
      expect(await worker(kind, fixture, scenario, true)).toMatchObject({ status: 'paused' });
      expect(choices(fixture.cwd)).toEqual(['writer', 'reviewer', 'judge', 'writer', 'reviewer', 'judge', 'writer', 'reviewer', 'judge']);
      expect(productCalls(fixture.cwd)[6]!.prompt).toContain('"Assume they have no account yet."');
      expect(judgeStates(fixture.cwd)[2]).toMatchObject({ lastRound: true });
      const [third] = await fixture.callbacks.listPending();
      expect(third!.requestId).not.toBe(second!.requestId);
      await answer(fixture.callbacks, third!, 'Keep it for new users.');
      // No build round follows: the answer is recorded and the run fails.
      expect(await worker(kind, fixture, scenario, true)).toMatchObject({ status: 'fail' });
      expect(await fixture.callbacks.listPending()).toEqual([]);
      expect(choices(fixture.cwd)).toHaveLength(9);
      expect(readFileSync(fixture.recordTo, 'utf8')).toContain('a person answered \\"Keep it for new users.\\", and no build round follows to apply it');
    }, 30_000);

    it.each(['holds', 'over_polishing', 'not_converging', 'continue'])('sends the answer to the builder, reviews and judges the result, then applies %s', async (ruling) => {
      const fixture = await setup();
      const scenario = { choices: ['product_decision', ruling, 'holds'], cap: 3 };
      expect(await worker(kind, fixture, scenario, false)).toMatchObject({ status: 'paused' });
      const [request] = await fixture.callbacks.listPending();
      expect(request!.decisionText).toBe('What product decision should guide this review?');
      expect(choices(fixture.cwd)).toEqual(['writer', 'reviewer', 'judge']);
      for (let i = 0; i < 2; i += 1) {
        expect(await worker(kind, fixture, scenario, true)).toMatchObject({ status: 'paused' });
        expect(choices(fixture.cwd)).toEqual(['writer', 'reviewer', 'judge']);
        expect((await fixture.callbacks.listPending()).map((item) => item.requestId)).toEqual([request!.requestId]);
      }
      await answer(fixture.callbacks, request!, 'Write for new users.');
      const outcome = await worker(kind, fixture, scenario, true);
      expect(outcome).toMatchObject({ status: ruling === 'not_converging' ? 'fail' : 'pass' });
      expect(choices(fixture.cwd).slice(0, 6)).toEqual(['writer', 'reviewer', 'judge', 'writer', 'reviewer', 'judge']);
      expect(productCalls(fixture.cwd)[3]!.prompt).toContain('"Write for new users."');
      const states = judgeStates(fixture.cwd);
      expect(states[1].round).toBe(states[0].round + 1);
      expect(states[1].rounds).toHaveLength(1);
      expect(states[1].productFeedback).toMatchObject([{ feedback: { audience: 'Write for new users.' }, prompt: 'Write for new users.' }]);
      expect(choices(fixture.cwd).filter((call) => call === 'writer')).toHaveLength(ruling === 'continue' ? 3 : 2);
      if (kind === 'dag') expect(choices(fixture.cwd).filter((call) => call === 'downstream')).toHaveLength(ruling === 'not_converging' ? 0 : 1);
    }, 30_000);

    it('keeps the per-finding decisions and the skipped list across a pending product decision', async () => {
      const fixture = await setup();
      const scenario = { choices: ['continue', 'product_decision', 'continue'], cap: 4, perFinding: true };
      expect(await worker(kind, fixture, scenario, false)).toMatchObject({ status: 'paused' });
      expect(choices(fixture.cwd)).toEqual(['writer', 'reviewer', 'judge', 'writer', 'reviewer', 'judge']);
      const [request] = await fixture.callbacks.listPending();
      await answer(fixture.callbacks, request!, 'Write for new users.');
      expect(await worker(kind, fixture, scenario, true)).toMatchObject({ status: 'pass' });
      expect(choices(fixture.cwd)).toEqual([
        // The person's answer goes straight to the builder; the judge is not asked again first.
        'writer', 'reviewer', 'judge', 'writer', 'reviewer', 'judge', 'writer', 'reviewer',
        ...(kind === 'dag' ? ['downstream'] : []),
      ]);
      const writers = productCalls(fixture.cwd).filter((call) => call.kind === 'writer').map((call) => call.prompt!);
      expect(writers[1]).toContain('REAL: the page must choose one audience (round 1)');
      expect(writers[1]).not.toContain('taste: a warmer tone');
      expect(writers[2]).toContain('REAL: the page must choose one audience (round 2)');
      expect(writers[2]).not.toContain('taste: a warmer tone');
      const states = judgeStates(fixture.cwd);
      expect(states[0].skipped).toBeUndefined();
      expect(states[1].skipped).toMatchObject([{ finding: { evidence: 'taste: a warmer tone (round 1)' }, reason: 'judged' }]);
      // After the person's answer the builder runs and the review passes, so the judge was asked twice.
      expect(states).toHaveLength(2);
      if (kind === 'workflow') {
        const lastReview = productCalls(fixture.cwd).filter((call) => call.kind === 'reviewer').at(-1)!.prompt!;
        expect(lastReview).toContain('taste: a warmer tone (round 1)');
        expect(lastReview).toContain('taste: a warmer tone (round 2)');
      }
    }, 30_000);

    it('counts the answered round against the cap and keeps review history across the pause', async () => {
      const fixture = await setup();
      const scenario = { choices: ['continue', 'product_decision', 'continue'], cap: kind === 'workflow' ? 3 : 2 };
      expect(await worker(kind, fixture, scenario, false)).toMatchObject({ status: 'paused' });
      expect(choices(fixture.cwd)).toEqual(['writer', 'reviewer', 'judge', 'writer', 'reviewer', 'judge']);
      const [request] = await fixture.callbacks.listPending();
      await answer(fixture.callbacks, request!, 'Keep the audience fixed.');
      const outcome = await worker(kind, fixture, scenario, true) as Outcome;
      expect(outcome.status).toBe('fail');
      // The answered round is the last one the cap allows: it runs the writer
      // with the answer, and the judge's continue on its review fails the run.
      expect(choices(fixture.cwd).slice(6)).toEqual(['writer', 'reviewer', 'judge']);
      expect(productCalls(fixture.cwd)[6]!.prompt).toContain('"Keep the audience fixed."');
      const states = judgeStates(fixture.cwd);
      expect(states[1].round).toBe(2);
      expect(states[1].cap).toBe(scenario.cap);
      expect(states[1].rounds).toHaveLength(1);
      expect(await fixture.callbacks.listPending()).toEqual([]);
    }, 30_000);

    it('asks a person after the last review the cap allows, records the answer, and runs no further build round', async () => {
      const fixture = await setup();
      // Two writer rounds either way: a workflow stage's cap of 2, or a dag's
      // first run plus one kickback.
      const scenario = { choices: ['continue', 'product_decision'], cap: kind === 'workflow' ? 2 : 1 };
      expect(await worker(kind, fixture, scenario, false)).toMatchObject({ status: 'paused' });
      expect(choices(fixture.cwd)).toEqual(['writer', 'reviewer', 'judge', 'writer', 'reviewer', 'judge']);
      expect(judgeStates(fixture.cwd)[1]).toMatchObject({ cap: scenario.cap, lastRound: true });
      const [request] = await fixture.callbacks.listPending();
      await answer(fixture.callbacks, request!, 'Write for new users.');
      const outcome = await worker(kind, fixture, scenario, true);
      expect(outcome).toMatchObject({ status: 'fail' });
      // The returned outcome says why the run stopped, not only the record.
      expect(JSON.stringify(outcome)).toContain(`after the last round the cap of ${scenario.cap} allows; a person answered \\"Write for new users.\\"`);
      expect(choices(fixture.cwd)).toEqual(['writer', 'reviewer', 'judge', 'writer', 'reviewer', 'judge']);
      expect(await fixture.callbacks.listPending()).toEqual([]);
      expect(readFileSync(fixture.recordTo, 'utf8')).toContain(`after the last round the cap of ${scenario.cap} allows; a person answered \\"Write for new users.\\"`);
    }, 30_000);

    it('recovers the pending product question after a waiting process is killed', async () => {
      const fixture = await setup();
      const scenario = { choices: ['product_decision', 'holds'], cap: 2 };
      const request = await worker(kind, fixture, scenario, false, true) as CallbackRequest;
      expect(await worker(kind, fixture, scenario, true)).toMatchObject({ status: 'paused' });
      expect(choices(fixture.cwd)).toEqual(['writer', 'reviewer', 'judge']);
      expect((await fixture.callbacks.listPending()).map((item) => item.requestId)).toEqual([request.requestId]);
      await answer(fixture.callbacks, request, 'Use the beginner audience.');
      expect(await worker(kind, fixture, scenario, true)).toMatchObject({ status: 'pass' });
      expect(choices(fixture.cwd)).toEqual(['writer', 'reviewer', 'judge', 'writer', 'reviewer', 'judge', ...(kind === 'dag' ? ['downstream'] : [])]);
      expect(productCalls(fixture.cwd)[3]!.prompt).toContain('"Use the beginner audience."');
    }, 30_000);

    it('does not attach an old answer to a changed definition or a different stage', async () => {
      const fixture = await setup();
      const scenario = { choices: ['product_decision'], cap: 2 };
      expect(await worker(kind, fixture, scenario, false)).toMatchObject({ status: 'paused' });
      const [original] = await fixture.callbacks.listPending();
      await answer(fixture.callbacks, original!, 'Only the original stage.');
      const changed = { ...scenario, brief: 'A different audience.', stageName: 'another-write' };
      expect(await worker(kind, fixture, changed, true)).toMatchObject({ status: 'paused' });
      const [next] = await fixture.callbacks.listPending();
      expect(next!.requestId).not.toBe(original!.requestId);
      expect(judgeStates(fixture.cwd).at(-1).productFeedback ?? []).toEqual([]);
      expect(choices(fixture.cwd).filter((call) => call === 'writer')).toHaveLength(2);
    }, 30_000);

    it('asks the judge about a block, and the judge can ask for a product decision on it', async () => {
      const fixture = await setup();
      const scenario = { choices: ['product_decision'], cap: 3, blockFirst: true };
      const result = await run(productDecisionJob(kind, fixture.cwd, scenario), { cwd: fixture.cwd, recordTo: fixture.recordTo, callbacks: fixture.callbacks });
      expect(result.outcome.status).toBe('paused');
      expect(choices(fixture.cwd)).toEqual(['writer', 'reviewer', 'judge']);
    });
  });
});


describe('fresh workers retain rich interactions', () => {
  it.each(['agent', 'human', 'person'] as const)('resumes the %s requester after a waiting process is killed', async (kind) => {
    const fixture = await setup();
    const scenario = { choices: [], cap: 3 };
    const question = await worker(kind, fixture, scenario, false, true) as CallbackRequest;
    const originalCalls = choices(fixture.cwd);
    expect(await worker(kind, fixture, scenario, true)).toMatchObject({ status: 'paused' });
    expect(choices(fixture.cwd)).toEqual(originalCalls);
    const callbacks = await createStoredCallbackClient(fixture.store.reopen(), fixture.store.runId);
    expect((await callbacks.listPending()).map((item) => item.requestId)).toEqual([question.requestId]);
    const claim = await callbacks.claim(question.requestId, 'person');
    if (!claim.ok) throw new Error('claim refused');
    const response = { feedback: { selected: ['beginners'], annotations: [{ quote: 'original page', note: 'Keep this phrase.' }] }, prompt: 'Use beginners.', ...(kind === 'human' ? { decision: 'approved' } : {}) };
    expect(await callbacks.submit(question.requestId, claim.claimToken, 'person', question.digest, response)).toMatchObject({ ok: true });
    expect(await worker(kind, fixture, scenario, true)).toMatchObject({ status: 'pass' });
    if (kind === 'agent') {
      expect(choices(fixture.cwd)).toEqual(['writer', 'writer']);
      expect(productCalls(fixture.cwd)[1]!.prompt).toContain(JSON.stringify(response));
      expect(productCalls(fixture.cwd)[1]!.prompt).toContain('Write the original page.');
    } else expect(choices(fixture.cwd)).toEqual(originalCalls);
  }, 30_000);
});
