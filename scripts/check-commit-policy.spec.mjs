import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

function createSignedHistory({ unsignedBeforeRuntimeRename = false } = {}) {
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

  if (unsignedBeforeRuntimeRename) {
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

// The real policy is private and lives outside the repository; the mechanism
// is proved with a fixture policy that blocks 02:00 to 04:00 UTC on Wednesdays.
const fixturePolicy = { timeZone: 'UTC', blockedWeekdays: ['Wed'], blockedFromHour: 2, blockedToHour: 4 };

test('blocks the policy window on a blocked weekday', () => {
  assert.equal(isAllowedCommitTime('2026-08-26T02:00:00Z', fixturePolicy), false);
  assert.equal(isAllowedCommitTime('2026-08-26T03:59:59Z', fixturePolicy), false);
});

test('allows the window boundaries outside the blocked hours', () => {
  assert.equal(isAllowedCommitTime('2026-08-26T01:59:59Z', fixturePolicy), true);
  assert.equal(isAllowedCommitTime('2026-08-26T04:00:00Z', fixturePolicy), true);
});

test('allows the blocked hours on a day the policy does not name', () => {
  assert.equal(isAllowedCommitTime('2026-08-27T03:00:00Z', fixturePolicy), true);
});

test('enforces nothing when no local policy exists', () => {
  assert.equal(isAllowedCommitTime('2026-08-26T03:00:00Z', null), true);
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

test('initial history ignores noncompliant unsigned commits before the runtime rename', () => {
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

test('initial history rejects an unsigned commit after the runtime rename', () => {
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

test('initial history follows the runtime package through its rename', () => {
  const fixture = createSignedHistory({ unsignedBeforeRuntimeRename: true });
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

// "Now" is always inside this window, whatever day and hour the test runs.
const alwaysBlockedPolicy = {
  timeZone: 'UTC',
  blockedWeekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  blockedFromHour: 0,
  blockedToHour: 24,
};

function policyRepository(branch, policy, config = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'obversa-commit-window-'));
  const repository = join(directory, 'repository');
  const policyFile = join(directory, 'commit-policy.json');
  writeFileSync(policyFile, JSON.stringify(policy));
  run('git', ['init', '--quiet', `--initial-branch=${branch}`, repository], directory);
  for (const [name, value] of Object.entries(config)) run('git', ['config', name, value], repository);
  return { directory, repository, policyFile };
}

function checkNow({ repository, policyFile }) {
  return spawnSync(process.execPath, [resolve(scripts, 'check-commit-policy.mjs'), '--now'], {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, OBVERSA_COMMIT_POLICY: policyFile },
  });
}

test('a branch commit inside the window passes --now', () => {
  const fixture = policyRepository('feat/x', alwaysBlockedPolicy);
  try {
    const result = checkNow(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /time window: not applied on feat\/x/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('a main commit inside the window fails --now', () => {
  const fixture = policyRepository('main', alwaysBlockedPolicy);
  try {
    const result = checkNow(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /commits are blocked by the local commit policy at this time/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('--now still checks identity on a branch', () => {
  const fixture = policyRepository(
    'feat/x',
    { ...alwaysBlockedPolicy, identity: { name: 'Policy Person', email: 'policy@example.test' } },
    { 'user.name': 'Policy Person', 'user.email': 'someone-else@example.test' },
  );
  try {
    const result = checkNow(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /user\.email does not match the local commit policy/);
    assert.doesNotMatch(result.stderr, /blocked by the local commit policy at this time/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('history checks apply the window unless the caller turns it off', () => {
  const fixture = policyRepository('main', fixturePolicy);
  const commit = (message, date) => run(
    'git',
    ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--quiet', '-m', message],
    fixture.repository,
    0,
    { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  );
  run('git', ['config', 'user.name', 'Test User'], fixture.repository);
  run('git', ['config', 'user.email', 'test@example.test'], fixture.repository);
  // A good message inside the Wednesday window, then a bad message outside it.
  commit('feat: add work', '2026-08-26T03:00:00Z');
  commit('add more work', '2026-08-27T03:00:00Z');
  const checkRange = (range, options) => spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { assertCommitRange } from ${JSON.stringify(pathToFileURL(resolve(scripts, 'check-commit-policy.mjs')).href)};
assertCommitRange(${JSON.stringify(range)}, ${JSON.stringify({ cwd: fixture.repository, ...options })});`,
    ],
    { encoding: 'utf8', env: { ...process.env, OBVERSA_COMMIT_POLICY: fixture.policyFile } },
  );
  try {
    const inWindow = checkRange('HEAD~1', {});
    assert.notEqual(inWindow.status, 0);
    assert.match(inWindow.stderr, /author and committer times are blocked by the local commit policy/);
    const windowOff = checkRange('HEAD~1', { timeWindow: false });
    assert.equal(windowOff.status, 0, windowOff.stderr);
    for (const options of [{}, { timeWindow: false }]) {
      const badMessage = checkRange('HEAD~1..HEAD', options);
      assert.notEqual(badMessage.status, 0);
      assert.match(badMessage.stderr, /Commit header must use Conventional Commits/);
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
