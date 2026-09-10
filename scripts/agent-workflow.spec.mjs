import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { manageStage } from './stage-merge.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkInstructions = join(projectRoot, 'scripts', 'check-agent-instructions.mjs');
const checkBranch = join(projectRoot, 'scripts', 'check-workstream-branch.mjs');
const stageMerge = join(projectRoot, 'scripts', 'stage-merge.mjs');
const stageLeaseRef = 'refs/obversa/stage-merge';
const temporaryDirectories = [];

test.after(() => {
  for (const directory of temporaryDirectories.reverse()) {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('accepts one tracked AGENTS file with a CLAUDE link to it', () => {
  const { main } = createRepository({ instructions: 'linked' });

  const result = runNode(checkInstructions, [], main);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Agent instruction links are valid/);
});

test('rejects a separate CLAUDE instruction file that can drift', () => {
  const { main } = createRepository({ instructions: 'copied' });

  const result = runNode(checkInstructions, [], main);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CLAUDE\.md must be a tracked symlink to AGENTS\.md/);
});

test('refuses a commit from the integration branch', () => {
  const { main } = createRepository();

  const result = runNode(checkBranch, [], main);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /main is integration-only/);
});

test('allows a commit from an isolated feature branch', () => {
  const { feature } = createRepository({ feature: true });

  const result = runNode(checkBranch, [], feature);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /feat\/graph-forms-v1/);
});

test('a workstream cannot claim the other workstream stage family', () => {
  const repository = createRepository({ feature: true, branch: 'feat/factory-v1' });

  const result = runStage('claim', 'D2', repository.feature);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /D2 belongs to feat\/graph-forms-v1/);
  assert.equal(existsSync(stageLock(repository)), false);
});

for (const [stage, branch] of [
  ['D14', 'feat/unattended-runner'],
  ['D15', 'feat/release-v1'],
  ['D16', 'feat/runner-hardening'],
  ['D18', 'feat/proof-cache-safe-change'],
  ['D19', 'feat/writer-exclusion'],
  ['D21', 'feat/parity-tests'],
  ['F4', 'feat/release-readiness'],
  ['F5', 'feat/release-wording'],
  ['F7', 'feat/residual-sweep'],
  ['F8', 'feat/residual-sweep-two'],
  ['F11', 'feat/transient-phase-tests'],
  ['F10', 'feat/release-1-1-0'],
  ['F14', 'feat/real-work-test-limits'],
  ['F15', 'feat/browser-proof-budgets'],
  ['D22', 'feat/feature-delivery-example'],
  ['F16', 'feat/source-surfacer-types'],
  ['D34', 'docs/retire-old-positioning'],
  ['D23', 'feat/reader-task-docs'],
  ['D24', 'feat/forge-helper-example'],
  ['D30', 'feat/plugins-page'],
  ['D43', 'docs/reader-first-pages'],
  ['D13', 'feat/graph-forms-v1'],
  ['D11A', 'feat/graph-forms-v1'],
  ['F0', 'feat/factory-v1'],
  ['F2b', 'feat/factory-v1'],
]) {
  test(`${stage} lands from its assigned branch ${branch}`, () => {
    const repository = createRepository({ feature: true, branch });
    commitFile(repository.feature, 'stage.txt', `${stage}\n`, `finish ${stage}`);
    const featureHead = git(repository.feature, 'rev-parse', 'HEAD').stdout.trim();

    const claimed = runStage('claim', stage, repository.feature);
    assert.equal(claimed.status, 0, claimed.stderr);
    assert.equal(readStageLease(repository).owner.branch, branch);
    const finished = runStage('finish', stage, repository.feature);

    assert.equal(finished.status, 0, finished.stderr);
    assert.equal(git(repository.main, 'rev-parse', 'HEAD').stdout.trim(), featureHead);
    assert.equal(readFileSync(join(repository.main, 'stage.txt'), 'utf8'), `${stage}\n`);
    assert.equal(stageClaimExists(repository), false);
  });
}

for (const [stage, branch] of [
  ['D14', 'feat/graph-forms-v1'],
  ['D14', 'feat/release-v1'],
  ['D15', 'feat/graph-forms-v1'],
  ['D15', 'feat/unattended-runner'],
  ['D16', 'feat/graph-forms-v1'],
  ['D18', 'feat/graph-forms-v1'],
  ['D19', 'feat/graph-forms-v1'],
  ['D21', 'feat/graph-forms-v1'],
  ['F4', 'feat/factory-v1'],
  ['F5', 'feat/factory-v1'],
  ['F7', 'feat/factory-v1'],
  ['F8', 'feat/factory-v1'],
  ['F11', 'feat/factory-v1'],
  ['F10', 'feat/factory-v1'],
  ['F14', 'feat/factory-v1'],
  ['F15', 'feat/factory-v1'],
  ['D22', 'feat/lines-v1'],
  ['D22', 'feat/graph-forms-v1'],
  ['F16', 'feat/graph-forms-v1'],
  ['D34', 'feat/graph-forms-v1'],
  ['D23', 'feat/graph-forms-v1'],
  ['D24', 'feat/graph-forms-v1'],
  ['D30', 'feat/graph-forms-v1'],
  ['D43', 'feat/graph-forms-v1'],
]) {
  test(`${stage} refuses the wrong branch ${branch}`, () => {
    const repository = createRepository({ feature: true, branch });
    const before = branchHeads(repository);

    const result = runStage('claim', stage, repository.feature);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot claim/);
    assert.equal(stageClaimExists(repository), false);
    assert.deepEqual(branchHeads(repository), before);
  });
}

test('finishing a stage fast-forwards main to the clean feature branch', () => {
  const repository = createRepository({ feature: true });
  commitFile(repository.feature, 'lines.txt', 'D1\n', 'finish D1');
  const featureHead = git(repository.feature, 'rev-parse', 'HEAD').stdout.trim();
  assert.equal(runStage('claim', 'D1', repository.feature).status, 0);

  const result = runStage('finish', 'D1', repository.feature);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(repository.main, 'rev-parse', 'HEAD').stdout.trim(), featureHead);
  assert.equal(readFileSync(join(repository.main, 'lines.txt'), 'utf8'), 'D1\n');
  assert.match(result.stdout, /D1 merged to main/);
});

test('finishing activates the integration worktree commit guard', () => {
  const repository = createRepository({ feature: true });
  commitFile(repository.feature, 'lines.txt', 'D1\n', 'finish D1');
  assert.equal(runStage('claim', 'D1', repository.feature).status, 0);

  const result = runStage('finish', 'D1', repository.feature);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(repository.main, 'config', '--get', 'core.hooksPath').stdout.trim(), '.githooks');
});

test('finishing refuses a commit that fails the public commit policy', () => {
  const repository = createRepository({ feature: true });
  commitFile(repository.feature, 'lines.txt', 'D1\n', 'finish D1');
  const before = branchHeads(repository);
  assert.equal(runStage('claim', 'D1', repository.feature).status, 0);

  const result = runStageCli('finish', 'D1', repository.feature, publicRulesOnlyPolicy());

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Commit header must use Conventional Commits/);
  assert.deepEqual(branchHeads(repository), before);
});

test('finishing an integrated stage reports converged state without claiming again', () => {
  const repository = createRepository({ feature: true });
  commitFile(repository.feature, 'lines.txt', 'D1\n', 'finish D1');
  assert.equal(runStage('claim', 'D1', repository.feature).status, 0);
  assert.equal(runStage('finish', 'D1', repository.feature).status, 0);
  const before = branchHeads(repository);

  const repeated = runStage('finish', 'D1', repository.feature);

  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /D1 is already on main/);
  assert.deepEqual(branchHeads(repository), before);
  assert.equal(stageClaimExists(repository), false);
});

test('finishing recovers after main moved but the lease was not released', () => {
  const repository = createRepository({ feature: true });
  commitFile(repository.feature, 'lines.txt', 'D1\n', 'finish D1');
  const featureHead = git(repository.feature, 'rev-parse', 'HEAD').stdout.trim();
  assert.equal(runStage('claim', 'D1', repository.feature).status, 0);
  git(repository.main, 'merge', '--ff-only', featureHead);

  const result = runStage('finish', 'D1', repository.feature);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /D1 is already on main/);
  assert.equal(stageClaimExists(repository), false);
});

test('finishing an unchanged claimed stage releases its merge turn', () => {
  const repository = createRepository({ feature: true });
  assert.equal(runStage('claim', 'D1', repository.feature).status, 0);

  const result = runStage('finish', 'D1', repository.feature);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /D1 is already on main/);
  assert.equal(stageClaimExists(repository), false);
});

test('an integrated branch cannot ignore another stage claim', () => {
  const repository = createRepository({ feature: true });
  const lock = stageLock(repository);
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), '{"stage":"F0"}\n');

  const result = runStage('finish', 'D1', repository.feature);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /stage merge turn belongs to F0/);
  assert.equal(readFileSync(join(lock, 'owner.json'), 'utf8'), '{"stage":"F0"}\n');
});

test('claiming a stage stores a complete versioned owner without a machine path', () => {
  const repository = createRepository({ feature: true });
  const mainHead = git(repository.main, 'rev-parse', 'HEAD').stdout.trim();

  const result = runStage('claim', 'D1', repository.feature);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(stageLock(repository)), false);
  const { objectId, owner } = readStageLease(repository);
  assert.equal(git(repository.feature, 'cat-file', '-t', objectId).stdout.trim(), 'blob');
  assert.match(owner.acquisitionToken, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ ...owner, acquisitionToken: '<token>' }, {
    acquisitionToken: '<token>',
    branch: 'feat/graph-forms-v1',
    mainHead,
    stage: 'D1',
    version: 1,
  });
  assert.equal('worktree' in owner, false);
});

test('dirty main blocks a stage claim without changing either branch', () => {
  const repository = createRepository({ feature: true });
  commitFile(repository.feature, 'lines.txt', 'D1\n', 'finish D1');
  writeFileSync(join(repository.main, 'claude-wip.txt'), 'keep me\n');
  const before = branchHeads(repository);

  const result = runStage('claim', 'D1', repository.feature);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /main worktree is dirty/);
  assert.deepEqual(branchHeads(repository), before);
  assert.equal(readFileSync(join(repository.main, 'claude-wip.txt'), 'utf8'), 'keep me\n');
});

test('dirty feature work blocks a stage claim without changing either branch', () => {
  const repository = createRepository({ feature: true });
  commitFile(repository.feature, 'lines.txt', 'D1\n', 'finish D1');
  writeFileSync(join(repository.feature, 'codex-wip.txt'), 'keep me too\n');
  const before = branchHeads(repository);

  const result = runStage('claim', 'D1', repository.feature);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /feature worktree is dirty/);
  assert.deepEqual(branchHeads(repository), before);
  assert.equal(
    readFileSync(join(repository.feature, 'codex-wip.txt'), 'utf8'),
    'keep me too\n',
  );
});

test('diverged branches block a stage without creating a merge commit', () => {
  const repository = createRepository({ feature: true });
  commitFile(repository.feature, 'lines.txt', 'D1\n', 'finish D1');
  commitFile(repository.main, 'factory.txt', 'F0\n', 'finish F0');
  const before = branchHeads(repository);
  assert.equal(runStage('claim', 'D1', repository.feature).status, 0);

  const result = runStage('finish', 'D1', repository.feature);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot fast-forward main/);
  assert.deepEqual(branchHeads(repository), before);
  assert.equal(readStageOwner(repository).length > 0, true);
});

test('finishing without a matching stage claim changes no branch', () => {
  const repository = createRepository({ feature: true });
  commitFile(repository.feature, 'lines.txt', 'D1\n', 'finish D1');
  const before = branchHeads(repository);

  const result = runStage('finish', 'D1', repository.feature);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /claim the stage merge turn first/);
  assert.deepEqual(branchHeads(repository), before);
});

test('an existing merge lock blocks a second stage claimant', () => {
  const repository = createRepository({ feature: true });
  commitFile(repository.feature, 'lines.txt', 'D1\n', 'finish D1');
  const lock = stageLock(repository);
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), '{"stage":"F0"}\n');
  const before = branchHeads(repository);

  const result = runStage('claim', 'D1', repository.feature);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /another stage merge is active/);
  assert.deepEqual(branchHeads(repository), before);
  assert.equal(readFileSync(join(lock, 'owner.json'), 'utf8'), '{"stage":"F0"}\n');
});

test('an incomplete legacy claim requires explicit recovery', () => {
  const repository = createRepository({ feature: true });
  const lock = stageLock(repository);
  mkdirSync(lock);

  const blocked = runStage('claim', 'D1', repository.feature);

  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /incomplete stage merge claim/);
  assert.match(blocked.stderr, /stage:release D1/);
  assert.equal(existsSync(lock), true);

  const unfinished = runStage('finish', 'D1', repository.feature);
  assert.notEqual(unfinished.status, 0);
  assert.match(unfinished.stderr, /incomplete stage merge claim/);
  assert.match(unfinished.stderr, /stage:release D1/);

  const released = runStage('release', 'D1', repository.feature);
  assert.equal(released.status, 0, released.stderr);
  assert.match(released.stdout, /cleared the incomplete stage merge claim/);
  assert.equal(existsSync(lock), false);

  const reclaimed = runStage('claim', 'D1', repository.feature);
  assert.equal(reclaimed.status, 0, reclaimed.stderr);
});

test('release never clears an unreadable owner record', () => {
  const repository = createRepository({ feature: true });
  const lock = stageLock(repository);
  writeFileSync(lock, 'not json\n');

  const result = runStage('release', 'D1', repository.feature);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /stage merge lock is unreadable/);
  assert.equal(readFileSync(lock, 'utf8'), 'not json\n');
});

test('incomplete legacy recovery preserves a claim that becomes non-empty', () => {
  const repository = createRepository({ feature: true });
  const lock = stageLock(repository);
  mkdirSync(lock);
  writeFileSync(join(lock, 'claiming'), 'still active\n');

  const result = runStage('release', 'D1', repository.feature);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /claim changed; nothing removed/);
  assert.equal(readFileSync(join(lock, 'claiming'), 'utf8'), 'still active\n');
});

test('an unreadable legacy lock blocks another claimant without changing its bytes', () => {
  const repository = createRepository({ feature: true });
  const lock = stageLock(repository);
  const owner = '{"stage":"F0"}\n';
  writeFileSync(lock, owner);

  const result = runStage('claim', 'D1', repository.feature);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /another stage merge is active/);
  assert.equal(readFileSync(lock, 'utf8'), owner);
});

test('two parallel claims produce one complete owner record', async () => {
  const repository = createRepository({ feature: true });

  const results = await Promise.all([
    runStageAsync('claim', 'D1', repository.feature),
    runStageAsync('claim', 'D1', repository.feature),
  ]);

  assert.deepEqual(results.map((result) => result.status).sort(), [0, 1]);
  assert.equal(results.some((result) => /another stage merge is active/.test(result.stderr)), true);
  const { owner } = readStageLease(repository);
  assert.equal(owner.stage, 'D1');
  assert.equal(owner.branch, 'feat/graph-forms-v1');
});

test('finishing supports a complete legacy directory claim', () => {
  const repository = createRepository({ feature: true });
  commitFile(repository.feature, 'lines.txt', 'D1\n', 'finish D1');
  const lock = stageLock(repository);
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), `${JSON.stringify({
    branch: 'feat/graph-forms-v1',
    mainHead: git(repository.main, 'rev-parse', 'HEAD').stdout.trim(),
    stage: 'D1',
    worktree: git(repository.feature, 'rev-parse', '--show-toplevel').stdout.trim(),
  })}\n`);

  const result = runStage('finish', 'D1', repository.feature);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    git(repository.main, 'rev-parse', 'HEAD').stdout.trim(),
    git(repository.feature, 'rev-parse', 'HEAD').stdout.trim(),
  );
  assert.equal(existsSync(lock), false);
});

test('main moving after a claim invalidates the merge turn', () => {
  const repository = createRepository({ feature: true });
  commitFile(repository.feature, 'lines.txt', 'D1\n', 'finish D1');
  assert.equal(runStage('claim', 'D1', repository.feature).status, 0);
  commitFile(repository.main, 'factory.txt', 'F0\n', 'finish F0');
  const before = branchHeads(repository);

  const result = runStage('finish', 'D1', repository.feature);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /main changed after D1 claimed the merge turn/);
  assert.deepEqual(branchHeads(repository), before);
});

test('releasing a claim lets the other workstream take the merge turn', () => {
  const repository = createRepository({ feature: true });
  assert.equal(runStage('claim', 'D1', repository.feature).status, 0);

  const released = runStage('release', 'D1', repository.feature);
  const factory = join(repository.directory, 'factory');
  git(repository.main, 'worktree', 'add', '-b', 'feat/factory-v1', factory);
  const reclaimed = runStage('claim', 'F0', factory);

  assert.equal(released.status, 0, released.stderr);
  assert.equal(reclaimed.status, 0, reclaimed.stderr);
  assert.match(reclaimed.stdout, /F0 claimed the stage merge turn/);
});

test('reacquiring the same stage creates a lease an old release cannot delete', () => {
  const repository = createRepository({ feature: true });
  assert.equal(runStage('claim', 'D1', repository.feature).status, 0);
  const firstObjectId = stageLeaseObjectId(repository);
  assert.equal(runStage('release', 'D1', repository.feature).status, 0);

  assert.equal(runStage('claim', 'D1', repository.feature).status, 0);
  const replacementObjectId = stageLeaseObjectId(repository);
  const staleDelete = spawnSync(
    'git',
    ['update-ref', '-d', stageLeaseRef, firstObjectId],
    { cwd: repository.feature, encoding: 'utf8' },
  );

  assert.notEqual(replacementObjectId, firstObjectId);
  assert.notEqual(staleDelete.status, 0);
  assert.equal(stageLeaseObjectId(repository), replacementObjectId);
});

test('a delayed release cannot delete a replacement lease', () => {
  const repository = createRepository({ feature: true });
  const factory = join(repository.directory, 'factory');
  git(repository.main, 'worktree', 'add', '-b', 'feat/factory-v1', factory);
  assert.equal(runStage('claim', 'D1', repository.feature).status, 0);
  let replacementObjectId;

  const released = runStage('release', 'D1', repository.feature, {
    beforeLeaseDelete() {
      const originalObjectId = stageLeaseObjectId(repository);
      git(repository.feature, 'update-ref', '-d', stageLeaseRef, originalObjectId);
      const reclaimed = runStage('claim', 'F0', factory);
      assert.equal(reclaimed.status, 0, reclaimed.stderr);
      replacementObjectId = stageLeaseObjectId(repository);
    },
  });

  assert.notEqual(released.status, 0);
  assert.match(released.stderr, /stage merge claim changed; nothing removed/);
  assert.equal(stageLeaseObjectId(repository), replacementObjectId);
  assert.equal(readStageLease(repository).owner.stage, 'F0');
});

function createRepository({ feature = false, instructions, branch = 'feat/graph-forms-v1' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'obversa-agent-workflow-'));
  temporaryDirectories.push(directory);
  const main = join(directory, 'main');
  mkdirSync(main);
  git(main, 'init', '--initial-branch=main');
  git(main, 'config', 'user.name', 'Test User');
  git(main, 'config', 'user.email', 'test@example.com');
  git(main, 'config', 'commit.gpgsign', 'false');
  git(main, 'config', 'core.hooksPath', '.test-hooks');
  writeFileSync(join(main, 'README.md'), 'fixture\n');

  if (instructions === 'linked' || instructions === 'copied') {
    writeFileSync(join(main, 'AGENTS.md'), '# Shared instructions\n');
    if (instructions === 'linked') symlinkSync('AGENTS.md', join(main, 'CLAUDE.md'));
    else writeFileSync(join(main, 'CLAUDE.md'), '# Copied instructions\n');
  }

  git(main, 'add', '--all');
  git(main, 'commit', '--no-gpg-sign', '-m', 'fixture');

  if (!feature) return { directory, main };

  const featurePath = join(directory, 'feature');
  git(main, 'worktree', 'add', '-b', branch, featurePath);
  return { directory, feature: featurePath, main };
}

function commitFile(worktree, path, contents, message) {
  writeFileSync(join(worktree, path), contents);
  git(worktree, 'add', path);
  git(worktree, 'commit', '--no-gpg-sign', '-m', message);
}

function branchHeads({ feature, main }) {
  return {
    feature: git(feature, 'rev-parse', 'HEAD').stdout.trim(),
    main: git(main, 'rev-parse', 'HEAD').stdout.trim(),
  };
}

function stageLock({ feature }) {
  const commonDirectory = git(
    feature,
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ).stdout.trim();
  return join(commonDirectory, 'obversa-stage-merge.lock');
}

function readStageOwner(repository) {
  const objectId = stageLeaseObjectId(repository, { required: false });
  if (objectId) return git(repository.feature, 'cat-file', 'blob', objectId).stdout;
  const lock = stageLock(repository);
  return lstatSync(lock).isDirectory()
    ? readFileSync(join(lock, 'owner.json'), 'utf8')
    : readFileSync(lock, 'utf8');
}

function readStageLease(repository) {
  const objectId = stageLeaseObjectId(repository);
  return {
    objectId,
    owner: JSON.parse(git(repository.feature, 'cat-file', 'blob', objectId).stdout),
  };
}

function stageLeaseObjectId(repository, { required = true } = {}) {
  const result = spawnSync(
    'git',
    ['rev-parse', '--verify', '--quiet', stageLeaseRef],
    { cwd: repository.feature, encoding: 'utf8' },
  );
  if (result.status === 0) return result.stdout.trim();
  if (!required && result.status === 1) return undefined;
  assert.equal(result.status, 0, result.stderr || `missing ${stageLeaseRef}`);
}

function stageClaimExists(repository) {
  return existsSync(stageLock(repository))
    || stageLeaseObjectId(repository, { required: false }) !== undefined;
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function runNode(script, args, cwd, env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function runStage(command, stage, cwd, options = {}) {
  try {
    const output = manageStage([command, stage], {
      cwd,
      assertCommitRange: () => 1,
      ...options,
    });
    return { status: 0, stderr: '', stdout: `${output}\n` };
  } catch (error) {
    return {
      status: 1,
      stderr: `ERROR: ${error instanceof Error ? error.message : String(error)}\n`,
      stdout: '',
    };
  }
}

function runStageCli(command, stage, cwd, env = {}) {
  return runNode(stageMerge, [command, stage], cwd, env);
}

// A local commit policy that blocks nothing and names nobody, so a test sees
// only the public rules whichever machine runs it.
function publicRulesOnlyPolicy() {
  const file = join(mkdtempSync(join(tmpdir(), 'obversa-commit-policy-')), 'commit-policy.json');
  writeFileSync(file, JSON.stringify({ timeZone: 'UTC', blockedWeekdays: [], blockedFromHour: 0, blockedToHour: 0 }));
  return { OBVERSA_COMMIT_POLICY: file };
}

function runStageAsync(command, stage, cwd) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [stageMerge, command, stage], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}
