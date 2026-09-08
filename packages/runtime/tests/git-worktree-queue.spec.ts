import { mkdtemp, readFile, realpath, rm, watch, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addWorktree, removeWorktree } from '../src/core/git.js';
import { cleanupRepos, tmpRepo } from './git-helpers.js';

// Real work: these tests create temporary Git repositories and write files
// to disk, so this file declares its own time limit; the suite default is a
// hang guard, not a speed bar.
const TEST_TIMEOUT_MS = 30_000;
const ENTERED_TIMEOUT_MS = 20_000;
vi.setConfig({ testTimeout: TEST_TIMEOUT_MS, hookTimeout: TEST_TIMEOUT_MS });

let control: string;
let realGit: string;

beforeEach(async () => {
  control = await realpath(await mkdtemp(join(tmpdir(), 'obversa-worktree-queue-')));
  realGit = (await execa('which', ['git'])).stdout;
  await writeFile(join(control, 'git'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const realGit = ${JSON.stringify(realGit)};
const control = ${JSON.stringify(control)};
const metadata = args[0] === 'worktree' && ['add', 'remove'].includes(args[1]);
async function main() {
  let lock;
  if (metadata) {
    const common = spawnSync(realGit, ['rev-parse', '--git-common-dir'], { encoding: 'utf8' });
    if (common.status !== 0) process.exit(common.status ?? 1);
    const key = fs.realpathSync(path.resolve(common.stdout.trim()));
    fs.appendFileSync(path.join(control, 'commands'), JSON.stringify({ repo: path.dirname(key), args }) + '\\n');
    lock = path.join(control, crypto.createHash('sha256').update(key).digest('hex'));
    try { fs.mkdirSync(lock); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      fs.appendFileSync(path.join(control, 'overlap'), JSON.stringify({ key, args }) + '\\n');
      console.error('fixture refused overlapping worktree metadata commands');
      process.exit(128);
    }
    if (args.includes('held')) {
      fs.writeFileSync(path.join(control, 'entered'), key);
      await new Promise((resolve) => {
        const watcher = fs.watch(control, () => {
          if (fs.existsSync(path.join(control, 'release'))) { watcher.close(); resolve(); }
        });
        if (fs.existsSync(path.join(control, 'release'))) { watcher.close(); resolve(); }
      });
    }
  }
  try {
    const result = spawnSync(realGit, args, { stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
  } finally { if (lock) fs.rmdirSync(lock); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
`, { mode: 0o755 });
  vi.stubEnv('PATH', `${control}:${process.env.PATH ?? ''}`);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (existsSync(join(control, 'commands'))) {
    for (const line of (await readFile(join(control, 'commands'), 'utf8')).trim().split('\n')) {
      const { repo, args } = JSON.parse(line) as { repo: string; args: string[] };
      if (args[1] !== 'add') continue;
      const directory = args[4]!;
      await execa(realGit, ['worktree', 'remove', '--force', directory], { cwd: repo, reject: false });
      await rm(directory, { recursive: true, force: true });
    }
  }
  cleanupRepos();
  await rm(control, { recursive: true, force: true });
});

async function entered(): Promise<void> {
  const events = watch(control, { signal: AbortSignal.timeout(ENTERED_TIMEOUT_MS) })[Symbol.asyncIterator]();
  try {
    if (existsSync(join(control, 'entered'))) return;
    while (!(await events.next()).done) {
      if (existsSync(join(control, 'entered'))) return;
    }
  } finally { await events.return?.(); }
}

async function withinDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('unrelated repository waited for the held repository')), 2000);
  });
  try { return await Promise.race([promise, deadline]); }
  finally { clearTimeout(timer!); }
}

describe('Git worktree metadata queues', () => {
  it('serializes adds through linked checkouts while another repository progresses', async () => {
    const repo = await tmpRepo();
    const otherRepo = await tmpRepo();
    const linked = await addWorktree(repo, { branch: 'linked' });
    const first = addWorktree(repo, { branch: 'held' });
    let second: ReturnType<typeof addWorktree> | undefined;
    let unrelated: ReturnType<typeof addWorktree> | undefined;
    let results: Promise<PromiseSettledResult<Awaited<typeof first>>[]> | undefined;
    try {
      await entered();
      second = addWorktree(linked.dir, { branch: 'second' });
      unrelated = addWorktree(otherRepo, { branch: 'independent' });
      results = Promise.allSettled([first, second, unrelated]);
      const independent = await withinDeadline(unrelated);
      expect(await readFile(join(independent.dir, 'README.md'), 'utf8')).toBe('# test\n');
    } finally {
      await writeFile(join(control, 'release'), 'release');
      await (results ?? Promise.allSettled([first]));
    }
    const settled = await results!;
    expect(settled.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    for (const result of settled) {
      if (result.status === 'fulfilled') expect(await readFile(join(result.value.dir, 'README.md'), 'utf8')).toBe('# test\n');
    }
    expect(existsSync(join(control, 'overlap'))).toBe(false);
  });

  it('shares the same repository queue between an add and a removal', async () => {
    const repo = await tmpRepo();
    const otherRepo = await tmpRepo();
    const removed = await addWorktree(repo, { branch: 'removed' });
    const first = addWorktree(repo, { branch: 'held' });
    let results: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await entered();
      const removal = removeWorktree(repo, removed.dir);
      const unrelated = addWorktree(otherRepo, { branch: 'independent' });
      results = Promise.allSettled([first, removal, unrelated]);
      await withinDeadline(unrelated);
    } finally {
      await writeFile(join(control, 'release'), 'release');
      await (results ?? Promise.allSettled([first]));
    }
    expect((await results!).map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    expect(existsSync(removed.dir)).toBe(false);
    expect(existsSync(join(control, 'overlap'))).toBe(false);
  });

  it('releases the repository queue after a real invalid-ref add fails', async () => {
    const repo = await tmpRepo();
    const otherRepo = await tmpRepo();
    const first = addWorktree(repo, { branch: 'held', base: 'missing-ref' });
    let results: Promise<PromiseSettledResult<Awaited<typeof first>>[]> | undefined;
    try {
      await entered();
      const next = addWorktree(repo, { branch: 'next' });
      const unrelated = addWorktree(otherRepo, { branch: 'independent' });
      results = Promise.allSettled([first, next, unrelated]);
      await withinDeadline(unrelated);
    } finally {
      await writeFile(join(control, 'release'), 'release');
    }
    const settled = await withinDeadline(results!);
    expect(settled[0]).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringMatching(/git worktree add failed \(exit [1-9]\d*\)/) }) });
    expect(settled[1]?.status).toBe('fulfilled');
    if (settled[1]?.status === 'fulfilled') {
      expect(await readFile(join(settled[1].value.dir, 'README.md'), 'utf8')).toBe('# test\n');
    }
    expect(existsSync(join(control, 'overlap'))).toBe(false);
  });
});
