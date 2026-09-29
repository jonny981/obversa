import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// ci-local-lock.mjs locates its worktree from its own file location, not
// process.cwd() (it must find the same root regardless of pnpm's own cwd),
// so testing it in isolation means running a copy from its own temp root.
async function root(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ci-local-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'scripts'), { recursive: true });
  await cp(new URL('./ci-local-lock.mjs', import.meta.url), join(dir, 'scripts', 'ci-local-lock.mjs'));
  return dir;
}

function run(dir) {
  return execFileSync(process.execPath, [join(dir, 'scripts', 'ci-local-lock.mjs')], { encoding: 'utf8' });
}

test('acquires the lock and prints the parent pid and worktree', async (t) => {
  const dir = await root(t);
  const out = run(dir);
  // execFileSync spawns the script directly, so its parent is this test
  // process; the script resolves symlinks (macOS's /tmp), this dir does not.
  assert.match(out, new RegExp(`pid ${process.pid} in .*${dir.split('/').pop()}`));
  const recorded = await readFile(join(dir, '.obversa', 'ci-local.lock'), 'utf8');
  assert.equal(recorded, String(process.pid));
});

test('refuses a second run while the recorded pid is still alive', async (t) => {
  const dir = await root(t);
  run(dir);
  assert.throws(() => run(dir), /already running/);
});

test('a stale lock from a dead pid self-heals: the next run proceeds', async (t) => {
  const dir = await root(t);
  run(dir);
  // A pid this high is vanishingly unlikely to be alive.
  await writeFile(join(dir, '.obversa', 'ci-local.lock'), '999999');
  assert.doesNotThrow(() => run(dir));
});
