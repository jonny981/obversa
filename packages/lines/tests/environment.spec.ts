import { describe, it, expect, afterAll } from 'vitest';

import {
  run,
  loop,
  dag,
  fnJob,
  commandSucceeds,
} from '../src/api.ts';
import type { RunOptions } from '../src/api.ts';
import { MockEngine, MockEnvironment } from '../src/testing.ts';
import { tmpRepo, write, cleanupRepos } from './git-helpers.ts';

afterAll(cleanupRepos);

const base: RunOptions = {
  engine: 'mock',
  engines: { mock: () => new MockEngine(() => '') },
};

describe('Environment axis', () => {
  it('brings the env up, threads the handle to the context, tears it down', async () => {
    const repo = await tmpRepo();
    const envir = new MockEnvironment({ env: { TEST_STAGE: 'live' } });
    let seenUrl: string | undefined;
    let seenStage: string | undefined;

    const job = fnJob('inspect', async (ctx) => {
      seenUrl = ctx.environment?.url;
      seenStage = ctx.environment?.env.TEST_STAGE;
      return { status: 'pass' };
    });

    const { outcome } = await run(job, { ...base, cwd: repo, environment: envir });
    expect(outcome.status).toBe('pass');
    expect(seenUrl).toContain('http://localhost/');
    expect(seenStage).toBe('live');
    expect(envir.upCount).toBe(1);
    expect(envir.downCount).toBe(1); // torn down after the run
  });

  it('tears the env down even when the job fails', async () => {
    const repo = await tmpRepo();
    const envir = new MockEnvironment();
    const job = fnJob('boom', async () => {
      throw new Error('kaboom');
    });
    await run(job, { ...base, cwd: repo, environment: envir });
    expect(envir.downCount).toBe(1);
  });

  it('lets the gate test the running environment (env vars reach commandSucceeds)', async () => {
    const repo = await tmpRepo();
    const envir = new MockEnvironment({ env: { TEST_STAGE: 'live' } });
    // The gate passes only because the environment injected the var.
    const job = loop({
      name: 'gated',
      body: fnJob('work', async () => ({ status: 'fail' })),
      until: commandSucceeds('sh', ['-c', 'test "$TEST_STAGE" = live']),
      max: 2,
    });
    const { outcome } = await run(job, { ...base, cwd: repo, environment: envir });
    expect(outcome.status).toBe('pass');
  });

  it('without an environment, the same gate cannot pass', async () => {
    const repo = await tmpRepo();
    const job = loop({
      name: 'gated',
      body: fnJob('work', async () => ({ status: 'fail' })),
      until: commandSucceeds('sh', ['-c', 'test "$TEST_STAGE" = live']),
      max: 2,
    });
    const { outcome } = await run(job, { ...base, cwd: repo });
    expect(outcome.status).toBe('exhausted'); // gate never opens, hits max
  });

  it('gives each worktree team its own environment, named after its branch', async () => {
    const repo = await tmpRepo();
    const envir = new MockEnvironment(); // url derived from ws.branch
    const seen: Record<string, string | undefined> = {};
    const job = dag({
      name: 'fan',
      isolation: 'worktree',
      environment: envir,
      stopOnError: false,
      nodes: {
        api: fnJob('api', async (ctx) => {
          seen.api = ctx.environment?.url;
          write(ctx.workspace.dir, 'api.ts', 'x\n');
          return { status: 'pass' };
        }),
        web: fnJob('web', async (ctx) => {
          seen.web = ctx.environment?.url;
          write(ctx.workspace.dir, 'web.ts', 'y\n');
          return { status: 'pass' };
        }),
      },
    });
    const { outcome } = await run(job, { ...base, cwd: repo });
    expect(outcome.status).toBe('pass');
    expect(envir.upCount).toBe(2); // one stage per team
    expect(envir.downCount).toBe(2); // each torn down with its worktree
    // each team's env is aligned with its own worktree branch
    expect(seen.api).toContain('lines/fan-api');
    expect(seen.web).toContain('lines/fan-web');
    expect(seen.api).not.toBe(seen.web);
  });

  it('does not bring up a per-team env for a non-isolated node', async () => {
    const repo = await tmpRepo();
    const envir = new MockEnvironment();
    const job = dag({
      name: 'plain',
      environment: envir,
      nodes: { x: fnJob('x', async () => ({ status: 'pass' })) },
    });
    await run(job, { ...base, cwd: repo });
    expect(envir.upCount).toBe(0); // per-team env requires isolation
  });

  it('fails the run cleanly when the environment cannot start', async () => {
    const repo = await tmpRepo();
    const broken = {
      name: 'broken',
      async up(): Promise<never> {
        throw new Error('deploy failed');
      },
    };
    const { outcome } = await run(fnJob('x', async () => ({ status: 'pass' })), {
      ...base,
      cwd: repo,
      environment: broken,
    });
    expect(outcome.status).toBe('fail');
    expect(outcome.summary).toContain('environment failed to start');
  });
});
