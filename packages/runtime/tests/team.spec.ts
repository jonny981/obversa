import { afterAll, describe, expect, it } from 'vitest';

import { run, team } from '../src/api.ts';
import type { AgentRequest } from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';
import { cleanupRepos, tmpRepo, write } from './git-helpers.ts';

afterAll(cleanupRepos);

const writer = {
  name: 'writer',
  role: 'writer',
  brief: 'Write the release note.',
  engine: 'mock' as const,
};

describe('team()', () => {
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
});
