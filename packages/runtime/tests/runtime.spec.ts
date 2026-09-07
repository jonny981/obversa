import { afterAll, describe, it, expect } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  run,
  exitCodeFor,
  fnJob,
  loop,
  dag,
  LoopError,
} from '../src/api.ts';
import type { Engine, RunOptions } from '../src/api.ts';
import { MockEngine, MockEnvironment } from '../src/testing.ts';
import { cleanupRepos, tmpBareDir } from './git-helpers.ts';
import { fixtureResult, fixtureUsage } from './engine-fixture.ts';
import { vi } from 'vitest';

// Real work: these tests create temporary Git repositories and write files
// to disk, so this file declares its own time limit; the suite default is a
// hang guard, not a speed bar.
vi.setConfig({ testTimeout: 30_000 });

afterAll(cleanupRepos);

const mockOpts: RunOptions = {
  engine: 'mock',
  engines: { mock: new MockEngine(() => '') },
};

describe('exitCodeFor', () => {
  it('maps every status', () => {
    expect(exitCodeFor({ status: 'pass' })).toBe(0);
    expect(exitCodeFor({ status: 'fail' })).toBe(1);
    expect(exitCodeFor({ status: 'exhausted' })).toBe(2);
    expect(exitCodeFor({ status: 'aborted' })).toBe(130);
  });
});

describe('run', () => {
  it('catches a thrown root job and reports a fail outcome', async () => {
    const { outcome, stats } = await run(
      fnJob('boom', async () => {
        throw new Error('kaboom');
      }),
      mockOpts,
    );
    // fnJob catches internally and returns fail; the run still records the error
    expect(outcome.status).toBe('fail');
    expect(stats.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('seeds shared state and threads it to jobs', async () => {
    let seen: unknown;
    await run(
      fnJob('peek', async (ctx) => {
        seen = ctx.state.seedValue;
        return { status: 'pass' };
      }),
      { ...mockOpts, state: { seedValue: 42 } },
    );
    expect(seen).toBe(42);
  });

  it('reads shared state at the root after a DAG node inside a loop changes it', async () => {
    let leafSeed: unknown;
    const nested = loop({
      name: 'nested',
      max: 1,
      body: dag({
        name: 'steps',
        nodes: {
          increment: fnJob('increment', async (ctx) => {
            leafSeed = ctx.state.count;
            ctx.state.count = Number(ctx.state.count) + 1;
            return { status: 'pass' };
          }),
        },
      }),
    });
    const { outcome } = await run(fnJob('root', async (ctx) => {
      const result = await nested(ctx);
      return { ...result, data: { rootCount: ctx.state.count } };
    }), { ...mockOpts, state: { count: 41 } });

    expect(leafSeed).toBe(41);
    expect(outcome).toMatchObject({ status: 'pass', data: { rootCount: 42 } });
  });

  it('gives every run an immutable empty brief by default', async () => {
    let seen: unknown;
    await run(
      fnJob('peek', async (ctx) => {
        seen = ctx.params;
        return { status: 'pass' };
      }),
      mockOpts,
    );

    expect(seen).toEqual({});
    expect(Object.isFrozen(seen)).toBe(true);
  });

  it('snapshots the run brief and reuses it in nested jobs', async () => {
    const source = {
      task: { name: 'original' },
      lanes: ['build'],
    };
    let rootBrief: Readonly<Record<string, unknown>> | undefined;
    let childBrief: Readonly<Record<string, unknown>> | undefined;
    const nested = loop({
      name: 'nested',
      max: 1,
      body: fnJob('child', async (ctx) => {
        childBrief = ctx.params;
        return { status: 'pass' };
      }),
    });

    const pending = run(
      fnJob('root', async (ctx) => {
        rootBrief = ctx.params;
        return nested(ctx);
      }),
      { ...mockOpts, params: source },
    );

    source.task.name = 'changed';
    source.lanes.push('review');
    const { outcome } = await pending;

    expect(outcome.status).toBe('pass');
    expect(rootBrief).toEqual({ task: { name: 'original' }, lanes: ['build'] });
    expect(rootBrief).not.toBe(source);
    expect(childBrief).toBe(rootBrief);
    expect(Object.isFrozen(rootBrief)).toBe(true);
    expect(Object.isFrozen(rootBrief?.task)).toBe(true);
    expect(Object.isFrozen(rootBrief?.lanes)).toBe(true);
    expect(Object.isFrozen(source)).toBe(false);
    expect(Object.isFrozen(source.task)).toBe(false);
  });

  it('rejects an invalid run brief before the job starts', async () => {
    let ran = false;
    const environment = new MockEnvironment();

    await expect(
      run(
        fnJob('never', async () => {
          ran = true;
          return { status: 'pass' };
        }),
        {
          ...mockOpts,
          environment,
          params: { task: { owner: undefined } } as never,
        },
      ),
    ).rejects.toMatchObject({
      name: 'JsonValueError',
      code: 'INVALID_JSON_VALUE',
      path: '/task/owner',
    });
    expect(ran).toBe(false);
    expect(environment.upCount).toBe(0);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'brief'],
    ['a number', 1],
    ['a boolean', false],
  ])('rejects %s as the run brief root before work starts', async (_label, params) => {
    let ran = false;
    const environment = new MockEnvironment();

    await expect(run(
      fnJob('never', async () => {
        ran = true;
        return { status: 'pass' };
      }),
      { ...mockOpts, environment, params: params as never },
    )).rejects.toMatchObject({
      name: 'JsonValueError',
      code: 'INVALID_JSON_VALUE',
      path: '',
    });
    expect(ran).toBe(false);
    expect(environment.upCount).toBe(0);
  });

  it('uses a custom Engine instance provided via engines map', async () => {
    let calledWith = '';
    const spy: Engine = {
      name: 'spy',
      async run(req, onEvent) {
        calledWith = req.prompt;
        const usage = fixtureUsage();
        onEvent({
          type: 'usage',
          usage,
          model: 'spy',
        });
        return fixtureResult('ok', { model: 'spy', usage });
      },
    };
    const { outcome } = await run(
      loop({
        name: 'x',
        body: (await import('../src/api.ts')).agentJob({
          label: 'w',
          engine: 'spy',
          prompt: 'hello-engine',
        }),
        max: 1,
      }),
      { engine: 'spy', engines: { spy } },
    );
    expect(calledWith).toBe('hello-engine');
    expect(outcome.status).toBe('pass');
  });

  it('auto-names JSONL records from the run id', async () => {
    const dir = tmpBareDir();
    const result = await run(
      fnJob('done', async () => ({
        status: 'pass',
        summary: 'ok',
        data: { secret: 'private payload' },
      })),
      { cwd: dir, recordTo: 'auto' },
    );

    expect(result.runId).toBeTruthy();
    expect(result.recordPath).toBe(`${dir}/.obversa/records/${result.runId}.jsonl`);
    expect(existsSync(result.recordPath!)).toBe(true);
    const record = readFileSync(result.recordPath!, 'utf8');
    expect(record).toContain('"kind":"job:end"');
    expect(record).not.toContain('private payload');
    expect(readFileSync(`${dir}/.obversa/.gitignore`, 'utf8')).toBe('*\n');
  });

  it('rejects Lines-managed paths that escape through a symlink', async () => {
    const dir = tmpBareDir();
    const target = mkdtempSync(join(tmpdir(), 'lines-escape-target-'));
    symlinkSync(target, join(dir, '.obversa'));
    try {
      await expect(
        run(fnJob('done', async () => ({ status: 'pass' })), {
          cwd: dir,
          recordTo: 'auto',
        }),
      ).rejects.toThrow(/unsafe \.obversa/);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

});

describe('LoopError', () => {
  it('returns an existing LoopError unchanged via from()', () => {
    const original = new LoopError({ code: 'CONFIG', message: 'bad' });
    expect(LoopError.from(original, { code: 'UNKNOWN' })).toBe(original);
  });
  it('wraps a plain Error and marks ENGINE/TIMEOUT retryable', () => {
    const wrapped = LoopError.from(new Error('net'), { code: 'ENGINE' });
    expect(wrapped.code).toBe('ENGINE');
    expect(wrapped.retryable).toBe(true);
    expect(LoopError.from(new Error('x'), { code: 'CONFIG' }).retryable).toBe(
      false,
    );
  });
});
