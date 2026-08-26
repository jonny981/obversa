#!/usr/bin/env node

import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { packWorkspacePackages } from './check-packages.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const expectedGraphReport = {
  conformance: true,
  cases: 6,
  state: 'done',
  decision: 'complete',
  planDigest: 'sha256:0b17551b9f4274dca832c040922d71251f9bf52bbd5e9462c6ed781506cd367b',
  dispatches: {
    min: { kind: 'known', value: 2 },
    max: { kind: 'known', value: 2 },
  },
  maxConcurrency: { kind: 'known', value: 1 },
  maxFanOut: { kind: 'known', value: 1 },
};

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
import {
  GraphValidationError,
  agentJob,
  run,
  validateGraphDescription,
} from '@obversa/lines';
import { commandEnvironment } from '@obversa/lines/env/command';
import { MockEngine } from '@obversa/lines/testing';
import linesPackage from '@obversa/lines/package.json' with { type: 'json' };

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Expect<Value extends true> = Value;
type PublicValidatorTakesOneArgument = Expect<Equal<
  Parameters<typeof validateGraphDescription>,
  [value: unknown]
>>;

const publicValidatorTakesOneArgument: PublicValidatorTakesOneArgument = true;

assert.equal(MEMORY_ROOT, '/memories');
assert.equal(linesPackage.version, '1.0.0');
assert.equal(commandEnvironment({
  deploy: () => ({ cmd: 'true' }),
  destroy: () => ({ cmd: 'true' }),
}).name, 'command');

const parsedGraphDescription: unknown = JSON.parse(JSON.stringify({
  schemaVersion: 1,
  graph: {
    id: 'packed-description',
    definitionVersion: 1,
    kind: 'empty',
    typeVersion: 1,
    definitionDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  },
  inputContract: {
    type: 'object',
    properties: { title: { type: 'string' } },
  },
  outputContract: { type: 'object' },
  phases: [{ id: 'work', name: 'Work', nodeIds: [] }],
  nodes: [],
  edges: [],
  policies: {
    retry: null,
    stop: null,
    concurrency: null,
    write: null,
    budget: null,
    action: null,
  },
  executionLanes: [],
  requestedPermissions: [],
  bounds: {
    dispatches: {
      min: { kind: 'known', value: 0 },
      max: { kind: 'known', value: 0 },
    },
    maxConcurrency: { kind: 'known', value: 0 },
    maxFanOut: { kind: 'known', value: 0 },
  },
  requirements: { memory: 'unused' },
}));
const validatedGraphDescription = validateGraphDescription(parsedGraphDescription);
const inputContract = validatedGraphDescription.inputContract as {
  readonly type: string;
  readonly properties: {
    readonly title: { readonly type: string };
  };
};
assert.equal(validatedGraphDescription.graph.id, 'packed-description');
assert.deepEqual(validatedGraphDescription.bounds.dispatches, {
  min: { kind: 'known', value: 0 },
  max: { kind: 'known', value: 0 },
});
assert.equal(inputContract.properties.title.type, 'string');
assert.equal(Object.isFrozen(validatedGraphDescription), true);
assert.equal(Object.isFrozen(validatedGraphDescription.graph), true);
assert.equal(Object.isFrozen(inputContract), true);
assert.equal(Object.isFrozen(inputContract.properties), true);
assert.equal(Object.isFrozen(inputContract.properties.title), true);
assert.equal(publicValidatorTakesOneArgument, true);

const malformedGraphDescription: unknown = JSON.parse('{}');
assert.throws(
  () => validateGraphDescription(malformedGraphDescription),
  (error: unknown) => error instanceof GraphValidationError,
);

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
  include: ['consumer.ts', 'offline-review.line.ts', 'custom-graph.ts'],
};

async function main() {
  const exampleSource = await readFile(
    join(root, 'examples', 'production-lines', 'offline-review.line.ts'),
    'utf8',
  );
  const graphExamplePath = join(root, 'examples', 'packages', 'custom-graph.ts');
  const graphExampleSource = await readFile(graphExamplePath, 'utf8');
  const graphDocument = await readFile(
    join(root, 'docs', 'public', 'graphs', 'contract.mdx'),
    'utf8',
  );
  const publicDocument = await readFile(
    join(root, 'docs', 'public', 'production-lines', 'offline-review.mdx'),
    'utf8',
  );
  if (sourceFromPublicDoc(publicDocument) !== exampleSource) {
    throw new Error('The offline production-line page does not match its runnable source');
  }
  if (sourceFromPublicDoc(graphDocument) !== graphExampleSource) {
    throw new Error('The outside graph contract page does not match its runnable source');
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
    await copyFile(graphExamplePath, join(consumerDirectory, 'custom-graph.ts'));

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
    const compiledGraph = JSON.parse(
      run(process.execPath, ['dist/custom-graph.js'], { cwd: consumerDirectory }),
    );
    const directGraph = JSON.parse(
      run('pnpm', ['exec', 'tsx', 'custom-graph.ts'], { cwd: consumerDirectory }),
    );
    assert.deepEqual(compiledGraph, expectedGraphReport);
    assert.deepEqual(directGraph, expectedGraphReport);
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
      'Clean offline consumer passed with TypeScript 6, the first production line, the outside graph, 17 memory cases, and both adapters.',
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
