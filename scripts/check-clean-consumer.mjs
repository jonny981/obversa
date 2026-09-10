#!/usr/bin/env node

import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
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

const expectedPipelineReport = {
  executor: 'complete',
  output: {
    nodes: {
      draft: { article: 'ready' },
      review: { approved: true },
      publish: { published: true },
    },
  },
  dispatches: 3,
  order: ['draft', 'review', 'publish'],
  planDigest: 'sha256:ebbf122994643028c5222a0afaf8d7a99a257716e00f0e255b15f315e4b862ed',
  bounds: {
    dispatches: {
      min: { kind: 'known', value: 3 },
      max: { kind: 'known', value: 3 },
    },
    maxConcurrency: { kind: 'known', value: 1 },
    maxFanOut: { kind: 'known', value: 1 },
  },
};

const expectedReviewLoopReport = {
  decision: {
    kind: 'complete',
    output: {
      iterations: 1,
      restarts: 0,
      seats: {
        'claude-review': 'accepted',
        'codex-review': 'accepted',
      },
      findings: [],
    },
  },
  events: 10,
  planDigest: 'sha256:499b4c4187dfb574d3a22653145a0b3289c7c6ed25eb106eb981ae86f4136aa1',
  bounds: {
    dispatches: {
      min: { kind: 'known', value: 4 },
      max: { kind: 'known', value: 11 },
    },
    maxConcurrency: { kind: 'known', value: 2 },
    maxFanOut: { kind: 'known', value: 2 },
  },
};

const expectedCallbackGateReport = {
  requestId: 'release-approval#1#3a32b8f32a48c2b1ddc28ecec2c3035d4619311acf96364200e8c25efe94cd05',
  digest: '3a32b8f32a48c2b1ddc28ecec2c3035d4619311acf96364200e8c25efe94cd05',
  sameQuestionId: true,
  changedQuestionId: true,
  blockedKind: 'claimed',
  released: true,
  submitted: true,
  events: [
    'callback-requested',
    'callback-claimed',
    'callback-released',
    'callback-claimed',
    'callback-submitted',
  ],
  replayedPending: 0,
};

const expectedProofBoundApprovalReport = {
  proof: {
    digest: 'sha256:db5b2a0eb5743b52617a78335dbc003a9a10619dc6cab05f6099f81c9b7fb329',
    byteLength: 133,
    recordsShareDigest: true,
  },
  callback: {
    responseSurvivedReopen: true,
    changedRequest: true,
  },
  acceptedResult: {
    unchanged: 'accepted',
    changedAnchor: 'wait',
  },
  approval: {
    unchanged: 'allow',
    changedOutput: 'wait',
  },
};

const expectedProofCacheReport = {
  sourceReads: { config: 2, policy: 1 },
  proofRuns: 1,
  sharedPacket: true,
  reused: 'accepted',
  changedSource: 'wait',
  unaffectedPacket: true,
  changedReviewer: 'wait',
  effectfulRefused: true,
};

const expectedTurnTakingReport = {
  conformance: true,
  cases: 6,
  state: 'done',
  decision: 'complete',
  executor: 'complete',
  executorOutput: { rounds: 3 },
  executorDispatches: 6,
  primaryCalls: 1,
  fallbackCalls: 3,
  planDigest: 'sha256:e8e9ba7fd2e6e9c454a2cb61684b4d8ef809cc9ebed8c5245f2e47daa9f9dbb4',
  criticLane: 'mock-primary',
  fallbackResolves: 'mock-fallback',
  writerLane: null,
  dispatches: {
    min: { kind: 'known', value: 6 },
    max: { kind: 'known', value: 6 },
  },
  maxConcurrency: { kind: 'known', value: 1 },
  maxFanOut: { kind: 'known', value: 1 },
};

const expectedStorageReport = {
  storedArtifactBytes: 65_591,
  eventPayloadBytes: 194,
  reopenedState: {
    eventCount: 1,
    artifactBytes: 65_591,
    lastArtifactDigest: 'sha256:45ccde9ad00cd4b72ab6c8aced15a85c3199c7ceab300942bf678ae1fa3d40cc',
  },
  conformance: {
    events: 10,
    artifacts: 15,
  },
};

const expectedAttemptReport = {
  grok: {
    requested: {
      adapter: 'grok-cli',
      adapterVersion: '1.0.5',
      provider: 'xai',
      modelFamily: 'grok-4',
      model: 'grok-4-example',
      capabilities: [],
    },
    effective: {
      adapter: 'grok-cli',
      adapterVersion: '1.0.5',
      provider: 'xai',
      modelFamily: 'grok-4',
      model: 'grok-4-example',
      capabilities: [],
    },
    final: { answer: 42 },
    usage: 'reported',
  },
  opencode: {
    requested: {
      adapter: 'opencode-cli',
      adapterVersion: '1.18.23',
      provider: 'opencode',
      modelFamily: null,
      model: 'opencode/x-preview-f-free',
      capabilities: [],
    },
    effective: {
      adapter: 'opencode-cli',
      adapterVersion: '1.18.23',
      provider: 'opencode',
      modelFamily: null,
      model: 'opencode/x-preview-f-free',
      capabilities: [],
    },
    final: { answer: 42 },
    usage: 'unknown',
  },
  temporaryDirectoryRemoved: true,
};

function withoutExecutablePath(selection, filename) {
  assert.equal(typeof selection.executable, 'string');
  assert.equal(isAbsolute(selection.executable), true);
  assert.equal(basename(selection.executable), filename);
  const { executable: _, ...rest } = selection;
  return rest;
}

function checkedAttemptReport(report) {
  assert.equal(
    report.grok.requested.executable,
    report.grok.effective.executable,
  );
  assert.equal(
    report.opencode.requested.executable,
    report.opencode.effective.executable,
  );
  return {
    ...report,
    grok: {
      ...report.grok,
      requested: withoutExecutablePath(
        report.grok.requested,
        'grok-fixture.mjs',
      ),
      effective: withoutExecutablePath(
        report.grok.effective,
        'grok-fixture.mjs',
      ),
    },
    opencode: {
      ...report.opencode,
      requested: withoutExecutablePath(
        report.opencode.requested,
        'opencode-fixture.mjs',
      ),
      effective: withoutExecutablePath(
        report.opencode.effective,
        'opencode-fixture.mjs',
      ),
    },
  };
}

export function checkedAttemptOutput(output, report) {
  const display = JSON.parse(output);
  for (const [name, filename] of [['grok', 'grok-fixture.mjs'], ['opencode', 'opencode-fixture.mjs']]) {
    for (const selection of ['requested', 'effective']) {
      assert.equal(display[name][selection].executable, filename);
      display[name][selection].executable = report[name][selection].executable;
    }
  }
  // Display paths are relative; the exported selections must still be absolute.
  assert.deepEqual(display, report);
  return checkedAttemptReport(report);
}

function sourceFromPublicDoc(document) {
  const match = /## Source[\s\S]*?```ts\n([\s\S]*?)\n```/.exec(document);
  if (!match) throw new Error('The public page has no TypeScript source block');
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
import { MockEngine } from '@obversa/engine/testing';
import { AgentSdkEngine } from '@obversa/engine-agent-sdk';
import { AnthropicApiEngine } from '@obversa/engine-anthropic-api';
import { ClaudeCliEngine } from '@obversa/engine-claude-cli';
import { CodexEngine } from '@obversa/engine-codex';
import type { runSurface, startSurface } from '@obversa/surfacer';
import type { createSurfaceClient } from '@obversa/surfacer/client';
import type { reviewDiff } from '@obversa/source';
import type { listTrackedFiles } from '@obversa/source/testing';

// Compile-time surface checks: these imports fail the consumer build if
// either package ships no type declarations, and the assertions fail it if
// the public callables lose their callable shape.
type SurfaceCallable = typeof runSurface extends (...args: never[]) => unknown ? true : never;
type SurfaceStartCallable = typeof startSurface extends (...args: never[]) => unknown ? true : never;
type ClientCallable = typeof createSurfaceClient extends (...args: never[]) => unknown ? true : never;
type ReviewCallable = typeof reviewDiff extends (...args: never[]) => unknown ? true : never;
type TrackedCallable = typeof listTrackedFiles extends (...args: never[]) => unknown ? true : never;
const _f16TypeSurfaces: [SurfaceCallable, SurfaceStartCallable, ClientCallable, ReviewCallable, TrackedCallable] = [true, true, true, true, true];
import { GrokCliEngine } from '@obversa/engine-grok-cli';
import { OpenCodeCliEngine } from '@obversa/engine-opencode-cli';
import {
  GraphValidationError,
  JsonValueError,
  agentJob,
  run,
  validateGraphDescription,
} from '@obversa/runtime';
import { commandEnvironment } from '@obversa/runtime/env/command';
import runtimePackage from '@obversa/runtime/package.json' with { type: 'json' };

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
assert.equal(runtimePackage.version, '1.0.0');
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

const engine = new MockEngine(() => 'ready');
const engines = {
  offline: engine,
  'agent-sdk': new AgentSdkEngine({ defaultModel: 'claude-test', permissionMode: 'auto' }),
  'anthropic-api': new AnthropicApiEngine({ defaultModel: 'claude-test', apiKey: 'test-key' }),
  'claude-cli': new ClaudeCliEngine({ defaultModel: 'claude-test', cliBinary: '/usr/bin/false', permissionMode: 'auto' }),
  codex: new CodexEngine({ defaultModel: 'gpt-test', cliBinary: '/usr/bin/false', permissionMode: 'plan' }),
  'grok-cli': new GrokCliEngine({ executable: '/usr/bin/false', version: '1.0.5', identity: { provider: 'xai', modelFamily: 'grok-4' }, permissionMode: 'dontAsk' }),
  'opencode-cli': new OpenCodeCliEngine({ executable: '/usr/bin/false', version: '1.18.23', identity: { provider: 'opencode', modelFamily: null } }),
};
assert.deepEqual(Object.values(engines).map(({ name }) => name).sort(), [
  'agent-sdk',
  'anthropic-api',
  'claude-cli',
  'codex',
  'grok-cli',
  'mock',
  'opencode-cli',
]);
await assert.rejects(
  run(
    agentJob({ label: 'invalid-params', engine: 'offline', prompt: 'Never runs.' }),
    {
      engine: 'offline',
      engines,
      params: null as never,
    },
  ),
  (error: unknown) => error instanceof JsonValueError,
);
const result = await run(
  agentJob({ label: 'packed-consumer', engine: 'offline', prompt: 'Return ready.' }),
  {
    engine: 'offline',
    engines,
    memory: simple,
  },
);
assert.equal(result.outcome.status, 'pass');

console.log(JSON.stringify({
  runtime: result.outcome.status,
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
    lib: ['ES2023', 'DOM'],
    strict: true,
    noUncheckedIndexedAccess: true,
    verbatimModuleSyntax: true,
    resolveJsonModule: true,
    skipLibCheck: false,
    outDir: 'dist',
    types: ['node'],
  },
  include: [
    'consumer.ts',
    'offline-review.workflow.ts',
    'feature-delivery.workflow.ts',
    'feature-team.ts',
    'custom-graph.ts',
    'pipeline.ts',
    'review-loop.ts',
    'callback-gate.ts',
    'proof-bound-approval.ts',
    'proof-cache.ts',
    'durable-storage.ts',
    'safe-node-attempt.ts',
    'turn-taking.ts',
    'workspace.ts',
    'supervised-run.ts',
    'example.ts',
    'recipe.ts',
    'file-adapter.ts',
  ],
};

async function main() {
  const exampleSource = await readFile(
    join(root, 'examples', 'workflows', 'offline-review.workflow.ts'),
    'utf8',
  );
  const featureExampleSource = await readFile(
    join(root, 'examples', 'workflows', 'feature-delivery.workflow.ts'),
    'utf8',
  );
  const graphExamplePath = join(root, 'examples', 'packages', 'custom-graph.ts');
  const graphExampleSource = await readFile(graphExamplePath, 'utf8');
  const pipelineExamplePath = join(root, 'examples', 'packages', 'pipeline.ts');
  const reviewLoopExamplePath = join(root, 'examples', 'packages', 'review-loop.ts');
  const callbackGateExamplePath = join(root, 'examples', 'packages', 'callback-gate.ts');
  const callbackGateExampleSource = await readFile(callbackGateExamplePath, 'utf8');
  const proofBoundApprovalExamplePath = join(
    root,
    'examples',
    'packages',
    'proof-bound-approval.ts',
  );
  const proofBoundApprovalExampleSource = await readFile(
    proofBoundApprovalExamplePath,
    'utf8',
  );
  const storageExamplePath = join(root, 'examples', 'packages', 'durable-storage.ts');
  const proofCacheExamplePath = join(root, 'examples', 'packages', 'proof-cache.ts');
  const storageExampleSource = await readFile(storageExamplePath, 'utf8');
  const attemptExamplePath = join(root, 'examples', 'packages', 'safe-node-attempt.ts');
  const attemptExampleSource = await readFile(attemptExamplePath, 'utf8');
  const turnTakingExamplePath = join(root, 'examples', 'packages', 'turn-taking.ts');
  const workspaceExamplePath = join(root, 'examples', 'packages', 'workspace.ts');
  const featureTeamExamplePath = join(root, 'examples', 'packages', 'feature-team.ts');
  const runnerExamplePath = join(root, 'examples', 'packages', 'supervised-run.ts');
  const runnerHostPath = join(root, 'examples', 'packages', 'supervised-host.mjs');
  const safeChangeExamplePath = join(root, 'examples', 'safe-change', 'example.ts');
  const safeChangeRecipePath = join(root, 'examples', 'safe-change', 'recipe.ts');
  const safeChangeFileAdapterPath = join(root, 'examples', 'safe-change', 'file-adapter.ts');
  const turnTakingExampleSource = await readFile(turnTakingExamplePath, 'utf8');
  const safeChangeExampleSource = await readFile(safeChangeExamplePath, 'utf8');
  const graphDocument = await readFile(
    join(root, 'docs', 'public', 'graphs', 'contract.mdx'),
    'utf8',
  );
  const publicDocument = await readFile(
    join(root, 'docs', 'public', 'workflows', 'offline-review.mdx'),
    'utf8',
  );
  const featureDocument = await readFile(
    join(root, 'docs', 'public', 'workflows', 'feature-delivery.mdx'),
    'utf8',
  );
  const storageDocument = await readFile(
    join(root, 'docs', 'public', 'recording', 'events-and-artifacts.mdx'),
    'utf8',
  );
  const attemptDocument = await readFile(
    join(root, 'docs', 'public', 'recording', 'node-attempts.mdx'),
    'utf8',
  );
  const callbackGateDocument = await readFile(
    join(root, 'docs', 'public', 'reviewing', 'callback-gates.mdx'),
    'utf8',
  );
  const reviewLoopDocument = await readFile(
    join(root, 'docs', 'public', 'reviewing', 'review-loop.mdx'),
    'utf8',
  );
  const proofAcceptanceDocument = await readFile(
    join(root, 'docs', 'public', 'reviewing', 'proof-acceptance.mdx'),
    'utf8',
  );
  const safeChangeDocument = await readFile(
    join(root, 'docs', 'public', 'workflows', 'safe-change.mdx'),
    'utf8',
  );
  if (sourceFromPublicDoc(publicDocument) !== exampleSource) {
    throw new Error('The offline production-line page does not match its runnable source');
  }
  if (sourceFromPublicDoc(graphDocument) !== graphExampleSource) {
    throw new Error('The outside graph contract page does not match its runnable source');
  }
  if (sourceFromPublicDoc(storageDocument) !== storageExampleSource) {
    throw new Error('The storage page does not match its runnable source');
  }
  if (sourceFromPublicDoc(attemptDocument) !== attemptExampleSource) {
    throw new Error('The node-attempt page does not match its runnable source');
  }
  if (sourceFromPublicDoc(callbackGateDocument) !== callbackGateExampleSource) {
    throw new Error('The callback-gate page does not match its runnable source');
  }
  if (sourceFromPublicDoc(proofAcceptanceDocument) !== proofBoundApprovalExampleSource) {
    throw new Error('The proof-acceptance page does not match its runnable source');
  }
  if (sourceFromPublicDoc(safeChangeDocument) !== safeChangeExampleSource) {
    throw new Error('The safe-change page does not match its runnable source');
  }
  if (sourceFromPublicDoc(featureDocument) !== featureExampleSource) {
    throw new Error('The feature-delivery production-line page does not match its runnable source');
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
        overrides: dependencies,
      },
    };

    await writeFile(join(consumerDirectory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(consumerDirectory, 'tsconfig.json'), `${JSON.stringify(tsconfig, null, 2)}\n`);
    await writeFile(join(consumerDirectory, 'consumer.ts'), consumerSource.trimStart());
    await writeFile(join(consumerDirectory, 'example.ts'), safeChangeExampleSource);
    await copyFile(safeChangeRecipePath, join(consumerDirectory, 'recipe.ts'));
    await copyFile(safeChangeFileAdapterPath, join(consumerDirectory, 'file-adapter.ts'));
    await writeFile(
      join(consumerDirectory, 'offline-review.workflow.ts'),
      exampleSource,
    );
    await writeFile(
      join(consumerDirectory, 'feature-delivery.workflow.ts'),
      featureExampleSource,
    );
    await copyFile(graphExamplePath, join(consumerDirectory, 'custom-graph.ts'));
    await copyFile(pipelineExamplePath, join(consumerDirectory, 'pipeline.ts'));
    await copyFile(reviewLoopExamplePath, join(consumerDirectory, 'review-loop.ts'));
    await copyFile(callbackGateExamplePath, join(consumerDirectory, 'callback-gate.ts'));
    await copyFile(
      proofBoundApprovalExamplePath,
      join(consumerDirectory, 'proof-bound-approval.ts'),
    );
    await copyFile(storageExamplePath, join(consumerDirectory, 'durable-storage.ts'));
    await copyFile(proofCacheExamplePath, join(consumerDirectory, 'proof-cache.ts'));
    await copyFile(attemptExamplePath, join(consumerDirectory, 'safe-node-attempt.ts'));
    await copyFile(turnTakingExamplePath, join(consumerDirectory, 'turn-taking.ts'));
    await copyFile(workspaceExamplePath, join(consumerDirectory, 'workspace.ts'));
    await copyFile(featureTeamExamplePath, join(consumerDirectory, 'feature-team.ts'));
    await copyFile(runnerExamplePath, join(consumerDirectory, 'supervised-run.ts'));
    await copyFile(runnerHostPath, join(consumerDirectory, 'supervised-host.mjs'));

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

    const tsc7 = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
    run(process.execPath, [tsc7, '-p', 'tsconfig.json'], { cwd: consumerDirectory });
    const tsc6 = join(root, 'node_modules', '@typescript', 'typescript6', 'bin', 'tsc6');
    run(process.execPath, [tsc6, '-p', 'tsconfig.json'], { cwd: consumerDirectory });
    await copyFile(runnerHostPath, join(consumerDirectory, 'dist', 'supervised-host.mjs'));

    run('git', ['init', '--quiet', gitRepository]);
    const output = run(process.execPath, ['dist/consumer.js'], {
      cwd: consumerDirectory,
      env: { CONSUMER_GIT_REPOSITORY: gitRepository },
    }).trim();
    const report = JSON.parse(output.split(/\r?\n/).at(-1));
    const productionLine = JSON.parse(
      run(process.execPath, ['dist/offline-review.workflow.js'], { cwd: consumerDirectory }),
    );
    const directProductionLine = JSON.parse(
      run('pnpm', ['exec', 'tsx', 'offline-review.workflow.ts'], { cwd: consumerDirectory }),
    );
    const featureLine = JSON.parse(
      run(process.execPath, ['dist/feature-delivery.workflow.js'], { cwd: consumerDirectory }),
    );
    const directFeatureLine = JSON.parse(
      run('pnpm', ['exec', 'tsx', 'feature-delivery.workflow.ts'], { cwd: consumerDirectory }),
    );
    const featureDenySource = featureExampleSource.replace(
      '{ approved: true },',
      '{ approved: false },',
    );
    await writeFile(
      join(consumerDirectory, 'feature-delivery.deny.workflow.ts'),
      featureDenySource,
    );
    const denyRun = spawnSync('pnpm', ['exec', 'tsx', 'feature-delivery.deny.workflow.ts'], {
      cwd: consumerDirectory,
      encoding: 'utf8',
    });
    assert.equal(denyRun.status, 1, denyRun.stdout + denyRun.stderr);
    const featureDeny = JSON.parse(denyRun.stdout);
    assert.equal(featureDeny.status, 'fail', 'a no-vote must not ship the change');
    const featureRedSource = featureExampleSource.replace(
      'const repaired = fixes.size > 0;',
      'const repaired = false;',
    );
    await writeFile(
      join(consumerDirectory, 'feature-delivery.red.workflow.ts'),
      featureRedSource,
    );
    const redRun = spawnSync('pnpm', ['exec', 'tsx', 'feature-delivery.red.workflow.ts'], {
      cwd: consumerDirectory,
      encoding: 'utf8',
    });
    assert.equal(redRun.status, 1, redRun.stdout + redRun.stderr);
    const featureRed = JSON.parse(redRun.stdout);
    assert.equal(featureRed.status, 'fail', 'an unrepaired line must not pass');
    const compiledGraph = JSON.parse(
      run(process.execPath, ['dist/custom-graph.js'], { cwd: consumerDirectory }),
    );
    const directGraph = JSON.parse(
      run('pnpm', ['exec', 'tsx', 'custom-graph.ts'], { cwd: consumerDirectory }),
    );
    const compiledPipeline = JSON.parse(
      run(process.execPath, ['dist/pipeline.js'], { cwd: consumerDirectory }),
    );
    const directPipeline = JSON.parse(
      run('pnpm', ['exec', 'tsx', 'pipeline.ts'], { cwd: consumerDirectory }),
    );
    const compiledReviewLoop = JSON.parse(
      run(process.execPath, ['dist/review-loop.js'], { cwd: consumerDirectory }),
    );
    const directReviewLoop = JSON.parse(
      run('pnpm', ['exec', 'tsx', 'review-loop.ts'], { cwd: consumerDirectory }),
    );
    const compiledCallbackGate = JSON.parse(
      run(process.execPath, ['dist/callback-gate.js'], { cwd: consumerDirectory }),
    );
    const directCallbackGate = JSON.parse(
      run('pnpm', ['exec', 'tsx', 'callback-gate.ts'], { cwd: consumerDirectory }),
    );
    const compiledProofBoundApproval = JSON.parse(
      run(process.execPath, ['dist/proof-bound-approval.js'], { cwd: consumerDirectory }),
    );
    const directProofBoundApproval = JSON.parse(
      run('pnpm', ['exec', 'tsx', 'proof-bound-approval.ts'], { cwd: consumerDirectory }),
    );
    const compiledStorage = JSON.parse(
      run(process.execPath, ['dist/durable-storage.js'], { cwd: consumerDirectory }),
    );
    const compiledProofCache = JSON.parse(
      run(process.execPath, ['dist/proof-cache.js'], { cwd: consumerDirectory }),
    );
    const directProofCache = JSON.parse(
      run('pnpm', ['exec', 'tsx', 'proof-cache.ts'], { cwd: consumerDirectory }),
    );
    const compiledSafeChange = JSON.parse(
      run(process.execPath, ['dist/example.js'], { cwd: consumerDirectory }),
    );
    const directSafeChange = JSON.parse(
      run('pnpm', ['exec', 'tsx', 'example.ts'], { cwd: consumerDirectory }),
    );
    const directStorage = JSON.parse(
      run('pnpm', ['exec', 'tsx', 'durable-storage.ts'], { cwd: consumerDirectory }),
    );
    const compiledAttemptOutput = run(process.execPath, ['--input-type=module', '--eval',
      "const { writeFileSync } = await import('node:fs'); const { attemptReport } = await import('./dist/safe-node-attempt.js'); writeFileSync('compiled-attempt-report.json', JSON.stringify(attemptReport));",
    ], { cwd: consumerDirectory });
    const compiledAttempt = checkedAttemptOutput(
      compiledAttemptOutput,
      JSON.parse(await readFile(join(consumerDirectory, 'compiled-attempt-report.json'), 'utf8')),
    );
    const directAttemptOutput = run('pnpm', ['exec', 'tsx', '--input-type=module', '--eval',
      "const { writeFileSync } = await import('node:fs'); const { attemptReport } = await import('./safe-node-attempt.ts'); writeFileSync('direct-attempt-report.json', JSON.stringify(attemptReport));",
    ], { cwd: consumerDirectory });
    const directAttempt = checkedAttemptOutput(
      directAttemptOutput,
      JSON.parse(await readFile(join(consumerDirectory, 'direct-attempt-report.json'), 'utf8')),
    );
    const compiledTurnTaking = JSON.parse(
      run(process.execPath, ['dist/turn-taking.js'], { cwd: consumerDirectory }),
    );
    const directTurnTaking = JSON.parse(
      run('pnpm', ['exec', 'tsx', 'turn-taking.ts'], { cwd: consumerDirectory }),
    );
    const compiledWorkspace = JSON.parse(run(process.execPath, ['dist/workspace.js'], { cwd: consumerDirectory }));
    const directWorkspace = JSON.parse(run('pnpm', ['exec', 'tsx', 'workspace.ts'], { cwd: consumerDirectory }));
    for (const command of [
      [process.execPath, ['dist/supervised-run.js']],
      ['pnpm', ['exec', 'tsx', 'supervised-run.ts']],
    ]) {
      const runner = JSON.parse(run(command[0], command[1], { cwd: consumerDirectory }));
      assert.deepEqual(runner, {
        phase: 'completed',
        cleanupCapability: process.platform === 'linux' ? 'inherited-owner' : 'observed-processes',
        results: [
          { nodeId: 'draft', position: 'dag/draft/1', result: { node: 'draft', message: 'An offline supervised run.' } },
          { nodeId: 'review', position: 'dag/review/1', result: { node: 'review', message: 'An offline supervised run.' } },
        ],
        temporaryDirectoryRemoved: true,
      });
    }
    assert.deepEqual(compiledTurnTaking, expectedTurnTakingReport);
    assert.deepEqual(directTurnTaking, expectedTurnTakingReport);
    for (const report of [compiledWorkspace, directWorkspace]) {
      assert.deepEqual(Object.keys(report).sort(), ['anchor', 'branch', 'revision']);
      assert.match(report.revision, /^[0-9a-f]{40}$/);
      assert.match(report.anchor, /^[0-9a-f]{64}$/);
      assert.equal(report.branch, 'refs/heads/obversa/example-child');
    }
    assert.deepEqual(compiledGraph, expectedGraphReport);
    assert.deepEqual(directGraph, expectedGraphReport);
    assert.deepEqual(compiledPipeline, expectedPipelineReport);
    assert.deepEqual(directPipeline, expectedPipelineReport);
    assert.deepEqual(compiledReviewLoop, expectedReviewLoopReport);
    assert.deepEqual(directReviewLoop, expectedReviewLoopReport);
    const reviewLoopReport = reviewLoopDocument.match(/```json\r?\n([\s\S]*?)```/);
    assert.ok(reviewLoopReport, 'The review-loop page must include its JSON report');
    assert.deepEqual(
      JSON.parse(reviewLoopReport[1]),
      compiledReviewLoop,
      'The review-loop page does not match its runnable output',
    );
    assert.deepEqual(compiledCallbackGate, expectedCallbackGateReport);
    assert.deepEqual(directCallbackGate, expectedCallbackGateReport);
    assert.deepEqual(compiledProofBoundApproval, expectedProofBoundApprovalReport);
    assert.deepEqual(directProofBoundApproval, expectedProofBoundApprovalReport);
    assert.deepEqual(compiledProofCache, expectedProofCacheReport);
    assert.deepEqual(directProofCache, expectedProofCacheReport);
    const safeChangePageReport = safeChangeDocument
      .match(/## Run the workflow[\s\S]*?```json\r?\n([\s\S]*?)```/);
    assert.ok(safeChangePageReport, 'The safe-change page must include its JSON report');
    assert.deepEqual(compiledSafeChange, JSON.parse(safeChangePageReport[1]));
    assert.deepEqual(directSafeChange, compiledSafeChange);
    const proofCacheReport = proofAcceptanceDocument.split('## Read-only proof cache')[1]
      ?.match(/```json\r?\n([\s\S]*?)```/);
    assert.ok(proofCacheReport, 'The proof page must include its cache report');
    assert.deepEqual(JSON.parse(proofCacheReport[1]), compiledProofCache);
    const featureLinePageReport = featureDocument
      .match(/## Run the workflow[\s\S]*?```json\r?\n([\s\S]*?)```/);
    assert.ok(featureLinePageReport, 'The feature-delivery page must include its JSON report');
    assert.deepEqual(featureLine, JSON.parse(featureLinePageReport[1]));
    assert.deepEqual(directFeatureLine, featureLine);
    assert.deepEqual(compiledStorage, expectedStorageReport);
    assert.deepEqual(directStorage, expectedStorageReport);
    assert.deepEqual(compiledAttempt, expectedAttemptReport);
    assert.deepEqual(directAttempt, expectedAttemptReport);
    if (
      report.runtime !== 'pass' ||
      report.memoryCases !== 17 ||
      report.simple !== true ||
      report.git !== true ||
      productionLine.status !== 'pass' ||
      productionLine.attempts !== 2 ||
      productionLine.summary !== 'config is complete' ||
      directProductionLine.status !== 'pass' ||
      directProductionLine.attempts !== 2 ||
      directProductionLine.summary !== 'config is complete' ||
      featureLine.status !== 'pass' ||
      featureLine.implementRuns !== 2 ||
      featureLine.reviewRounds !== 2 ||
      featureLine.acceptedKickbacks !== 1 ||
      directFeatureLine.status !== 'pass' ||
      directFeatureLine.implementRuns !== 2 ||
      directFeatureLine.reviewRounds !== 2 ||
      directFeatureLine.acceptedKickbacks !== 1
    ) {
      throw new Error(
        `Packed consumer returned an invalid report: ${JSON.stringify({ report, productionLine, directProductionLine, featureLine, directFeatureLine })}`,
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
      'Clean offline consumer passed with TypeScript 7 and 6, the first production line, the safe-change production line, the feature-delivery line, the outside graph, the pipeline executor example, the review loop, the callback gate, proof-bound approval, the turn-taking executor example, durable storage, safe node attempts, the supervised runner, 17 memory cases, and both memory adapters.',
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
