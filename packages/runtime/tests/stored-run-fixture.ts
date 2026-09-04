import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveGraphPlan } from '../src/graph/plan.js';
import { compileGraph } from '../src/graph/type.js';
import { dag } from '../src/graph-types/dag.js';
import {
  persistRunDefinition,
  type RunStorageBinding,
} from '../src/runtime/run-definition.js';
import { createLocalRunStorage } from '../src/storage/local.js';

export interface StoredRunFixture {
  readonly runId: string;
  readonly storage: RunStorageBinding;
  reopen(): RunStorageBinding;
  close(): Promise<void>;
}

export async function createStoredRunFixture(name: string): Promise<StoredRunFixture> {
  const root = await mkdtemp(join(tmpdir(), `obversa-${name}-`));
  const directory = join(root, 'storage');
  const namespace = `${name}-tests`;
  const open = (): RunStorageBinding => createLocalRunStorage({
    directory,
    namespace,
    policy: {
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
    },
  });
  const storage = open();
  const graph = compileGraph(dag, {
    id: `${name}-graph`,
    definitionVersion: 1,
    data: {
      globalConcurrency: 2,
      keyedConcurrency: {},
      stopOnError: true,
      retryCapPerNode: 0,
    },
    nodes: [
      { id: 'review-a', data: { kind: 'required', key: null } },
      { id: 'review-b', data: { kind: 'required', key: null } },
    ],
    edges: [],
  });
  const packageIdentity = {
    source: `npm:@example/${name}`,
    version: '1.0.0',
    digest: `sha256:${'1'.repeat(64)}` as const,
  };
  const runId = `${name}-run`;
  await persistRunDefinition(storage, {
    runId,
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    graphDefinition: graph.definition,
    resolvedPlan: resolveGraphPlan(graph.describe(), {
      package: packageIdentity,
      admission: { package: packageIdentity, permissions: [] },
      executionLanes: [],
    }),
    resolvedInputs: {},
    workspaceBinding: null,
    hostBinding: null,
  });
  return {
    runId,
    storage,
    reopen: open,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

export async function recordFixtureDispatches(
  run: StoredRunFixture,
): Promise<Readonly<{ reviewA: string; reviewB: string }>> {
  const reviewA = 'dag/review-a/1';
  const reviewB = 'dag/review-b/1';
  let revision = 0;
  for await (const event of run.storage.eventStore.read({
    namespace: run.storage.record.namespace,
    streamId: run.runId,
  })) revision = event.revision;
  await run.storage.eventStore.append({
    namespace: run.storage.record.namespace,
    streamId: run.runId,
  }, revision, [{
    eventId: randomUUID(),
    type: 'graph:node-dispatched',
    version: 1,
    timestamp: new Date().toISOString(),
    correlationId: run.runId,
    causationId: null,
    payload: { nodeId: 'review-a', position: reviewA },
  }, {
    eventId: randomUUID(),
    type: 'graph:node-dispatched',
    version: 1,
    timestamp: new Date().toISOString(),
    correlationId: run.runId,
    causationId: null,
    payload: { nodeId: 'review-b', position: reviewB },
  }]);
  return Object.freeze({ reviewA, reviewB });
}

export function rejectEventAppends(
  storage: RunStorageBinding,
  error: Error,
): RunStorageBinding {
  const eventStore = storage.eventStore;
  return {
    ...storage,
    eventStore: {
      preflightAppend: eventStore.preflightAppend.bind(eventStore),
      read: eventStore.read.bind(eventStore),
      append: async () => { throw error; },
    },
  };
}

export function raceFirstTwoEventAppends(
  storage: RunStorageBinding,
): Readonly<{
  readonly storage: RunStorageBinding;
  readonly firstAppendReached: Promise<void>;
}> {
  const eventStore = storage.eventStore;
  let calls = 0;
  let releaseFirst!: () => void;
  let finishFirst!: () => void;
  let markFirstReached!: () => void;
  const firstMayAppend = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstFinished = new Promise<void>((resolve) => { finishFirst = resolve; });
  const firstAppendReached = new Promise<void>((resolve) => { markFirstReached = resolve; });
  const racingStorage: RunStorageBinding = {
    ...storage,
    eventStore: {
      preflightAppend: eventStore.preflightAppend.bind(eventStore),
      read: eventStore.read.bind(eventStore),
      append: async (stream, expectedRevision, events) => {
        calls += 1;
        if (calls === 1) {
          markFirstReached();
          await firstMayAppend;
          try {
            return await eventStore.append(stream, expectedRevision, events);
          } finally {
            finishFirst();
          }
        }
        if (calls === 2) {
          releaseFirst();
          await firstFinished;
        }
        return eventStore.append(stream, expectedRevision, events);
      },
    },
  };
  return { storage: racingStorage, firstAppendReached };
}
