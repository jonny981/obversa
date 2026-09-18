import assert from 'node:assert/strict';

import { parseUnifiedDiff } from '@obversa/surface-diff';

const diff = [
  'diff --git a/answer.txt b/answer.txt',
  '--- a/answer.txt',
  '+++ b/answer.txt',
  '@@ -1 +1 @@',
  '-41',
  '+42',
  '',
].join('\n');

const parsed = parseUnifiedDiff(diff);
assert.equal(parsed.files.length, 1);
const file = parsed.files[0]!;
assert.equal(file.path, 'answer.txt');
assert.equal(file.hunks.length, 1);
assert.deepEqual(file.hunks[0]!.lines, [
  { type: 'del', oldNumber: 1, newNumber: null, text: '41' },
  { type: 'add', oldNumber: null, newNumber: 1, text: '42' },
]);

console.log(JSON.stringify({ path: file.path, lines: file.hunks[0]!.lines }, null, 2));
