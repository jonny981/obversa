/**
 * The single-repository Git worktree provider (roadmap D12): the one safe
 * Git default.
 *
 * Capture and verify are read-only — status, head, and content digests.
 * Fork validates the anchor first; a changed anchor fails before a branch
 * or worktree exists. A successful fork writes exactly two things into
 * the bound repository's metadata — a new ref at the anchored revision
 * and a worktree registration — plus the worktree directory itself at a
 * deterministic sibling path. The user's checkout, index, and dirty files
 * are untouched. The create order is fixed: ref first, then the worktree,
 * so a crash between the two leaves a detectable bare ref that cleanup
 * can remove or retry; a second fork of the same child id fails at the
 * existing ref or path instead of duplicating anything.
 *
 * The lease lives in private Git refs. Its complete JSON record is a Git blob.
 * Git's expected-object-id update makes publication, release, and recovery
 * change only the exact record they checked. Acquisition creates the one ref
 * with a complete blob, so a kill cannot publish a partial valid owner.
 */

import { execa } from 'execa';
import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

import {
  captureGitWorkspaceSnapshot,
  gitRoot,
  workspaceFingerprint,
} from '../core/git.js';
import type { JsonObject } from '../graph/value.js';
import {
  type AcquireResult,
  type ForkResult,
  type RecoverResult,
  type WorkspaceReleaseResult,
  type VerifyResult,
  type WorkspaceAnchor,
  type WorkspaceDrift,
  type WorkspaceProvider,
} from './provider.js';

interface LeaseFile {
  readonly owner: string;
  readonly scope: string;
  readonly anchorDigest: string;
  readonly token: string;
  readonly createdAtMs: number;
  readonly complete: boolean;
}

interface StoredLease {
  readonly oid: string;
  readonly record: LeaseFile | 'corrupt';
}

type LeaseRead = StoredLease | 'missing';

const MAX_INCOMPLETE_LEASE_AGE_MS = 30_000;
const ACTIVE_LEASE_REF = 'refs/obversa/workspace-lease/v1/active';

async function git(
  cwd: string,
  args: readonly string[],
  input?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await execa('git', args, {
    cwd,
    reject: false,
    ...(input === undefined ? {} : { input }),
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.exitCode ?? 1,
  };
}

function anchorDigest(anchor: WorkspaceAnchor): string {
  return createHash('sha256')
    .update(`${anchor.repositoryId}\0${anchor.root}\0${anchor.head}\0${anchor.fingerprint}\0${JSON.stringify(anchor.files)}`)
    .digest('hex');
}

async function repositoryIdentity(root: string): Promise<string> {
  const common = await git(root, ['rev-parse', '--git-common-dir']);
  if (common.exitCode !== 0) throw new Error('git common dir unavailable');
  const path = common.stdout.trim();
  return realpath(isAbsolute(path) ? path : join(root, path));
}

function parseLease(text: string): LeaseFile | 'corrupt' {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return 'corrupt';
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.owner !== 'string'
      || typeof record.scope !== 'string'
      || typeof record.anchorDigest !== 'string'
      || typeof record.token !== 'string'
      || typeof record.createdAtMs !== 'number'
      || !Number.isFinite(record.createdAtMs)
      || (record.complete !== true && record.complete !== false)
    ) {
      return 'corrupt';
    }
    return parsed as LeaseFile;
  } catch {
    return 'corrupt';
  }
}

async function readLease(root: string): Promise<LeaseRead> {
  const resolved = await git(root, ['rev-parse', '--verify', '--quiet', ACTIVE_LEASE_REF]);
  if (resolved.exitCode === 1) return 'missing';
  if (resolved.exitCode !== 0) {
    throw new Error(`Git could not read the workspace lease ref: ${resolved.stderr.trim()}`);
  }
  const oid = resolved.stdout.trim();
  const blob = await git(root, ['cat-file', 'blob', oid]);
  return {
    oid,
    record: blob.exitCode === 0 ? parseLease(blob.stdout) : 'corrupt',
  };
}

async function writeLeaseBlob(root: string, record: LeaseFile): Promise<string> {
  const stored = await git(
    root,
    ['hash-object', '-w', '--no-filters', '--stdin'],
    `${JSON.stringify(record)}\n`,
  );
  const oid = stored.stdout.trim();
  if (stored.exitCode !== 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(oid)) {
    throw new Error(`Git could not store the workspace lease: ${stored.stderr.trim()}`);
  }
  return oid;
}

async function createLeaseRef(root: string, oid: string): Promise<boolean> {
  const updated = await git(root, [
    'update-ref',
    '--no-deref',
    ACTIVE_LEASE_REF,
    oid,
    '0'.repeat(oid.length),
  ]);
  if (updated.exitCode === 0) return true;
  const current = await readLease(root);
  return current !== 'missing' && current.oid === oid;
}

async function deleteLeaseRef(root: string, expectedOid: string): Promise<boolean> {
  const updated = await git(root, [
    'update-ref',
    '--no-deref',
    '-d',
    ACTIVE_LEASE_REF,
    expectedOid,
  ]);
  if (updated.exitCode === 0) return true;
  const current = await readLease(root);
  if (current === 'missing' || current.oid !== expectedOid) return false;
  throw new Error(`Git could not remove the workspace lease ref: ${updated.stderr.trim()}`);
}

function filesDrift(
  before: readonly JsonObject[],
  after: readonly JsonObject[],
): readonly string[] {
  const pathOf = (file: JsonObject): string =>
    (file as { path?: unknown }).path as string;
  const stateOf = (file: JsonObject): string => JSON.stringify(file);
  const beforeByPath = new Map(before.map((file) => [pathOf(file), file]));
  const afterByPath = new Map(after.map((file) => [pathOf(file), file]));
  const changed: string[] = [];
  for (const [path, file] of beforeByPath) {
    const current = afterByPath.get(path);
    if (current === undefined || stateOf(current) !== stateOf(file)) {
      changed.push(path);
    }
  }
  for (const path of afterByPath.keys()) {
    if (!beforeByPath.has(path)) changed.push(path);
  }
  return changed.sort();
}

/** Create the single-repository Git worktree provider for one checkout. */
export function createGitWorktreeProvider(
  options: { readonly repositoryPath: string; readonly signal?: AbortSignal },
): WorkspaceProvider {
  const repositoryPath = options.repositoryPath;

  const capture = async (scope?: readonly string[]): Promise<WorkspaceAnchor> => {
    const root = await gitRoot({ cwd: repositoryPath });
    if (!root) throw new Error(`"${repositoryPath}" is not a git repository`);
    const opts = {
      cwd: repositoryPath,
      signal: options.signal,
      ...(scope === undefined ? {} : { includePaths: [...scope] }),
    };
    const [snapshot, fingerprint] = await Promise.all([
      captureGitWorkspaceSnapshot(opts),
      workspaceFingerprint(opts),
    ]);
    if (fingerprint === undefined) throw new Error('workspace fingerprint unavailable');
    return Object.freeze({
      schemaVersion: 1 as const,
      root: snapshot.root,
      repositoryId: await repositoryIdentity(root),
      head: snapshot.head ?? '',
      fingerprint,
      scope: scope === undefined ? null : [...scope],
      // Frozen plain JSON from the snapshot; typed as objects for the
      // record-shaped anchor.
      files: snapshot.files as unknown as readonly JsonObject[],
    });
  };

  const verify = async (anchor: WorkspaceAnchor): Promise<VerifyResult> => {
    const current = await capture(anchor.scope ?? undefined);
    const drift: WorkspaceDrift[] = [];
    if (current.repositoryId !== anchor.repositoryId) {
      drift.push({ kind: 'repository', currentRepositoryId: current.repositoryId });
    }
    if (current.head !== anchor.head) {
      drift.push({ kind: 'head', currentHead: current.head });
    }
    const changedPaths = filesDrift(anchor.files, current.files);
    if (changedPaths.length > 0) {
      drift.push({ kind: 'files', changedPaths });
    }
    if (drift.length === 0) return { ok: true };
    return { ok: false, drift: Object.freeze(drift) };
  };

  const worktreeParent = (root: string): string =>
    join(dirname(root), `${basename(root)}.obversa-worktrees`);

  const fork = async (
    anchor: WorkspaceAnchor,
    childId: string,
    leaseToken: string,
  ): Promise<ForkResult> => {
    if (childId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(childId)) {
      return { ok: false, kind: 'invalid-child' };
    }
    const root = await gitRoot({ cwd: repositoryPath });
    if (!root) throw new Error(`"${repositoryPath}" is not a git repository`);
    const storedLease = await readLease(root);
    if (
      storedLease === 'missing'
      || storedLease.record === 'corrupt'
      || storedLease.record.complete !== true
    ) {
      return {
        ok: false,
        kind: 'unleased',
        reason: 'fork requires a lease held for this anchor',
      };
    }
    if (
      storedLease.record.token !== leaseToken
      || storedLease.record.anchorDigest !== anchorDigest(anchor)
    ) {
      return {
        ok: false,
        kind: 'unleased',
        reason: 'the held lease belongs to another owner or anchor',
      };
    }
    const verification = await verify(anchor);
    if (!verification.ok) {
      return {
        ok: false,
        kind: 'anchor-changed',
        drift: verification.drift,
      };
    }
    if (anchor.head === '') return { ok: false, kind: 'no-revision' };
    const branchRef = `refs/heads/obversa/${childId}`;
    const worktreePath = join(worktreeParent(root), childId);

    const branch = await git(root, ['branch', branchRef, anchor.head]);
    if (branch.exitCode !== 0) {
      // A bare ref from an earlier incomplete fork at the same anchored
      // revision is finished by this retry; anything else is a collision.
      const existing = await git(root, ['rev-parse', '--verify', `${branchRef}^{commit}`]);
      if (existing.exitCode !== 0 || existing.stdout.trim() !== anchor.head) {
        return { ok: false, kind: 'exists', branchRef, worktreePath };
      }
    }
    const added = await git(root, ['worktree', 'add', worktreePath, branchRef]);
    if (added.exitCode !== 0) {
      const worktreeExists = await git(root, ['worktree', 'list', '--porcelain']);
      if (worktreeExists.stdout.includes(worktreePath)) {
        return { ok: false, kind: 'exists', branchRef, worktreePath };
      }
      return { ok: false, kind: 'incomplete', branchRef, worktreePath };
    }
    const head = await git(worktreePath, ['rev-parse', 'HEAD']);
    if (head.stdout.trim() !== anchor.head) {
      throw new Error('forked worktree does not start at the anchored revision');
    }
    const child = await createGitWorktreeProvider({
      repositoryPath: worktreePath,
      signal: options.signal,
    }).capture();
    return { ok: true, branchRef, worktreePath, anchor: child };
  };

  const leaseRoot = async (): Promise<string> => {
    const root = await gitRoot({ cwd: repositoryPath });
    if (!root) throw new Error(`"${repositoryPath}" is not a git repository`);
    return root;
  };

  const acquireLease = async (
    owner: string,
    scope: string,
    anchor: WorkspaceAnchor,
  ): Promise<AcquireResult> => {
    const root = await leaseRoot();
    const existing = await readLease(root);
    if (existing !== 'missing') {
      const record = existing.record;
      if (record === 'corrupt') {
        return {
          ok: false,
          kind: 'incomplete',
          reason: 'the lease ref does not contain a readable record; run recoverIncompleteLease',
        };
      }
      if (record.complete !== true) {
        return {
          ok: false,
          kind: 'incomplete',
          reason: 'the previous acquisition did not finish; run recoverIncompleteLease after its age bound',
        };
      }
      return { ok: false, kind: 'held', owner: record.owner };
    }
    const token = randomUUID();
    const record: LeaseFile = {
      owner,
      scope,
      anchorDigest: anchorDigest(anchor),
      token,
      createdAtMs: Date.now(),
      complete: true,
    };
    const oid = await writeLeaseBlob(root, record);
    if (!(await createLeaseRef(root, oid))) {
      const winner = await readLease(root);
      if (winner !== 'missing' && winner.record !== 'corrupt' && winner.record.complete) {
        return { ok: false, kind: 'held', owner: winner.record.owner };
      }
      return {
        ok: false,
        kind: 'incomplete',
        reason: winner === 'missing'
          ? 'another acquisition took and released the lease; retry acquisition'
          : 'another acquisition left an incomplete lease; run recoverIncompleteLease',
      };
    }
    return { ok: true, token, owner, scope, anchorDigest: record.anchorDigest };
  };

  const releaseLease = async (token: string): Promise<WorkspaceReleaseResult> => {
    const root = await leaseRoot();
    const existing = await readLease(root);
    if (existing === 'missing') return { ok: false, kind: 'unknown-token' };
    if (existing.record === 'corrupt' || !existing.record.complete) {
      return { ok: false, kind: 'incomplete' };
    }
    if (existing.record.token !== token) return { ok: false, kind: 'not-owner' };
    if (await deleteLeaseRef(root, existing.oid)) return { ok: true };

    const winner = await readLease(root);
    if (winner === 'missing') return { ok: false, kind: 'unknown-token' };
    if (winner.record === 'corrupt' || !winner.record.complete) {
      return { ok: false, kind: 'incomplete' };
    }
    return { ok: false, kind: 'not-owner' };
  };

  const recoverIncompleteLease = async (): Promise<RecoverResult> => {
    const root = await leaseRoot();
    const existing = await readLease(root);
    if (existing === 'missing') return { ok: false, kind: 'none' };
    if (
      existing.record !== 'corrupt'
      && (
        existing.record.complete
        || Date.now() - existing.record.createdAtMs < MAX_INCOMPLETE_LEASE_AGE_MS
      )
    ) {
      return { ok: false, kind: 'live' };
    }
    if (await deleteLeaseRef(root, existing.oid)) return { ok: true };

    const winner = await readLease(root);
    if (winner === 'missing') return { ok: false, kind: 'none' };
    return { ok: false, kind: 'live' };
  };

  return Object.freeze({
    capture,
    verify,
    fork,
    acquireLease,
    releaseLease,
    recoverIncompleteLease,
  });
}
