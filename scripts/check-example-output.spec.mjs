import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const SCRIPT = join(process.cwd(), 'scripts/check-example-output.mjs');

function runFixture(source) {
  const directory = mkdtempSync(join(tmpdir(), 'obversa-example-output-'));
  const file = join(directory, 'fixture.mjs');
  writeFileSync(file, source);
  try {
    return spawnSync(process.execPath, [SCRIPT, process.execPath, file], { encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('accepts an example that exits 0 and prints', () => {
  const result = runFixture("console.log(JSON.stringify({ status: 'pass' }));\n");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\"status\":\"pass\"/);
});

test('rejects an example that exits 0 without output', () => {
  const result = runFixture('void 0;\n');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exited 0 without printing an outcome/);
});

test('keeps a non-zero example red', () => {
  const result = runFixture("console.error('failed'); process.exit(2);\n");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /failed/);
});
