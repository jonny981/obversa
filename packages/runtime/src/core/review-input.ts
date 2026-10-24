/**
 * What a reviewer reads of a change: the diff against where the branch left
 * its base, then every new file whole. When that does not fit the reviewer's
 * engine, data files are listed by path, size and sha256 instead of inlined,
 * then the largest other new files, until the rest fits.
 */

import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';

import { mapWithConcurrency } from './concurrency.js';
import { processText, runRuntimeProcess } from './process.js';
import type { JobContext } from './types.js';

/** A file the change names but does not inline. */
export interface ListedFile {
  readonly path: string;
  /** The file's size in the worktree; 0 for a deleted file. */
  readonly bytes: number;
  /** The sha256 of the file in the worktree; absent for a deleted file. */
  readonly sha256?: string;
}

export interface ChangeUnderReview {
  /** The change as the reviewer reads it. */
  readonly text: string;
  /** The files named by path instead of inlined. */
  readonly listed: readonly ListedFile[];
  /** False when the change is larger than the budget even with every permitted file listed. */
  readonly fits: boolean;
  /** Every changed file by the characters it adds to the change, largest first. */
  readonly largest: readonly { readonly path: string; readonly characters: number }[];
}

export interface ChangeUnderReviewOptions {
  /** What the change is measured against; the diff starts where the branch left it. */
  readonly base: string;
  /** The most characters the change may take; no budget inlines everything. */
  readonly budget?: number;
  /** The worktree. Default: the step's workspace. */
  readonly cwd?: string;
}

interface ChangeOptions extends ChangeUnderReviewOptions {
  readonly cwd: string;
  /** Paths left out of the change: the run's own record and files. */
  readonly excludePaths?: readonly string[];
  readonly signal?: AbortSignal;
}

// Line-record and table files, logs and git bundles. JSON counts as data
// too: a small one stays inlined while the change fits.
const DATA_EXTENSIONS = new Set(['.jsonl', '.ndjson', '.csv', '.tsv', '.log', '.bundle', '.json']);

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<{ stdout: string; ok: boolean }> {
  const r = await runRuntimeProcess({ executable: 'git', args, cwd, ...(signal ? { signal } : {}) });
  return { stdout: processText(r.stdout), ok: r.exitCode === 0 };
}

/**
 * The worktree's files as a git tree, staged or not, untracked files
 * included and ignored files left out, without touching the repository's
 * index. Two calls on the same files give the same tree.
 */
export { workTree as workspaceTree } from './git.js';

/** The diff between two trees `workspaceTree` wrote; `undefined` when git cannot compare them. */
export async function diffTrees(cwd: string, from: string, to: string, signal?: AbortSignal): Promise<string | undefined> {
  const r = await git(cwd, ['diff', '--no-color', from, to], signal);
  return r.ok ? r.stdout.trim() : undefined;
}

function isDataPath(path: string): boolean {
  return DATA_EXTENSIONS.has(extname(path).toLowerCase());
}

function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

interface Entry {
  readonly path: string;
  /** The section the change inlines for this file. */
  readonly section: string;
  /** New since the base: untracked, or added on the branch. A new file may be listed. */
  readonly added: boolean;
  readonly data: boolean;
}

async function listedFile(cwd: string, path: string): Promise<ListedFile> {
  try {
    const contents = await readFile(join(cwd, path));
    return { path, bytes: contents.length, sha256: createHash('sha256').update(contents).digest('hex') };
  } catch {
    return { path, bytes: 0 };
  }
}

function listedLine(file: ListedFile): string {
  return file.sha256 === undefined
    ? `=== listed, not inlined: ${file.path} (deleted) ===`
    : `=== listed, not inlined: ${file.path} (${file.bytes} bytes, sha256 ${file.sha256}); read it from the worktree ===`;
}

async function untrackedSection(cwd: string, path: string): Promise<{ section: string; binary: boolean }> {
  const full = join(cwd, path);
  const stat = await lstat(full);
  // A new symlink is shown by where it points: reading it would follow it.
  if (stat.isSymbolicLink()) return { section: `=== new symlink ${path} -> ${await readlink(full)} ===`, binary: false };
  const contents = await readFile(full);
  const binary = isBinary(contents);
  return {
    section: binary
      ? `=== new file ${path} (binary, ${contents.length} bytes) ===`
      : `=== new file ${path} ===\n${contents.toString('utf8')}`,
    binary,
  };
}

function excluded(cwd: string, excludePaths: readonly string[] | undefined): Set<string> {
  return new Set((excludePaths ?? [])
    .map((path) => relative(cwd, resolve(cwd, path)).replace(/\\/g, '/'))
    .filter((path) => path && !path.startsWith('..')));
}

/** An excluded path, or a file inside an excluded directory. */
function isExcluded(skip: ReadonlySet<string>, path: string): boolean {
  if (skip.has(path)) return true;
  for (const dir of skip) if (path.startsWith(`${dir}/`)) return true;
  return false;
}

/**
 * The change as a reviewer reads it, within `budget` characters. The diff
 * runs from where the branch left `base`, so a base that moves on during a
 * run does not show as undone work. The run's own record and files are
 * left out.
 */
export function changeUnderReview(ctx: JobContext, options: ChangeUnderReviewOptions): Promise<ChangeUnderReview> {
  return changeIn({
    ...options,
    cwd: options.cwd ?? ctx.workspace.dir,
    signal: ctx.signal,
    ...(ctx.fingerprintExcludePaths === undefined ? {} : { excludePaths: ctx.fingerprintExcludePaths }),
  });
}

/** `changeUnderReview` with every input given. */
export async function changeIn(options: ChangeOptions): Promise<ChangeUnderReview> {
  const { cwd, signal } = options;
  const mergeBase = await git(cwd, ['merge-base', options.base, 'HEAD'], signal);
  const from = mergeBase.ok ? mergeBase.stdout.trim() : options.base;
  const skip = excluded(cwd, options.excludePaths);
  const untracked = (await git(cwd, ['ls-files', '-z', '--others', '--exclude-standard'], signal)).stdout
    .split('\0').filter((path) => path && !isExcluded(skip, path));
  const whole = async (): Promise<string> => {
    const diff = (await git(cwd, ['diff', '--no-color', from, '--', '.', ...[...skip].map((path) => `:(exclude,top,literal)${path}`)], signal)).stdout;
    const added = await mapWithConcurrency(untracked, 8, async (path) => (await untrackedSection(cwd, path)).section);
    return [diff, ...added].join('\n\n').trim() || '(no change)';
  };
  const budget = options.budget;
  const text = await whole();
  // The common case: the whole change fits, and one git call made it.
  if (budget === undefined || text.length <= budget) {
    return { text, listed: [], fits: true, largest: [] };
  }

  // Per file, so each one can be inlined or listed on its own.
  const status = (await git(cwd, ['diff', '--no-renames', '--name-status', '-z', from], signal)).stdout.split('\0');
  const tracked: { path: string; added: boolean }[] = [];
  for (let i = 0; i + 1 < status.length; i += 2) {
    const path = status[i + 1]!;
    if (!isExcluded(skip, path)) tracked.push({ path, added: status[i] === 'A' });
  }
  const entries: Entry[] = [
    ...await mapWithConcurrency(tracked, 8, async ({ path, added }) => {
      const section = (await git(cwd, ['diff', '--no-color', '--no-renames', from, '--', `:(top,literal)${path}`], signal)).stdout.trim();
      return { path, section, added, data: isDataPath(path) || /^Binary files /m.test(section) };
    }),
    ...await mapWithConcurrency(untracked, 8, async (path) => {
      const { section, binary } = await untrackedSection(cwd, path);
      return { path, section, added: true, data: isDataPath(path) || binary };
    }),
  ];
  const largest = [...entries]
    .map((entry) => ({ path: entry.path, characters: entry.section.length }))
    .sort((a, b) => b.characters - a.characters);

  // Data files go first, largest first, whether new or changed; then the
  // largest other new files. Code and docs that were there before keep
  // their diff inlined.
  const bySize = (a: Entry, b: Entry) => b.section.length - a.section.length;
  const order = [
    ...entries.filter((entry) => entry.data).sort(bySize),
    ...entries.filter((entry) => !entry.data && entry.added).sort(bySize),
  ];
  const listed = new Map<string, ListedFile>();
  const render = () => entries
    .map((entry) => {
      const file = listed.get(entry.path);
      return file === undefined ? entry.section : listedLine(file);
    })
    .join('\n\n')
    .trim() || '(no change)';
  let rendered = render();
  for (const entry of order) {
    if (rendered.length <= budget) break;
    listed.set(entry.path, await listedFile(cwd, entry.path));
    rendered = render();
  }
  return { text: rendered, listed: [...listed.values()], fits: rendered.length <= budget, largest };
}

/** What a send-back or a pause says about a change too large for a reviewer. */
export function changeTooLarge(change: ChangeUnderReview, characters: number, engine: string, limit: number): string {
  const files = change.largest.slice(0, 5).map((file) => `${file.path} (${file.characters} characters)`).join(', ');
  return `the review input is ${characters} characters with every data file listed, and ${engine} takes at most ${limit}`
    + (files ? `; the largest files in the change: ${files}` : '');
}
