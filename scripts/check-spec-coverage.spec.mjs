import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { checkSpecCoverage } from './check-spec-coverage.mjs';

/**
 * The arm that matters most is the third: a spec named by a script nothing
 * calls. The first version of this check passed that case, and a gate had to
 * find it instead.
 */
function repo(scripts, specs) {
  const dir = mkdtempSync(join(tmpdir(), 'spec-reach-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  for (const name of specs) writeFileSync(join(dir, 'scripts', name), '// a spec\n');
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'x', scripts }, null, 2)}\n`);
  return dir;
}

// The specs the check looks at come from git; the tests hand it a list instead,
// so an arm is about the rule rather than about a temporary repository.
const lister = (specs) => (args) =>
  args[0] === 'ls-files' ? specs.map((s) => `scripts/${s}`).join('\n') : '';

function run(scripts, specs, assertions) {
  const dir = repo(scripts, specs);
  try { assertions(checkSpecCoverage(dir, { run: lister(specs) })); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

const chain = { 'verify:d1': 'pnpm check:boundaries && pnpm test:boundaries', 'check:boundaries': 'node scripts/check-boundaries.mjs' };

test('a spec a verify chain reaches passes', () => {
  run({ ...chain, 'test:boundaries': 'node --test scripts/a.spec.mjs' }, ['a.spec.mjs'],
    ({ failures }) => assert.deepEqual(failures, []));
});

test('a spec no script names at all fails', () => {
  run(chain, ['a.spec.mjs'], ({ failures }) => {
    assert.equal(failures.length, 1, failures.join('; '));
    assert.match(failures[0], /is named by no script/);
  });
});

test('a spec named only by a script nothing calls fails, which the older rule allowed', () => {
  run({ ...chain, 'test:lint': 'node --test scripts/a.spec.mjs' }, ['a.spec.mjs'], ({ failures }) => {
    assert.equal(failures.length, 1, failures.join('; '));
    assert.match(failures[0], /named only by test:lint, which no verify chain reaches/);
  });
});

test('the walk follows a chain through several hops', () => {
  run({
    'verify:d2': 'pnpm verify:d1',
    'verify:d1': 'pnpm check:boundaries && pnpm test:deep',
    'check:boundaries': 'node scripts/check-boundaries.mjs',
    'test:deep': 'pnpm test:deeper',
    'test:deeper': 'node --test scripts/a.spec.mjs',
  }, ['a.spec.mjs'], ({ failures }) => assert.deepEqual(failures, []));
});

test('a walk that never reaches the control refuses to report rather than calling everything unreachable', () => {
  const dir = repo({ 'verify:d1': 'echo nothing' }, ['a.spec.mjs']);
  try {
    assert.throws(() => checkSpecCoverage(dir, { run: lister(['a.spec.mjs']) }),
      /never reached check:boundaries/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a script that calls itself does not hang the walk', () => {
  run({ ...chain, 'test:boundaries': 'pnpm test:boundaries && node --test scripts/a.spec.mjs' },
    ['a.spec.mjs'], ({ failures }) => assert.deepEqual(failures, []));
});
