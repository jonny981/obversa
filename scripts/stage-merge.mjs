import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  rmdirSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCommitRange } from './check-commit-policy.mjs';
import { configureGitHooks } from './configure-git-hooks.mjs';

const leaseRef = 'refs/obversa/stage-merge';
export const stageBranches = {
  D14: 'feat/unattended-runner',
  D15: 'feat/release-v1',
  D16: 'feat/runner-hardening',
  D18: 'feat/proof-cache-safe-change',
  D19: 'feat/writer-exclusion',
  D28: 'feat/team-form',
  D21: 'feat/parity-tests',
  F4: 'feat/release-readiness',
  F5: 'feat/release-wording',
  F7: 'feat/residual-sweep',
  F8: 'feat/residual-sweep-two',
  F11: 'feat/transient-phase-tests',
  F10: 'feat/release-1-1-0',
  F14: 'feat/real-work-test-limits',
  F15: 'feat/browser-proof-budgets',
  D22: 'feat/feature-delivery-example',
  F16: 'feat/source-surfacer-types',
  F19: 'feat/f19-dag-node-metadata',
  F17: 'feat/retire-lines-name',
  D34: 'docs/retire-old-positioning',
  D23: 'feat/reader-task-docs',
  D24: 'feat/forge-helper-example',
  D30: 'feat/plugins-page',
  D43: 'docs/reader-first-pages',
  F20: 'feat/f20-checks-that-run',
  F22: 'feat/bounded-child-process',
  F25: 'feat/examples-a-user-would-write',
  F26: 'feat/one-run-per-rename',
  D44: 'docs/lead-with-the-team',
  F27: 'fix/sweep-three-proof',
  F29: 'fix/runtime-per-target-kickbacks',
  F30: 'fix/engine-owner-cleanup',
  D36: 'feat/teams',
  D45: 'docs/whole-file-examples',
};

export function manageStage(args, options = {}) {
  if (args.length !== 2 || !['claim', 'finish', 'release'].includes(args[0])) {
    throw new Error('usage: pnpm stage:<claim|finish|release> <D1|F0>');
  }
  if (!/^[DF]\d+[A-Za-z]?$/.test(args[1])) {
    throw new Error('stage must look like D1, D11A, F0, or F2b');
  }

  const [command, stage] = args;
  const context = featureContext(stage, options.cwd ?? process.cwd());
  if (command === 'claim') return claim(context);
  if (command === 'finish') {
    return finish(context, {
      assertCommitRange: options.assertCommitRange ?? assertCommitRange,
      beforeLeaseDelete: options.beforeLeaseDelete,
      configureGitHooks: options.configureGitHooks ?? configureGitHooks,
    });
  }
  return release(context, { beforeLeaseDelete: options.beforeLeaseDelete });
}

function claim(context) {
  const mainWorktree = findMainWorktree(context.worktree);
  assertClean(context.worktree, 'feature');
  assertClean(mainWorktree, 'main');
  if (existsSync(context.legacyLockPath)) {
    if (isIncompleteLegacyLock(context)) {
      throw new Error(
        `incomplete stage merge claim; run pnpm stage:release ${context.stage}, then retry`,
      );
    }
    throw new Error(`another stage merge is active (${context.legacyLockPath})`);
  }

  const owner = {
    acquisitionToken: randomUUID(),
    branch: context.branch,
    mainHead: git(mainWorktree, 'rev-parse', 'HEAD').trim(),
    stage: context.stage,
    version: 1,
  };
  const objectId = gitWithInput(
    context.worktree,
    `${JSON.stringify(owner, null, 2)}\n`,
    'hash-object',
    '-w',
    '--stdin',
  ).trim();
  const result = rawGit(
    context.worktree,
    'update-ref',
    context.leaseRef,
    objectId,
    '0'.repeat(objectId.length),
  );
  if (result.status !== 0) {
    throw new Error(`another stage merge is active (${context.leaseRef})`);
  }

  if (existsSync(context.legacyLockPath)) {
    deleteRefLease(context, objectId);
    if (isIncompleteLegacyLock(context)) {
      throw new Error(
        `incomplete stage merge claim; run pnpm stage:release ${context.stage}, then retry`,
      );
    }
    throw new Error(`another stage merge is active (${context.legacyLockPath})`);
  }

  return `${context.stage} claimed the stage merge turn from ${owner.mainHead}.`;
}

function finish(context, dependencies) {
  const mainWorktree = findMainWorktree(context.worktree);
  assertClean(context.worktree, 'feature');
  assertClean(mainWorktree, 'main');

  const featureHead = git(context.worktree, 'rev-parse', 'HEAD').trim();
  const mainHead = git(mainWorktree, 'rev-parse', 'HEAD').trim();
  if (featureHead === mainHead) {
    const lease = readLease(context, 'claim the stage merge turn first', { optional: true });
    if (lease) {
      assertOwner(context, lease.owner);
      if (lease.owner.mainHead !== mainHead) {
        const ancestry = rawGit(
          context.worktree,
          'merge-base',
          '--is-ancestor',
          lease.owner.mainHead,
          mainHead,
        );
        if (ancestry.status !== 0) {
          throw new Error(`${context.stage} cannot finish because main changed after ${context.stage} claimed the merge turn`);
        }
        dependencies.assertCommitRange(`${lease.owner.mainHead}..${featureHead}`, {
          cwd: context.worktree,
        });
        git(context.worktree, 'diff', '--check', `${lease.owner.mainHead}..${featureHead}`);
      }
      dependencies.configureGitHooks(mainWorktree);
      deleteLease(context, lease, dependencies.beforeLeaseDelete);
    } else {
      dependencies.configureGitHooks(mainWorktree);
    }
    return `${context.stage} is already on main at ${featureHead}.`;
  }

  const lease = readLease(context, 'claim the stage merge turn first');
  assertOwner(context, lease.owner);
  if (lease.owner.mainHead !== mainHead) {
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
  deleteLease(context, lease, dependencies.beforeLeaseDelete);
  return `${context.stage} merged to main at ${featureHead}.`;
}

function release(context, dependencies) {
  if (isIncompleteLegacyLock(context)) {
    clearIncompleteLegacyLock(context);
    return `${context.stage} cleared the incomplete stage merge claim; retry stage:claim.`;
  }
  const lease = readLease(context, 'no stage merge turn is active');
  assertOwner(context, lease.owner);
  deleteLease(context, lease, dependencies.beforeLeaseDelete);
  return `${context.stage} released the stage merge turn.`;
}

function featureContext(stage, cwd) {
  const worktree = git(cwd, 'rev-parse', '--show-toplevel').trim();
  const branch = git(worktree, 'branch', '--show-current').trim();
  if (branch.length === 0 || branch === 'main' || branch === 'master') {
    throw new Error('manage a stage from its named feature branch, not main');
  }
  const expectedBranch = stageBranches[stage]
    ?? (stage.startsWith('D') ? 'feat/graph-forms-v1' : 'feat/factory-v1');
  if (branch !== expectedBranch) {
    throw new Error(
      `${stage} belongs to ${expectedBranch}; ${branch} cannot claim ${stage}`,
    );
  }
  const commonDirectory = git(
    worktree,
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ).trim();
  const legacyLockPath = join(commonDirectory, 'obversa-stage-merge.lock');
  return {
    branch,
    leaseRef,
    legacyLockPath,
    legacyOwnerPath: join(legacyLockPath, 'owner.json'),
    stage,
    worktree,
  };
}

function assertOwner(context, owner) {
  if (owner.branch !== context.branch || owner.stage !== context.stage) {
    throw new Error(
      `stage merge turn belongs to ${owner.stage ?? 'unknown'} on ${owner.branch ?? 'unknown'}`,
    );
  }
}

function readLease(context, missingMessage, { optional = false } = {}) {
  const objectId = leaseObjectId(context);
  const hasLegacyLock = existsSync(context.legacyLockPath);
  if (objectId && hasLegacyLock) {
    throw new Error('multiple stage merge claims exist; nothing changed');
  }
  if (objectId) {
    const result = rawGit(context.worktree, 'cat-file', 'blob', objectId);
    if (result.status !== 0) throw unreadableLease(context);
    try {
      const owner = JSON.parse(result.stdout);
      if (
        owner.version !== 1
        || typeof owner.acquisitionToken !== 'string'
        || owner.acquisitionToken.length === 0
        || typeof owner.branch !== 'string'
        || typeof owner.mainHead !== 'string'
        || typeof owner.stage !== 'string'
      ) {
        throw new Error('invalid owner');
      }
      return { kind: 'ref', objectId, owner };
    } catch {
      throw unreadableLease(context);
    }
  }

  if (!hasLegacyLock) {
    if (optional) return undefined;
    throw new Error(missingMessage);
  }
  if (isIncompleteLegacyLock(context)) {
    throw new Error(
      `incomplete stage merge claim; run pnpm stage:release ${context.stage}, then retry`,
    );
  }

  try {
    if (!lstatSync(context.legacyLockPath).isDirectory()) throw new Error('unsupported');
    return {
      kind: 'legacy',
      owner: JSON.parse(readFileSync(context.legacyOwnerPath, 'utf8')),
    };
  } catch {
    throw unreadableLease(context);
  }
}

function isIncompleteLegacyLock(context) {
  try {
    return lstatSync(context.legacyLockPath).isDirectory()
      && !existsSync(context.legacyOwnerPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function deleteLease(context, lease, beforeDelete) {
  if (lease.kind === 'ref') {
    beforeDelete?.(lease);
    deleteRefLease(context, lease.objectId);
    return;
  }
  rmSync(context.legacyLockPath, { force: true, recursive: true });
}

function deleteRefLease(context, objectId) {
  const result = rawGit(
    context.worktree,
    'update-ref',
    '-d',
    context.leaseRef,
    objectId,
  );
  if (result.status !== 0) {
    throw new Error('stage merge claim changed; nothing removed');
  }
}

function leaseObjectId(context) {
  const result = rawGit(
    context.worktree,
    'rev-parse',
    '--verify',
    '--quiet',
    context.leaseRef,
  );
  if (result.status === 0) return result.stdout.trim();
  if (result.status === 1) return undefined;
  throw unreadableLease(context);
}

function unreadableLease(context) {
  return new Error(`stage merge lock is unreadable (${context.leaseRef})`);
}

function clearIncompleteLegacyLock(context) {
  try {
    rmdirSync(context.legacyLockPath);
  } catch {
    throw new Error('incomplete stage merge claim changed; nothing removed');
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

function gitWithInput(cwd, input, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', input });
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
