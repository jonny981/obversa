import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  compileGraph,
  createGraphExecutor,
  dagGraphType,
  loadRunDefinition,
  persistRunDefinition,
  readRunPreflight,
  resolveGraphPlan,
  type DagDefinition,
  type ExecutionTarget,
  type RunStoragePolicy,
} from '@obversa/runtime';
import { createLocalRunStorage } from '@obversa/runtime/storage/local';
import { bindRun } from './preflight-host.mjs';

const target = {
  adapter: 'scripted-local',
  provider: 'local',
  modelFamily: 'scripted',
  model: 'offline-check',
  tools: [],
} as const satisfies ExecutionTarget;

const definition = {
  id: 'preflight-executor',
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

const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'obversa-preflight-executor-')));
const controlFile = join(temporaryRoot, 'control.txt');
const runId = 'preflight-executor-run';
const callsFile = join(temporaryRoot, 'engine-calls.log');
let report: Record<string, unknown> | undefined;

try {
  await writeFile(controlFile, 'not-ready\n');
  await writeFile(callsFile, '');
  const graph = compileGraph(dagGraphType, definition);
  const packageIdentity = {
    source: 'npm:@example/preflight-executor',
    version: '1.0.0',
    digest: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
  } as const;
  const plan = resolveGraphPlan(graph.describe(), {
    package: packageIdentity,
    admission: { package: packageIdentity, permissions: [] },
    executionLanes: [{ id: 'local', effective: target }],
    preflight: {
      timeoutMs: 2_000,
      lanes: [{ laneId: 'local', live: 'required', unsupportedStatic: 'block' }],
    },
  });
  const storage = createLocalRunStorage({
    directory: join(temporaryRoot, 'storage'),
    namespace: 'preflight-executor-example',
    policy: storagePolicy,
  });
  await persistRunDefinition(storage, {
    runId,
    eventId: 'preflight-executor-started',
    timestamp: new Date().toISOString(),
    graphDefinition: graph.definition,
    resolvedPlan: plan,
    resolvedInputs: { controlFile, callsFile },
    workspaceBinding: null,
    hostBinding: null,
  });

  const loaded = await loadRunDefinition(storage, runId);
  const makeExecutor = async () => createGraphExecutor({
    ...await bindRun({
      definition: loaded.record.payload.definition,
      scratchDirectory: temporaryRoot,
    }),
    runId,
    storage,
    preflightScratchDirectory: temporaryRoot,
  });

  const paused = await (await makeExecutor()).run(new AbortController().signal);
  if (paused.kind !== 'pause' || !('preflightEventId' in paused)) {
    throw new Error(`Expected a preflight pause, received ${JSON.stringify(paused)}.`);
  }
  assert.equal(paused.code, 'PREFLIGHT_PAUSED');
  assert.equal((await readRunPreflight(storage, runId)).phase, 'paused');

  let dispatchesBeforeResume = 0;
  for await (const event of storage.eventStore.read({
    namespace: storage.record.namespace,
    streamId: runId,
  })) {
    if (event.type === 'graph:node-dispatched') dispatchesBeforeResume += 1;
  }
  assert.equal(dispatchesBeforeResume, 0);

  await writeFile(controlFile, 'ready\n');
  const completed = await (await makeExecutor()).resume(
    { preflightEventId: paused.preflightEventId },
    new AbortController().signal,
  );
  if (completed.kind !== 'complete') {
    throw new Error(`Expected completion, received ${JSON.stringify(completed)}.`);
  }
  assert.deepEqual(completed.output, { nodes: { check: { checked: 'offline' } } });
  const finalPreflight = await readRunPreflight(storage, runId);
  assert.equal(finalPreflight.phase, 'admitted');
  assert.equal(finalPreflight.resumedPreflightEventId, paused.preflightEventId);
  const calls = (await readFile(callsFile, 'utf8')).trim().split('\n').filter(Boolean);
  assert.deepEqual(calls, ['static', 'live:not-ready', 'static', 'live:ready', 'ordinary']);

  report = {
    pause: { phase: 'paused', code: paused.code, dispatches: dispatchesBeforeResume },
    resume: {
      usedReturnedToken: finalPreflight.resumedPreflightEventId === paused.preflightEventId,
      phase: finalPreflight.phase,
      result: completed.kind,
      output: completed.output,
    },
    calls,
  };
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ...report,
  temporaryDirectoryRemoved: !existsSync(temporaryRoot),
}, null, 2));
