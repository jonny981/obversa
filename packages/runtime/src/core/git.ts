/** Local Git helpers used by workspace-aware jobs. */

import { execa } from 'execa';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
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

interface GitIndexState {
  readonly mode: string;
  readonly oid: string;
}

interface GitDirtyState {
  readonly status: string;
  readonly kind: 'file' | 'symlink' | 'missing';
  readonly mode: number;
  readonly digest: string | null;
  readonly lines: readonly string[];
}

export interface GitWorkspaceFileState {
  readonly path: string;
  readonly index: GitIndexState | null;
  readonly dirty: GitDirtyState | null;
}

export interface GitWorkspaceSnapshot {
  readonly root: string;
  readonly head: string | null;
  readonly files: readonly GitWorkspaceFileState[];
}

export interface GitWorkspaceDelta {
  readonly headChanged: boolean;
  readonly changedPaths: readonly string[];
  readonly filesChanged: number;
  readonly linesChanged: number;
}

interface DirtyStatus {
  readonly status: string;
  readonly path: string;
}

function parseDirtyStatus(output: string): readonly DirtyStatus[] {
  const records = output.split('\0');
  const entries: DirtyStatus[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== ' ') {
      throw new Error('git status returned an invalid porcelain record');
    }
    const status = record.slice(0, 2);
    entries.push({ status, path: record.slice(3) });
    if (status.includes('R') || status.includes('C')) {
      const source = records[index + 1];
      if (!source) throw new Error('git status omitted a rename source');
      entries.push({ status: `${status}:source`, path: source });
      index += 1;
    }
  }
  return entries;
}

function parseIndexState(output: string): Map<string, GitIndexState> {
  const entries = new Map<string, GitIndexState>();
  for (const record of output.split('\0')) {
    if (!record) continue;
    const match = /^(\d{6}) ([0-9a-f]+) (\d)\t(.+)$/u.exec(record);
    if (!match) throw new Error('git index returned an invalid entry');
    const [, mode, oid, stage, path] = match;
    if (stage !== '0') {
      throw new Error(`git index has an unresolved entry at ${path}`);
    }
    if (entries.has(path!)) {
      throw new Error(`git index returned a duplicate entry at ${path}`);
    }
    entries.set(path!, { mode: mode!, oid: oid! });
  }
  return entries;
}

function lineDigests(bytes: Uint8Array): readonly string[] {
  if (bytes.byteLength === 0) return Object.freeze([]);
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    lines.push(
      createHash('sha256').update(bytes.subarray(start, index + 1)).digest('hex'),
    );
    start = index + 1;
  }
  if (start < bytes.byteLength) {
    lines.push(createHash('sha256').update(bytes.subarray(start)).digest('hex'));
  }
  return Object.freeze(lines);
}

async function dirtyState(
  root: string,
  entry: DirtyStatus,
): Promise<GitDirtyState> {
  const path = join(root, entry.path);
  try {
    const stat = await lstat(path);
    let bytes: Uint8Array;
    let kind: GitDirtyState['kind'];
    if (stat.isFile()) {
      kind = 'file';
      bytes = await readFile(path);
    } else if (stat.isSymbolicLink()) {
      kind = 'symlink';
      bytes = await readlink(path, { encoding: 'buffer' });
    } else {
      throw new Error(
        `git workspace contains an unsupported dirty entry at ${entry.path}`,
      );
    }
    return {
      status: entry.status,
      kind,
      mode: stat.mode,
      digest: createHash('sha256').update(bytes).digest('hex'),
      lines: lineDigests(bytes),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        status: entry.status,
        kind: 'missing',
        mode: 0,
        digest: null,
        lines: Object.freeze([]),
      };
    }
    throw error;
  }
}

/**
 * Capture the Git-visible entry state for one attempt. Clean tracked files are
 * represented by their index object; only already-dirty bytes are read and
 * reduced to hashes. No workspace content is retained in the snapshot.
 */
export async function captureGitWorkspaceSnapshot(
  opts: GitOpts,
): Promise<GitWorkspaceSnapshot> {
  const root = await gitRoot(opts);
  if (!root) throw new Error('not a git repository');
  const commandOpts = { ...opts, cwd: root };
  const included = [...new Set(opts.includePaths ?? [])]
    .map((path) => path.trim())
    .filter(Boolean)
    .sort();
  const pathspec = included.length > 0 ? ['--', ...included] : [];
  const [head, indexResult, statusResult] = await Promise.all([
    headSha(commandOpts),
    git([
      ...(pathspec.length === 0 ? ['--literal-pathspecs'] : []),
      'ls-files', '--stage', '-z', ...pathspec,
    ], commandOpts),
    git(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...pathspec],
      commandOpts,
    ),
  ]);
  if (indexResult.exitCode !== 0) throw new Error('git index inspection failed');
  if (statusResult.exitCode !== 0) throw new Error('git status inspection failed');

  const index = parseIndexState(indexResult.stdout);
  const dirtyEntries = parseDirtyStatus(statusResult.stdout);
  const dirty = new Map<string, GitDirtyState>();
  for (const entry of dirtyEntries) {
    dirty.set(entry.path, await dirtyState(root, entry));
  }
  const paths = [...new Set([...index.keys(), ...dirty.keys()])].sort();
  const files = paths.map((path) => Object.freeze({
    path,
    index: index.get(path) ?? null,
    dirty: dirty.get(path) ?? null,
  }));
  return Object.freeze({
    root,
    head: head ?? null,
    files: Object.freeze(files),
  });
}

function fileStateKey(value: GitWorkspaceFileState | undefined): string {
  if (!value) return '[absent]';
  return JSON.stringify({ index: value.index, dirty: value.dirty });
}

function lineEditCount(
  before: readonly string[],
  after: readonly string[],
): number {
  if (
    before.length === after.length &&
    before.every((line, index) => line === after[index])
  ) {
    return 0;
  }
  const maximum = before.length + after.length;
  let frontier = new Map<number, number>([[1, 0]]);
  for (let distance = 0; distance <= maximum; distance += 1) {
    const next = new Map<number, number>();
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = frontier.get(diagonal + 1) ?? -1;
      const right = (frontier.get(diagonal - 1) ?? -1) + 1;
      let x = diagonal === -distance || (diagonal !== distance && right < down)
        ? down
        : right;
      let y = x - diagonal;
      while (
        x < before.length &&
        y < after.length &&
        before[x] === after[y]
      ) {
        x += 1;
        y += 1;
      }
      if (x >= before.length && y >= after.length) return distance;
      next.set(diagonal, x);
    }
    frontier = next;
  }
  return maximum;
}

async function blobLines(
  root: string,
  oid: string | undefined,
  cache: Map<string, readonly string[]>,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  if (!oid) return Object.freeze([]);
  const cached = cache.get(oid);
  if (cached) return cached;
  const result = await execa('git', ['cat-file', 'blob', oid], {
    cwd: root,
    cancelSignal: signal,
    reject: false,
    stdin: 'ignore',
    encoding: 'buffer',
  });
  if (result.exitCode !== 0) throw new Error(`git cannot read workspace blob ${oid}`);
  const lines = lineDigests(result.stdout ?? new Uint8Array());
  cache.set(oid, lines);
  return lines;
}

async function worktreeLines(
  root: string,
  state: GitWorkspaceFileState | undefined,
  cache: Map<string, readonly string[]>,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  if (!state) return Object.freeze([]);
  if (state.dirty) return state.dirty.lines;
  return await blobLines(root, state.index?.oid, cache, signal);
}

/** Compare two snapshots without treating untouched entry dirt as attempt work. */
export async function compareGitWorkspaceSnapshots(
  before: GitWorkspaceSnapshot,
  after: GitWorkspaceSnapshot,
  signal?: AbortSignal,
): Promise<GitWorkspaceDelta> {
  if (before.root !== after.root) {
    throw new Error('git workspace root changed during the attempt');
  }
  const beforeFiles = new Map(before.files.map((file) => [file.path, file]));
  const afterFiles = new Map(after.files.map((file) => [file.path, file]));
  const changedPaths = [...new Set([
    ...beforeFiles.keys(),
    ...afterFiles.keys(),
  ])]
    .filter(
      (path) =>
        fileStateKey(beforeFiles.get(path)) !== fileStateKey(afterFiles.get(path)),
    )
    .sort();

  const cache = new Map<string, readonly string[]>();
  let linesChanged = 0;
  for (const path of changedPaths) {
    const beforeState = beforeFiles.get(path);
    const afterState = afterFiles.get(path);
    const [beforeWorktree, afterWorktree, beforeIndex, afterIndex] =
      await Promise.all([
        worktreeLines(before.root, beforeState, cache, signal),
        worktreeLines(after.root, afterState, cache, signal),
        blobLines(before.root, beforeState?.index?.oid, cache, signal),
        blobLines(after.root, afterState?.index?.oid, cache, signal),
      ]);
    linesChanged += Math.max(
      lineEditCount(beforeWorktree, afterWorktree),
      lineEditCount(beforeIndex, afterIndex),
    );
    if (!Number.isSafeInteger(linesChanged)) {
      throw new Error('workspace line count exceeded the safe integer range');
    }
  }

  return Object.freeze({
    headChanged: before.head !== after.head,
    changedPaths: Object.freeze(changedPaths),
    filesChanged: changedPaths.length,
    linesChanged,
  });
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

// Serialize metadata changes within this process and common Git directory only.
const worktreeQueues = new Map<string, Promise<void>>();

async function withWorktreeQueue<T>(
  repoDir: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const common = await git(['rev-parse', '--git-common-dir'], { cwd: repoDir, signal });
  if (common.exitCode !== 0) throw new Error('git common directory unavailable');
  const key = await realpath(resolve(repoDir, common.stdout.trim()));
  const result = (worktreeQueues.get(key) ?? Promise.resolve()).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  worktreeQueues.set(key, tail);
  try {
    return await result;
  } finally {
    if (worktreeQueues.get(key) === tail) worktreeQueues.delete(key);
  }
}

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
  return withWorktreeQueue(repoDir, opts.signal, async () => {
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
  });
}

/** Remove a worktree (force-discards anything uncommitted left in it). */
export async function removeWorktree(
  repoDir: string,
  dir: string,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  await withWorktreeQueue(repoDir, opts.signal, () => git(['worktree', 'remove', '--force', dir], {
    cwd: repoDir,
    signal: opts.signal,
  }));
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
