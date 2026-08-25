import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { manageStage } from './stage-merge.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkInstructions = join(projectRoot, 'scripts', 'check-agent-instructions.mjs');
const checkBranch = join(projectRoot, 'scripts', 'check-workstream-branch.mjs');
const stageMerge = join(projectRoot, 'scripts', 'stage-merge.mjs');
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
  assert.match(result.stdout, /feat\/lines-v1/);
});

test('a workstream cannot claim the other workstream stage family', () => {
  const repository = createRepository({ feature: true, branch: 'feat/factory-v1' });

  const result = runStage('claim', 'D2', repository.feature);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /D stages belong to feat\/lines-v1/);
  assert.equal(existsSync(stageLock(repository)), false);
});

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

  const result = runStageCli('finish', 'D1', repository.feature);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /author and committer names must be Jonny Neill/);
  assert.deepEqual(branchHeads(repository), before);
});

test('finishing an integrated stage is safe to repeat', () => {
  const repository = createRepository({ feature: true });
  commitFile(repository.feature, 'lines.txt', 'D1\n', 'finish D1');
  assert.equal(runStage('claim', 'D1', repository.feature).status, 0);
  assert.equal(runStage('finish', 'D1', repository.feature).status, 0);

  const repeated = runStage('finish', 'D1', repository.feature);

  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /D1 is already on main/);
});

test('finishing an unchanged claimed stage releases its merge turn', () => {
  const repository = createRepository({ feature: true });
  assert.equal(runStage('claim', 'D1', repository.feature).status, 0);

  const result = runStage('finish', 'D1', repository.feature);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /D1 is already on main/);
  assert.equal(existsSync(stageLock(repository)), false);
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

test('claiming a stage records its branch, worktree, stage, and main head', () => {
  const repository = createRepository({ feature: true });
  const mainHead = git(repository.main, 'rev-parse', 'HEAD').stdout.trim();
  const worktree = git(repository.feature, 'rev-parse', '--show-toplevel').stdout.trim();

  const result = runStage('claim', 'D1', repository.feature);

  assert.equal(result.status, 0, result.stderr);
  const owner = JSON.parse(readFileSync(join(stageLock(repository), 'owner.json'), 'utf8'));
  assert.deepEqual(owner, {
    branch: 'feat/lines-v1',
    mainHead,
    stage: 'D1',
    worktree,
  });
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
  assert.equal(readFileSync(join(stageLock(repository), 'owner.json'), 'utf8').length > 0, true);
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

function createRepository({ feature = false, instructions, branch = 'feat/lines-v1' } = {}) {
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

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function runNode(script, args, cwd) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function runStage(command, stage, cwd) {
  try {
    const output = manageStage([command, stage], {
      cwd,
      assertCommitRange: () => 1,
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

function runStageCli(command, stage, cwd) {
  return runNode(stageMerge, [command, stage], cwd);
}
