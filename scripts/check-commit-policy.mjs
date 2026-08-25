#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const EXPECTED_NAME = 'Jonny Neill';
const EXPECTED_EMAIL = 'jonnyneill@hotmail.com';
const EXPECTED_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICFRtiuaPtCSNS9gSKWPxHna590mlLMOQ+eGh7XCh6Xg';
const SIGNATURE_BOUNDARY_PATH = 'packages/lines/package.json';
const LONDON = 'Europe/London';
const WORKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
const HEADER = /^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([a-z0-9][a-z0-9._/-]*\))?!?: [a-z0-9](?:[^\r\n]*[^.\s\r\n])?$/;
const ATTRIBUTION = new RegExp(
  `(?:${'gene' + 'rated'} (?:with|by) (?:claude|codex)|` +
    `${'co-' + 'authored-by'}:.*(?:claude|openai)|` +
    `claude\\.ai/code/${'sess' + 'ion'}_)`,
  'i',
);

export function isAllowedCommitTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid commit time: ${value}`);

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: LONDON,
      weekday: 'short',
      hour: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const hour = Number(parts.hour);
  return !WORKDAYS.has(parts.weekday) || hour < 8 || hour >= 18;
}

export function assertConventionalMessage(message) {
  const header = message.split(/\r?\n/, 1)[0] ?? '';
  if (!HEADER.test(header)) {
    throw new Error(
      'Commit header must use Conventional Commits, start its description in lowercase, and have no final period.',
    );
  }
  if (ATTRIBUTION.test(message)) {
    throw new Error('Commit messages must not contain automated attribution.');
  }
}

function git(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

function gitConfig(name) {
  return git(['config', '--get', name]).trim();
}

function normalisePublicKey(value) {
  const words = value.trim().split(/\s+/);
  return words.length >= 2 ? `${words[0]} ${words[1]}` : value.trim();
}

function configuredPublicKey() {
  const configured = gitConfig('user.signingkey');
  if (configured.startsWith('ssh-')) return normalisePublicKey(configured);
  return normalisePublicKey(readFileSync(resolve(configured), 'utf8'));
}

function assertCurrentPolicy() {
  const failures = [];
  if (gitConfig('user.name') !== EXPECTED_NAME) failures.push(`user.name must be ${EXPECTED_NAME}`);
  if (gitConfig('user.email') !== EXPECTED_EMAIL) failures.push(`user.email must be ${EXPECTED_EMAIL}`);
  if (gitConfig('gpg.format') !== 'ssh') failures.push('gpg.format must be ssh');
  if (gitConfig('commit.gpgsign') !== 'true') failures.push('commit.gpgsign must be true');
  if (configuredPublicKey() !== EXPECTED_KEY) failures.push('user.signingkey is not the trusted key');
  if (!isAllowedCommitTime(new Date())) {
    failures.push('commits are blocked during the hours the local commit policy names on the policy weekdays');
  }
  if (failures.length) throw new Error(failures.join('\n'));
}

function commitDetails(commit, options = {}) {
  const fields = git([
    'show',
    '--no-patch',
    '--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%aI%x00%cI',
    commit,
  ], options).trimEnd().split('\0');
  if (fields.length !== 7) throw new Error(`Could not read commit metadata for ${commit}`);
  const [hash, authorName, authorEmail, committerName, committerEmail, authorTime, committerTime] = fields;
  return { hash, authorName, authorEmail, committerName, committerEmail, authorTime, committerTime };
}

function assertGoodSshSignature(commit, options = {}) {
  const expectedKey = options.expectedKey ?? EXPECTED_KEY;
  const object = git(['cat-file', 'commit', commit], options);
  if (!object.includes('gpgsig -----BEGIN SSH SIGNATURE-----')) {
    throw new Error(`${commit} does not contain an SSH signature`);
  }

  const directory = mkdtempSync(join(tmpdir(), 'obversa-signature-'));
  const allowed = join(directory, 'allowed_signers');
  try {
    writeFileSync(allowed, `${EXPECTED_EMAIL} ${expectedKey}\n`, { mode: 0o600 });
    git([
      '-c',
      `gpg.ssh.allowedSignersFile=${allowed}`,
      '-c',
      'gpg.minTrustLevel=fully',
      'verify-commit',
      commit,
    ], options);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertCommit(commit, options = {}) {
  const details = commitDetails(commit, options);
  const failures = [];
  if (details.authorName !== EXPECTED_NAME || details.committerName !== EXPECTED_NAME) {
    failures.push('author and committer names must be Jonny Neill');
  }
  if (details.authorEmail !== EXPECTED_EMAIL || details.committerEmail !== EXPECTED_EMAIL) {
    failures.push('author and committer emails must be jonnyneill@hotmail.com');
  }
  if (!isAllowedCommitTime(details.authorTime) || !isAllowedCommitTime(details.committerTime)) {
    failures.push('author and committer times must be outside the hours the local commit policy names');
  }
  if (failures.length) throw new Error(`${details.hash}: ${failures.join('; ')}`);

  const message = git(['show', '--no-patch', '--format=%B', details.hash], options);
  assertConventionalMessage(message);
  if (options.requireSignature !== false) assertGoodSshSignature(details.hash, options);
}

function commitsInRange(range, options = {}) {
  return git(['rev-list', '--reverse', range], options)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function assertCommitRange(range, options = {}) {
  const commits = commitsInRange(range, options);
  if (!commits.length) throw new Error(`No commits found in range: ${range}`);
  for (const commit of commits) assertCommit(commit, options);
  return commits.length;
}

function firstSignatureBoundary(options = {}) {
  const [commit] = git([
    'log',
    '--reverse',
    '--format=%H',
    '--diff-filter=A',
    'HEAD',
    '--',
    SIGNATURE_BOUNDARY_PATH,
  ], options)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!commit) {
    throw new Error(`No commit introduces ${SIGNATURE_BOUNDARY_PATH}.`);
  }
  return commit;
}

function commitsFromBoundary(boundary, options = {}) {
  const [commit, firstParent] = git(['rev-list', '--parents', '-n', '1', boundary], options)
    .trim()
    .split(/\s+/);
  if (commit !== boundary) throw new Error(`Could not read signature boundary ${boundary}.`);
  return commitsInRange(firstParent ? `${firstParent}..HEAD` : 'HEAD', options);
}

export function assertInitialHistory(options = {}) {
  const history = commitsInRange('HEAD', options);
  if (!history.length) throw new Error('No commits found at HEAD.');
  const boundary = firstSignatureBoundary(options);
  const commits = commitsFromBoundary(boundary, options);
  if (!commits.includes(boundary)) {
    throw new Error(`Signature boundary ${boundary} is not reachable from HEAD.`);
  }
  for (const commit of commits) {
    assertCommit(commit, options);
  }
  const legacyCount = history.length - commits.length;
  console.log(
    `Initial-history policy passed for ${commits.length} commit(s) from ${boundary.slice(0, 12)}; ` +
      `ignored ${legacyCount} pre-Lines legacy commit(s).`,
  );
}

function usage() {
  return [
    `Usage: ${basename(process.argv[1])} [--now | --message <file> | --head | --all | --initial-history | --range <revision-range>]`,
    'No option is the same as --now.',
  ].join('\n');
}

export function parsePolicyArgs(args) {
  const [mode = '--now', value, ...extra] = args;
  const takesNoValue =
    mode === '--now' ||
    mode === '--head' ||
    mode === '--all' ||
    mode === '--initial-history';
  if (extra.length || (takesNoValue ? value !== undefined : value === undefined)) {
    throw new Error(usage());
  }
  return { mode, value };
}

function main(args) {
  const { mode, value } = parsePolicyArgs(args);

  switch (mode) {
    case '--now':
      if (value !== undefined) throw new Error(usage());
      assertCurrentPolicy();
      console.log('Commit identity, signing, and time policy passed.');
      return;
    case '--message':
      assertConventionalMessage(readFileSync(resolve(value), 'utf8'));
      console.log('Commit message policy passed.');
      return;
    case '--head':
      if (value !== undefined) throw new Error(usage());
      assertCommit('HEAD');
      console.log('HEAD commit policy passed.');
      return;
    case '--all': {
      if (value !== undefined) throw new Error(usage());
      const commits = commitsInRange('HEAD');
      if (!commits.length) throw new Error('No commits found at HEAD.');
      for (const commit of commits) assertCommit(commit);
      console.log(`Commit policy passed for all ${commits.length} commit(s).`);
      return;
    }
    case '--initial-history':
      if (value !== undefined) throw new Error(usage());
      assertInitialHistory();
      return;
    case '--range': {
      const count = assertCommitRange(value);
      console.log(`Commit policy passed for ${count} commit(s).`);
      return;
    }
    default:
      throw new Error(usage());
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
