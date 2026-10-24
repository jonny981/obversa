/**
 * A fresh run with `carryFrom` reads the earlier run's open findings and
 * accepted proofs, and keeps the earlier record beside the new one. A
 * proof stands until a file it covers changes. A passed run with `commit`
 * commits its own work with the named step's message and its trailers; a
 * hook that refuses leaves the work uncommitted, and the run still passes.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { acceptProofs, dag, fnJob, review, reviewPanel, run, standingProofs, workspaceTree, type CarriedWork, type JobContext } from '../src/api.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): { cwd: string; git: (...args: string[]) => string } {
  const cwd = mkdtempSync(join(tmpdir(), 'carry-commit-'));
  dirs.push(cwd);
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  // The person's own hooks stay out of the test repository.
  mkdirSync(join(cwd, '.hooks'));
  git('config', 'core.hooksPath', join(cwd, '.hooks'));
  writeFileSync(join(cwd, '.gitignore'), 'records/\n.hooks/\n');
  writeFileSync(join(cwd, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(cwd, 'b.ts'), 'export const b = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { cwd, git };
}

describe('carryFrom', () => {
  it("hands a fresh run the earlier run's open findings and accepted proofs, and keeps the earlier record", async () => {
    const { cwd } = repo();
    const record = join(cwd, 'records', 'run.jsonl');
    // The earlier run: a proof accepted on this tree, and a review that ended with a block open.
    const tree = await workspaceTree({ cwd });
    const earlier = dag({
      name: 'deliver',
      nodes: {
        build: { refine: review({ rounds: 0 }), job: fnJob('build', () => 'built') },
        proof: { needs: ['build'], job: fnJob('proof', (ctx) => ({ status: 'pass', data: { acceptedProofs: acceptProofs(ctx, [{ item: 'proof 2', tree: tree!, files: ['a.ts'] }]) } })) },
        review: {
          needs: ['proof'], sendsBackTo: ['build'],
          job: reviewPanel({ label: 'review', target: 'build', reviewers: [{ name: 'r', job: fnJob('r', () => ({ status: 'fail', revision: { target: 'build', reason: 'no', findings: [{ severity: 'block', evidence: 'a.ts:1 still wrong' }] } })) }] }),
        },
      },
    });
    const first = await run(earlier, { cwd, recordTo: record });
    expect(first.outcome.status).toBe('fail');

    let carried: CarriedWork | undefined;
    const second = await run(fnJob('look', (ctx) => { carried = ctx.carried; }), { cwd, recordTo: record, carryFrom: record });

    expect(second.outcome.status).toBe('pass');
    expect(carried?.openFindings.map((finding) => finding.evidence)).toEqual(['a.ts:1 still wrong']);
    expect(carried?.acceptedProofs).toEqual([{ item: 'proof 2', tree, files: ['a.ts'] }]);
    expect(carried?.ended).toMatchObject({ node: 'review', status: 'fail' });
    const kept = readdirSync(join(cwd, 'records')).filter((name) => /^run-\d{4}-.*\.jsonl$/.test(name));
    expect(kept).toHaveLength(1);
    expect(carried?.record).toBe(join(cwd, 'records', kept[0]!));
  });

  it('keeps a proof while the files it covers are unchanged, and asks again once one changes', async () => {
    const { cwd } = repo();
    const ctx = { state: {}, carried: undefined } as unknown as JobContext;
    const accepted = await workspaceTree({ cwd });
    acceptProofs(ctx, [{ item: 'covers a', tree: accepted!, files: ['a.ts'] }, { item: 'covers b', tree: accepted!, files: ['b.ts'] }]);

    writeFileSync(join(cwd, 'b.ts'), 'export const b = 2;\n');
    const now = await workspaceTree({ cwd });
    const { standing, changed } = await standingProofs([{ item: 'covers a', tree: accepted!, files: ['a.ts'] }, { item: 'covers b', tree: accepted!, files: ['b.ts'] }], now!, { cwd });

    expect(standing.map((proof) => proof.item)).toEqual(['covers a']);
    expect(changed.map((proof) => proof.item)).toEqual(['covers b']);
  });
});

describe('commit', () => {
  const graph = (message: string) => dag({
    name: 'deliver',
    commit: { from: 'report' },
    nodes: {
      report: { job: fnJob('report', () => ({ status: 'pass', data: `Done.\n\n\`\`\`commit\n${message}\n\`\`\`\n` })) },
    },
  });

  it("commits a passed run's work with the step's message and the run's trailer", async () => {
    const { cwd, git } = repo();
    writeFileSync(join(cwd, 'a.ts'), 'export const a = 2;\n');
    const record = join(cwd, 'records', 'run.jsonl');

    const { outcome } = await run(graph('feat(a): raise a to two\n\nThe caller needs two.'), { cwd, recordTo: record });

    expect(outcome.status).toBe('pass');
    expect(outcome.commit).toEqual({ sha: git('rev-parse', 'HEAD') });
    expect(git('log', '-1', '--format=%B')).toBe('feat(a): raise a to two\n\nThe caller needs two.\n\nRun: run');
    expect(git('status', '--porcelain')).toBe('');
  });

  it('leaves the work uncommitted when a hook refuses, and the run still passes and says why', async () => {
    const { cwd, git } = repo();
    const hook = join(cwd, '.hooks', 'commit-msg');
    writeFileSync(hook, '#!/bin/sh\necho "commits are closed at this hour" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    writeFileSync(join(cwd, 'a.ts'), 'export const a = 2;\n');
    const base = git('rev-parse', 'HEAD');

    const { outcome } = await run(graph('feat(a): raise a to two'), { cwd });

    expect(outcome.status).toBe('pass');
    expect(git('rev-parse', 'HEAD')).toBe(base);
    expect(outcome.commit).toEqual({ uncommitted: expect.stringContaining('commits are closed at this hour') });
    expect(outcome.summary).toContain('left uncommitted: git commit was refused');
    expect(existsSync(join(cwd, 'a.ts'))).toBe(true);
    expect(git('diff', 'HEAD', '--stat')).toContain('a.ts');
  });
});
