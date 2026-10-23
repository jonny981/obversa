// stage:finish must not land a branch on main without a ci:local proof that
// matches the feature branch's own tree.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildCiProof, CI_PROOF_PATH } from './ci-proof.mjs';
import { manageStage } from './stage-merge.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function twoWorktrees(t) {
  const root = await mkdtemp(join(tmpdir(), 'stage-finish-ci-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = join(root, 'main');
  const feature = join(root, 'feature');
  const signingKey = join(root, 'signing-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', signingKey]);
  git(root, 'init', '-q', '-b', 'main', main);
  for (const cwd of [main]) {
    git(cwd, 'config', 'user.name', 'Example');
    git(cwd, 'config', 'user.email', 'example@example.com');
    git(cwd, 'config', 'commit.gpgsign', 'false');
    git(cwd, 'config', 'gpg.format', 'ssh');
    git(cwd, 'config', 'user.signingkey', signingKey);
  }
  await writeFile(join(main, '.gitignore'), '.obversa/\n');
  await writeFile(join(main, 'a.txt'), 'one\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'chore: seed');
  git(main, 'worktree', 'add', feature, '-b', 'feat/factory-v1');
  git(feature, 'config', 'user.name', 'Example');
  git(feature, 'config', 'user.email', 'example@example.com');
  git(feature, 'config', 'commit.gpgsign', 'false');
  const message = join(root, 'squash-message.txt');
  await writeFile(message, 'feat: add b and c\n');
  return { main, feature, message };
}

const noOpGitHooks = () => {};
// The commit-policy check has its own test file; this one is scoped to the
// new ci-proof gate, so the range check is stubbed the way beforeLeaseDelete
// and configureGitHooks already are for other concerns finish() has.
const noOpCommitRange = () => {};
const noOpCommit = () => {};

test('stage:finish refuses missing and stale proof, then lands with matching proof', async (t) => {
  const { main, feature, message } = await twoWorktrees(t);
  manageStage(['claim', 'F999'], { cwd: feature });
  await writeFile(join(feature, 'b.txt'), 'feature work\n');
  git(feature, 'add', '-A');
  git(feature, 'commit', '-q', '-m', 'feat: b');
  const mainHeadBefore = git(main, 'rev-parse', 'HEAD');
  const claimBefore = git(feature, 'rev-parse', 'refs/obversa/stage-merge');
  const options = {
    cwd: feature,
    assertCommit: noOpCommit,
    assertCommitRange: noOpCommitRange,
    configureGitHooks: noOpGitHooks,
  };
  const finish = ['finish', 'F999', '--message', message];

  assert.throws(() => manageStage(finish, options), /run `pnpm ci:local` on this tree first/);
  assert.equal(git(main, 'rev-parse', 'HEAD'), mainHeadBefore);
  assert.equal(git(feature, 'rev-parse', 'refs/obversa/stage-merge'), claimBefore);

  await mkdir(join(feature, '.obversa'));
  await writeFile(join(feature, CI_PROOF_PATH), `${JSON.stringify(buildCiProof(feature))}\n`);
  await writeFile(join(feature, 'c.txt'), 'later work\n');
  git(feature, 'add', 'c.txt');
  git(feature, 'commit', '-q', '-m', 'feat: c');
  const featureHead = git(feature, 'rev-parse', 'HEAD');

  assert.throws(() => manageStage(finish, options), /run `pnpm ci:local` on this tree first/);
  assert.equal(git(main, 'rev-parse', 'HEAD'), mainHeadBefore);
  assert.equal(git(feature, 'rev-parse', 'refs/obversa/stage-merge'), claimBefore);

  await writeFile(join(feature, CI_PROOF_PATH), `${JSON.stringify(buildCiProof(feature))}\n`);
  const result = manageStage(finish, options);
  assert.match(result, /F999 landed on main/);
  assert.equal(git(main, 'rev-parse', 'HEAD^{tree}'), git(main, 'rev-parse', `${featureHead}^{tree}`));
});
