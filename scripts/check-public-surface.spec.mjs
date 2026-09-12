import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { buildDebtIndex } from './check-public-surface.mjs';

test('public surface checker is wired into docs validation', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.match(pkg.scripts['docs:validate'], /check-public-surface/);
});

test('a missing documented name is detected', () => {
  const page = 'docs/public/graphs/executor.mdx';
  const original = fs.readFileSync(page, 'utf8');
  const broken = original.replaceAll('GraphExecutionError', 'RemovedGraphError');
  assert.notEqual(broken, original);
  fs.writeFileSync(page, broken);
  try {
    const result = spawnSync(process.execPath, ['scripts/check-public-surface.mjs'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
  } finally {
    fs.writeFileSync(page, original);
  }
});

test('the documented public surface passes when no name is missing', () => {
  const result = spawnSync(process.execPath, ['scripts/check-public-surface.mjs'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('a debt entry whose owner has landed is refused', () => {
  assert.throws(
    () => buildDebtIndex([{ name: 'MISSING_NAME', owner: 'D34', why: 'queued' }], { landed: new Set(['D34']) }),
    /names D34, which has landed/,
  );
});

test('a debt entry without an owner or reason is refused', () => {
  assert.throws(
    () => buildDebtIndex([{ name: 'MISSING_NAME' }]),
    /names no stage that owns the fix/,
  );
});

test('a debt entry without a reason is refused', () => {
  assert.throws(
    () => buildDebtIndex([{ name: 'MISSING_NAME', owner: 'D34' }]),
    /does not say what it hides/,
  );
});

test('a debt entry with an open owner is kept', () => {
  const index = buildDebtIndex(
    [{ name: 'MISSING_NAME', owner: 'D34', why: 'queued' }],
    { landed: new Set(['D35']) },
  );
  assert.equal(index.get('MISSING_NAME').owner, 'D34');
});
