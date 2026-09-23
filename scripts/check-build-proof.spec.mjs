import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as guard from './check-publish-allowlist.mjs';

function write(path, contents) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'obversa-build-proof-'));
  write(join(root, 'package.json'), JSON.stringify({ private: true, scripts: { build: 'node scripts/build-workspace.mjs' } }));
  write(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  write(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  write(join(root, 'tsconfig.base.json'), '{}\n');
  write(join(root, 'scripts', 'publish-allowlist.json'), JSON.stringify({ packages: ['@x/a', '@x/meta'] }));
  write(join(root, 'scripts', 'check-publish-allowlist.mjs'), 'guard\n');
  write(join(root, 'scripts', 'build-workspace.mjs'), 'build\n');
  write(join(root, 'packages', 'a', 'package.json'), JSON.stringify({
    name: '@x/a',
    version: '1.0.0',
    scripts: { build: 'fixture build' },
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
    bin: { 'x-a': './bin/x-a.mjs' },
  }));
  write(join(root, 'packages', 'a', 'src', 'index.ts'), 'export const answer = 42;\n');
  write(join(root, 'packages', 'a', 'bin', 'x-a.mjs'), '#!/usr/bin/env node\n');
  write(join(root, 'packages', 'a', 'tsconfig.json'), '{}\n');
  write(join(root, 'packages', 'a', 'tsconfig.build.json'), '{}\n');
  write(join(root, 'packages', 'a', 'tsup.config.ts'), 'export default {};\n');
  write(join(root, 'packages', 'a', 'tests', 'ignored.spec.ts'), 'test\n');
  write(join(root, 'packages', 'a', 'assets', 'ignored.css'), 'body{}\n');
  write(join(root, 'packages', 'a', 'README.md'), 'docs\n');
  write(join(root, 'packages', 'a', 'dist', 'index.js'), 'export const answer = 42;\n');
  write(join(root, 'packages', 'a', 'dist', 'index.d.ts'), 'export declare const answer = 42;\n');
  write(join(root, 'packages', 'meta', 'package.json'), JSON.stringify({ name: '@x/meta', version: '1.0.0' }));
  return { root, packageRoot: join(root, 'packages', 'a'), metaRoot: join(root, 'packages', 'meta') };
}

function withWorkspace(run) {
  const fixture = workspace();
  try {
    run(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function addBuilder(root, name) {
  const directory = join(root, 'packages', name);
  write(join(directory, 'package.json'), JSON.stringify({
    name: `@x/${name}`,
    version: '1.0.0',
    scripts: { build: 'fixture build' },
    main: './dist/index.js',
  }));
  write(join(directory, 'src', 'index.ts'), `export const ${name} = true;\n`);
  write(join(directory, 'tsconfig.build.json'), '{}\n');
  write(join(directory, 'dist', 'index.js'), `export const ${name} = true;\n`);
  const allowlistPath = join(root, 'scripts', 'publish-allowlist.json');
  const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'));
  allowlist.packages.push(`@x/${name}`);
  writeFileSync(allowlistPath, JSON.stringify(allowlist));
  return directory;
}

test('the build record hashes the stated compiler inputs and excludes tests, docs, and assets', () => withWorkspace(({ root }) => {
  const paths = guard.captureBuildInputs(root).map(({ path }) => path);
  assert.deepEqual(paths, [
    'package.json',
    'packages/a/bin/x-a.mjs',
    'packages/a/package.json',
    'packages/a/src/index.ts',
    'packages/a/tsconfig.build.json',
    'packages/a/tsconfig.json',
    'packages/a/tsup.config.ts',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'scripts/build-workspace.mjs',
    'scripts/check-publish-allowlist.mjs',
    'scripts/publish-allowlist.json',
    'tsconfig.base.json',
  ]);
}));

test('built output and every declared local entry target pass the read-only package check', () => withWorkspace(({ root, packageRoot, metaRoot }) => {
  guard.recordWorkspaceBuild({ root, runBuild() {} });
  assert.deepEqual(guard.checkBuildProof({ root, cwd: packageRoot }), []);
  assert.deepEqual(guard.checkBuildProof({ root, cwd: metaRoot }), [], 'a package without a build needs no proof');
}));

test('removing the build command cannot hide a missing declared dist target', () => withWorkspace(({ root, packageRoot }) => {
  guard.recordWorkspaceBuild({ root, runBuild() {} });
  const manifestPath = join(packageRoot, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  delete manifest.scripts.build;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  rmSync(join(packageRoot, 'dist', 'index.js'));
  const problems = guard.checkBuildProof({ root, cwd: packageRoot }).join('\n');
  assert.match(problems, /declares dist output but has no scripts\.build/);
  assert.match(problems, /declared target .*dist\/index\.js.*missing/);
}));

for (const [label, mutate, expected] of [
  ['missing dist', (root) => rmSync(join(root, 'packages/a/dist/index.js')), /declared target .*dist\/index\.js.*missing|built output.*changed/],
  ['added source', (root) => write(join(root, 'packages/a/src/new.ts'), 'export {};\n'), /build inputs changed/],
  ['tampered output', (root) => write(join(root, 'packages/a/dist/index.js'), 'tampered\n'), /built workspace output changed/],
]) {
  test(label, () => withWorkspace(({ root, packageRoot }) => {
    guard.recordWorkspaceBuild({ root, runBuild() {} });
    mutate(root);
    assert.match(guard.checkBuildProof({ root, cwd: packageRoot }).join('\n'), expected);
  }));
}

test('a changed output in another build-bearing package invalidates the shared proof', () => withWorkspace(({ root, packageRoot }) => {
  const dependency = addBuilder(root, 'dependency');
  guard.recordWorkspaceBuild({ root, runBuild() {} });
  write(join(dependency, 'dist', 'index.js'), 'tampered dependency\n');
  assert.match(guard.checkBuildProof({ root, cwd: packageRoot }).join('\n'), /built workspace output changed/);
}));

test('a failed rebuild removes the old record before it runs', () => withWorkspace(({ root }) => {
  guard.recordWorkspaceBuild({ root, runBuild() {} });
  assert.equal(existsSync(join(root, '.obversa', 'build-proof.json')), true);
  assert.throws(() => guard.recordWorkspaceBuild({ root, runBuild() { throw new Error('build failed'); } }), /build failed/);
  assert.equal(existsSync(join(root, '.obversa', 'build-proof.json')), false);
}));

test('inputs changing during a successful build leave no record', () => withWorkspace(({ root }) => {
  assert.throws(() => guard.recordWorkspaceBuild({
    root,
    runBuild() { write(join(root, 'packages/a/src/index.ts'), 'changed during build\n'); },
  }), /build inputs changed while the build was running/);
  assert.equal(existsSync(join(root, '.obversa', 'build-proof.json')), false);
}));

test('the record contains content hashes for the full input and output file sets', () => withWorkspace(({ root }) => {
  guard.recordWorkspaceBuild({ root, runBuild() {} });
  const record = JSON.parse(readFileSync(join(root, '.obversa', 'build-proof.json'), 'utf8'));
  assert.equal(record.schemaVersion, 1);
  assert.ok(record.inputs.every(({ path, sha256 }) => path && /^[a-f0-9]{64}$/.test(sha256)));
  assert.deepEqual(record.outputs['@x/a'].map(({ path }) => path), [
    'packages/a/dist/index.d.ts',
    'packages/a/dist/index.js',
  ]);
}));
