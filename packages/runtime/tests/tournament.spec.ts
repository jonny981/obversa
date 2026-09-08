import { describe, it, expect, afterAll, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';

import {
  run,
  tournament,
  fnJob,
} from '../src/api.ts';
import type { RunOptions } from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';
import { tmpRepo, tmpBareDir, write, cleanupRepos } from './git-helpers.ts';

// Real work: these tests create temporary Git repositories and write files
// to disk, so this file declares its own time limit; the suite default is a
// hang guard, not a speed bar.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

vi.mock('execa', { spy: true });

afterAll(cleanupRepos);

const base: RunOptions = {
  engine: 'mock',
  engines: { mock: new MockEngine(() => '') },
};

describe('tournament (branch-and-select)', () => {
  it('runs N candidates in isolated worktrees and lands only the winner', async () => {
    vi.mocked(execa).mockClear();
    const repo = await tmpRepo();
    const dirs: string[] = [];
    const job = tournament({
      name: 'approach',
      n: 3,
      candidate: (i) =>
        fnJob(`cand-${i}`, async (ctx) => {
          dirs.push(ctx.workspace.dir);
          write(ctx.workspace.dir, 'result.txt', `candidate ${i}\n`);
          return { status: 'pass', summary: `cand ${i}`, data: { score: i } };
        }),
      // candidate 2 has the highest score
      judge: (o) => (o.data as { score: number }).score,
    });

    const { outcome } = await run(job, { ...base, cwd: repo });
    let failureDetail: string | undefined;
    if (outcome.status !== 'pass') {
      const executions = await Promise.allSettled(
        vi.mocked(execa).mock.results.map((result) => result.value),
      );
      failureDetail = JSON.stringify({
        outcome,
        gitFailures: executions.flatMap((execution) => {
          const result = execution.status === 'fulfilled' ? execution.value : execution.reason;
          return result?.exitCode ? [{
            command: result.command, exitCode: result.exitCode,
            stdout: result.stdout, stderr: result.stderr,
          }] : [];
        }),
      });
    }
    expect(outcome.status, failureDetail).toBe('pass');
    expect((outcome.data as { winner: number }).winner).toBe(2);

    // each candidate ran in its OWN worktree, none the shared repo
    expect(new Set(dirs).size).toBe(3);
    expect(dirs).not.toContain(repo);

    // only the winner's work landed on the line
    expect(readFileSync(join(repo, 'result.txt'), 'utf8')).toContain('candidate 2');
    // and the loser branches were cleaned up
    const { stdout } = await execa('git', ['log', '--format=%s'], { cwd: repo });
    expect(stdout.split('\n').some((s) => /land candidate 2/.test(s))).toBe(true);
  });

  it('a paused candidate propagates the pause instead of flattening it into a loss', async () => {
    const repo = await tmpRepo();
    const job = tournament({
      name: 'gated',
      n: 2,
      candidate: (i) =>
        i === 0
          ? fnJob('paused', async () => ({
              status: 'paused',
              summary: 'waiting for an outside decision',
            }))
          : fnJob('c1', async (ctx) => {
              write(ctx.workspace.dir, 'result.txt', 'candidate 1\n');
              return { status: 'pass', data: { score: 1 } };
            }),
      judge: () => 1,
    });
    const { outcome } = await run(job, { ...base, cwd: repo });
    // The deliberate halt outranks the win: nothing lands past an
    // unacknowledged gate, and the root sees `paused` (exit 75), not a fail.
    expect(outcome.status).toBe('paused');
    expect(outcome.summary).toContain('waiting for an outside decision');
    expect(existsSync(join(repo, 'result.txt'))).toBe(false);
  });

  it('fails when no candidate passes', async () => {
    const repo = await tmpRepo();
    const job = tournament({
      name: 'all-fail',
      n: 2,
      candidate: (i) => fnJob(`c${i}`, async () => ({ status: 'fail' })),
      judge: () => 1,
    });
    const { outcome } = await run(job, { ...base, cwd: repo });
    expect(outcome.status).toBe('fail');
  });

  it('requires a git repo', async () => {
    const bare = tmpBareDir();
    const job = tournament({
      name: 't',
      n: 1,
      candidate: () => fnJob('c', async () => ({ status: 'pass', data: { score: 1 } })),
      judge: () => 1,
    });
    const { outcome } = await run(job, { ...base, cwd: bare });
    expect(outcome.status).toBe('fail');
    expect(outcome.error?.code).toBe('CONFIG');
  });
});
