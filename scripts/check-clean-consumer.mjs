#!/usr/bin/env node

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { packWorkspacePackages } from './check-packages.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFromPublicDoc(document) {
  const match = /## Source[\s\S]*?```ts\n([\s\S]*?)\n```/.exec(document);
  if (!match) throw new Error('The offline production-line page has no TypeScript source block');
  return `${match[1]}\n`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`);
  }
  return result.stdout;
}

const consumerSource = `
import assert from 'node:assert/strict';

import {
  MEMORY_ROOT,
  type MemoryResult,
} from '@obversa/memory';
import { runMemoryConformance } from '@obversa/memory/testing';
import { createSimpleMemory } from '@obversa/memory-simple';
import { openGitMemory } from '@obversa/memory-git';
import { agentJob, run } from '@obversa/lines';
import { commandEnvironment } from '@obversa/lines/env/command';
import { MockEngine } from '@obversa/lines/testing';
import linesPackage from '@obversa/lines/package.json' with { type: 'json' };

assert.equal(MEMORY_ROOT, '/memories');
assert.equal(linesPackage.version, '1.0.0');
assert.equal(commandEnvironment({
  deploy: () => ({ cmd: 'true' }),
  destroy: () => ({ cmd: 'true' }),
}).name, 'command');

const simple = createSimpleMemory({ scope: 'packed-consumer' });
const created: MemoryResult = await simple.execute({
  command: 'create',
  path: '/memories/simple.md',
  text: 'simple adapter',
});
assert.equal(created.ok, true);

const conformance = await runMemoryConformance(createSimpleMemory);
assert.equal(conformance.ok, true);
assert.equal(conformance.cases, 17);

const repositoryPath = process.env.CONSUMER_GIT_REPOSITORY;
assert.ok(repositoryPath);
const gitMemory = await openGitMemory({ repositoryPath, scope: 'packed-consumer' });
const gitCreated = await gitMemory.execute({
  command: 'create',
  path: '/memories/git.md',
  text: 'git adapter',
});
assert.equal(gitCreated.ok, true);
const gitViewed = await gitMemory.execute({ command: 'view', path: '/memories/git.md' });
assert.ok(gitViewed.ok && gitViewed.command === 'view' && gitViewed.value.kind === 'file');
assert.equal(gitViewed.value.text, 'git adapter');

let receivedMemory = false;
const engine = new MockEngine((request) => {
  receivedMemory = request.memory === simple;
  return 'ready';
});
const result = await run(
  agentJob({ label: 'packed-consumer', engine: 'offline', prompt: 'Return ready.' }),
  {
    engine: 'offline',
    engines: { offline: engine },
    memory: simple,
  },
);
assert.equal(result.outcome.status, 'pass');
assert.equal(receivedMemory, true);

console.log(JSON.stringify({
  lines: result.outcome.status,
  memoryCases: conformance.cases,
  simple: created.ok,
  git: gitViewed.ok,
}));
`;

const tsconfig = {
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    lib: ['ES2023'],
    strict: true,
    noUncheckedIndexedAccess: true,
    verbatimModuleSyntax: true,
    resolveJsonModule: true,
    skipLibCheck: false,
    outDir: 'dist',
    types: ['node'],
  },
  include: ['consumer.ts', 'offline-review.line.ts'],
};

async function main() {
  const exampleSource = await readFile(
    join(root, 'examples', 'production-lines', 'offline-review.line.ts'),
    'utf8',
  );
  const publicDocument = await readFile(
    join(root, 'docs', 'public', 'production-lines', 'offline-review.mdx'),
    'utf8',
  );
  if (sourceFromPublicDoc(publicDocument) !== exampleSource) {
    throw new Error('The offline production-line page does not match its runnable source');
  }

  const directory = await mkdtemp(join(tmpdir(), 'obversa-consumer-'));
  const archivesDirectory = join(directory, 'archives');
  const consumerDirectory = join(directory, 'consumer');
  const gitRepository = join(directory, 'memory-repository');

  try {
    await mkdir(archivesDirectory);
    await mkdir(consumerDirectory);
    const archives = await packWorkspacePackages(archivesDirectory);
    const dependencies = Object.fromEntries(
      [...archives.entries()].map(([name, tarball]) => [name, `file:${tarball}`]),
    );
    const manifest = {
      name: 'obversa-packed-consumer-proof',
      private: true,
      type: 'module',
      dependencies,
      devDependencies: {
        '@types/node': '22.12.0',
        tsx: '4.22.4',
      },
      pnpm: {
        overrides: {
          '@obversa/memory': dependencies['@obversa/memory'],
        },
      },
    };

    await writeFile(join(consumerDirectory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(consumerDirectory, 'tsconfig.json'), `${JSON.stringify(tsconfig, null, 2)}\n`);
    await writeFile(join(consumerDirectory, 'consumer.ts'), consumerSource.trimStart());
    await writeFile(
      join(consumerDirectory, 'offline-review.line.ts'),
      exampleSource,
    );

    run('pnpm', ['install', '--offline', '--ignore-scripts'], {
      cwd: consumerDirectory,
      env: { CI: 'true', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
    });

    for (const name of archives.keys()) {
      const installed = JSON.parse(
        await readFile(join(consumerDirectory, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'),
      );
      if (JSON.stringify(installed).includes('workspace:')) {
        throw new Error(`${name} retained a workspace dependency after installation`);
      }
    }

    const tsc6 = join(root, 'node_modules', '@typescript', 'typescript6', 'bin', 'tsc6');
    run(process.execPath, [tsc6, '-p', 'tsconfig.json'], { cwd: consumerDirectory });

    run('git', ['init', '--quiet', gitRepository]);
    const output = run(process.execPath, ['dist/consumer.js'], {
      cwd: consumerDirectory,
      env: { CONSUMER_GIT_REPOSITORY: gitRepository },
    }).trim();
    const report = JSON.parse(output.split(/\r?\n/).at(-1));
    const productionLine = JSON.parse(
      run(process.execPath, ['dist/offline-review.line.js'], { cwd: consumerDirectory }),
    );
    const directProductionLine = JSON.parse(
      run('pnpm', ['exec', 'tsx', 'offline-review.line.ts'], { cwd: consumerDirectory }),
    );
    if (
      report.lines !== 'pass' ||
      report.memoryCases !== 17 ||
      report.simple !== true ||
      report.git !== true ||
      productionLine.status !== 'pass' ||
      productionLine.attempts !== 2 ||
      productionLine.summary !== 'config is complete' ||
      directProductionLine.status !== 'pass' ||
      directProductionLine.attempts !== 2 ||
      directProductionLine.summary !== 'config is complete'
    ) {
      throw new Error(
        `Packed consumer returned an invalid report: ${JSON.stringify({ report, productionLine, directProductionLine })}`,
      );
    }

    if (run('git', ['status', '--porcelain'], { cwd: gitRepository }).trim()) {
      throw new Error('The Git memory adapter changed the consumer worktree or index');
    }
    const refs = run('git', ['for-each-ref', '--format=%(refname)', 'refs/obversa/memory/v1'], {
      cwd: gitRepository,
    })
      .split(/\r?\n/)
      .filter(Boolean);
    if (refs.length !== 1) throw new Error(`Git memory created ${refs.length} private refs instead of one`);

    console.log(
      'Clean offline consumer passed with TypeScript 6, the first production line, 17 memory cases, and both adapters.',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
