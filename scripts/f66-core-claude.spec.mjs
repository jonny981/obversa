import assert from 'node:assert/strict';
import { test } from 'node:test';

import { claudeToolOptions } from '@obversa/core/claude-tools';

test('core exposes the shared Claude tool bound', () => {
  const options = claudeToolOptions({
    workspaceMode: 'read',
    tools: ['Read', 'Bash'],
    allowedTools: ['Read'],
    leaf: true,
  });
  assert.deepEqual(options.tools, ['Read']);
  assert.ok(options.disallowedTools.includes('Bash'));
});
