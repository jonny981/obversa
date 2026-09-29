// The shared shape behind pnpm ci:local's proof. write-ci-proof.mjs writes
// one after every check in ci:local has passed; stage-merge.mjs's finish
// step reads it back and refuses to land without a fresh one. Not the
// prepack build-proof record (packages/*'s dist hashes): this one is about
// a whole local run of the CI job, not a build.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

export const CI_PROOF_PATH = join('.obversa', 'ci-proof.json');
export const CI_LOCAL_COMMAND = 'pnpm ci:local';
export const STALE_MESSAGE = 'run `pnpm ci:local` on this tree first';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** The commit tree ci:local ran against, once it is committed. */
export function currentTreeHash(cwd) {
  return git(cwd, 'rev-parse', 'HEAD^{tree}').trim();
}

/**
 * Include the index and the files on disk, so both staged and unstaged
 * changes invalidate a proof. Hash a symlink's destination path.
 */
export function currentFilesDigest(cwd) {
  const hash = createHash('sha256');
  for (const entry of git(cwd, 'ls-files', '-s', '-z').split('\0').filter(Boolean)) {
    const path = join(cwd, entry.slice(entry.indexOf('\t') + 1));
    let file;
    try {
      const stat = lstatSync(path);
      const link = stat.isSymbolicLink();
      const content = createHash('sha256')
        .update(link ? readlinkSync(path) : readFileSync(path)).digest('hex');
      file = [link ? 'link' : 'file', stat.mode & 0o111, content];
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      file = ['missing'];
    }
    hash.update(`${JSON.stringify([entry, ...file])}\n`);
  }
  return hash.digest('hex');
}

export function buildCiProof(cwd) {
  return {
    schemaVersion: 1,
    treeHash: currentTreeHash(cwd),
    filesDigest: currentFilesDigest(cwd),
    ranAt: new Date().toISOString(),
    command: CI_LOCAL_COMMAND,
  };
}

export function readCiProof(cwd) {
  const path = join(cwd, CI_PROOF_PATH);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Throws with one plain sentence when the proof is missing, unreadable, or does not match this tree. */
export function assertFreshCiProof(cwd) {
  const record = readCiProof(cwd);
  if (!record || typeof record.treeHash !== 'string' || typeof record.filesDigest !== 'string') {
    throw new Error(STALE_MESSAGE);
  }
  if (record.treeHash !== currentTreeHash(cwd) || record.filesDigest !== currentFilesDigest(cwd)) {
    throw new Error(STALE_MESSAGE);
  }
}
