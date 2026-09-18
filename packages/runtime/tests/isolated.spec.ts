import { describe, it, expect, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run, isolated, fnJob } from '../src/api.ts';
import type { RunOptions } from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';
import { tmpRepo, write, cleanupRepos } from './git-helpers.ts';

// Real work: these tests create temporary Git repositories and write files
// to disk, so this file declares its own time limit; the suite default is a
// hang guard, not a speed bar.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

afterAll(cleanupRepos);

const base: RunOptions = {
  engine: 'mock',
  engines: { mock: new MockEngine(() => '') },
};

describe('isolated() — worktree as a composable Job wrapper', () => {
  // A recorder that reports what it was asked and what it was told, so a test
  // can see the seam rather than infer it from a commit body alone.
  const recorderSpy = (message = { subject: 'feat(build): the change', body: '## Why\n\nbecause' }) => {
    const seen: string[] = [];
    const commits: string[] = [];
    return {
      seen,
      commits,
      asked: () => commits.length,
      observe(event: { kind: string; path?: readonly string[]; delta?: string }) {
        if (event.kind === 'engine:text' && typeof event.delta === 'string') seen.push(event.delta);
      },
      async message() { return message; },
      committed(sha: string) { commits.push(sha); },
    };
  };

  it('puts the composed message on the commit that carries the change', async () => {
    const repo = await tmpRepo();
    const record = recorderSpy();
    const job = isolated(
      fnJob('build', async (ctx) => {
        write(ctx.workspace.dir, 'out.ts', 'built\n');
        return { status: 'pass', summary: 'built' };
      }),
      { label: 'build', record },
    );

    const { outcome } = await run(job, { ...base, cwd: repo });

    expect(outcome.status).toBe('pass');
    // The promise is that reasoning is attached to the thing it explains, so
    // the test asks the way a reader would: blame the changed line, then read
    // that commit's body. The branch's own tip is the merge, which is why
    // reading the last commit would have proved nothing.
    const blamed = execFileSync('git', ['-C', repo, 'blame', '--porcelain', '-L', '1,1', 'out.ts'], { encoding: 'utf8' })
      .split('\n')[0]!
      .split(' ')[0]!;
    const body = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%B', blamed], { encoding: 'utf8' });
    expect(body).toContain('feat(build): the change');
    expect(body).toContain('because');
    // Told the commit exists, so the next iteration does not inherit these turns.
    expect(record.asked()).toBe(1);
  });

  it('refuses a stage that asked to record where there is no repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'obversa-isolated-plain-'));
    const record = recorderSpy();
    const job = isolated(fnJob('build', async () => ({ status: 'pass', summary: 'built' })), {
      label: 'build',
      record,
    });

    const { outcome } = await run(job, { ...base, cwd: plain });

    // Without a record this runs in place and passes; with one there is no
    // commit for the reasoning, and dropping the opt-in in silence is the
    // outcome the design forbids.
    expect(outcome.status).toBe('fail');
    expect(outcome.summary).toContain('not a git repository');
    expect(outcome.summary).toContain('build');
  });

  it('fails a recording stage that committed its own work, rather than merging it unexplained', async () => {
    const repo = await tmpRepo();
    const record = recorderSpy();
    const job = isolated(
      fnJob('build', async (ctx) => {
        write(ctx.workspace.dir, 'out.ts', 'built\n');
        execFileSync('git', ['-C', ctx.workspace.dir, 'add', '-A']);
        execFileSync('git', ['-C', ctx.workspace.dir, 'commit', '--quiet', '-m', 'the job committed this itself']);
        return { status: 'pass', summary: 'built' };
      }),
      { label: 'build', record },
    );

    const { outcome } = await run(job, { ...base, cwd: repo });

    expect(outcome.status).toBe('fail');
    expect(outcome.summary).toContain('committed its own work');
    expect(record.asked()).toBe(0);
  });

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
