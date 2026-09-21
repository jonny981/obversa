import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const expected = new Map([
  ['@obversa/api', 'packages/api'],
  ['@obversa/core', 'packages/core'],
  ['@obversa/runtime', 'packages/runtime'],
  ['@obversa/runner', 'packages/runner'],
  ['@obversa/obversa', 'packages/obversa'],
  ['@obversa/builtin-workflows', 'packages/builtin-workflows'],
  ['@obversa/surface', 'packages/surface'],
  ['@obversa/surface-diff', 'packages/surface-diff'],
  ['@obversa/engine-claude-agent-sdk', 'plugins/engine-claude-agent-sdk'],
  ['@obversa/engine-anthropic-api', 'plugins/engine-anthropic-api'],
  ['@obversa/engine-claude-cli', 'plugins/engine-claude-cli'],
  ['@obversa/engine-codex-cli', 'plugins/engine-codex-cli'],
  ['@obversa/engine-grok-cli', 'plugins/engine-grok-cli'],
  ['@obversa/engine-opencode-cli', 'plugins/engine-opencode-cli'],
  ['@obversa/memory-git', 'plugins/memory-git'],
  ['@obversa/memory-simple', 'plugins/memory-simple'],
  ['@obversa/memory-markdown', 'plugins/memory-markdown'],
  ['@obversa/notify-webhook', 'plugins/notify-webhook'],
]);

const manifestAt = (directory) => JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));

test('all eighteen public packages have the accepted names and locations', () => {
  const allowlist = JSON.parse(readFileSync('scripts/publish-allowlist.json', 'utf8'));
  assert.deepEqual(allowlist.packages, [...expected.keys()].sort());
  for (const [name, directory] of expected) {
    const manifest = manifestAt(directory);
    assert.equal(manifest.name, name, directory);
    assert.equal(manifest.version, '0.1.0', name);
  }
});

test('@obversa/obversa installs every other public package', () => {
  const dependencies = manifestAt('packages/obversa').dependencies;
  assert.deepEqual(Object.keys(dependencies).sort(), [...expected.keys()].filter((name) => name !== '@obversa/obversa').sort());
});

test('the four core packages use exact workspace references while API remains a runtime peer', () => {
  assert.equal(manifestAt('packages/core').dependencies['@obversa/api'], 'workspace:*');
  const runtime = manifestAt('packages/runtime');
  assert.equal(runtime.dependencies['@obversa/core'], 'workspace:*');
  assert.equal(runtime.peerDependencies['@obversa/api'], 'workspace:*');
  assert.equal(runtime.devDependencies['@obversa/api'], 'workspace:*');
  assert.deepEqual(manifestAt('packages/runner').dependencies, {
    '@obversa/api': 'workspace:*',
    '@obversa/core': 'workspace:*',
    '@obversa/runtime': 'workspace:*',
  });
});
