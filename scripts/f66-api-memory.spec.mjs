import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MEMORY_ROOT } from '@obversa/api';
import { runMemoryConformance } from '@obversa/api/testing';

test('the API owns the memory port and its conformance check', async () => {
  assert.equal(MEMORY_ROOT, '/memories');
  const report = await runMemoryConformance(({ scope }) => ({
    scope,
    async execute(command) {
      return {
        ok: false,
        command: command.command,
        error: { code: 'STORAGE_ERROR', message: 'deliberate failure' },
      };
    },
  }));
  assert.equal(report.ok, false);
  assert.ok(report.failures.length > 0);
  assert.ok(report.failures.some((failure) => failure.message.includes('STORAGE_ERROR')));
});
