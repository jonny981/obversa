import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runChild } from '@obversa/core';

test('core runs one bounded child and returns its output', async () => {
  const result = await runChild({
    executable: process.execPath,
    args: ['-e', "process.stdout.write('ready')"],
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(new TextDecoder().decode(result.stdout), 'ready');
});
