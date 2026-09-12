import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  assertSurfaceShape,
  buildDebtIndex,
  checkPublicSurface,
  codes,
  exportListNames,
  exportedValues,
  exportedTypes,
} from './check-public-surface.mjs';

test('public surface checker is wired into docs validation', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.match(pkg.scripts['docs:validate'], /check-public-surface/);
});

test('barrel exports keep value aliases and skip type-only names', () => {
  assert.deepEqual(
    exportListNames('run, type RunOptions, createGraphExecutor as createExecutor'),
    ['run', 'createExecutor'],
  );
});

test('type-only barrel exports keep only the ruled type names', () => {
  assert.deepEqual(
    exportedTypes('export type { GraphExecutorResult }; export { type RunPreflightPolicy, run };'),
    ['GraphExecutorResult', 'RunPreflightPolicy'],
  );
});

test('one-level export-star traversal finds values without type exports', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obversa-public-surface-'));
  try {
    fs.writeFileSync(path.join(directory, 'leaf.ts'), 'export const leaf = 1;\nexport type Leaf = string;\n');
    const values = exportedValues(
      path.join(directory, 'barrel.ts'),
      "export * from './leaf.js';\n",
    );
    assert.deepEqual(values, ['leaf']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the surface parser refuses a truncated value export list', () => {
  const values = ['run', 'createGraphExecutor', 'startSupervisedRun', ...Array.from({ length: 97 }, (_, i) => `value${i}`)];
  assert.doesNotThrow(() => assertSurfaceShape({ values }));
  assert.throws(
    () => assertSurfaceShape({ values: values.slice(0, 99) }),
    /expected at least 100/,
  );
});

test('code names come from the named unions, not every uppercase string', () => {
  assert.ok(codes.includes('INVALID_PREFLIGHT_CONFIG'));
  assert.ok(codes.includes('WORKSPACE_DRIFT'));
  assert.equal(codes.includes('PATH'), false);
  assert.equal(codes.includes('ERRNO'), false);
});

test('a missing documented name is detected through a copied page string', () => {
  const page = 'docs/public/graphs/executor.mdx';
  const original = fs.readFileSync(page, 'utf8');
  const broken = original.replaceAll('GraphExecutionError', 'RemovedGraphError');
  assert.notEqual(broken, original);
  const result = checkPublicSurface({
    names: ['GraphExecutionError'],
    types: [],
    codes: [],
    pageText: broken,
    debt: new Map(),
  });
  assert.deepEqual(result.missing, ['GraphExecutionError']);
  assert.equal(fs.readFileSync(page, 'utf8'), original);
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
