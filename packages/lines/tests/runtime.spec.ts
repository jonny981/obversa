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
  LoopError,
} from '../src/api.ts';
import type { Engine, RunOptions } from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';
import { cleanupRepos, tmpBareDir } from './git-helpers.ts';

afterAll(cleanupRepos);

const mockOpts: RunOptions = {
  engine: 'mock',
  engines: { mock: () => new MockEngine(() => '') },
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

  it('uses a custom Engine instance provided via engines map', async () => {
    let calledWith = '';
    const spy: Engine = {
      name: 'spy',
      async run(req, onEvent) {
        calledWith = req.prompt;
        onEvent({
          type: 'usage',
          usage: { inputTokens: 1, outputTokens: 1 },
          model: 'spy',
        });
        return {
          text: 'ok',
          usage: { inputTokens: 1, outputTokens: 1 },
          model: 'spy',
        };
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
    expect(result.recordPath).toBe(`${dir}/.lines/records/${result.runId}.jsonl`);
    expect(existsSync(result.recordPath!)).toBe(true);
    const record = readFileSync(result.recordPath!, 'utf8');
    expect(record).toContain('"kind":"job:end"');
    expect(record).not.toContain('private payload');
    expect(readFileSync(`${dir}/.lines/.gitignore`, 'utf8')).toBe('*\n');
  });

  it('rejects Lines-managed paths that escape through a symlink', async () => {
    const dir = tmpBareDir();
    const target = mkdtempSync(join(tmpdir(), 'lines-escape-target-'));
    symlinkSync(target, join(dir, '.lines'));
    try {
      await expect(
        run(fnJob('done', async () => ({ status: 'pass' })), {
          cwd: dir,
          recordTo: 'auto',
        }),
      ).rejects.toThrow(/unsafe \.lines/);
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
