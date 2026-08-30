#!/usr/bin/env node
// The one skill-install helper (an internal note): wrap the pinned skills
// CLI's add, update, and remove for the review-diff skill with an ownership
// preflight, and nothing else. With --yes the bare CLI silently replaces a
// foreign skill that happens to share the name, and remove deletes a
// same-name path without proving who installed it; the preflight is the
// difference.
//
// Ownership means all three of: a lock entry whose source names the Obversa
// repository handed to this command (the CLI normalizes a GitHub source to
// owner/repo, so the URL forms that normalize the same match); a canonical
// copy that carries the entry's content — for a local install the CLI's own
// sha256 directory hash, recomputed here, and for a GitHub install (a git
// tree hash no local walk can recompute) the copy's presence with its
// SKILL.md; and a Claude Code path that is exactly a symlink to that
// canonical copy. A source string alone proves nothing.

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);

export const SKILL = 'review-diff';
export const CLI_SPEC = 'skills@1.5.17';

// The CLI runs through npx from the pinned npm, by real path under this
// Node: never whichever npx is first on PATH.
const NPX_CLI = join(dirname(require.resolve('npm/package.json')), 'bin', 'npx-cli.js');

export function paths(home = process.env.HOME ?? homedir()) {
  return {
    canonical: join(home, '.agents', 'skills', SKILL),
    claude: join(home, '.claude', 'skills', SKILL),
    lock: join(home, '.agents', '.skill-lock.json'),
  };
}

// The CLI's own folder hash, reproduced byte for byte.
export function folderHash(directory) {
  const files = [];
  const collect = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        collect(join(current, entry.name));
      } else if (entry.isFile()) {
        const fullPath = join(current, entry.name);
        files.push({ relativePath: fullPath.slice(directory.length + 1), content: readFileSync(fullPath) });
      }
    }
  };
  collect(directory);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update(file.content);
  }
  return hash.digest('hex');
}

// The CLI records a GitHub source as its normalized owner/repo; this
// comparison accepts the URL forms that normalize to the same repository.
export function sameSource(recorded, given) {
  if (recorded === given) return true;
  const normalize = (value) =>
    String(value)
      .replace(/^git@github\.com:/i, '')
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/\.git$/i, '')
      .replace(/\/$/, '')
      .toLowerCase();
  return normalize(recorded) === normalize(given);
}

// Why ownership does not hold, or null when it holds in full. The content
// check depends on what the CLI recorded: a local install carries the
// sha256 directory hash this module recomputes; a GitHub install carries a
// git tree hash no local walk can recompute, so ownership there rests on
// the matching entry, the canonical copy's presence with its SKILL.md, and
// the exact Claude Code link.
export function ownershipFailure(source, { canonical, claude, lock } = paths()) {
  let entry;
  try {
    entry = JSON.parse(readFileSync(lock, 'utf8'))?.skills?.[SKILL];
  } catch {
    entry = undefined;
  }
  if (!entry) return `${lock}: no lock entry for ${SKILL}`;
  if (!sameSource(entry.source, source)) return `${lock}: the ${SKILL} entry's source is ${JSON.stringify(entry.source)}, not this repository`;
  if (!existsSync(canonical)) return `${canonical}: the canonical copy is missing`;
  if (/^[0-9a-f]{64}$/.test(entry.skillFolderHash ?? '')) {
    const hash = folderHash(canonical);
    if (hash !== entry.skillFolderHash) return `${canonical}: directory hash ${hash} does not equal the lock entry's ${entry.skillFolderHash}`;
  } else if (!existsSync(join(canonical, 'SKILL.md'))) {
    return `${canonical}: the canonical copy holds no SKILL.md`;
  }
  let stat;
  try {
    stat = lstatSync(claude);
  } catch {
    return `${claude}: the Claude Code path is missing`;
  }
  if (!stat.isSymbolicLink()) return `${claude}: the Claude Code path is not a symlink`;
  const target = resolve(dirname(claude), readlinkSync(claude));
  if (realpathSync(target) !== realpathSync(canonical)) return `${claude}: links ${target}, not the canonical copy`;
  return null;
}

// The exact CLI argv for each action; exported so the spec pins them.
export function cliArguments(action, source) {
  if (action === 'remove') return ['-y', CLI_SPEC, 'remove', SKILL, '--global', '--agent', 'claude-code', 'codex'];
  return ['-y', CLI_SPEC, 'add', source, '--skill', SKILL, '--global', '--agent', 'claude-code', 'codex', '--full-depth', '--yes'];
}

export function preflight(action, source, at = paths()) {
  if (action === 'remove') {
    const failure = ownershipFailure(source, at);
    if (failure) return `remove refused: ownership does not hold — ${failure}`;
    return null;
  }
  // add and update: an existing path that this repository does not own, in
  // full, stops before the CLI deletes anything. A missing lock record never
  // permits an overwrite.
  if (!existsSync(at.canonical) && !existsSync(at.claude) && !(() => { try { return lstatSync(at.claude).isSymbolicLink(); } catch { return false; } })()) {
    return null;
  }
  const failure = ownershipFailure(source, at);
  if (failure) return `${action} refused: a ${SKILL} install already exists and ownership does not hold — ${failure}`;
  return null;
}

export function runHelper(action, source, { at = paths(), run } = {}) {
  if (!['add', 'update', 'remove'].includes(action)) {
    throw new Error(`Usage: skill-install.mjs add|update|remove <source>`);
  }
  if (typeof source !== 'string' || source.length === 0) {
    throw new Error('The Obversa repository source (a Git URL or path) is required');
  }
  const refusal = preflight(action, source, at);
  if (refusal) return { status: 1, refusal };
  const execute = run ?? ((args) => spawnSync(process.execPath, [NPX_CLI, ...args], { stdio: 'inherit' }));
  const result = execute(cliArguments(action, source));
  return { status: result.status ?? 0, refusal: null };
}

const isMain = process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  const [action, source] = process.argv.slice(2);
  try {
    const { status, refusal } = runHelper(action, source);
    if (refusal) console.error(refusal);
    process.exitCode = status;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
