import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCommitRange } from './check-commit-policy.mjs';
import { configureGitHooks } from './configure-git-hooks.mjs';

export function manageStage(args, options = {}) {
  if (args.length !== 2 || !['claim', 'finish', 'release'].includes(args[0])) {
    throw new Error('usage: pnpm stage:<claim|finish|release> <D1|F0>');
  }
  if (!/^[DF]\d+[A-Z]?$/.test(args[1])) {
    throw new Error('stage must look like D1, D11A, or F0');
  }

  const [command, stage] = args;
  const context = featureContext(stage, options.cwd ?? process.cwd());
  if (command === 'claim') return claim(context);
  if (command === 'finish') {
    return finish(context, {
      assertCommitRange: options.assertCommitRange ?? assertCommitRange,
      configureGitHooks: options.configureGitHooks ?? configureGitHooks,
    });
  }
  return release(context);
}

function claim(context) {
  try {
    mkdirSync(context.lockDirectory);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`another stage merge is active (${context.lockDirectory})`);
    }
    throw error;
  }

  try {
    const mainWorktree = findMainWorktree(context.worktree);
    assertClean(context.worktree, 'feature');
    assertClean(mainWorktree, 'main');
    const owner = {
      branch: context.branch,
      mainHead: git(mainWorktree, 'rev-parse', 'HEAD').trim(),
      stage: context.stage,
      worktree: context.worktree,
    };
    writeFileSync(context.ownerPath, `${JSON.stringify(owner, null, 2)}\n`);
    return `${context.stage} claimed the stage merge turn from ${owner.mainHead}.`;
  } catch (error) {
    rmSync(context.lockDirectory, { force: true, recursive: true });
    throw error;
  }
}

function finish(context, dependencies) {
  const mainWorktree = findMainWorktree(context.worktree);
  assertClean(context.worktree, 'feature');
  assertClean(mainWorktree, 'main');

  const featureHead = git(context.worktree, 'rev-parse', 'HEAD').trim();
  const mainHead = git(mainWorktree, 'rev-parse', 'HEAD').trim();
  if (featureHead === mainHead) {
    if (existsSync(context.lockDirectory)) {
      const owner = readOwner(context, 'claim the stage merge turn first');
      assertOwner(context, owner);
      if (owner.mainHead !== mainHead) {
        throw new Error(`${context.stage} cannot finish because main changed after ${context.stage} claimed the merge turn`);
      }
      dependencies.configureGitHooks(mainWorktree);
      rmSync(context.lockDirectory, { force: true, recursive: true });
    } else {
      dependencies.configureGitHooks(mainWorktree);
    }
    return `${context.stage} is already on main at ${featureHead}.`;
  }

  const owner = readOwner(context, 'claim the stage merge turn first');
  assertOwner(context, owner);
  if (owner.mainHead !== mainHead) {
    throw new Error(`${context.stage} cannot finish because main changed after ${context.stage} claimed the merge turn`);
  }

  const ancestry = rawGit(
    context.worktree,
    'merge-base',
    '--is-ancestor',
    mainHead,
    featureHead,
  );
  if (ancestry.status !== 0) {
    throw new Error(
      'cannot fast-forward main; update the feature branch from main before final proof and review',
    );
  }

  dependencies.assertCommitRange(`${mainHead}..${featureHead}`, { cwd: context.worktree });
  git(context.worktree, 'diff', '--check', `${mainHead}..${featureHead}`);
  git(mainWorktree, 'merge', '--ff-only', featureHead);

  const mergedHead = git(mainWorktree, 'rev-parse', 'HEAD').trim();
  if (mergedHead !== featureHead) throw new Error('main did not reach the reviewed feature commit');

  dependencies.configureGitHooks(mainWorktree);
  rmSync(context.lockDirectory, { force: true, recursive: true });
  return `${context.stage} merged to main at ${featureHead}.`;
}

function release(context) {
  const owner = readOwner(context, 'no stage merge turn is active');
  assertOwner(context, owner);
  rmSync(context.lockDirectory, { force: true, recursive: true });
  return `${context.stage} released the stage merge turn.`;
}

function featureContext(stage, cwd) {
  const worktree = git(cwd, 'rev-parse', '--show-toplevel').trim();
  const branch = git(worktree, 'branch', '--show-current').trim();
  if (branch.length === 0 || branch === 'main' || branch === 'master') {
    throw new Error('manage a stage from its named feature branch, not main');
  }
  const expectedBranch = stage.startsWith('D') ? 'feat/lines-v1' : 'feat/factory-v1';
  if (branch !== expectedBranch) {
    throw new Error(
      `${stage[0]} stages belong to ${expectedBranch}; ${branch} cannot claim ${stage}`,
    );
  }
  const commonDirectory = git(
    worktree,
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ).trim();
  const lockDirectory = join(commonDirectory, 'obversa-stage-merge.lock');
  return {
    branch,
    lockDirectory,
    ownerPath: join(lockDirectory, 'owner.json'),
    stage,
    worktree,
  };
}

function assertOwner(context, owner) {
  if (
    owner.branch !== context.branch
    || owner.stage !== context.stage
    || owner.worktree !== context.worktree
  ) {
    throw new Error(
      `stage merge turn belongs to ${owner.stage ?? 'unknown'} on ${owner.branch ?? 'unknown'}`,
    );
  }
}

function readOwner(context, missingMessage) {
  try {
    return JSON.parse(readFileSync(context.ownerPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(missingMessage);
    throw new Error(`stage merge lock is unreadable (${context.ownerPath})`);
  }
}

function assertClean(worktree, label) {
  const status = git(worktree, 'status', '--porcelain=v1', '--untracked-files=all');
  if (status.length > 0) throw new Error(`${label} worktree is dirty; preserve its work before merging`);
}

function findMainWorktree(cwd) {
  const records = git(cwd, 'worktree', 'list', '--porcelain').trim().split(/\n\n+/);
  for (const record of records) {
    const lines = record.split('\n');
    if (!lines.includes('branch refs/heads/main')) continue;
    const path = lines.find((line) => line.startsWith('worktree '));
    if (path) return path.slice('worktree '.length);
  }
  throw new Error('main must have one dedicated worktree');
}

function git(cwd, ...args) {
  const result = rawGit(cwd, ...args);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout;
}

function rawGit(cwd, ...args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    console.log(manageStage(process.argv.slice(2)));
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
