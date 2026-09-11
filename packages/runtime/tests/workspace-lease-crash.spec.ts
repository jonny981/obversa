import { afterEach, describe, expect, it, vi } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real work: these tests create temporary Git repositories and write files
// to disk, so this file declares its own time limit; the suite default is a
// hang guard, not a speed bar.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const ACTIVE_LEASE_REF = 'refs/obversa/workspace-lease/v1/active';
const LEASE_REF_PREFIX = 'refs/obversa/workspace-lease';
const updatedLeaseRefs = vi.hoisted(() => [] as string[]);

const createGate = vi.hoisted(() => ({
  pause: false,
  entered: null as (() => void) | null,
  continue: null as (() => void) | null,
  resume: Promise.resolve() as Promise<void>,
  args: [] as readonly string[],
}));

const deleteGate = vi.hoisted(() => ({
  pause: false,
  entered: null as (() => void) | null,
  continue: null as (() => void) | null,
  resume: Promise.resolve() as Promise<void>,
  args: [] as readonly string[],
}));

const refReadGate = vi.hoisted(() => ({
  pause: false,
  entered: null as (() => void) | null,
  continue: null as (() => void) | null,
  resume: Promise.resolve() as Promise<void>,
}));

vi.mock('../src/core/process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/process.js')>();
  const wrapped = async (
    options: Parameters<typeof actual.runRuntimeProcess>[0],
  ): ReturnType<typeof actual.runRuntimeProcess> => {
    const args = options.args ?? [];
    if (options.executable === 'git' && args[0] === 'update-ref') {
      updatedLeaseRefs.push(...args.filter((arg) => arg.startsWith(LEASE_REF_PREFIX)));
      if (typeof options.stdin === 'string') {
        updatedLeaseRefs.push(
          ...(options.stdin.match(new RegExp(`${LEASE_REF_PREFIX}[^\\s]*`, 'gu')) ?? []),
        );
      }
    }
    if (
      options.executable === 'git'
      && args[0] === 'rev-parse'
      && args.includes('--verify')
      && args.includes(ACTIVE_LEASE_REF)
      && refReadGate.pause
    ) {
      refReadGate.pause = false;
      refReadGate.entered?.();
      await refReadGate.resume;
    }
    if (
      options.executable === 'git'
      && args[0] === 'update-ref'
      && args.includes(ACTIVE_LEASE_REF)
    ) {
      const gate = args.includes('-d') ? deleteGate : createGate;
      if (gate.pause) {
        gate.pause = false;
        gate.args = [...args];
        gate.entered?.();
        await gate.resume;
      }
    }
    return actual.runRuntimeProcess(options);
  };
  return { ...actual, runRuntimeProcess: wrapped };
});

import { createGitWorktreeProvider } from '../src/workspace/git-provider.js';

const roots: string[] = [];

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'obversa-lease-crash-'));
  roots.push(dir);
  await execa('git', ['init', '.'], { cwd: dir });
  await execa('git', ['config', 'user.email', 'lease@example.invalid'], { cwd: dir });
  await execa('git', ['config', 'user.name', 'lease test'], { cwd: dir });
  await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), '# lease\n', 'utf8');
  await execa('git', ['add', 'README.md'], { cwd: dir });
  await execa('git', ['commit', '-m', 'first'], { cwd: dir });
  return dir;
}

async function readRef(repositoryPath: string): Promise<string | undefined> {
  const result = await execa(
    'git', ['rev-parse', '--verify', '--quiet', ACTIVE_LEASE_REF],
    { cwd: repositoryPath, reject: false },
  );
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

async function readBlob(repositoryPath: string, oid: string): Promise<string> {
  return (await execa('git', ['cat-file', 'blob', oid], { cwd: repositoryPath })).stdout;
}

async function leaseRefs(repositoryPath: string): Promise<readonly string[]> {
  const result = await execa('git', [
    'for-each-ref',
    '--format=%(refname)',
    'refs/obversa/workspace-lease',
  ], { cwd: repositoryPath });
  return result.stdout.split('\n').filter(Boolean);
}

async function writeRef(
  repositoryPath: string,
  contents: string,
  expected?: string,
): Promise<string> {
  const oid = (await execa(
    'git', ['hash-object', '-w', '--no-filters', '--stdin'],
    { cwd: repositoryPath, input: contents },
  )).stdout.trim();
  await execa(
    'git', [
      'update-ref',
      '--no-deref',
      ACTIVE_LEASE_REF,
      oid,
      expected ?? '0'.repeat(oid.length),
    ],
    { cwd: repositoryPath },
  );
  return oid;
}

function incompleteLease(createdAtMs: number): string {
  return `${JSON.stringify({
    owner: 'runner-a',
    scope: 'run-a',
    anchorDigest: 'digest',
    token: 'incomplete-token',
    createdAtMs,
    complete: false,
  })}\n`;
}

function pauseNextCreate(): {
  readonly entered: Promise<void>;
  readonly resume: () => void;
} {
  let entered!: () => void;
  let resume!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  createGate.resume = new Promise<void>((resolve) => { resume = resolve; });
  createGate.entered = entered;
  createGate.continue = resume;
  createGate.pause = true;
  return { entered: enteredPromise, resume };
}

function pauseNextDelete(): {
  readonly entered: Promise<void>;
  readonly resume: () => void;
} {
  let entered!: () => void;
  let resume!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  deleteGate.resume = new Promise<void>((resolve) => { resume = resolve; });
  deleteGate.entered = entered;
  deleteGate.continue = resume;
  deleteGate.pause = true;
  return { entered: enteredPromise, resume };
}

function pauseNextRefRead(): {
  readonly entered: Promise<void>;
  readonly resume: () => void;
} {
  let entered!: () => void;
  let resume!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  refReadGate.resume = new Promise<void>((resolve) => { resume = resolve; });
  refReadGate.entered = entered;
  refReadGate.continue = resume;
  refReadGate.pause = true;
  return { entered: enteredPromise, resume };
}

afterEach(async () => {
  createGate.continue?.();
  createGate.pause = false;
  createGate.entered = null;
  createGate.continue = null;
  createGate.args = [];
  deleteGate.continue?.();
  deleteGate.pause = false;
  deleteGate.entered = null;
  deleteGate.continue = null;
  deleteGate.args = [];
  refReadGate.continue?.();
  refReadGate.pause = false;
  refReadGate.entered = null;
  refReadGate.continue = null;
  updatedLeaseRefs.splice(0);
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('workspace lease crash safety', () => {
  it.each([
    ['empty', ''],
    ['partial', '{"owner":"dead"'],
  ])('recovers a corrupt %s lease blob', async (_name, contents) => {
    const repositoryPath = await makeRepo();
    const provider = createGitWorktreeProvider({ repositoryPath });
    const anchor = await provider.capture();
    await writeRef(repositoryPath, contents);

    const blocked = await provider.acquireLease('runner-a', 'run-a', anchor);
    expect(blocked.ok).toBe(false);
    expect(blocked.ok === false && blocked.kind).toBe('incomplete');
    expect(await provider.recoverIncompleteLease()).toEqual({ ok: true });
    expect(await readRef(repositoryPath)).toBeUndefined();

    const acquired = await provider.acquireLease('runner-a', 'run-a', anchor);
    expect(acquired.ok).toBe(true);
  });

  it('publishes one complete blob with one create-if-absent update', async () => {
    const repositoryPath = await makeRepo();
    const provider = createGitWorktreeProvider({ repositoryPath });
    const anchor = await provider.capture();
    const gate = pauseNextCreate();

    const acquiring = provider.acquireLease('runner-a', 'run-a', anchor);
    await gate.entered;
    expect(await readRef(repositoryPath)).toBeUndefined();
    expect(await leaseRefs(repositoryPath)).toEqual([]);
    const pendingOid = createGate.args[createGate.args.indexOf(ACTIVE_LEASE_REF) + 1];
    expect(createGate.args.at(-1)).toBe('0'.repeat(pendingOid!.length));
    expect(JSON.parse(await readBlob(repositoryPath, pendingOid!))).toMatchObject({
      owner: 'runner-a',
      complete: true,
    });

    gate.resume();
    const acquired = await acquiring;
    expect(acquired.ok).toBe(true);
    expect(await readRef(repositoryPath)).toBe(pendingOid);
    expect(await leaseRefs(repositoryPath)).toEqual([ACTIVE_LEASE_REF]);
    expect(updatedLeaseRefs).toEqual([ACTIVE_LEASE_REF]);
  });

  it('lets only one create-if-absent update win', async () => {
    const repositoryPath = await makeRepo();
    const provider = createGitWorktreeProvider({ repositoryPath });
    const anchor = await provider.capture();
    const gate = pauseNextCreate();

    const callerA = provider.acquireLease('runner-a', 'run-a', anchor);
    await gate.entered;
    const callerB = await provider.acquireLease('runner-b', 'run-b', anchor);
    expect(callerB.ok).toBe(true);
    gate.resume();

    expect(await callerA).toEqual({ ok: false, kind: 'held', owner: 'runner-b' });
    expect(await provider.releaseLease(callerB.ok ? callerB.token : '')).toEqual({ ok: true });
  });

  it('types a lost acquisition when the winner releases before classification', async () => {
    const repositoryPath = await makeRepo();
    const provider = createGitWorktreeProvider({ repositoryPath });
    const anchor = await provider.capture();
    const create = pauseNextCreate();

    const callerA = provider.acquireLease('runner-a', 'run-a', anchor);
    await create.entered;
    const callerB = await provider.acquireLease('runner-b', 'run-b', anchor);
    expect(callerB.ok).toBe(true);
    if (!callerB.ok) throw new Error('lease setup failed');

    const fallbackRead = pauseNextRefRead();
    create.resume();
    await fallbackRead.entered;
    expect(await provider.releaseLease(callerB.token)).toEqual({ ok: true });
    fallbackRead.resume();

    const lost = await callerA;
    expect(lost.ok).toBe(false);
    expect(lost.ok === false && lost.kind).toBe('incomplete');
  });

  it('does not let a delayed duplicate release remove the next owner', async () => {
    const repositoryPath = await makeRepo();
    const provider = createGitWorktreeProvider({ repositoryPath });
    const anchor = await provider.capture();
    const lease = await provider.acquireLease('runner-a', 'run-a', anchor);
    expect(lease.ok).toBe(true);
    if (!lease.ok) throw new Error('lease setup failed');
    const gate = pauseNextDelete();

    const delayedRelease = provider.releaseLease(lease.token);
    await gate.entered;
    expect(await provider.releaseLease(lease.token)).toEqual({ ok: true });
    const owner = await provider.acquireLease('runner-b', 'run-b', anchor);
    expect(owner.ok).toBe(true);
    if (!owner.ok) throw new Error('lease setup failed');
    gate.resume();

    expect(await delayedRelease).toEqual({ ok: false, kind: 'not-owner' });
    expect(await provider.releaseLease(owner.token)).toEqual({ ok: true });
  });

  it.each([
    ['corrupt', '{"owner":"dead"'],
    ['stale incomplete', incompleteLease(0)],
  ])('does not let delayed %s recovery remove the next owner', async (_name, contents) => {
    const repositoryPath = await makeRepo();
    const provider = createGitWorktreeProvider({ repositoryPath });
    const anchor = await provider.capture();
    await writeRef(repositoryPath, contents);
    const gate = pauseNextDelete();

    const delayedRecovery = provider.recoverIncompleteLease();
    await gate.entered;
    expect(await provider.recoverIncompleteLease()).toEqual({ ok: true });
    const owner = await provider.acquireLease('runner-b', 'run-b', anchor);
    expect(owner.ok).toBe(true);
    if (!owner.ok) throw new Error('lease setup failed');
    gate.resume();

    expect(await delayedRecovery).toEqual({ ok: false, kind: 'live' });
    expect(await provider.releaseLease(owner.token)).toEqual({ ok: true });
  });

  it('waits for the age bound before recovering a readable incomplete blob', async () => {
    const repositoryPath = await makeRepo();
    const provider = createGitWorktreeProvider({ repositoryPath });
    const current = await writeRef(repositoryPath, incompleteLease(Date.now()));

    expect(await provider.recoverIncompleteLease()).toEqual({ ok: false, kind: 'live' });
    await writeRef(repositoryPath, incompleteLease(0), current);
    expect(await provider.recoverIncompleteLease()).toEqual({ ok: true });
    expect(await readRef(repositoryPath)).toBeUndefined();
  });

  it('does not admit an acquisition that read before recovery changed the ref', async () => {
    const repositoryPath = await makeRepo();
    const provider = createGitWorktreeProvider({ repositoryPath });
    const anchor = await provider.capture();
    await writeRef(repositoryPath, '{"owner":"dead"');
    const recoveryGate = pauseNextDelete();

    const delayedRecovery = provider.recoverIncompleteLease();
    await recoveryGate.entered;
    expect(await provider.recoverIncompleteLease()).toEqual({ ok: true });

    const create = pauseNextCreate();
    const precheckedAcquire = provider.acquireLease('runner-c', 'run-c', anchor);
    await create.entered;
    const owner = await provider.acquireLease('runner-b', 'run-b', anchor);
    expect(owner.ok).toBe(true);
    if (!owner.ok) throw new Error('lease setup failed');

    recoveryGate.resume();
    expect(await delayedRecovery).toEqual({ ok: false, kind: 'live' });
    create.resume();
    expect(await precheckedAcquire).toEqual({ ok: false, kind: 'held', owner: 'runner-b' });
    expect(await provider.releaseLease(owner.token)).toEqual({ ok: true });
  });
});
