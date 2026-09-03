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
 * The lease lives in a JSON file inside the repository's metadata. The
 * acquisition is two-phase: the file is created with the full record
 * marked incomplete, then completed by an atomic rename. A kill between
 * the phases leaves an incomplete claim — visible, typed, and clearable
 * only through the explicit recovery call, which never touches a live
 * lease.
 */

import { execa } from 'execa';
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
  type ReleaseResult,
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
  readonly complete: boolean;
}

async function git(cwd: string, args: readonly string[]): Promise<{ stdout: string; exitCode: number }> {
  const result = await execa('git', args, { cwd, reject: false });
  return { stdout: result.stdout ?? '', exitCode: result.exitCode ?? 1 };
}

function anchorDigest(anchor: WorkspaceAnchor): string {
  return createHash('sha256')
    .update(`${anchor.root}\0${anchor.head}\0${anchor.fingerprint}\0${JSON.stringify(anchor.files)}`)
    .digest('hex');
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
    const leaseFile = await readLease(await leasePath());
    if (leaseFile === null || leaseFile === 'unparseable' || !leaseFile.complete) {
      return {
        ok: false,
        kind: 'unleased',
        reason: 'fork requires a lease held for this anchor',
      };
    }
    if (leaseFile.token !== leaseToken || leaseFile.anchorDigest !== anchorDigest(anchor)) {
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
    const branchRef = `refs/heads/obversa/${childId}`;
    const worktreePath = join(worktreeParent(anchor.root), childId);

    const branch = await git(anchor.root, ['branch', branchRef, anchor.head]);
    if (branch.exitCode !== 0) {
      // A bare ref from an earlier incomplete fork at the same anchored
      // revision is finished by this retry; anything else is a collision.
      const existing = await git(anchor.root, ['rev-parse', '--verify', `${branchRef}^{commit}`]);
      if (existing.exitCode !== 0 || existing.stdout.trim() !== anchor.head) {
        return { ok: false, kind: 'exists', branchRef, worktreePath };
      }
    }
    const added = await git(anchor.root, ['worktree', 'add', worktreePath, branchRef]);
    if (added.exitCode !== 0) {
      const worktreeExists = await git(anchor.root, ['worktree', 'list', '--porcelain']);
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

  const leasePath = async (): Promise<string> => {
    const root = await gitRoot({ cwd: repositoryPath });
    if (!root) throw new Error(`"${repositoryPath}" is not a git repository`);
    // The common dir is shared by every linked worktree, so one lease
    // covers the repository — one writer per workspace.
    const commonDir = await git(root, ['rev-parse', '--git-common-dir']);
    if (commonDir.exitCode !== 0) throw new Error('git common dir unavailable');
    const dir = commonDir.stdout.trim();
    // At the repository top level git reports a relative ".git"; resolve
    // it against the worktree root before joining.
    const resolved = isAbsolute(dir) ? dir : join(root, dir);
    return join(resolved, 'obversa-workspace-lease.json');
  };

  const readLease = async (path: string): Promise<LeaseFile | null | 'unparseable'> => {
    try {
      const text = await readFile(path, 'utf8');
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null) return 'unparseable';
      const record = parsed as Record<string, unknown>;
      if (typeof record.owner !== 'string' || typeof record.token !== 'string'
        || typeof record.complete !== 'boolean') {
        return 'unparseable';
      }
      return parsed as LeaseFile;
    } catch {
      return null;
    }
  };

  const acquireLease = async (
    owner: string,
    scope: string,
    anchor: WorkspaceAnchor,
  ): Promise<AcquireResult> => {
    const path = await leasePath();
    const existing = await readLease(path);
    if (existing === 'unparseable') {
      return {
        ok: false,
        kind: 'incomplete',
        reason: 'the lease file is not a readable record; run recoverIncompleteLease',
      };
    }
    if (existing !== null) {
      if (!existing.complete) {
        return {
          ok: false,
          kind: 'incomplete',
          reason: 'the previous acquisition did not finish; run recoverIncompleteLease',
        };
      }
      return { ok: false, kind: 'held', owner: existing.owner };
    }
    const token = randomUUID();
    const record: LeaseFile = {
      owner,
      scope,
      anchorDigest: anchorDigest(anchor),
      token,
      complete: false,
    };
    let file;
    try {
      file = await open(path, 'wx', 0o600);
    } catch (error) {
      // A racing acquisition won the create: classify instead of throwing.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const winner = await readLease(path);
        if (winner !== null && winner !== 'unparseable' && winner.complete) {
          return { ok: false, kind: 'held', owner: winner.owner };
        }
        return {
          ok: false,
          kind: 'incomplete',
          reason: 'a concurrent acquisition is in flight; run recoverIncompleteLease',
        };
      }
      throw error;
    }
    try {
      await file.writeFile(`${JSON.stringify(record)}\n`);
    } finally {
      await file.close();
    }
    const completed: LeaseFile = { ...record, complete: true };
    // Same-directory temporary plus rename: the completion is atomic and
    // a kill leaves either the incomplete record or the live lease.
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(completed)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
    return { ok: true, token, owner, scope, anchorDigest: record.anchorDigest };
  };

  const releaseLease = async (token: string): Promise<ReleaseResult> => {
    const path = await leasePath();
    const existing = await readLease(path);
    if (existing === null) return { ok: false, kind: 'unknown-token' };
    if (existing === 'unparseable') return { ok: false, kind: 'incomplete' };
    if (!existing.complete) return { ok: false, kind: 'incomplete' };
    if (existing.token !== token) return { ok: false, kind: 'not-owner' };
    await rm(path, { force: true });
    return { ok: true };
  };

  const recoverIncompleteLease = async (): Promise<RecoverResult> => {
    const path = await leasePath();
    const existing = await readLease(path);
    if (existing === null) return { ok: false, kind: 'none' };
    if (existing !== 'unparseable' && existing.complete) {
      return { ok: false, kind: 'live' };
    }
    await rm(path, { force: true });
    return { ok: true };
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
