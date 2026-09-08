import { afterEach, describe, expect, it, vi } from 'vitest';
import { execa } from 'execa';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { runWorkspaceProviderConformance } from '../src/workspace/conformance.js';
import { createGitWorktreeProvider } from '../src/workspace/git-provider.js';
import type { WorkspaceAnchor } from '../src/workspace/provider.js';

// Real work: these tests create temporary Git repositories and write files
// to disk, so this file declares its own time limit; the suite default is a
// hang guard, not a speed bar.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const roots: string[] = [];

async function makeRepo(objectFormat: 'sha1' | 'sha256'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `obversa-d12-${objectFormat}-`));
  roots.push(dir);
  const init = await execa('git', ['init', '--object-format', objectFormat, '.'], {
    cwd: dir, reject: false,
  });
  if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr}`);
  await execa('git', ['config', 'user.email', 'devin@example.invalid'], { cwd: dir });
  await execa('git', ['config', 'user.name', 'devin test'], { cwd: dir });
  await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), '# one\n', 'utf8');
  await execa('git', ['add', 'README.md'], { cwd: dir });
  await execa('git', ['commit', '-m', 'first'], { cwd: dir });
  return dir;
}

async function writeFileAt(dir: string, path: string, text: string): Promise<void> {
  const target = join(dir, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, 'utf8');
}

async function commitFile(dir: string, path: string, text: string, message: string): Promise<void> {
  await writeFileAt(dir, path, text);
  await execa('git', ['add', path], { cwd: dir });
  await execa('git', ['commit', '-m', message], { cwd: dir });
}

async function headOf(dir: string): Promise<string> {
  const result = await execa('git', ['rev-parse', 'HEAD'], { cwd: dir });
  return result.stdout.trim();
}

async function statusOf(dir: string): Promise<string> {
  const result = await execa('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: dir, reject: false,
  });
  return result.stdout;
}

afterEach(async () => {
  for (const dir of roots.splice(0)) {
    const worktrees = join(dirname(dir), `${basename(dir)}.obversa-worktrees`);
    await rm(worktrees, { recursive: true, force: true }).catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('git worktree provider', () => {
  it('captures a read-only anchor including dirty and scoped untracked files', async () => {
    const dir = await makeRepo('sha1');
    await writeFile(join(dir, 'README.md'), '# one\n\ndirty line\n', 'utf8');
    await writeFileAt(dir, 'notes/scratch.md', 'untracked note\n');

    const before = await statusOf(dir);
    const provider = createGitWorktreeProvider({ repositoryPath: dir });
    const anchor = await provider.capture();
    const after = await statusOf(dir);

    expect(after).toBe(before);
    expect(await realpath(anchor.root)).toBe(await realpath(dir));
    expect(anchor.head).toBe(await headOf(dir));
    expect(anchor.files.map((file) => (file as { path: string }).path)).toContain('README.md');
    expect(anchor.files.map((file) => (file as { path: string }).path)).toContain('notes/scratch.md');
    expect(typeof anchor.fingerprint).toBe('string');
  });

  it('verifies an unchanged anchor and names drift precisely', async () => {
    const dir = await makeRepo('sha1');
    const provider = createGitWorktreeProvider({ repositoryPath: dir });
    const anchor = await provider.capture();
    expect(await provider.verify(anchor)).toEqual({ ok: true });

    // A non-committing unowned write to a tracked file is seen and named.
    await writeFile(join(dir, 'README.md'), '# one\n\ntampered\n', 'utf8');
    const dirty = await provider.verify(anchor);
    expect(dirty.ok).toBe(false);
    if (!dirty.ok) {
      const files = dirty.drift.find((item) => item.kind === 'files');
      expect(files && files.kind === 'files' && files.changedPaths).toContain('README.md');
    }

    // A new unowned untracked file inside the capture scope is seen too.
    await execa('git', ['checkout', '--', 'README.md'], { cwd: dir });
    const scoped = await provider.capture(['notes/**']);
    await writeFileAt(dir, 'notes/new.md', 'foreign\n');
    const untracked = await provider.verify(scoped);
    expect(untracked.ok).toBe(false);
    if (!untracked.ok) {
      const files = untracked.drift.find((item) => item.kind === 'files');
      expect(files && files.kind === 'files' && files.changedPaths).toContain('notes/new.md');
    }

    // A foreign commit moves the head and is named with the new head.
    await execa('git', ['clean', '-fd'], { cwd: dir });
    await commitFile(dir, 'extra.txt', 'extra\n', 'foreign');
    const drifted = await provider.verify(anchor);
    expect(drifted.ok).toBe(false);
    if (!drifted.ok) {
      const head = drifted.drift.find((item) => item.kind === 'head');
      expect(head && head.kind === 'head' && head.currentHead).toBe(await headOf(dir));
    }
  });

  it('forks at the anchored revision, writing only a new ref and a worktree registration', async () => {
    const dir = await makeRepo('sha1');
    await writeFileAt(dir, 'dirty.txt', 'user work in progress\n');
    const provider = createGitWorktreeProvider({ repositoryPath: dir });
    const anchor = await provider.capture();
    const statusBefore = await statusOf(dir);
    const headBefore = await headOf(dir);

    const lease = await provider.acquireLease('runner-a', 'run-1', anchor);
    expect(lease.ok).toBe(true);
    const forked = await provider.fork(anchor, 'child-1', lease.ok === true ? lease.token : '');
    expect(forked.ok).toBe(true);
    if (!forked.ok) return;
    expect(forked.branchRef).toBe('refs/heads/obversa/child-1');
    expect(await headOf(forked.worktreePath)).toBe(anchor.head);
    expect(forked.anchor.head).toBe(anchor.head);
    const symbolicHead = await execa('git', ['symbolic-ref', '--quiet', 'HEAD'], {
      cwd: forked.worktreePath,
      reject: false,
    });
    expect.soft({ exitCode: symbolicHead.exitCode, ref: symbolicHead.stdout.trim() }).toEqual({
      exitCode: 0,
      ref: forked.branchRef,
    });

    // The user's checkout, index, and dirty files are untouched.
    expect(await statusOf(dir)).toBe(statusBefore);
    expect(await headOf(dir)).toBe(headBefore);

    // The new ref points at the anchored revision.
    const ref = await execa(
      'git', ['show-ref', '--verify', '--hash', forked.branchRef], { cwd: dir, reject: false },
    );
    expect({ exitCode: ref.exitCode, oid: ref.stdout.trim() }).toEqual({
      exitCode: 0,
      oid: anchor.head,
    });

    // Work committed in the child advances the branch returned to the caller.
    await commitFile(forked.worktreePath, 'child.txt', 'child\n', 'advance child');
    const childHead = await headOf(forked.worktreePath);
    const advancedRef = await execa(
      'git', ['show-ref', '--verify', '--hash', forked.branchRef], { cwd: dir },
    );
    expect.soft({ childHead, refHead: advancedRef.stdout.trim() }).toEqual({
      childHead: expect.not.stringMatching(`^${anchor.head}$`),
      refHead: childHead,
    });

    // A second fork of the same child id fails instead of duplicating.
    const second = await provider.fork(anchor, 'child-1', lease.ok === true ? lease.token : '');
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.kind).toBe('exists');
  });

  it('refuses a pre-existing user branch with the child name', async () => {
    const dir = await makeRepo('sha1');
    await execa('git', ['branch', 'obversa/child-1', 'HEAD'], { cwd: dir });
    await commitFile(dir, 'later.txt', 'later\n', 'later');
    const provider = createGitWorktreeProvider({ repositoryPath: dir });
    const anchor = await provider.capture();
    const lease = await provider.acquireLease('runner-a', 'run-1', anchor);

    const forked = await provider.fork(
      anchor,
      'child-1',
      lease.ok === true ? lease.token : '',
    );

    expect(forked.ok).toBe(false);
    expect(forked.ok === false && forked.kind).toBe('exists');
  });

  it('refuses to fork a changed anchor before creating anything', async () => {
    const dir = await makeRepo('sha1');
    const provider = createGitWorktreeProvider({ repositoryPath: dir });
    const anchor = await provider.capture();
    await commitFile(dir, 'extra.txt', 'extra\n', 'foreign');

    const lease = await provider.acquireLease('runner-a', 'run-1', anchor);
    const forked = await provider.fork(anchor, 'child-1', lease.ok === true ? lease.token : '');
    expect(forked.ok).toBe(false);
    expect(forked.ok === false && forked.kind).toBe('anchor-changed');

    const branches = await execa('git', ['branch', '--list', 'obversa/child-1'], {
      cwd: dir, reject: false,
    });
    expect(branches.stdout.trim()).toBe('');
  });

  it('holds one writer per workspace and types the second claim', async () => {
    const dir = await makeRepo('sha1');
    const provider = createGitWorktreeProvider({ repositoryPath: dir });
    const anchor = await provider.capture();

    const first = await provider.acquireLease('runner-a', 'run-1', anchor);
    expect(first.ok).toBe(true);
    const token = first.ok === true ? first.token : '';

    const second = await provider.acquireLease('runner-b', 'run-2', anchor);
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.kind).toBe('held');
    expect(second.ok === false && second.kind === 'held' && second.owner).toBe('runner-a');

    const wrongRelease = await provider.releaseLease('not-the-token');
    expect(wrongRelease.ok).toBe(false);
    expect(wrongRelease.ok === false && wrongRelease.kind).toBe('not-owner');

    const released = await provider.releaseLease(token);
    expect(released).toEqual({ ok: true });

    const reclaimed = await provider.acquireLease('runner-b', 'run-2', anchor);
    expect(reclaimed.ok).toBe(true);

    const unknown = await provider.releaseLease('not-the-token');
    expect(unknown.ok).toBe(false);
    expect(unknown.ok === false && unknown.kind).toBe('not-owner');
  });

  it('types a corrupt final record and recovers it without stealing a live lease', async () => {
    const dir = await makeRepo('sha1');
    const provider = createGitWorktreeProvider({ repositoryPath: dir });
    const anchor = await provider.capture();

    // A partial blob is corrupt and cannot become a valid owner.
    const corrupt = (await execa(
      'git', ['hash-object', '-w', '--no-filters', '--stdin'],
      { cwd: dir, input: '{"owner":"dead-runner"' },
    )).stdout.trim();
    await execa('git', [
      'update-ref',
      '--no-deref',
      'refs/obversa/workspace-lease/v1/active',
      corrupt,
      '0'.repeat(corrupt.length),
    ], { cwd: dir });

    const claim = await provider.acquireLease('runner-b', 'run-1', anchor);
    expect(claim.ok).toBe(false);
    expect(claim.ok === false && claim.kind).toBe('incomplete');
    expect(claim.ok === false && claim.reason).toContain('recoverIncompleteLease');

    const recovered = await provider.recoverIncompleteLease();
    expect(recovered).toEqual({ ok: true });

    const acquired = await provider.acquireLease('runner-b', 'run-1', anchor);
    expect(acquired.ok).toBe(true);

    // A live lease is never stolen by recovery.
    const live = await provider.recoverIncompleteLease();
    expect(live.ok).toBe(false);
    expect(live.ok === false && live.kind).toBe('live');
  });

  it('keeps a lease readable across a linked worktree', async () => {
    const dir = await makeRepo('sha1');
    const provider = createGitWorktreeProvider({ repositoryPath: dir });
    const anchor = await provider.capture();
    const lease = await provider.acquireLease('runner-a', 'run-1', anchor);
    const forked = await provider.fork(anchor, 'child-1', lease.ok === true ? lease.token : '');
    expect(forked.ok).toBe(true);
    await provider.releaseLease(lease.ok === true ? lease.token : '');

    const fromChild = createGitWorktreeProvider({
      repositoryPath: forked.ok === true ? forked.worktreePath : dir,
    });
    const claim = await fromChild.acquireLease('runner-a', 'run-1', anchor);
    expect(claim.ok).toBe(true);
    const held = await provider.acquireLease('runner-b', 'run-2', anchor);
    expect(held.ok === false);
    expect(held.ok === false && held.kind).toBe('held');
  });

  it('runs capture, verify, and fork under the sha256 object format', async () => {
    const dir = await makeRepo('sha256');

    const provider = createGitWorktreeProvider({ repositoryPath: dir });
    const anchor = await provider.capture();
    expect(await provider.verify(anchor)).toEqual({ ok: true });
    const lease = await provider.acquireLease('runner-a', 'run-1', anchor);
    const forked = await provider.fork(anchor, 'child-1', lease.ok === true ? lease.token : '');
    expect(forked.ok).toBe(true);
    if (forked.ok === true) {
      expect(await headOf(forked.worktreePath)).toBe(anchor.head);
    }
  });

  it('anchors are plain durable JSON', async () => {
    const dir = await makeRepo('sha1');
    const provider = createGitWorktreeProvider({ repositoryPath: dir });
    const anchor: WorkspaceAnchor = await provider.capture();
    const round: WorkspaceAnchor = JSON.parse(JSON.stringify(anchor));
    expect(await provider.verify(round)).toEqual({ ok: true });
    expect((await readFile(join(dir, 'README.md'), 'utf8')).startsWith('# one')).toBe(true);
  });

  it('refuses an anchor captured from another repository', async () => {
    const first = await makeRepo('sha1');
    const second = await makeRepo('sha1');
    const firstProvider = createGitWorktreeProvider({ repositoryPath: first });
    const secondProvider = createGitWorktreeProvider({ repositoryPath: second });
    const foreignAnchor = await firstProvider.capture();

    const verified = await secondProvider.verify(foreignAnchor);
    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.drift.some((item) => item.kind === 'repository')).toBe(true);
    }

    const lease = await secondProvider.acquireLease('runner-a', 'run-1', foreignAnchor);
    expect(lease.ok).toBe(true);
    const forked = await secondProvider.fork(
      foreignAnchor,
      'foreign-anchor',
      lease.ok ? lease.token : '',
    );
    expect(forked.ok).toBe(false);
    expect(forked.ok ? '' : forked.kind).toBe('anchor-changed');
  });

  it('uses the provider repository instead of the anchor root when forking', async () => {
    const dir = await makeRepo('sha1');
    const provider = createGitWorktreeProvider({ repositoryPath: dir });
    const captured = await provider.capture();
    const anchor: WorkspaceAnchor = Object.freeze({
      ...captured,
      root: join(dir, 'not-a-repository'),
    });
    const lease = await provider.acquireLease('runner-a', 'run-1', anchor);
    expect(lease.ok).toBe(true);

    const forked = await provider.fork(anchor, 'provider-root', lease.ok ? lease.token : '');
    expect(forked.ok).toBe(true);
    if (!forked.ok) throw new Error(`fork failed: ${forked.kind}`);
    const resolvedDir = await realpath(dir);
    expect(forked.worktreePath).toBe(join(
      dirname(resolvedDir),
      `${basename(resolvedDir)}.obversa-worktrees`,
      'provider-root',
    ));
    expect(await readFile(join(forked.worktreePath, 'README.md'), 'utf8')).toBe('# one\n');
  });

  it('types a fork without a revision and rejects unsafe child ids', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'obversa-d12-empty-'));
    roots.push(dir);
    await execa('git', ['init', '.'], { cwd: dir });
    const provider = createGitWorktreeProvider({ repositoryPath: dir });
    const anchor = await provider.capture();
    const lease = await provider.acquireLease('runner-a', 'run-1', anchor);
    expect(lease.ok).toBe(true);

    const noRevision = await provider.fork(anchor, 'a'.repeat(128), lease.ok ? lease.token : '');
    expect(noRevision).toEqual({ ok: false, kind: 'no-revision' });
    const unsafe = await provider.fork(anchor, '../escape', lease.ok ? lease.token : '');
    expect(unsafe).toEqual({ ok: false, kind: 'invalid-child' });
    const tooLong = await provider.fork(anchor, 'a'.repeat(129), lease.ok ? lease.token : '');
    expect(tooLong).toEqual({ ok: false, kind: 'invalid-child' });
  });

  it('refuses to fork without a lease held for the exact anchor', async () => {
    const dir = await makeRepo('sha1');
    const provider = createGitWorktreeProvider({ repositoryPath: dir });
    const anchor = await provider.capture();

    const unleased = await provider.fork(anchor, 'child-1', 'not-a-token');
    expect(unleased.ok).toBe(false);
    expect(unleased.ok === false && unleased.kind).toBe('unleased');

    const otherAnchor = await provider.capture(['README.md']);
    const lease = await provider.acquireLease('runner-a', 'run-1', otherAnchor);
    const mismatched = await provider.fork(anchor, 'child-1', lease.ok === true ? lease.token : '');
    expect(mismatched.ok).toBe(false);
    expect(mismatched.ok === false && mismatched.kind).toBe('unleased');

    const branches = await execa('git', ['branch', '--list', 'obversa/child-1'], {
      cwd: dir, reject: false,
    });
    expect(branches.stdout.trim()).toBe('');
  });

  it('types a concurrent second acquisition instead of throwing', async () => {
    const dir = await makeRepo('sha1');
    const provider = createGitWorktreeProvider({ repositoryPath: dir });
    const anchor = await provider.capture();

    const [first, second] = await Promise.all([
      provider.acquireLease('runner-a', 'run-1', anchor),
      provider.acquireLease('runner-b', 'run-2', anchor),
    ]);
    const winners = [first, second].filter((result) => result.ok).length;
    expect(winners).toBe(1);
    const loser = first.ok ? second : first;
    expect(loser.ok).toBe(false);
    expect(loser.ok === false && (loser.kind === 'held' || loser.kind === 'incomplete')).toBe(true);
  });

  it('finishes an incomplete fork on retry and types a worktree collision', async () => {
    const dir = await makeRepo('sha1');
    const provider = createGitWorktreeProvider({ repositoryPath: dir });
    const anchor = await provider.capture();
    const lease = await provider.acquireLease('runner-a', 'run-1', anchor);
    const token = lease.ok === true ? lease.token : '';

    // A bare ref from an earlier interrupted fork: the retry finishes it.
    await execa('git', ['branch', 'obversa/child-1', anchor.head], { cwd: dir });
    const finished = await provider.fork(anchor, 'child-1', token);
    expect(finished.ok).toBe(true);
    if (finished.ok === true) {
      expect(await headOf(finished.worktreePath)).toBe(anchor.head);
    }
    await provider.releaseLease(token);

    // A colliding ref at a different revision is a typed exists.
    await commitFile(dir, 'other.txt', 'other\n', 'moved on');
    const next = await createGitWorktreeProvider({ repositoryPath: dir });
    const nextAnchor = await next.capture();
    const nextLease = await next.acquireLease('runner-b', 'run-2', nextAnchor);
    const collision = await next.fork(nextAnchor, 'child-1', nextLease.ok === true ? nextLease.token : '');
    expect(collision.ok).toBe(false);
    expect(collision.ok === false && collision.kind).toBe('exists');
  });

  it('passes the workspace provider conformance kit', async () => {
    const dir = await makeRepo('sha1');
    const provider = createGitWorktreeProvider({ repositoryPath: dir });
    const anchor = await provider.capture();
    const report = await runWorkspaceProviderConformance({
      provider,
      anchor,
      childId: 'kit-child',
      driftWorkspace: async () => {
        await writeFileAt(dir, 'drift.txt', 'drifted\n');
      },
    });
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.cases).toBe(6);
  }, 20_000);
});
