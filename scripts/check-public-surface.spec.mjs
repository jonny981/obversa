import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('public surface checker is wired into docs validation', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.match(pkg.scripts['docs:validate'], /check-public-surface/);
});
