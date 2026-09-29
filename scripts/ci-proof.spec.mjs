import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertFreshCiProof, buildCiProof, CI_PROOF_PATH, currentFilesDigest, currentTreeHash, readCiProof, STALE_MESSAGE } from './ci-proof.mjs';

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

async function repo(t) {
  const root = await mkdtemp(join(tmpdir(), 'ci-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Example');
  git(root, 'config', 'user.email', 'example@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(root, 'a.txt'), 'one\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'chore: seed');
  return root;
}

test('buildCiProof records the current tree, file digest, time and command', async (t) => {
  const root = await repo(t);
  const record = buildCiProof(root);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.treeHash, currentTreeHash(root));
  assert.equal(record.filesDigest, currentFilesDigest(root));
  assert.equal(record.command, 'pnpm ci:local');
  assert.ok(typeof record.ranAt === 'string' && !Number.isNaN(Date.parse(record.ranAt)));
});

test('assertFreshCiProof refuses when no proof exists', async (t) => {
  const root = await repo(t);
  assert.equal(readCiProof(root), undefined);
  assert.throws(() => assertFreshCiProof(root), new RegExp(STALE_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('assertFreshCiProof refuses an unreadable proof file', async (t) => {
  const root = await repo(t);
  await mkdir(join(root, '.obversa'), { recursive: true });
  await writeFile(join(root, CI_PROOF_PATH), 'not json');
  assert.throws(() => assertFreshCiProof(root), /run `pnpm ci:local`/);
});

test('assertFreshCiProof accepts a proof matching the current tree, and refuses once a new commit changes it', async (t) => {
  const root = await repo(t);
  await mkdir(join(root, '.obversa'), { recursive: true });
  await writeFile(join(root, CI_PROOF_PATH), `${JSON.stringify(buildCiProof(root))}\n`);
  assert.doesNotThrow(() => assertFreshCiProof(root));

  await writeFile(join(root, 'a.txt'), 'two\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'chore: change a.txt');
  assert.throws(() => assertFreshCiProof(root), /run `pnpm ci:local`/);
});

test('assertFreshCiProof refuses once a tracked file is staged again, even before a new commit', async (t) => {
  const root = await repo(t);
  await mkdir(join(root, '.obversa'), { recursive: true });
  await writeFile(join(root, CI_PROOF_PATH), `${JSON.stringify(buildCiProof(root))}\n`);
  assert.doesNotThrow(() => assertFreshCiProof(root));

  // The tree hash alone would not catch this: HEAD has not moved. The files
  // digest (over git ls-files -s, the index) does, the moment the edit is staged.
  await writeFile(join(root, 'a.txt'), 'three\n');
  git(root, 'add', 'a.txt');
  assert.equal(currentTreeHash(root), readCiProof(root).treeHash, 'HEAD has not moved yet');
  assert.throws(() => assertFreshCiProof(root), /run `pnpm ci:local`/);
});

for (const change of ['edit', 'delete']) {
  test(`assertFreshCiProof refuses an unstaged tracked-file ${change}`, async (t) => {
    const root = await repo(t);
    await mkdir(join(root, '.obversa'));
    await writeFile(join(root, CI_PROOF_PATH), `${JSON.stringify(buildCiProof(root))}\n`);
    assert.doesNotThrow(() => assertFreshCiProof(root));

    if (change === 'edit') await writeFile(join(root, 'a.txt'), 'changed without staging\n');
    else await rm(join(root, 'a.txt'));

    assert.equal(currentTreeHash(root), readCiProof(root).treeHash, 'the commit is unchanged');
    assert.throws(() => assertFreshCiProof(root), /run `pnpm ci:local`/);
  });
}

test('assertFreshCiProof refuses a changed symlink even when both targets contain the same bytes', async (t) => {
  const root = await repo(t);
  await writeFile(join(root, 'b.txt'), 'one\n');
  await symlink('a.txt', join(root, 'link'));
  git(root, 'add', 'b.txt', 'link');
  git(root, 'commit', '-q', '-m', 'chore: add link');
  await mkdir(join(root, '.obversa'));
  await writeFile(join(root, CI_PROOF_PATH), `${JSON.stringify(buildCiProof(root))}\n`);
  assert.doesNotThrow(() => assertFreshCiProof(root));

  await rm(join(root, 'link'));
  await symlink('b.txt', join(root, 'link'));

  assert.throws(() => assertFreshCiProof(root), /run `pnpm ci:local`/);
});
