import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { execFileSync, fork } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run, dag, isolated, tournament, fnJob, kickback } from '../src/api.ts';
import type { LoopEvent, RunOptions } from '../src/api.ts';
import { addWorktree } from '../src/core/git.ts';
import { MockEngine } from '../src/testing.ts';
import { tmpRepo, write, cleanupRepos } from './git-helpers.ts';

// Real work: these tests create temporary Git repositories, write files to
// disk and start a child process, so this file declares its own time limit;
// the suite default is a hang guard, not a speed bar.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

afterAll(cleanupRepos);
afterEach(() => { vi.unstubAllEnvs(); });

const base: RunOptions = {
  engine: 'mock',
  engines: { mock: new MockEngine(() => '') },
};

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const forkBranches = (repo: string) =>
  git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/lines/').split('\n').filter(Boolean);
const worktrees = (repo: string) =>
  git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '));

describe('a run cleans up the forks it made', () => {
  it('removes the branch of an isolated step that fails, and records the commits it threw away', async () => {
    const repo = await tmpRepo();
    let made = '';
    let branch = '';
    const job = isolated(
      fnJob('build', async (ctx) => {
        branch = ctx.workspace.branch!;
        write(ctx.workspace.dir, 'out.txt', 'half done\n');
        git(ctx.workspace.dir, 'add', 'out.txt');
        git(ctx.workspace.dir, 'commit', '--quiet', '-m', 'wip');
        made = git(ctx.workspace.dir, 'rev-parse', 'HEAD');
        return { status: 'fail', summary: 'the build broke' };
      }),
      { label: 'build' },
    );

    const { outcome } = await run(job, { ...base, cwd: repo });

    expect(outcome.status).toBe('fail');
    expect(forkBranches(repo)).toEqual([]);
    expect(worktrees(repo)).toHaveLength(1);
    expect(branch).toMatch(/^lines\/build-/);
    expect(outcome.discarded).toEqual([{ branch, sha: made }]);
  });

  it('keeps the branch of an isolated step that commits and then throws, and says so', async () => {
    const repo = await tmpRepo();
    let made = '';
    let branch = '';
    const events: LoopEvent[] = [];
    const job = isolated(async (ctx) => {
      branch = ctx.workspace.branch!;
      write(ctx.workspace.dir, 'out.txt', 'half done\n');
      git(ctx.workspace.dir, 'add', 'out.txt');
      git(ctx.workspace.dir, 'commit', '--quiet', '-m', 'wip');
      made = git(ctx.workspace.dir, 'rev-parse', 'HEAD');
      throw new Error('the step broke after committing');
    }, { label: 'build' });

    const { outcome } = await run(job, { ...base, cwd: repo, onEvent: (event) => events.push(event) });

    expect(outcome.status).not.toBe('pass');
    expect(forkBranches(repo)).toEqual([branch]);
    expect(git(repo, 'rev-parse', branch)).toBe(made);
    expect(JSON.stringify(events)).toContain(`kept the branch ${branch}`);
  });

  it('keeps the branch of an isolated dag node that commits and then throws', async () => {
    const repo = await tmpRepo();
    let made = '';
    let branch = '';
    const job = dag({
      name: 'trio',
      nodes: {
        build: {
          isolate: true,
          job: async (ctx) => {
            branch = ctx.workspace.branch!;
            write(ctx.workspace.dir, 'out.txt', 'half done\n');
            git(ctx.workspace.dir, 'add', 'out.txt');
            git(ctx.workspace.dir, 'commit', '--quiet', '-m', 'wip');
            made = git(ctx.workspace.dir, 'rev-parse', 'HEAD');
            throw new Error('the node broke after committing');
          },
        },
      },
    });

    const { outcome } = await run(job, { ...base, cwd: repo });

    expect(outcome.status).not.toBe('pass');
    expect(forkBranches(repo)).toEqual([branch]);
    expect(git(repo, 'rev-parse', branch)).toBe(made);
  });

  it('leaves no fork after a review sends a dag node back', async () => {
    const repo = await tmpRepo();
    let reviews = 0;
    const { outcome } = await run(dag({
      name: 'ship',
      isolation: 'worktree',
      maxKickbacks: 1,
      nodes: {
        build: fnJob('build', async (ctx) => {
          write(ctx.workspace.dir, 'out.txt', `build ${reviews}\n`);
          return { status: 'pass' };
        }),
        review: {
          needs: ['build'],
          job: fnJob('review', async () => {
            reviews += 1;
            return reviews === 1 ? kickback('build', 'tighten it') : { status: 'pass' };
          }),
        },
      },
    }), { ...base, cwd: repo });

    expect(outcome.status).toBe('pass');
    expect(reviews).toBe(2);
    expect(forkBranches(repo)).toEqual([]);
    expect(worktrees(repo)).toHaveLength(1);
  });

  it('removes the losing candidates of a tournament and records what each one threw away', async () => {
    const repo = await tmpRepo();
    const { outcome } = await run(tournament({
      name: 'approach',
      n: 3,
      candidate: (i) => fnJob(`cand-${i}`, async (ctx) => {
        write(ctx.workspace.dir, 'result.txt', `candidate ${i}\n`);
        return { status: 'pass', data: { score: i } };
      }),
      judge: (o) => (o.data as { score: number }).score,
    }), { ...base, cwd: repo });

    expect(outcome.status).toBe('pass');
    expect(forkBranches(repo)).toEqual([]);
    expect(worktrees(repo)).toHaveLength(1);
    expect(outcome.discarded?.map((fork) => fork.branch)).toEqual([
      'lines/approach-cand-0',
      'lines/approach-cand-1',
    ]);
    // Each recorded sha still names the losing candidate's own work.
    expect(outcome.discarded?.map((fork) => git(repo, 'show', `${fork.sha}:result.txt`))).toEqual([
      'candidate 0',
      'candidate 1',
    ]);
  });

  it('keeps the worktree and branch of an isolated attempt whose process died', async () => {
    const repo = await tmpRepo();
    const child = fork(fileURLToPath(new URL('./fork-cleanup-crash-fixture.ts', import.meta.url)), [repo], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      execArgv: ['--import', import.meta.resolve('tsx')],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const closed = new Promise<NodeJS.Signals | null>((resolve) => {
      child.once('close', (_code, signal) => resolve(signal));
    });
    const dir = await new Promise<string>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => reject(new Error(`fixture exited early (${code}/${signal}): ${stderr}`)));
      child.once('message', (message) => resolve(String(message)));
    });
    child.kill('SIGKILL');
    expect(await closed).toBe('SIGKILL');

    expect(forkBranches(repo)).toEqual(['lines/build-1']);
    expect(worktrees(repo)).toHaveLength(2);
    expect(existsSync(join(dir, 'out.txt'))).toBe(true);
    git(repo, 'worktree', 'remove', '--force', dir);
  });

  it('removes the folder it made when git cannot add the worktree', async () => {
    const repo = await tmpRepo();
    git(repo, 'branch', 'taken');
    const temp = mkdtempSync(join(tmpdir(), 'obversa-fork-temp-'));
    vi.stubEnv('TMPDIR', temp);

    await expect(addWorktree(repo, { branch: 'taken' })).rejects.toThrow(/git worktree add failed/);

    expect(readdirSync(temp)).toEqual([]);
  });

  it('logs a cleanup that fails as a warning and keeps the step outcome', async () => {
    const repo = await tmpRepo();
    let dir = '';
    let branch = '';
    const events: LoopEvent[] = [];
    const job = isolated(
      fnJob('build', async (ctx) => {
        dir = ctx.workspace.dir;
        branch = ctx.workspace.branch!;
        // A locked worktree refuses a single forced removal.
        git(repo, 'worktree', 'lock', dir);
        return { status: 'fail', summary: 'the build broke' };
      }),
      { label: 'build' },
    );

    const { outcome } = await run(job, { ...base, cwd: repo, onEvent: (event) => events.push(event) });

    expect(outcome).toMatchObject({ status: 'fail', summary: 'the build broke' });
    const warnings = events.filter((event): event is Extract<LoopEvent, { kind: 'log' }> =>
      event.kind === 'log' && event.level === 'warn');
    expect(warnings.map((event) => event.message)).toEqual([
      expect.stringContaining(`could not remove the worktree ${dir}`),
      expect.stringContaining(`could not delete the branch ${branch}`),
    ]);
    git(repo, 'worktree', 'unlock', dir);
    git(repo, 'worktree', 'remove', '--force', dir);
  });
});
