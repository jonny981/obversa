import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { createStoredCallbackClient, loop, pipeline, run, team } from '../src/api.ts';
import type { AgentRequest, JsonValue, TeamReview } from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';
import { cleanupRepos, tmpRepo, write } from './git-helpers.ts';
import { createStoredRunFixture, type StoredRunFixture } from './stored-run-fixture.ts';

afterAll(cleanupRepos);

const roots: string[] = [];
const stores: StoredRunFixture[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const writer = {
  name: 'writer',
  role: 'writer',
  brief: 'Write the release note.',
  engine: 'mock' as const,
};

describe('team()', () => {
  it.each([
    { kind: 'panel', config: { reviewers: [] } },
    { kind: 'callback', definition: {
      gateId: '', gateVersion: 1, decisionText: 'Approve?', responseSchema: {}, input: {},
    } },
  ] satisfies TeamReview[])('rejects invalid $kind review before any member work', async (review) => {
    const repo = await tmpRepo();
    const requests: AgentRequest[] = [];
    const engine = new MockEngine((request) => {
      requests.push(request);
      return 'writer answer';
    });
    let error: unknown;
    try {
      await run(team({ task: 'Prepare the release note.', agents: [writer], review }), {
        engine: 'mock', engines: { mock: engine }, cwd: repo,
      });
    } catch (caught) {
      error = caught;
    }
    expect(requests).toHaveLength(0);
    expect(error).toBeInstanceOf(Error);
  });

  it('constructs a job from a task and one named agent role', () => {
    const job = team({
      task: 'Prepare the release note.',
      agents: [writer],
    });

    expect(typeof job).toBe('function');
  });

  it('rejects a team with no agents', () => {
    expect(() => team({ task: 'Prepare the release note.', agents: [] })).toThrow();
  });

  it('rejects duplicate agent names', () => {
    expect(() => team({
      task: 'Prepare the release note.',
      agents: [writer, { ...writer, role: 'reviewer' }],
    })).toThrow();
  });

  it('rejects an agent without a role or brief', () => {
    expect(() => team({
      task: 'Prepare the release note.',
      agents: [{ ...writer, role: '', brief: '' }],
    })).toThrow();
  });

  it('runs each member in an isolated worktree and preserves separate answers', async () => {
    const repo = await tmpRepo();
    const requests: AgentRequest[] = [];
    const engine = new MockEngine((request) => {
      requests.push(request);
      if (!request.cwd) throw new Error('mock request has no worktree');
      const role = request.prompt.includes('reviewer') ? 'reviewer' : 'writer';
      write(request.cwd, `${role}.txt`, `${role}\n`);
      return `${role} answer`;
    });

    const { outcome } = await run(team({
      task: 'Prepare the release note.',
      agents: [
        writer,
        {
          name: 'reviewer',
          role: 'reviewer',
          brief: 'Check the release note.',
          engine: 'mock',
        },
      ],
    }), {
      engine: 'mock',
      engines: { mock: engine },
      cwd: repo,
    });

    expect(outcome.status).toBe('pass');
    const data = outcome.data as {
      agents: readonly { name: string; outcome: { status: string; data?: unknown } }[];
      integrated: boolean;
    };
    expect(data.agents.map((member) => member.name)).toEqual(['writer', 'reviewer']);
    expect(data.agents.every((member) => member.outcome.status === 'pass')).toBe(true);
    expect(data.integrated).toBe(true);
    expect(requests).toHaveLength(2);
    expect(new Set(requests.map((request) => request.cwd)).size).toBe(2);
    expect(requests.every((request) => request.cwd !== repo)).toBe(true);
    expect(requests.some((request) => request.prompt.includes('Write the release note.'))).toBe(true);
    expect(requests.some((request) => request.prompt.includes('Check the release note.'))).toBe(true);
    expect(await readFile(join(repo, 'writer.txt'), 'utf8')).toBe('writer\n');
    expect(await readFile(join(repo, 'reviewer.txt'), 'utf8')).toBe('reviewer\n');
  });

  it('returns every member outcome when one member fails', async () => {
    const repo = await tmpRepo();
    const engine = new MockEngine((request) => {
      if (request.prompt.includes('Check the release note.')) {
        throw new Error('reviewer engine failed');
      }
      if (!request.cwd) throw new Error('mock request has no worktree');
      write(request.cwd, 'writer.txt', 'writer\n');
      return 'writer answer';
    });

    const { outcome } = await run(team({
      task: 'Prepare the release note.',
      agents: [
        writer,
        {
          name: 'reviewer',
          role: 'reviewer',
          brief: 'Check the release note.',
          engine: 'mock',
        },
      ],
    }), {
      engine: 'mock',
      engines: { mock: engine },
      cwd: repo,
    });

    expect(outcome.status).toBe('fail');
    const data = outcome.data as {
      agents: readonly { name: string; outcome: { status: string } }[];
    };
    expect(data.agents.map((member) => member.name)).toEqual(['writer', 'reviewer']);
    expect(data.agents.map((member) => member.outcome.status)).toEqual(['pass', 'fail']);
  });

  it('reuses an existing review panel after the members finish', async () => {
    const repo = await tmpRepo();
    const engine = new MockEngine((request) => {
      if (!request.cwd) throw new Error('mock request has no worktree');
      write(request.cwd, 'writer.txt', 'writer\n');
      return 'writer answer';
    });

    const { outcome } = await run(team({
      task: 'Prepare the release note.',
      agents: [writer],
      review: {
        kind: 'panel',
        config: {
          reviewers: [{
            name: 'check',
            review: async (_ctx, last) => ({
              met: (last?.data as { task?: string } | undefined)?.task === 'Prepare the release note.',
              reason: 'reviewed the team result',
            }),
          }],
        },
      },
    }), {
      engine: 'mock',
      engines: { mock: engine },
      cwd: repo,
    });

    expect(outcome.status).toBe('pass');
    expect((outcome.data as { review?: { status: string } }).review?.status).toBe('pass');
  });

  it('returns an existing callback gate as a paused review', async () => {
    const repo = await tmpRepo();
    const engine = new MockEngine((request) => {
      if (!request.cwd) throw new Error('mock request has no worktree');
      write(request.cwd, 'writer.txt', 'writer\n');
      return 'writer answer';
    });

    const { outcome } = await run(team({
      task: 'Prepare the release note.',
      agents: [writer],
      review: {
        kind: 'callback',
        definition: {
          gateId: 'team-review',
          gateVersion: 1,
          decisionText: 'Approve the team result?',
          responseSchema: {
            type: 'object',
            properties: { approved: { type: 'boolean' } },
            required: ['approved'],
          },
          input: { task: 'Prepare the release note.' },
        },
      },
    }), {
      engine: 'mock',
      engines: { mock: engine },
      cwd: repo,
    });

    expect(outcome.status).toBe('paused');
    const review = (outcome.data as {
      review?: { status: string; data?: { gateId?: string; requestId?: string } };
    }).review;
    expect(review?.status).toBe('paused');
    expect(review?.data?.gateId).toBe('team-review');
    expect(review?.data?.requestId).toContain('team-review#1#');
  });

  describe('with a callback review', () => {
    const review: TeamReview = {
      kind: 'callback',
      definition: {
        gateId: 'team-review',
        gateVersion: 1,
        decisionText: 'Approve the team result?',
        responseSchema: {
          type: 'object',
          properties: { approved: { type: 'boolean' }, note: { type: 'string' } },
          required: ['approved'],
        },
        input: { task: 'Prepare the release note.' },
      },
    };

    async function setup(shape: 'team' | 'step' | 'loop' = 'team') {
      const repo = await tmpRepo();
      const records = await mkdtemp(join(tmpdir(), 'team-review-'));
      roots.push(records);
      const store = await createStoredRunFixture('team-review');
      stores.push(store);
      const requests: AgentRequest[] = [];
      const engine = new MockEngine((request) => {
        requests.push(request);
        if (!request.cwd) throw new Error('mock request has no worktree');
        write(request.cwd, 'writer.txt', `writer ${requests.length}\n`);
        return 'writer answer';
      });
      const job = () => {
        const prepared = team({ task: 'Prepare the release note.', agents: [writer], review });
        if (shape === 'step') return pipeline('ship', [{ name: 'team', job: prepared }]);
        if (shape === 'loop') return loop({ name: 'redo', body: prepared, max: 3 });
        return prepared;
      };
      const resume = async (first = false) => run(job(), {
        engine: 'mock',
        engines: { mock: engine },
        cwd: repo,
        recordTo: join(records, 'record.jsonl'),
        callbacks: await createStoredCallbackClient(store.reopen(), store.runId),
        ...(first ? {} : { resume: true }),
      });
      const person = () => createStoredCallbackClient(store.reopen(), store.runId);
      return { repo, requests, resume, person };
    }

    type Paused = { requestId?: string; agents: { name: string; outcome: { status: string } }[]; review?: { status: string; data?: { requestId?: string } } };

    it('posts its question, stays paused until it is answered, and passes on approval without running members again', async () => {
      const { repo, requests, resume, person } = await setup();

      const first = await resume(true);
      expect(first.outcome.status).toBe('paused');
      const [question, ...others] = await (await person()).listPending();
      expect(others).toHaveLength(0);
      expect(question?.gateId).toBe('team-review');
      const paused = first.outcome.data as Paused;
      expect(paused.requestId).toBe(question!.requestId);
      expect(paused.review?.data?.requestId).toBe(question!.requestId);
      expect(question!.input).toMatchObject({ team: { task: 'Prepare the release note.', agents: [{ name: 'writer', outcome: { status: 'pass' } }] } });
      expect(paused.agents.map((agent) => [agent.name, agent.outcome.status])).toEqual([['writer', 'pass']]);

      const pending = await resume();
      expect(pending.outcome.status).toBe('paused');
      expect((pending.outcome.data as Paused).requestId).toBe(question!.requestId);
      expect((pending.outcome.data as Paused).review?.data?.requestId).toBe(question!.requestId);
      expect((await (await person()).listPending()).map((request) => request.requestId)).toEqual([question!.requestId]);

      const answering = await person();
      const claim = await answering.claim(question!.requestId, 'a-person');
      if (!claim.ok) throw new Error('the person could not claim the question');
      const invalid: JsonValue = { approved: 'yes' };
      expect(await answering.submit(question!.requestId, claim.claimToken, 'a-person', question!.digest, invalid))
        .toMatchObject({ ok: false, kind: 'invalid' });
      expect((await resume()).outcome.status).toBe('paused');

      expect(await answering.submit(question!.requestId, claim.claimToken, 'a-person', question!.digest, { approved: true }))
        .toMatchObject({ ok: true });
      const done = await resume();
      expect(done.outcome.status).toBe('pass');
      const data = done.outcome.data as { task: string; integrated: boolean } & Paused;
      expect(data.task).toBe('Prepare the release note.');
      expect(data.integrated).toBe(true);
      expect(data.agents.map((agent) => [agent.name, agent.outcome.status])).toEqual([['writer', 'pass']]);
      expect(data.review).toMatchObject({ status: 'pass', data: { approved: true } });
      expect(requests).toHaveLength(1);
      expect(await readFile(join(repo, 'writer.txt'), 'utf8')).toBe('writer 1\n');
    });

    it('fails with the note when the person refuses, without running members again', async () => {
      const { requests, resume, person } = await setup();

      expect((await resume(true)).outcome.status).toBe('paused');
      const answering = await person();
      const [question] = await answering.listPending();
      const claim = await answering.claim(question!.requestId, 'a-person');
      if (!claim.ok) throw new Error('the person could not claim the question');
      expect(await answering.submit(question!.requestId, claim.claimToken, 'a-person', question!.digest, { approved: false, note: 'Too long.' }))
        .toMatchObject({ ok: true });

      const done = await resume();
      expect(done.outcome.status).toBe('fail');
      expect(done.outcome.summary).toBe('Too long.');
      const data = done.outcome.data as Paused;
      expect(data.agents.map((agent) => [agent.name, agent.outcome.status])).toEqual([['writer', 'pass']]);
      expect(data.review).toMatchObject({ status: 'fail', data: { approved: false, note: 'Too long.' } });
      expect(requests).toHaveLength(1);
    });

    it('resumes as a pipeline step without running members again', async () => {
      const { requests, resume, person } = await setup('step');

      expect((await resume(true)).outcome.status).toBe('paused');
      expect((await resume()).outcome.status).toBe('paused');
      const answering = await person();
      const [question] = await answering.listPending();
      expect(question?.gateId).toBe('team-review');
      const claim = await answering.claim(question!.requestId, 'a-person');
      if (!claim.ok) throw new Error('the person could not claim the question');
      expect(await answering.submit(question!.requestId, claim.claimToken, 'a-person', question!.digest, { approved: true }))
        .toMatchObject({ ok: true });

      expect((await resume()).outcome.status).toBe('pass');
      expect(requests).toHaveLength(1);
    });

    it('asks a fresh question when a loop runs the team again after a refusal', async () => {
      const { requests, resume, person } = await setup('loop');

      expect((await resume(true)).outcome.status).toBe('paused');
      const answering = await person();
      const [first] = await answering.listPending();
      const claim = await answering.claim(first!.requestId, 'a-person');
      if (!claim.ok) throw new Error('the person could not claim the question');
      expect(await answering.submit(first!.requestId, claim.claimToken, 'a-person', first!.digest, { approved: false, note: 'Too long.' }))
        .toMatchObject({ ok: true });

      const again = await resume();
      expect(again.outcome.status).toBe('paused');
      expect(requests).toHaveLength(2);
      const pending = await (await person()).listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.requestId).not.toBe(first!.requestId);
      expect((again.outcome.data as Paused).requestId).toBe(pending[0]!.requestId);
    });

    it('asks each of two teams with the same review its own question', async () => {
      const repo = await tmpRepo();
      const store = await createStoredRunFixture('team-review-twice');
      stores.push(store);
      const engine = new MockEngine((request) => {
        if (!request.cwd) throw new Error('mock request has no worktree');
        write(request.cwd, 'writer.txt', 'writer\n');
        return 'writer answer';
      });
      const prepared = () => team({ task: 'Prepare the release note.', agents: [writer], review });
      const { outcome } = await run(pipeline('ship', [
        { name: 'first', job: prepared() },
        { name: 'second', job: prepared() },
      ]), {
        engine: 'mock',
        engines: { mock: engine },
        cwd: repo,
        callbacks: await createStoredCallbackClient(store.reopen(), store.runId),
      });
      expect(outcome.status).toBe('paused');
      const answering = await createStoredCallbackClient(store.reopen(), store.runId);
      const [question] = await answering.listPending();
      const claim = await answering.claim(question!.requestId, 'a-person');
      if (!claim.ok) throw new Error('the person could not claim the question');
      await answering.submit(question!.requestId, claim.claimToken, 'a-person', question!.digest, { approved: true });

      const next = await run(pipeline('ship', [
        { name: 'first', job: prepared() },
        { name: 'second', job: prepared() },
      ]), {
        engine: 'mock',
        engines: { mock: engine },
        cwd: repo,
        callbacks: await createStoredCallbackClient(store.reopen(), store.runId),
      });
      expect(next.outcome.status).toBe('paused');
      const pending = await answering.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.requestId).not.toBe(question!.requestId);
      expect(question!.input).toMatchObject({ requester: { path: expect.arrayContaining(['first']) } });
      expect(pending[0]!.input).toMatchObject({ requester: { path: expect.arrayContaining(['second']) } });
    });
  });
});
