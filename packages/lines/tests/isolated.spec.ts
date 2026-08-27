import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run, isolated, fnJob } from '../src/api.ts';
import type { RunOptions } from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';
import { tmpRepo, write, cleanupRepos } from './git-helpers.ts';

afterAll(cleanupRepos);

const base: RunOptions = {
  engine: 'mock',
  engines: { mock: new MockEngine(() => '') },
};

describe('isolated() — worktree as a composable Job wrapper', () => {
  it('runs the job in its own worktree and lands work back on pass', async () => {
    const repo = await tmpRepo();
    let ranIn = '';
    const job = isolated(
      fnJob('build', async (ctx) => {
        ranIn = ctx.workspace.dir;
        write(ctx.workspace.dir, 'out.ts', 'built\n');
        return { status: 'pass', summary: 'built' };
      }),
      { label: 'build' },
    );
    const { outcome } = await run(job, { ...base, cwd: repo });
    expect(outcome.status).toBe('pass');
    expect(ranIn).not.toBe(repo); // ran in a worktree, not the shared repo
    expect(existsSync(join(repo, 'out.ts'))).toBe(true); // landed back into the parent
  });

  it('degrades to the shared workspace when not a git repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lines-noniso-'));
    let ranIn = '';
    const job = isolated(
      fnJob('x', async (ctx) => {
        ranIn = ctx.workspace.dir;
        return { status: 'pass' };
      }),
    );
    const { outcome } = await run(job, { ...base, cwd: dir });
    expect(outcome.status).toBe('pass');
    expect(ranIn).toBe(dir); // ran in place, no worktree
  });

  it('does not land work back when the job fails', async () => {
    const repo = await tmpRepo();
    const job = isolated(
      fnJob('build', async (ctx) => {
        write(ctx.workspace.dir, 'bad.ts', 'x\n');
        return { status: 'fail', summary: 'nope' };
      }),
    );
    const { outcome } = await run(job, { ...base, cwd: repo });
    expect(outcome.status).toBe('fail');
    expect(existsSync(join(repo, 'bad.ts'))).toBe(false); // discarded with the worktree
  });
});
