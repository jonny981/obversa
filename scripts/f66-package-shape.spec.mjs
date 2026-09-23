import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { valid as validVersion } from 'semver';

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
  ['@obversa/engine-jev-api', 'plugins/engine-jev-api'],
  ['@obversa/engine-opencode-cli', 'plugins/engine-opencode-cli'],
  ['@obversa/memory-git', 'plugins/memory-git'],
  ['@obversa/memory-simple', 'plugins/memory-simple'],
  ['@obversa/memory-markdown', 'plugins/memory-markdown'],
  ['@obversa/notify-webhook', 'plugins/notify-webhook'],
]);

const manifestAt = (directory) => JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));

function localTargets(value, targets = []) {
  if (typeof value === 'string') {
    if (value.startsWith('./')) targets.push(value.slice(2));
  } else if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) localTargets(nested, targets);
  }
  return targets;
}

function declaresDistOutput(manifest) {
  return [manifest.main, manifest.types, manifest.exports, manifest.bin]
    .flatMap((value) => localTargets(value))
    .some((target) => target === 'dist' || target.startsWith('dist/'));
}

function assertExactVersion(version, name) {
  assert.equal(typeof version, 'string', `${name}: version must be an exact valid SemVer`);
  assert.notEqual(validVersion(version), null, `${name}: version must be an exact valid SemVer`);
}

test('all nineteen public packages have the accepted names and locations', () => {
  const allowlist = JSON.parse(readFileSync('scripts/publish-allowlist.json', 'utf8'));
  assert.deepEqual(allowlist.packages, [...expected.keys()].sort());
  for (const [name, directory] of expected) {
    const manifest = manifestAt(directory);
    assert.equal(manifest.name, name, directory);
    assertExactVersion(manifest.version, name);
  }
});

test('public packages with declared dist output build and validate it without rebuilding during prepack', () => {
  for (const directory of expected.values()) {
    const manifest = manifestAt(directory);
    const scripts = manifest.scripts ?? {};
    const buildProofRequired = declaresDistOutput(manifest);
    assert.equal(typeof scripts.build === 'string', buildProofRequired, directory);
    assert.equal(scripts.prepack, buildProofRequired ? 'node ../../scripts/check-publish-allowlist.mjs --build-proof' : undefined, directory);
  }
});

test('package versions may advance but remain exact SemVer', () => {
  assert.doesNotThrow(() => assertExactVersion('0.1.1+build.1', '@obversa/example'));
  assert.throws(() => assertExactVersion('next', '@obversa/example'), /version must be an exact valid SemVer/);
  assert.throws(() => assertExactVersion('^0.1.0', '@obversa/example'), /version must be an exact valid SemVer/);
});

test('release verification reaches package shape, clean consumer, and retired-name checks', () => {
  const scripts = manifestAt('.').scripts;
  const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf8');
  assert.equal(scripts['verify:f108'], 'pnpm verify:d15');
  assert.match(releaseWorkflow, /run: pnpm verify:d15/);
  assert.match(scripts['verify:d15'], /node --test scripts\/f66-package-shape\.spec\.mjs/);
  assert.match(scripts['verify:d15'], /pnpm test:retired-names/);
  assert.match(scripts['verify:d15'], /pnpm check:retired-names/);
  assert.match(scripts['verify:d1'], /pnpm check:consumer/);
  assert.match(scripts['check:consumer'], /node --test scripts\/check-clean-consumer\.spec\.mjs/);
});

test('release builds use the recorded root build and the manual sequence stops on failure', () => {
  const root = manifestAt('.');
  const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf8');
  const releasing = readFileSync('docs/RELEASING.md', 'utf8');
  assert.equal(root.scripts.build, 'node scripts/build-workspace.mjs');
  assert.match(root.scripts['test:publish-guard'], /scripts\/check-build-proof\.spec\.mjs/);
  assert.match(releaseWorkflow, /- run: pnpm build/);
  assert.doesNotMatch(releaseWorkflow, /- run: pnpm --recursive --if-present run build/);
  assert.match(releasing, /pnpm build && \\\n  OBVERSA_RELEASE=1 pnpm changeset publish && \\\n  node scripts\/tag-published\.mjs && \\\n  node scripts\/verify-published\.mjs/);
});

test('@obversa/obversa installs every other published package', () => {
  const dependencies = manifestAt('packages/obversa').dependencies;
  const notYetPublished = new Set(['@obversa/engine-jev-api']);
  assert.deepEqual(Object.keys(dependencies).sort(), [...expected.keys()].filter((name) => name !== '@obversa/obversa' && !notYetPublished.has(name)).sort());
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
