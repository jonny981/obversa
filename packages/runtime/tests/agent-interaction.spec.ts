import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { agentJob, createStoredCallbackClient, person, run, stage, workflow } from '../src/api.ts';
import type { AgentRequest, InteractionBinding, InteractionResponse, JsonObject } from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';
import { createStoredRunFixture, type StoredRunFixture } from './stored-run-fixture.ts';

const roots: string[] = [];
const stores: StoredRunFixture[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const feedback: InteractionResponse = {
  feedback: {
    selected: ['beginners', 'short-form'],
    annotations: [{ quote: 'advanced setup', note: 'Remove this requirement.' }],
    edits: [{ file: 'page.md', before: 'expert', after: 'beginner' }],
  },
  prompt: 'Write for beginners. Keep it short. Remove the advanced setup requirement.',
};
const binding: InteractionBinding = {
  id: 'audience-review',
  responseSchema: { type: 'object', properties: { feedback: { type: 'object' }, prompt: { type: 'string' } }, required: ['feedback', 'prompt'] },
};
const request = JSON.stringify({ interaction: { question: 'Which audience?', input: { sourceText: 'advanced setup', choices: ['beginners', 'experts'] } } });
async function setup() {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-interaction-'));
  roots.push(cwd);
  const store = await createStoredRunFixture('agent-interaction');
  stores.push(store);
  return { cwd, store, recordTo: join(cwd, 'record.jsonl') };
}

describe('agent interaction', () => {
  it('returns the full feedback and task context to the original model after a stored pause', async () => {
    const { cwd, store, recordTo } = await setup();
    const calls: AgentRequest[] = [];
    const makeJob = () => agentJob({
      label: 'write', engine: new MockEngine((sent) => {
        calls.push(sent);
        return calls.length === 1 ? request : 'Finished the original task.';
      }), model: 'original-model', prompt: 'Write the introduction.', interaction: binding,
    });
    const callbacks = await createStoredCallbackClient(store.storage, store.runId);
    expect((await run(makeJob(), { cwd, recordTo, callbacks })).outcome.status).toBe('paused');
    for (let i = 0; i < 2; i += 1) {
      expect((await run(makeJob(), { cwd, recordTo, callbacks: await createStoredCallbackClient(store.reopen(), store.runId), resume: true })).outcome.status).toBe('paused');
    }
    expect(calls).toHaveLength(1);
    const [question] = await callbacks.listPending();
    expect(question!.input).toMatchObject({ requester: { model: 'original-model', prompt: expect.stringContaining('Write the introduction.') }, material: { sourceText: 'advanced setup' } });
    const claim = await callbacks.claim(question!.requestId, 'person');
    if (!claim.ok) throw new Error('could not claim question');
    expect(await callbacks.submit(question!.requestId, claim.claimToken, 'person', question!.digest, feedback)).toMatchObject({ ok: true });
    expect((await run(makeJob(), { cwd, recordTo, callbacks: await createStoredCallbackClient(store.reopen(), store.runId), resume: true })).outcome.status).toBe('pass');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.model).toBe('original-model');
    expect(calls[1]!.prompt).toContain('Write the introduction.');
    expect(calls[1]!.prompt).toContain(JSON.stringify(feedback));
    expect(calls[1]!.prompt).toContain(JSON.stringify({ sourceText: 'advanced setup', choices: ['beginners', 'experts'] }));
  });

  it('lets the injected handler answer through the real callback contract', async () => {
    const { cwd, store, recordTo } = await setup();
    const prompts: string[] = [];
    let answered = 0;
    const result = await run(agentJob({
      engine: new MockEngine((sent) => { prompts.push(sent.prompt); return prompts.length === 1 ? request : 'done'; }),
      model: 'writer', prompt: 'Original task',
      interaction: { ...binding, async answer(question) { answered += 1; expect(question.input).toMatchObject({ material: { sourceText: 'advanced setup' } }); return feedback; } },
    }), { cwd, recordTo, callbacks: await createStoredCallbackClient(store.storage, store.runId) });
    expect(result.outcome.status).toBe('pass');
    expect(answered).toBe(1);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(JSON.stringify(feedback));
  });

  it('keeps cancellation pending and does not call the model again', async () => {
    const { cwd, store, recordTo } = await setup();
    let calls = 0;
    const callbacks = await createStoredCallbackClient(store.storage, store.runId);
    const result = await run(agentJob({
      engine: new MockEngine(() => { calls += 1; return request; }), prompt: 'Original task',
      interaction: { ...binding, async answer() { return undefined; } },
    }), { cwd, recordTo, callbacks, onCallback: 'wait' });
    expect(result.outcome.status).toBe('paused');
    expect(calls).toBe(1);
    expect(await callbacks.listPending()).toHaveLength(1);
  });

  it.each([{ feedback: {}, prompt: '   ' }, { prompt: 'missing feedback' }])('rejects an invalid rich response even with a permissive binding schema', async (response) => {
    const { cwd, store, recordTo } = await setup();
    let calls = 0;
    const callbacks = await createStoredCallbackClient(store.storage, store.runId);
    const result = await run(agentJob({
      engine: new MockEngine(() => { calls += 1; return request; }), prompt: 'Original task',
      interaction: { ...binding, responseSchema: {}, async answer() { return response as InteractionResponse; } },
    }), { cwd, recordTo, callbacks });
    expect(result.outcome.status).not.toBe('pass');
    expect(calls).toBe(1);
    expect(await callbacks.listPending()).toHaveLength(1);
  });

  it('recognises the interaction marker only for an opted-in job', async () => {
    const { cwd } = await setup();
    expect((await run(agentJob({ engine: new MockEngine(() => request), prompt: 'Original task' }), { cwd })).outcome)
      .toMatchObject({ status: 'pass', data: request });
  });

  it('keeps a rich person stage response whole', async () => {
    const { cwd } = await setup();
    const result = await run(workflow('human-input', {
      brief: 'Choose the audience.', roles: { editor: person('Which audience?', { interaction: { ...binding, async answer() { return feedback; } } }) },
      stages: [stage('choose', { input: 'editor' })],
    }), { cwd });
    expect(result.outcome).toMatchObject({ status: 'pass', data: { choose: { status: 'pass', data: feedback } } });
  });
});

describe('human review decides completion', () => {
  it('returns two rich revisions to the writer and completes only after explicit human approval', async () => {
    const { cwd } = await setup();
    const { humanReview, loop } = await import('../src/api.ts');
    const calls: AgentRequest[] = [];
    let reviews = 0;
    const result = await run(loop({
      name: 'human-refinement', max: 4,
      body: agentJob({ engine: new MockEngine((sent) => { calls.push(sent); return `draft ${calls.length}`; }), model: 'original-writer', prompt: 'Write the introduction.', consumeFeedback: true }),
      review: humanReview('audience', {
        question: 'Is this ready?', input: (ctx) => ({ draft: String(ctx.lastOutcome!.data) }),
        interaction: { ...binding, async answer() { reviews += 1; return { ...feedback, decision: reviews === 3 ? 'approved' : 'changes-requested' }; } },
      }),
    }), { cwd });
    expect(result.outcome.status).toBe('pass');
    expect(reviews).toBe(3);
    expect(calls).toHaveLength(3);
    expect(calls[1]!.prompt).toContain(JSON.stringify({ ...feedback, decision: 'changes-requested' }));
    expect(calls[2]!.prompt).toContain(feedback.prompt);
    expect(calls.every((call) => call.model === 'original-writer')).toBe(true);
  });

  it('cannot turn a model pass or a spent cap into a human approval', async () => {
    const { cwd } = await setup();
    const { humanReview, loop } = await import('../src/api.ts');
    const result = await run(loop({
      name: 'approval-required', max: 2,
      body: agentJob({ engine: new MockEngine(() => 'finished'), prompt: 'Write it.', consumeFeedback: true }),
      review: humanReview('audience', { question: 'Ready?', input: { draft: 'finished' }, interaction: { ...binding, async answer() { return { ...feedback, decision: 'changes-requested' }; } } }),
    }), { cwd });
    expect(result.outcome.status).toBe('exhausted');
  });

  it('resumes the same human review without rerunning the completed writer', async () => {
    const { cwd, store, recordTo } = await setup();
    const { humanReview, loop } = await import('../src/api.ts');
    let writes = 0;
    const callbacks = await createStoredCallbackClient(store.storage, store.runId);
    const makeJob = () => loop({
      name: 'human-refinement', max: 3,
      body: agentJob({ engine: new MockEngine(() => { writes += 1; return `draft ${writes}`; }), prompt: 'Write it.', consumeFeedback: true }),
      review: humanReview('audience', { question: 'Ready?', input: (ctx) => ({ draft: String(ctx.lastOutcome!.data) }), interaction: binding }),
    });
    expect((await run(makeJob(), { cwd, callbacks, recordTo })).outcome.status).toBe('paused');
    expect((await run(makeJob(), { cwd, callbacks, recordTo, resume: true })).outcome.status).toBe('paused');
    expect(writes).toBe(1);
    const [question] = await callbacks.listPending();
    const claim = await callbacks.claim(question!.requestId, 'person');
    if (!claim.ok) throw new Error('claim refused');
    expect(await callbacks.submit(question!.requestId, claim.claimToken, 'person', question!.digest, { ...feedback, decision: 'approved' })).toMatchObject({ ok: true });
    expect((await run(makeJob(), { cwd, callbacks, recordTo, resume: true })).outcome.status).toBe('pass');
    expect(writes).toBe(1);
  });
});

describe('composing machine and human review', () => {
  it('runs the machine review loop inside the human loop and requires approval after two revisions', async () => {
    const { cwd } = await setup();
    const { humanReview, loop } = await import('../src/api.ts');
    const sent: AgentRequest[] = [];
    let machineReviews = 0;
    let humanReviews = 0;
    const result = await run(loop({
      name: 'human', max: 3,
      body: loop({
        name: 'machine', max: 2,
        body: agentJob({ engine: new MockEngine((request) => { sent.push(request); return `draft ${sent.length}`; }), model: 'writer', prompt: 'Write the proposal.', consumeFeedback: true }),
        review: async () => { machineReviews += 1; return { status: machineReviews === 1 ? 'fail' : 'pass', summary: 'machine review' }; },
      }),
      review: humanReview('product', { question: 'Ready?', input: (ctx) => String(ctx.lastOutcome?.data), interaction: {
        ...binding,
        async answer() { humanReviews += 1; return { ...feedback, decision: humanReviews === 3 ? 'approved' : 'changes-requested', prompt: humanReviews === 3 ? '' : feedback.prompt }; },
      } }),
    }), { cwd });
    expect(result.outcome.status).toBe('pass');
    expect(humanReviews).toBe(3);
    expect(machineReviews).toBe(4);
    expect(sent[2]!.prompt).toContain(feedback.prompt);
    expect(sent[3]!.prompt).toContain(JSON.stringify({ ...feedback, decision: 'changes-requested' }));
  });

  it('does not reuse approval when the reviewed material changes', async () => {
    const { cwd, store, recordTo } = await setup();
    const { humanReview, loop } = await import('../src/api.ts');
    const callbacks = await createStoredCallbackClient(store.storage, store.runId);
    let material = 'first draft';
    const makeJob = () => loop({
      name: 'human', max: 2,
      body: async () => ({ status: 'pass', data: 'writer output' }),
      review: humanReview('product', { question: 'Ready?', input: () => material, interaction: binding }),
    });
    expect((await run(makeJob(), { cwd, callbacks, recordTo })).outcome.status).toBe('paused');
    const [first] = await callbacks.listPending();
    const claim = await callbacks.claim(first!.requestId, 'person');
    if (!claim.ok) throw new Error('claim refused');
    expect(await callbacks.submit(first!.requestId, claim.claimToken, 'person', first!.digest, { feedback: {}, prompt: '', decision: 'approved' })).toMatchObject({ ok: true });
    material = 'edited draft';
    expect((await run(makeJob(), { cwd, callbacks, recordTo, resume: true })).outcome.status).toBe('paused');
    const [next] = await callbacks.listPending();
    expect(next!.requestId).not.toBe(first!.requestId);
    expect(next!.input).toMatchObject({ material: 'edited draft' });
  });

  it('refuses blank changes and missing decisions through stored external submission', async () => {
    const { cwd, store, recordTo } = await setup();
    const { humanReview } = await import('../src/api.ts');
    const callbacks = await createStoredCallbackClient(store.storage, store.runId);
    await run(humanReview('product', { question: 'Ready?', input: 'the material', interaction: binding }), { cwd, callbacks, recordTo });
    const [question] = await callbacks.listPending();
    const claim = await callbacks.claim(question!.requestId, 'person');
    if (!claim.ok) throw new Error('claim refused');
    for (const response of [{ feedback: {}, prompt: ' ', decision: 'changes-requested' }, { feedback: {}, prompt: 'Do this.' }, { feedback: {}, prompt: '', decision: 'yes' }] as JsonObject[]) {
      expect(await callbacks.submit(question!.requestId, claim.claimToken, 'person', question!.digest, response)).toMatchObject({ ok: false, kind: 'invalid' });
    }
    expect(await callbacks.submit(question!.requestId, claim.claimToken, 'person', question!.digest, { feedback: {}, prompt: '', decision: 'approved' })).toMatchObject({ ok: true });
  });
});


describe('human approval and budget limits survive a pause', () => {
  it('does not report a workflow pass when human review reaches its cap without approval', async () => {
    const { cwd } = await setup();
    let writes = 0;
    const writer = new MockEngine(() => {
      writes += 1;
      return { text: JSON.stringify({ status: 'pass', summary: 'written' }) };
    });
    const writingEngine = { ...writer, name: writer.name, run: async (...args: Parameters<typeof writer.run>) => {
      await writeFile(join(cwd, 'draft.md'), `draft ${writes + 1}`);
      return writer.run(...args);
    } };
    const result = await run(workflow('human-stage', {
      brief: 'Write a draft.',
      roles: {
        writer: { engine: writingEngine, identity: { adapter: 'mock', provider: 'mock', modelFamily: 'writer', model: 'writer', tools: ['Write'] } },
        editor: person('Ready?', { interaction: { ...binding, async answer() { return { ...feedback, decision: 'changes-requested' }; } } }),
      },
      stages: [stage('write', { agent: 'writer', writes: 'draft.md', reviewedBy: 'editor', refine: 1 })],
    }), { cwd });
    expect(writes).toBe(2);
    expect(result.outcome.status).toBe('fail');
  });

  it('does not refill the token budget when returning a stored answer to the agent', async () => {
    const { cwd, store, recordTo } = await setup();
    let calls = 0;
    const makeJob = () => agentJob({ prompt: 'Write it.', model: 'writer', interaction: binding,
      engine: new MockEngine(() => { calls += 1; return calls === 1 ? request : 'done'; }),
    });
    const callbacks = await createStoredCallbackClient(store.storage, store.runId);
    expect((await run(makeJob(), { cwd, callbacks, recordTo, budget: 15 })).outcome.status).toBe('paused');
    const [question] = await callbacks.listPending();
    const claim = await callbacks.claim(question!.requestId, 'person');
    if (!claim.ok) throw new Error('claim refused');
    expect(await callbacks.submit(question!.requestId, claim.claimToken, 'person', question!.digest, feedback)).toMatchObject({ ok: true });
    const result = await run(makeJob(), { cwd, callbacks, recordTo, budget: 15, resume: true });
    expect(result.outcome).toMatchObject({ status: 'fail', error: { code: 'BUDGET' } });
    expect(calls).toBe(1);
    expect(result.budget?.spent).toBe(15);
  });
});

describe('the requester keeps its engine route', () => {
  it.each([false, true])('resumes the selected fallback without retrying the primary or silently switching again (failure=%s)', async (failAfterAnswer) => {
    const { cwd, store, recordTo } = await setup();
    const { LoopError } = await import('../src/api.ts');
    let primaryCalls = 0;
    let fallbackCalls = 0;
    let otherCalls = 0;
    const makeJob = () => agentJob({
      label: 'writer', prompt: 'Write the original.', model: 'primary', interaction: binding,
      engine: new MockEngine(() => { primaryCalls += 1; throw new LoopError({ code: 'RATE_LIMIT', message: 'limited' }); }),
      fallback: [
        { model: 'requester', engine: new MockEngine((sent) => {
          expect(sent.model).toBe('requester');
          fallbackCalls += 1;
          if (fallbackCalls === 1) return request;
          if (failAfterAnswer) throw new LoopError({ code: 'RATE_LIMIT', message: 'limited again' });
          expect(sent.prompt).toContain(JSON.stringify(feedback));
          return 'done';
        }) },
        { model: 'other', engine: new MockEngine(() => { otherCalls += 1; return 'must not run'; }) },
      ],
    });
    const callbacks = await createStoredCallbackClient(store.storage, store.runId);
    expect((await run(makeJob(), { cwd, callbacks, recordTo })).outcome.status).toBe('paused');
    const [question] = await callbacks.listPending();
    const claim = await callbacks.claim(question!.requestId, 'person');
    if (!claim.ok) throw new Error('claim refused');
    expect(await callbacks.submit(question!.requestId, claim.claimToken, 'person', question!.digest, feedback)).toMatchObject({ ok: true });
    expect((await run(makeJob(), { cwd, callbacks, recordTo, resume: true })).outcome.status).toBe(failAfterAnswer ? 'fail' : 'pass');
    expect([primaryCalls, fallbackCalls, otherCalls]).toEqual([1, 2, 0]);
  });
});

describe('application response constraints', () => {
  it.each(['prompt', 'anyOf'] as const)('preserves the application %s constraint when adding the rich response contract', async (constraint) => {
    const { cwd, store, recordTo } = await setup();
    const { humanReview } = await import('../src/api.ts');
    const callbacks = await createStoredCallbackClient(store.storage, store.runId);
    const responseSchema: JsonObject = constraint === 'prompt'
      ? { properties: { prompt: { type: 'string', enum: ['Only the chosen prompt.'] } } }
      : { anyOf: [{ properties: { policy: { type: 'string', enum: ['review-policy'] } } }] };
    await run(humanReview('product', { question: 'Ready?', input: 'material', interaction: { ...binding, responseSchema } }), { cwd, callbacks, recordTo });
    const [question] = await callbacks.listPending();
    const claim = await callbacks.claim(question!.requestId, 'person');
    if (!claim.ok) throw new Error('claim refused');
    expect(await callbacks.submit(question!.requestId, claim.claimToken, 'person', question!.digest, { feedback: {}, prompt: 'Different prompt.', decision: 'approved', policy: 'wrong-policy' }))
      .toMatchObject({ ok: false, kind: 'invalid' });
  });
});
