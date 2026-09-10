import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { checkRetiredPaths } from './check-retired-paths.mjs';

/**
 * The rename that moved these forms swept the tree and missed four references
 * in one file, and nothing noticed until a ten-minute verify run failed on
 * them. The check exists so the sweep is not the only thing standing between
 * a rename and a red build, and these arms exist so the check cannot pass
 * vacuously.
 */
function repoWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'retired-paths-'));
  execFileSync('git', ['init', '-q', '.'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: dir });
  return dir;
}

test('a retired form in a tracked file fails', () => {
  const dir = repoWith({ 'scripts/thing.mjs': "run('examples/production-lines/offline-review.line.js');\n" });
  try {
    const failures = checkRetiredPaths(dir);
    assert.equal(failures.length, 2, failures.join('; '));
    assert.match(failures.join(' '), /retired directory name/);
    assert.match(failures.join(' '), /retired example suffix \(js\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the retired heading fails', () => {
  const dir = repoWith({ 'docs/page.md': '## Run the line\n' });
  try {
    assert.match(checkRetiredPaths(dir).join(' '), /retired heading/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the redirect file is the one allowed place', () => {
  const dir = repoWith({ 'docs/public/docs.json': '{"source":"/production-lines"}\n' });
  try {
    assert.deepEqual(checkRetiredPaths(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a clean tree passes', () => {
  const dir = repoWith({ 'examples/workflows/offline-review.workflow.ts': 'export const workflow = 1;\n' });
  try {
    assert.deepEqual(checkRetiredPaths(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
