import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { checkSpecCoverage } from './check-spec-coverage.mjs';

/**
 * This check exists because a thorough spec sat in the tree for a day
 * without a single script running it, and a review read it as cover. The
 * arms below prove it looks at what the manifest runs rather than at what
 * exists.
 */
function repoWith(specs, scripts) {
  const dir = mkdtempSync(join(tmpdir(), 'spec-coverage-'));
  execFileSync('git', ['init', '-q', '.'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  for (const name of specs) writeFileSync(join(dir, 'scripts', name), '// a spec\n');
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'x', scripts }, null, 2)}\n`);
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: dir });
  return dir;
}

function run(specs, scripts, assertions) {
  const dir = repoWith(specs, scripts);
  try { assertions(checkSpecCoverage(dir)); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('a spec no script names is reported', () => {
  run(['a.spec.mjs'], { test: 'echo hello' }, (failures) => {
    assert.equal(failures.length, 1, failures.join('; '));
    assert.match(failures[0], /scripts\/a\.spec\.mjs is run by no script/);
  });
});

test('a spec a script names passes', () => {
  run(['a.spec.mjs'], { test: 'node --test scripts/a.spec.mjs' }, (failures) => assert.deepEqual(failures, []));
});

test('being named by any script counts, not only by one called test', () => {
  run(['a.spec.mjs'], { 'check:things': 'node --test scripts/a.spec.mjs && node scripts/a.mjs' },
    (failures) => assert.deepEqual(failures, []));
});

test('one wired spec does not cover an unwired one beside it', () => {
  run(['a.spec.mjs', 'b.spec.mjs'], { test: 'node --test scripts/a.spec.mjs' }, (failures) => {
    assert.equal(failures.length, 1, failures.join('; '));
    assert.match(failures[0], /b\.spec\.mjs/);
  });
});

test('a tree with no specs at all passes rather than erroring', () => {
  run([], { test: 'echo hello' }, (failures) => assert.deepEqual(failures, []));
});
