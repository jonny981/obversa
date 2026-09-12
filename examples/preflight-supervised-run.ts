import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';

import {
  compileGraph,
  createGitWorktreeProvider,
  dagGraphType,
  readRunPreflight,
  resolveGraphPlan,
  type DagDefinition,
  type RunStoragePolicy,
} from '@obversa/runtime';
import { createLocalRunStorage } from '@obversa/runtime/storage/local';
import {
  resumeSupervisedRun,
  startSupervisedRun,
  type SupervisedRunHandle,
} from '@obversa/runner';

const git = promisify(execFile);
const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'obversa-preflight-supervised-')));
const runRoot = join(temporaryRoot, 'workspace');
const controlFile = join(temporaryRoot, 'control.txt');
const callsFile = join(temporaryRoot, 'engine-calls.log');
const runnerDirectory = join(temporaryRoot, 'runner');
const runId = 'preflight-supervised-run';
let handle: SupervisedRunHandle | undefined;
let startupAttempted = false;
let report: Record<string, unknown> | undefined;

const target = {
  adapter: 'scripted-local',
  provider: 'local',
  modelFamily: 'scripted',
  model: 'offline-check',
  tools: [],
} as const;

const definition = {
  id: 'preflight-supervised',
  definitionVersion: 1,
  data: {
    globalConcurrency: 1,
    keyedConcurrency: {},
    stopOnError: true,
    retryCapPerNode: 0,
  },
  nodes: [{
    id: 'check',
    data: {
      kind: 'required',
      key: null,
      lane: { id: 'local', requested: target, knownSubstitutions: [] },
    },
  }],
  edges: [],
} as const satisfies DagDefinition;

const storagePolicy = {
  schemaVersion: 1,
  maxEventPayloadBytes: 64_000,
  maxAppendBatchBytes: 128_000,
  maxArtifactBytes: 1_000_000,
  maxTotalArtifactBytesPerRun: 4_000_000,
  retention: 'until-run-delete',
  sensitiveContent: {
    marked: 'reject',
    exact: 'reject',
    freeText: 'redact-before-hash',
  },
} as const satisfies RunStoragePolicy;

try {
  await writeFile(controlFile, 'not-ready\n');
  await writeFile(callsFile, '');
  assert.equal(relative(runRoot, controlFile).startsWith('..'), true);

  await mkdir(runRoot);
  const hostBytes = await readFile(new URL('./preflight-host.mjs', import.meta.url));
  await writeFile(join(runRoot, 'host.mjs'), hostBytes);
  await writeFile(join(runRoot, '.gitignore'), 'node_modules/\n');
  await git('git', ['init', '-q', '-b', 'main'], { cwd: runRoot });
  await git('git', ['add', 'host.mjs', '.gitignore'], { cwd: runRoot });
  await git('git', [
    '-c', 'user.name=Example',
    '-c', 'user.email=example@example.com',
    '-c', 'commit.gpgsign=false',
    'commit', '-qm', 'chore: initialize disposable preflight example',
  ], { cwd: runRoot });

  await mkdir(join(runRoot, 'node_modules/@obversa'), { recursive: true });
  await symlink(
    dirname(createRequire(join(process.cwd(), 'package.json')).resolve('@obversa/runtime/package.json')),
    join(runRoot, 'node_modules/@obversa/runtime'),
    'junction',
  );

  const graph = compileGraph(dagGraphType, definition);
  const packageIdentity = {
    source: 'file:host.mjs',
    version: '1.0.0',
    digest: `sha256:${createHash('sha256').update(hostBytes).digest('hex')}`,
  } as const;
  const resolvedPlan = resolveGraphPlan(graph.describe(), {
    package: packageIdentity,
    admission: { package: packageIdentity, permissions: [] },
    executionLanes: [{ id: 'local', effective: target }],
    preflight: {
      timeoutMs: 2_000,
      lanes: [{ laneId: 'local', live: 'required', unsupportedStatic: 'block' }],
    },
  });
  const storage = {
    directory: join(temporaryRoot, 'storage'),
    namespace: 'preflight-supervised-example',
    policy: storagePolicy,
  } as const;
  const workspace = createGitWorktreeProvider({ repositoryPath: runRoot });
  const restart = {
    maxRestarts: 1,
    initialBackoffMs: 100,
    maxBackoffMs: 1_000,
  } as const;

  startupAttempted = true;
  handle = await startSupervisedRun({
    directory: runnerDirectory,
    runRoot,
    module: './host.mjs',
    storage,
    workspace,
    definition: {
      runId,
      graphDefinition: graph.definition,
      resolvedPlan,
      resolvedInputs: { controlFile, callsFile },
    },
    limits: { timeoutMs: 20_000, maxDispatches: 1 },
    restart,
    teardownGraceMs: 100,
  });
  const paused = await handle.done;
  if (paused.kind !== 'pause' || paused.code !== 'PREFLIGHT_PAUSED' || paused.preflightEventId === undefined) {
    throw new Error(`Expected a preflight pause, received ${JSON.stringify(paused)}.`);
  }
  const pausedStatus = await handle.status();
  assert.equal(pausedStatus.phase, 'paused');
  assert.equal(pausedStatus.cleanupVerified, true);
  assert.equal(pausedStatus.leaseRetained, false);

  const runStorage = createLocalRunStorage(storage);
  let dispatchesBeforeResume = 0;
  for await (const event of runStorage.eventStore.read({
    namespace: storage.namespace,
    streamId: runId,
  })) {
    if (event.type === 'graph:node-dispatched') dispatchesBeforeResume += 1;
  }
  assert.equal(dispatchesBeforeResume, 0);

  await writeFile(controlFile, 'ready\n');
  await handle.stop();
  handle = undefined;
  handle = await resumeSupervisedRun({
    directory: runnerDirectory,
    runRoot,
    storage,
    workspace,
    restart,
    teardownGraceMs: 100,
    runId,
    preflightEventId: paused.preflightEventId,
  });
  const completed = await handle.done;
  if (completed.kind !== 'complete') {
    throw new Error(`Expected completion, received ${JSON.stringify(completed)}.`);
  }
  assert.deepEqual(completed.output, { nodes: { check: { checked: 'offline' } } });
  const completedStatus = await handle.status();
  assert.equal(completedStatus.phase, 'completed');
  assert.equal(completedStatus.cleanupVerified, true);
  assert.equal(completedStatus.leaseRetained, false);
  const finalPreflight = await readRunPreflight(runStorage, runId);
  assert.equal(finalPreflight.phase, 'admitted');
  assert.equal(finalPreflight.resumedPreflightEventId, paused.preflightEventId);
  const calls = (await readFile(callsFile, 'utf8')).trim().split('\n').filter(Boolean);
  assert.deepEqual(calls, ['static', 'live:not-ready', 'static', 'live:ready', 'ordinary']);

  report = {
    pause: { phase: pausedStatus.phase, code: paused.code, dispatches: dispatchesBeforeResume },
    resume: {
      usedReturnedToken: finalPreflight.resumedPreflightEventId === paused.preflightEventId,
      phase: completedStatus.phase,
      result: completed.kind,
      output: completed.output,
    },
    calls,
    controlOutsideCapturedWorkspace: relative(runRoot, controlFile).startsWith('..'),
  };
} finally {
  // Preserve the lock and lease if cleanup cannot be verified.
  if (handle !== undefined) {
    await handle.stop();
    const status = await handle.status();
    assert.equal(status.cleanupVerified, true, 'Retain the directory when cleanup is unverified.');
    assert.equal(status.leaseRetained, false, 'Retain the directory while its workspace lease is held.');
  }
  // Startup can fail before returning a handle while retaining ownership.
  if (!startupAttempted || handle !== undefined) {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({
  ...report,
  temporaryDirectoryRemoved: !existsSync(temporaryRoot),
}, null, 2));
