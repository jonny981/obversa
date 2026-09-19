import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const expected = new Map([
  ['@obversa/api', 'packages/api'],
  ['@obversa/core', 'packages/core'],
  ['@obversa/runtime', 'packages/runtime'],
  ['@obversa/runner', 'packages/runner'],
  ['@obversa/builtin-workflows', 'packages/builtin-workflows'],
  ['@obversa/surface-decision', 'packages/surface-decision'],
  ['@obversa/surface-diff', 'packages/surface-diff'],
  ['@obversa/engine-claude-agent-sdk', 'plugins/engine-claude-agent-sdk'],
  ['@obversa/engine-anthropic-api', 'plugins/engine-anthropic-api'],
  ['@obversa/engine-claude-cli', 'plugins/engine-claude-cli'],
  ['@obversa/engine-codex-cli', 'plugins/engine-codex-cli'],
  ['@obversa/engine-grok-cli', 'plugins/engine-grok-cli'],
  ['@obversa/engine-opencode-cli', 'plugins/engine-opencode-cli'],
  ['@obversa/memory-git', 'plugins/memory-git'],
  ['@obversa/memory-simple', 'plugins/memory-simple'],
  ['@obversa/search-markdown', 'plugins/search-markdown'],
  ['@obversa/notify-webhook', 'plugins/notify-webhook'],
]);

test('all seventeen public packages have the accepted names and locations', () => {
  const allowlist = JSON.parse(readFileSync('scripts/publish-allowlist.json', 'utf8'));
  assert.deepEqual(allowlist.packages, [...expected.keys()].sort());
  for (const [name, directory] of expected) {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    assert.equal(manifest.name, name, directory);
  }
});
