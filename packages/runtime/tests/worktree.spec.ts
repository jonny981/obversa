import { describe, it, expect, afterAll, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';

import { run, dag, fnJob, isolated } from '../src/api.ts';
import * as git from '../src/core/git.ts';
import type { RunOptions, Outcome } from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';
import { tmpRepo, tmpBareDir, write, cleanupRepos } from './git-helpers.ts';

afterAll(cleanupRepos);

const base: RunOptions = {
  engine: 'mock',
  engines: { mock: new MockEngine(() => '') },
};

describe('dag worktree isolation (branches-as-teams)', () => {
  it.each(['dag', 'wrapper'] as const)('serialises three simultaneous %s land-backs through real Git', async (mode) => {
    const repo = await tmpRepo();
    const names = ['one', 'two', 'three'];
    const directories: string[] = [];
    let ready = 0;
    let finishTogether!: () => void;
    const finished = new Promise<void>((resolve) => { finishTogether = resolve; });
    let committed = 0;
    let allCommitted!: () => void;
    const captured = new Promise<void>((resolve) => { allCommitted = resolve; });
    const commit = git.commit;
    const mergeBranch = git.mergeBranch;
    let activeMerges = 0;
    let maximumMerges = 0;
    const boundaries: string[] = [];
    const commitObserver = vi.spyOn(git, 'commit').mockImplementation(async (...args) => {
      const result = await commit(...args);
      committed += 1;
      if (committed === names.length) allCommitted();
      return result;
    });
    const mergeObserver = vi.spyOn(git, 'mergeBranch').mockImplementation(async (...args) => {
      activeMerges += 1;
      maximumMerges = Math.max(maximumMerges, activeMerges);
      boundaries.push('start');
      try {
        await captured;
        return await mergeBranch(...args);
      } finally {
        boundaries.push('end');
        activeMerges -= 1;
      }
    });
    try {
      const nodes = Object.fromEntries(names.map((name) => {
        const job = fnJob(name, async (ctx) => {
          directories.push(ctx.workspace.dir);
          write(ctx.workspace.dir, `${name}.ts`, `${name}\n`);
          ready += 1;
          if (ready === names.length) finishTogether();
          await finished;
          return { status: 'pass' };
        });
        return [name, mode === 'wrapper' ? isolated(job, { label: name }) : job];
      }));
      const { outcome } = await run(dag({
        name: 'contention', nodes, concurrency: 3, stopOnError: false,
        ...(mode === 'dag' ? { isolation: 'worktree' as const } : {}),
      }), { ...base, cwd: repo });

      expect(maximumMerges).toBe(1);
      expect(boundaries).toEqual(['start', 'end', 'start', 'end', 'start', 'end']);
      expect(outcome.status).toBe('pass');
      expect(new Set(directories).size).toBe(3);
      expect(directories).not.toContain(repo);
      for (const name of names) expect(readFileSync(join(repo, `${name}.ts`), 'utf8')).toBe(`${name}\n`);
      const { stdout } = await execa('git', ['log', '--first-parent', '--merges', '--format=%H'], { cwd: repo });
      expect(stdout.split('\n')).toHaveLength(3);
      expect((await execa('git', ['status', '--porcelain'], { cwd: repo })).stdout).toBe('');
    } finally {
      commitObserver.mockRestore();
      mergeObserver.mockRestore();
    }
  });

  it('shares the workspace when isolation is off', async () => {
    const repo = await tmpRepo();
    let seenDir = '';
    const job = dag({
      name: 'plain',
      nodes: {
        x: fnJob('x', async (ctx) => {
          seenDir = ctx.workspace.dir;
          return { status: 'pass' };
        }),
      },
    });
    await run(job, { ...base, cwd: repo });
    expect(seenDir).toBe(repo);
  });

  it('runs isolated nodes in their own worktree and lands disjoint work back', async () => {
    const repo = await tmpRepo();
    const dirs: string[] = [];
    const job = dag({
      name: 'build',
      isolation: 'worktree',
      stopOnError: false,
      nodes: {
        api: fnJob('api', async (ctx) => {
          dirs.push(ctx.workspace.dir);
          write(ctx.workspace.dir, 'api.ts', 'api\n');
          return { status: 'pass', summary: 'api' };
        }),
        web: fnJob('web', async (ctx) => {
          dirs.push(ctx.workspace.dir);
          write(ctx.workspace.dir, 'web.ts', 'web\n');
          return { status: 'pass', summary: 'web' };
        }),
      },
    });
    const { outcome } = await run(job, { ...base, cwd: repo });
    expect(outcome.status).toBe('pass');

    // each node ran in its OWN dir, neither the shared repo
    expect(dirs).toHaveLength(2);
    expect(dirs[0]).not.toBe(dirs[1]);
    expect(dirs).not.toContain(repo);

    // both teams' disjoint work landed back into the line
    expect(existsSync(join(repo, 'api.ts'))).toBe(true);
    expect(existsSync(join(repo, 'web.ts'))).toBe(true);
    const { stdout } = await execa('git', ['log', '--format=%s'], { cwd: repo });
    expect(stdout.split('\n').filter((s) => s.startsWith('merge lines/build-'))).toHaveLength(2);
  });

  it('fails a node honestly on a merge conflict, leaving the line clean', async () => {
    const repo = await tmpRepo();
    const job = dag({
      name: 'clash',
      isolation: 'worktree',
      stopOnError: false,
      nodes: {
        a: fnJob('a', async (ctx) => {
          write(ctx.workspace.dir, 'shared.ts', 'A\n');
          return { status: 'pass' };
        }),
        b: fnJob('b', async (ctx) => {
          write(ctx.workspace.dir, 'shared.ts', 'B\n');
          return { status: 'pass' };
        }),
      },
    });
    const { outcome } = await run(job, { ...base, cwd: repo });

    // both forked from the same base and added the same file: exactly one lands,
    // the other conflicts and is failed honestly.
    const data = outcome.data as Record<string, Outcome>;
    const conflicts = Object.values(data).filter((o) =>
      /conflict/.test(o.summary ?? ''),
    );
    expect(conflicts.length).toBe(1);
    expect(outcome.status).toBe('fail');

    // the line is clean — no half-merged conflict markers
    const content = readFileSync(join(repo, 'shared.ts'), 'utf8');
    expect(content).not.toContain('<<<<<<<');
    expect(['A\n', 'B\n']).toContain(content);
  });

  it('degrades to the shared workspace (with a warning) outside a git repo', async () => {
    const bare = tmpBareDir();
    let seenDir = '';
    const job = dag({
      name: 'degrade',
      nodes: {
        x: {
          job: fnJob('x', async (ctx) => {
            seenDir = ctx.workspace.dir;
            return { status: 'pass' };
          }),
          isolate: true,
        },
      },
    });
    const { outcome } = await run(job, { ...base, cwd: bare });
    expect(outcome.status).toBe('pass');
    expect(seenDir).toBe(bare); // ran in the shared workspace, no fork
  });
});
