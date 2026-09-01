import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as commitPolicy from './check-commit-policy.mjs';

const { assertConventionalMessage, isAllowedCommitTime, parsePolicyArgs } = commitPolicy;

const scripts = dirname(fileURLToPath(import.meta.url));

function run(command, args, cwd, expectedStatus = 0, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(
    result.status,
    expectedStatus,
    [result.stdout, result.stderr].filter(Boolean).join('\n'),
  );
  return result.stdout.trim();
}

function createSignedHistory({ unsignedBetweenLinesAndRuntime = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'obversa-commit-policy-'));
  const repository = join(directory, 'repository');
  const signingKey = join(directory, 'signing-key');
  run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', signingKey], directory);
  const publicKey = readFileSync(`${signingKey}.pub`, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');

  run('git', ['init', '--quiet', repository], directory);
  run('git', ['config', 'user.name', 'Jonny Neill'], repository);
  run('git', ['config', 'user.email', 'jonnyneill@hotmail.com'], repository);
  run('git', ['config', 'gpg.format', 'ssh'], repository);
  run('git', ['config', 'user.signingkey', signingKey], repository);
  run('git', ['config', 'commit.gpgsign', 'true'], repository);

  const legacyEnvironment = {
    GIT_AUTHOR_NAME: 'Legacy Author',
    GIT_AUTHOR_EMAIL: 'legacy@example.test',
    GIT_COMMITTER_NAME: 'Legacy Author',
    GIT_COMMITTER_EMAIL: 'legacy@example.test',
    GIT_AUTHOR_DATE: '2026-08-14T10:35:00+01:00',
    GIT_COMMITTER_DATE: '2026-08-14T10:35:00+01:00',
  };
  run(
    'git',
    ['commit', '--allow-empty', '--quiet', '--no-gpg-sign', '-m', 'messy legacy work'],
    repository,
    0,
    legacyEnvironment,
  );

  mkdirSync(join(repository, 'packages', 'lines'), { recursive: true });
  const legacyRuntimeName = `@obversa/${'li' + 'nes'}`;
  writeFileSync(
    join(repository, 'packages', 'lines', 'package.json'),
    `${JSON.stringify({ name: legacyRuntimeName })}\n`,
  );
  run('git', ['add', 'packages/lines/package.json'], repository);
  const boundaryEnvironment = {
    GIT_AUTHOR_DATE: '2026-08-24T23:00:00+01:00',
    GIT_COMMITTER_DATE: '2026-08-24T23:00:00+01:00',
  };
  run(
    'git',
    ['commit', '--quiet', '-m', 'feat(lines): add the graph runtime'],
    repository,
    0,
    boundaryEnvironment,
  );

  if (unsignedBetweenLinesAndRuntime) {
    run(
      'git',
      ['commit', '--allow-empty', '--quiet', '--no-gpg-sign', '-m', 'fix(lines): expose skipped history'],
      repository,
      0,
      boundaryEnvironment,
    );
  }

  mkdirSync(join(repository, 'packages', 'runtime'), { recursive: true });
  run('git', ['mv', 'packages/lines/package.json', 'packages/runtime/package.json'], repository);
  writeFileSync(join(repository, 'packages', 'runtime', 'package.json'), '{"name":"@obversa/runtime"}\n');
  run('git', ['add', 'packages/runtime/package.json'], repository);
  run(
    'git',
    ['commit', '--quiet', '-m', 'refactor(runtime)!: rename the graph runtime'],
    repository,
    0,
    boundaryEnvironment,
  );

  writeFileSync(join(repository, 'packages', 'runtime', 'README.md'), '# Runtime\n');
  run('git', ['add', 'packages/runtime/README.md'], repository);
  const laterEnvironment = {
    GIT_AUTHOR_DATE: '2026-08-25T23:15:00+01:00',
    GIT_COMMITTER_DATE: '2026-08-25T23:15:00+01:00',
  };
  run(
    'git',
    ['commit', '--quiet', '-m', 'docs(runtime): explain the runtime'],
    repository,
    0,
    laterEnvironment,
  );

  return { directory, repository, publicKey, laterEnvironment };
}

test('blocks the London working window on weekdays', () => {
  assert.equal(isAllowedCommitTime('2026-08-24T07:00:00Z'), false);
  assert.equal(isAllowedCommitTime('2026-08-24T16:59:59Z'), false);
});

test('allows the London window boundaries outside working hours', () => {
  assert.equal(isAllowedCommitTime('2026-08-24T06:59:59Z'), true);
  assert.equal(isAllowedCommitTime('2026-08-24T17:00:00Z'), true);
});

test('allows every hour at the weekend', () => {
  assert.equal(isAllowedCommitTime('2026-08-23T11:00:00Z'), true);
});

test('accepts conventional public commit messages', () => {
  assert.doesNotThrow(() =>
    assertConventionalMessage('feat(lines): seed the graph runtime\n\nExplain why.'),
  );
  assert.doesNotThrow(() =>
    assertConventionalMessage('feat(memory)!: freeze the port\n\nBREAKING CHANGE: freeze the commands'),
  );
});

test('rejects non-conventional or attributed commit messages', () => {
  assert.throws(() => assertConventionalMessage('Seed the graph runtime'));
  assert.throws(() => assertConventionalMessage('feat: seed the graph runtime.'));
  assert.throws(() =>
    assertConventionalMessage(
      `feat: seed the graph runtime\n\n${'Co-' + 'Authored-By'}: ${'Clau' + 'de'} <x@example.test>`,
    ),
  );
});

test('accepts initial-history mode without a value', () => {
  assert.deepEqual(parsePolicyArgs(['--initial-history']), {
    mode: '--initial-history',
    value: undefined,
  });
  assert.throws(() => parsePolicyArgs(['--initial-history', 'HEAD']));
});

test('initial history ignores noncompliant unsigned commits before Lines', () => {
  const fixture = createSignedHistory();
  try {
    assert.equal(typeof commitPolicy.assertInitialHistory, 'function');
    assert.doesNotThrow(() =>
      commitPolicy.assertInitialHistory({
        cwd: fixture.repository,
        expectedKey: fixture.publicKey,
      }),
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('initial history rejects an unsigned commit after Lines', () => {
  const fixture = createSignedHistory();
  try {
    run(
      'git',
      ['commit', '--allow-empty', '--quiet', '--no-gpg-sign', '-m', 'fix(lines): expose bad history'],
      fixture.repository,
      0,
      fixture.laterEnvironment,
    );
    assert.equal(typeof commitPolicy.assertInitialHistory, 'function');
    assert.throws(
      () =>
        commitPolicy.assertInitialHistory({
          cwd: fixture.repository,
          expectedKey: fixture.publicKey,
        }),
      /does not contain an SSH signature/,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('initial history follows the Lines package through its runtime rename', () => {
  const fixture = createSignedHistory({ unsignedBetweenLinesAndRuntime: true });
  try {
    assert.throws(
      () =>
        commitPolicy.assertInitialHistory({
          cwd: fixture.repository,
          expectedKey: fixture.publicKey,
        }),
      /does not contain an SSH signature/,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('configures hooks only for the active linked worktree', () => {
  const directory = mkdtempSync(join(tmpdir(), 'obversa-hook-policy-'));
  const repository = join(directory, 'repository');
  const linked = join(directory, 'linked');
  try {
    run('git', ['init', '--quiet', repository], directory);
    run('git', ['config', 'user.name', 'Test User'], repository);
    run('git', ['config', 'user.email', 'test@example.test'], repository);
    run('git', ['commit', '--allow-empty', '--quiet', '--no-gpg-sign', '-m', 'test: seed'], repository);
    run('git', ['worktree', 'add', '--quiet', '-b', 'test/hooks', linked], repository);
    run('git', ['config', '--local', 'core.hooksPath', '.githooks'], repository);
    run('git', ['config', '--local', 'test.keep', 'unchanged'], repository);

    run(process.execPath, [resolve(scripts, 'configure-git-hooks.mjs')], linked);

    assert.equal(run('git', ['config', '--worktree', '--get', 'core.hooksPath'], linked), '.githooks');
    assert.equal(run('git', ['config', '--local', '--get', 'test.keep'], repository), 'unchanged');
    const shared = spawnSync(
      'git',
      ['config', '--local', '--get-all', 'core.hooksPath'],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(shared.status, 1, shared.stdout || shared.stderr);
    assert.equal(shared.stdout, '');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
