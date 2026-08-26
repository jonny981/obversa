import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url));
const checker = resolve(scripts, 'check-graph-purity.mjs');
const temporaryDirectories = [];

test.after(() => {
  for (const directory of temporaryDirectories.reverse()) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function runFixture(files) {
  const directory = mkdtempSync(join(tmpdir(), 'obversa-graph-purity-'));
  temporaryDirectories.push(directory);

  for (const [path, source] of Object.entries(files)) {
    const absolute = join(directory, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, source);
  }

  return spawnSync(process.execPath, [checker, directory], {
    encoding: 'utf8',
  });
}

test('allows pure local modules, approved Node utilities, and the memory port type', () => {
  const result = runFixture({
    'graph.ts': `
      import { createHash } from 'node:crypto';
      import { isDeepStrictEqual } from 'node:util';
      import type { Memory } from '@obversa/memory';
      import { type MemoryCommand } from '@obversa/memory';
      import { local } from './nested/local.js';
      export { local } from './nested/local.js';
      export const value = createHash('sha256').update(String(local)).digest('hex');
      export const equal = isDeepStrictEqual(value, value);
      export const maximum = Math.max(1, 2);
      export type Port = Memory | MemoryCommand;
    `,
    'nested/local.tsx': 'export const local = 1;',
    'more.mts': "export type { Port } from './graph.js';",
    'legacy.cts': "const text = \"require('node:fs') import('../runtime/runner.js')\"; export { text };",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Graph purity check passed \(4 files\)/);
});

test('rejects forbidden dependencies through static imports and export-from', () => {
  const forbidden = [
    '../runtime/runner.js',
    '../engines/engine.js',
    '../env/environment.js',
    '../workspace/provider.js',
    '../core/git.js',
    '../runtime/process-tree.js',
    '../storage/store.js',
    '../telemetry/reporter.js',
    'node:fs/promises',
    'node:child_process',
    'node:process',
    '@obversa/memory-simple',
    '@obversa/memory-git',
    '@obversa/memory/testing',
    '@obversa/memory',
    'execa',
    '../core/job.js',
    '../shared/helpers.js',
  ];
  const result = runFixture({
    'forbidden.ts': `
      import '../runtime/runner.js';
      export { engine } from '../engines/engine.js';
      import type { Environment } from '../env/environment.js';
      import { workspace } from '../workspace/provider.js';
      import { git } from '../core/git.js';
      import { tree } from '../runtime/process-tree.js';
      export type { Store } from '../storage/store.js';
      import { telemetry } from '../telemetry/reporter.js';
      import { readFile } from 'node:fs/promises';
      import { spawn } from 'node:child_process';
      import process from 'node:process';
      import { openSimpleMemory } from '@obversa/memory-simple';
      import { openGitMemory } from '@obversa/memory-git';
      import type { MemoryConformanceReport } from '@obversa/memory/testing';
      import { MEMORY_ROOT } from '@obversa/memory';
      import { execa } from 'execa';
      import { agentJob } from '../core/job.js';
      import { helper } from '../shared/helpers.js';
    `,
  });

  assert.equal(result.status, 1, result.stdout);
  for (const specifier of forbidden) {
    assert.match(result.stderr, new RegExp(specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('allows only the reviewed named imports from Node utilities', () => {
  const result = runFixture({
    'node-utilities.ts': `
      import crypto from 'node:crypto';
      import { randomUUID } from 'node:crypto';
      import { inspect } from 'node:util';
      export { crypto, randomUUID, inspect };
    `,
  });

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /createHash/);
  assert.match(result.stderr, /isDeepStrictEqual/);
});

test('rejects effectful globals', () => {
  const result = runFixture({
    'time.ts': 'export const now = Date.now() + performance.now();',
    'randomness.ts': 'export const random = Math.random() + crypto.randomUUID().length;',
    'process.ts': 'export const cwd = process.cwd();',
    'network.ts': "export const request = fetch('https://example.invalid');",
    'timers.ts': 'export const timer = setTimeout(() => undefined, 1);',
    'evaluation.ts': "export const value = eval('1 + 1') + new Function('return 1')();",
    'global-object.ts': 'export const roots = [globalThis, global, window, self];',
  });

  assert.equal(result.status, 1, result.stdout);
  for (const path of [
    'time.ts',
    'randomness.ts',
    'process.ts',
    'network.ts',
    'timers.ts',
    'evaluation.ts',
    'global-object.ts',
  ]) {
    assert.match(result.stderr, new RegExp(path.replace('.', '\\.')));
  }
});

test('rejects a destructured alias that can reach Math.random', () => {
  const result = runFixture({
    'aliased-random.ts': `
      const { random } = Math;
      export const value = random();
    `,
  });

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /aliased-random\.ts:.*Math/);
});

test('rejects local runtime imports whose implementation is not scanned', () => {
  const result = runFixture({
    'graph.ts': "import { effect } from './effect.js'; export { effect };",
    'effect.js': 'export const effect = process.cwd();',
  });

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /graph\.ts:.*\.\/effect\.js/);
  assert.match(result.stderr, /scanned source/i);
});

test('rejects forbidden dynamic imports', () => {
  const result = runFixture({
    'dynamic.ts': `
      export async function loadRuntime() {
        return import('../runtime/runner.js');
      }
    `,
  });

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /dynamic\.ts:.*\.\.\/runtime\/runner\.js/);
});

test('rejects forbidden import types', () => {
  const result = runFixture({
    'import-type.ts': "export type Runtime = import('../runtime/runner.js').Runtime;",
  });

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /import-type\.ts:.*\.\.\/runtime\/runner\.js/);
});

test('rejects forbidden require calls and TypeScript import-equals', () => {
  const result = runFixture({
    'require.cts': `
      const childProcess = require('node:child_process');
      import runtime = require('../runtime/runner.js');
      export { childProcess, runtime };
    `,
  });

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /node:child_process/);
  assert.match(result.stderr, /\.\.\/runtime\/runner\.js/);
});

test('rejects non-literal import and require targets', () => {
  const result = runFixture({
    'computed.ts': `
      const target = '../runtime/runner.js';
      export const imported = import(target);
      export const required = require(target);
    `,
  });

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /import\(\) must use a string literal/);
  assert.match(result.stderr, /require\(\) must use a string literal/);
});

test('rejects malformed source instead of skipping its imports', () => {
  const result = runFixture({
    'broken.ts': "import { readFile from 'node:fs';",
  });

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /broken\.ts:.*cannot parse source/);
});
