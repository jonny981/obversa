import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdirSync, realpathSync } from 'node:fs';

import {
  isRepo,
  currentBranch,
  gitRoot,
  headSha,
  stageAll,
  hasStagedChanges,
  isDirty,
  commit,
} from '../src/core/git.ts';
import { tmpRepo, tmpBareDir, write, cleanupRepos } from './git-helpers.ts';

// Real work: these tests create temporary Git repositories and write files
// to disk, so this file declares its own time limit; the suite default is a
// hang guard, not a speed bar.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

afterAll(cleanupRepos);

describe('git substrate', () => {
  it('detects a repo and reports the branch + head', async () => {
    const repo = await tmpRepo();
    expect(await isRepo({ cwd: repo })).toBe(true);
    expect(await currentBranch({ cwd: repo })).toBe('main');
    expect(await headSha({ cwd: repo })).toBeTruthy();
  });

  it('reports a non-repo directory as not a repo', async () => {
    const bare = tmpBareDir();
    expect(await isRepo({ cwd: bare })).toBe(false);
    expect(await currentBranch({ cwd: bare })).toBeUndefined();
    expect(await gitRoot({ cwd: bare })).toBeUndefined();
  });

  it('reports the git top-level from a subdirectory', async () => {
    const repo = await tmpRepo();
    mkdirSync(`${repo}/nested`);
    expect(await gitRoot({ cwd: `${repo}/nested` })).toBe(realpathSync(repo));
  });

  it('stages and reports staged + dirty state', async () => {
    const repo = await tmpRepo();
    expect(await hasStagedChanges({ cwd: repo })).toBe(false);
    expect(await isDirty({ cwd: repo })).toBe(false);
    write(repo, 'a.txt', 'one\n');
    expect(await isDirty({ cwd: repo })).toBe(true);
    expect(await hasStagedChanges({ cwd: repo })).toBe(false);
    await stageAll({ cwd: repo });
    expect(await hasStagedChanges({ cwd: repo })).toBe(true);
  });

  it('commits the staged index and returns a sha', async () => {
    const repo = await tmpRepo();
    write(repo, 'a.txt', 'one\n');
    await stageAll({ cwd: repo });
    const sha = await commit({ subject: 'feat: a' }, { cwd: repo });
    expect(sha).toBeTruthy();
    expect(await hasStagedChanges({ cwd: repo })).toBe(false);
  });

  it('returns undefined when there is nothing to commit', async () => {
    const repo = await tmpRepo();
    const sha = await commit({ subject: 'feat: noop' }, { cwd: repo });
    expect(sha).toBeUndefined();
  });
});
