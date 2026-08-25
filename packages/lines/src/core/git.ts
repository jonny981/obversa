/** Local Git helpers used by workspace-aware jobs. */

import { execa } from 'execa';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

interface GitOpts {
  cwd: string;
  signal?: AbortSignal;
  excludePaths?: string[];
  includePaths?: string[];
}

async function git(
  args: string[],
  { cwd, signal }: GitOpts,
  input?: string,
): Promise<{ stdout: string; exitCode: number }> {
  const r = await execa('git', args, {
    cwd,
    cancelSignal: signal,
    reject: false,
    stdin: input === undefined ? 'ignore' : undefined,
    input,
  });
  return { stdout: r.stdout ?? '', exitCode: r.exitCode ?? 1 };
}

/** True when `cwd` is inside a git work tree. Never throws. */
export async function isRepo(opts: GitOpts): Promise<boolean> {
  try {
    const r = await git(['rev-parse', '--is-inside-work-tree'], opts);
    return r.exitCode === 0 && r.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/** The checked-out branch name, or undefined on a detached HEAD / non-repo. */
export async function currentBranch(opts: GitOpts): Promise<string | undefined> {
  const r = await git(['rev-parse', '--abbrev-ref', 'HEAD'], opts);
  if (r.exitCode !== 0) return undefined;
  const name = r.stdout.trim();
  return name && name !== 'HEAD' ? name : undefined;
}

/** The git worktree root containing `cwd`, or undefined outside a git repo. */
export async function gitRoot(opts: GitOpts): Promise<string | undefined> {
  const r = await git(['rev-parse', '--show-toplevel'], opts);
  return r.exitCode === 0 ? r.stdout.trim() || undefined : undefined;
}

/** The HEAD commit sha, or undefined when the branch has no commits yet. */
export async function headSha(opts: GitOpts): Promise<string | undefined> {
  const r = await git(['rev-parse', 'HEAD'], opts);
  return r.exitCode === 0 ? r.stdout.trim() || undefined : undefined;
}

/** Stage every change in the work tree (`git add -A`). */
export async function stageAll(opts: GitOpts): Promise<void> {
  await git(['add', '-A'], opts);
}

/** True when there is something staged to commit. */
export async function hasStagedChanges(opts: GitOpts): Promise<boolean> {
  // `diff --cached --quiet` exits 1 when the index differs from HEAD.
  const r = await git(['diff', '--cached', '--quiet'], opts);
  return r.exitCode === 1;
}

/** True when the work tree (staged or unstaged) has any change. */
export async function isDirty(opts: GitOpts): Promise<boolean> {
  const r = await git(['status', '--porcelain'], opts);
  return r.stdout.trim().length > 0;
}

/**
 * A content hash of the workspace's observable state: HEAD, every pending
 * tracked change (staged + unstaged, with content), the porcelain status, and
 * the CONTENT of untracked files (hashed by git itself, so a revisit to a
 * byte-identical tree fingerprints identically). Whole-workspace hashes omit
 * ignored files; `includePaths` observes ignored content explicitly selected
 * by the caller. Scoped hashes omit unrelated commits. This is the
 * deterministic evidence channel behind `noProgress`: two iterations with the
 * same fingerprint left the observed workspace in the same state. Returns
 * undefined outside a git work tree; the caller treats that channel as
 * absent, never as "unchanged". Never throws.
 */
export async function workspaceFingerprint(
  opts: GitOpts,
): Promise<string | undefined> {
  try {
    if (!(await isRepo(opts))) return undefined;
    const excluded = (opts.excludePaths ?? [])
      .map((p) => relative(opts.cwd, resolve(opts.cwd, p)).replace(/\\/g, '/'))
      .filter((p) => p && !p.startsWith('..') && p !== '.');
    const included = [...new Set(opts.includePaths ?? [])]
      .map((p) => p.trim())
      .filter(Boolean)
      .sort();
    const scoped = included.length > 0;
    const pathspec = scoped || excluded.length
      ? [
          '--',
          ...(scoped ? included : ['.']),
          ...excluded.map((p) => `:(exclude)${p}`),
        ]
      : [];
    const output = async (args: string[]): Promise<string> => {
      const result = await git(args, opts);
      if (result.exitCode !== 0)
        throw new Error(`git ${args[0] ?? 'command'} failed`);
      return result.stdout;
    };
    const hash = createHash('sha256');
    const feed = (label: string, value: string) => {
      hash.update(label);
      hash.update('\x1f');
      hash.update(value);
      hash.update('\x1e');
    };
    if (scoped) {
      // A scoped fingerprint follows the selected content, not the branch tip:
      // an unrelated commit must not invalidate a reviewer that never read it.
      feed('scope', included.join('\n'));
      feed(
        'tracked',
        await output(['ls-files', '--stage', ...pathspec]),
      );
    } else {
      feed('head', (await headSha(opts)) ?? '');
    }
    // `status --porcelain` captures names/stages even where a diff cannot run
    // (e.g. an unborn HEAD); the two diffs capture tracked content.
    feed(
      'status',
      await output(['status', '--porcelain', ...pathspec]),
    );
    feed('unstaged', await output(['diff', ...pathspec]));
    feed('staged', await output(['diff', '--cached', ...pathspec]));
    // Untracked content, hashed by git (streams; no JS-side file reads). A file
    // vanishing between the list and the hash fails the chunk; its paths still
    // feed the fingerprint, so the disappearance itself reads as a new state.
    const untracked = (
      await output([
        'ls-files',
        '--others',
        ...(scoped ? [] : ['--exclude-standard']),
        ...pathspec,
      ])
    )
      .split('\n')
      .filter(Boolean);
    for (let i = 0; i < untracked.length; i += 500) {
      const chunk = untracked.slice(i, i + 500);
      feed(`untracked-paths:${i}`, chunk.join('\n'));
      feed(
        `untracked-content:${i}`,
        await output(['hash-object', '--', ...chunk]),
      );
    }
    return hash.digest('hex');
  } catch {
    return undefined;
  }
}

export interface CommitInput {
  subject: string;
  /** The structured body. Joined to the subject with a blank line. */
  body?: string;
  /** Commit even with an empty index (default false). */
  allowEmpty?: boolean;
}

/**
 * Commit the staged index. The message is passed on stdin (`-F -`) so an
 * arbitrarily-shaped body never has to survive shell escaping. The repo's
 * configured author is used. Lines never changes commit authorship.
 * Returns the new sha, or undefined when there was nothing to commit and
 * `allowEmpty` was not set.
 */
export async function commit(
  input: CommitInput,
  opts: GitOpts,
): Promise<string | undefined> {
  if (!input.allowEmpty && !(await hasStagedChanges(opts))) return undefined;
  const message = input.body
    ? `${input.subject}\n\n${input.body}\n`
    : `${input.subject}\n`;
  const args = ['commit', '-F', '-'];
  if (input.allowEmpty) args.push('--allow-empty');
  const r = await git(args, opts, message);
  if (r.exitCode !== 0) {
    throw new Error(
      `git commit failed (exit ${r.exitCode}): ${r.stdout}`.trim(),
    );
  }
  return headSha(opts);
}

/** Recent commit messages from one branch, used only to explain a merge. */
export async function branchCommits(opts: {
  cwd: string;
  ref: string;
  max: number;
  signal?: AbortSignal;
}): Promise<Array<{ subject: string; body: string }>> {
  const field = '\x1f';
  const record = '\x1e';
  const result = await git(
    ['log', `-n${opts.max}`, `--format=%s${field}%b${record}`, opts.ref],
    opts,
  );
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split(record)
    .map((value) => value.replace(/^\n+/, '').split(field))
    .filter((fields) => fields[0]?.trim())
    .map(([subject, body]) => ({
      subject: subject!.trim(),
      body: (body ?? '').trim(),
    }));
}

// ── Worktrees (branches-as-teams) ──────────────────────────────────────────

export interface WorktreeHandle {
  /** The isolated working directory. */
  dir: string;
  /** The branch checked out there. */
  branch: string;
}

/**
 * Fork an isolated worktree on a new branch from `base` (default HEAD). Each
 * concurrent writer gets its own working dir and branch, so siblings never
 * collide on files or the index.
 */
export async function addWorktree(
  repoDir: string,
  opts: { branch: string; base?: string; signal?: AbortSignal },
): Promise<WorktreeHandle> {
  const dir = mkdtempSync(join(tmpdir(), 'lines-wt-'));
  const r = await git(
    ['worktree', 'add', '-b', opts.branch, dir, opts.base ?? 'HEAD'],
    { cwd: repoDir, signal: opts.signal },
  );
  if (r.exitCode !== 0)
    throw new Error(
      `git worktree add failed (exit ${r.exitCode}): ${r.stdout}`.trim(),
    );
  return { dir, branch: opts.branch };
}

/** Remove a worktree (force-discards anything uncommitted left in it). */
export async function removeWorktree(
  repoDir: string,
  dir: string,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  await git(['worktree', 'remove', '--force', dir], {
    cwd: repoDir,
    signal: opts.signal,
  });
}

/** Delete a branch ref (used to clean up a merged fork branch). */
export async function deleteBranch(
  repoDir: string,
  branch: string,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  await git(['branch', '-D', branch], { cwd: repoDir, signal: opts.signal });
}

export interface MergeResult {
  ok: boolean;
  conflict: boolean;
}

/**
 * Land a fork branch back into the branch checked out at `repoDir` (`--no-ff`).
 * On conflict the merge is aborted so the target stays clean and the caller can
 * fail the node. Lines does not auto-resolve (a merge-resolver is a separate
 * layer).
 */
export async function mergeBranch(
  repoDir: string,
  branch: string,
  opts: { signal?: AbortSignal; message?: string } = {},
): Promise<MergeResult> {
  const r = await git(
    ['merge', '--no-ff', '-m', opts.message ?? `merge ${branch}`, branch],
    { cwd: repoDir, signal: opts.signal },
  );
  if (r.exitCode === 0) return { ok: true, conflict: false };
  await git(['merge', '--abort'], { cwd: repoDir, signal: opts.signal });
  return { ok: false, conflict: true };
}

/**
 * Begin a `--no-ff --no-commit` merge WITHOUT aborting on conflict, so a resolver
 * can synthesise the result. `clean` means it merged cleanly (staged, ready to
 * commit); otherwise `conflicted` lists the unresolved paths (with markers).
 */
export async function mergeNoCommit(
  repoDir: string,
  branch: string,
  opts: { signal?: AbortSignal } = {},
): Promise<{ clean: boolean; conflicted: string[] }> {
  const r = await git(['merge', '--no-ff', '--no-commit', branch], {
    cwd: repoDir,
    signal: opts.signal,
  });
  if (r.exitCode === 0) return { clean: true, conflicted: [] };
  return { clean: false, conflicted: await conflictedFiles(repoDir, opts) };
}

/** Paths with unresolved merge conflicts. */
export async function conflictedFiles(
  repoDir: string,
  opts: { signal?: AbortSignal } = {},
): Promise<string[]> {
  const r = await git(['diff', '--name-only', '--diff-filter=U'], {
    cwd: repoDir,
    signal: opts.signal,
  });
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Abort an in-progress merge. */
export async function mergeAbort(
  repoDir: string,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  await git(['merge', '--abort'], { cwd: repoDir, signal: opts.signal });
}
