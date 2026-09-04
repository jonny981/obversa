import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createLocalArtifactStore } from '../src/artifacts/file-store.js';
import { createLocalEventStore } from '../src/events/jsonl-store.js';
import { createGraphKernel } from '../src/graph/kernel.js';
import { resolveGraphPlan, type GraphDescription } from '../src/graph/plan.js';
import {
  canonicalJson,
  digestJson,
  type JsonValue,
} from '../src/graph/value.js';
import { StorageError } from '../src/storage/error.js';
import { createLocalRunStorage } from '../src/storage/local.js';
import {
  loadRunDefinition,
  persistRunDefinition,
  validateRunDefinition,
  type RunStorageBinding,
  type RunStoragePolicy,
  type RunStorageRecord,
} from '../src/runtime/run-definition.js';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'obversa-run-storage-'));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

const graph = createGraphKernel({
  id: 'stored-review',
  definitionVersion: 1,
  data: {},
  nodes: [{ id: 'review', data: {} }],
  edges: [],
});

const description: GraphDescription = {
  schemaVersion: 1,
  graph: {
    id: 'stored-review',
    definitionVersion: 1,
    kind: 'review',
    typeVersion: 1,
    definitionDigest: graph.definition.digest,
  },
  inputContract: {},
  outputContract: {},
  phases: [{ id: 'review', name: 'Review', nodeIds: ['review'] }],
  nodes: [{
    id: 'review',
    phaseId: 'review',
    inputContract: {},
    outputContract: {},
    laneId: null,
  }],
  edges: [],
  policies: {
    retry: {}, stop: {}, concurrency: {}, write: {}, budget: {}, action: {},
  },
  executionLanes: [],
  requestedPermissions: [],
  bounds: {
    dispatches: {
      min: { kind: 'known', value: 1 },
      max: { kind: 'known', value: 1 },
    },
    maxConcurrency: { kind: 'known', value: 1 },
    maxFanOut: { kind: 'known', value: 1 },
  },
  requirements: { memory: 'unused' },
};

const packageIdentity = {
  source: 'npm:@example/stored-review',
  version: '1.0.0',
  digest: `sha256:${'2'.repeat(64)}` as const,
};

const plan = resolveGraphPlan(description, {
  package: packageIdentity,
  admission: { package: packageIdentity, permissions: [] },
  executionLanes: [],
});

function planSnapshot(value: JsonValue) {
  return {
    plan: value,
    canonicalJson: canonicalJson(value),
    digest: digestJson(value),
  } as const;
}

const policy = {
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
} as const;

function storage(
  namespace: string,
  storagePolicy: RunStoragePolicy = policy,
): RunStorageRecord {
  const provider = {
    schemaVersion: 1 as const,
    name: 'local',
    version: '1',
    configDigest: `sha256:${'3'.repeat(64)}` as const,
  };
  return {
    schemaVersion: 1,
    namespace,
    eventStore: provider,
    artifactStore: provider,
    policy: storagePolicy,
  };
}

function binding(
  root: string,
  namespace = 'intent-42',
  knownSecrets: readonly string[] = [],
  storagePolicy: RunStoragePolicy = policy,
): RunStorageBinding {
  return {
    record: storage(namespace, storagePolicy),
    knownSecrets: Object.freeze([...knownSecrets]),
    eventStore: createLocalEventStore({
      root: join(root, 'events'),
      maxEventPayloadBytes: storagePolicy.maxEventPayloadBytes,
      maxAppendBatchBytes: storagePolicy.maxAppendBatchBytes,
      knownSecrets,
    }),
    artifactStore: createLocalArtifactStore({
      root: join(root, 'artifacts'),
      maxArtifactBytes: storagePolicy.maxArtifactBytes,
      maxTotalArtifactBytesPerRun: storagePolicy.maxTotalArtifactBytesPerRun,
      knownSecrets,
    }),
  };
}

describe('stored run definitions', () => {
  it.each([undefined, ''])('rejects an invalid local storage directory with a typed error', (directory) => {
    expect(() => createLocalRunStorage({
      directory: directory as never,
      namespace: 'intent-42',
      policy,
    })).toThrowError(expect.objectContaining({
      name: 'StorageError',
      code: 'INVALID_STORED_VALUE',
    }));
  });

  it('derives one frozen storage record without persisting live secrets', async () => {
    const directory = await temporaryRoot();
    const first = createLocalRunStorage({
      directory,
      namespace: 'intent-42',
      policy,
      knownSecrets: ['first-secret'],
    });
    const rotated = createLocalRunStorage({
      directory: join(directory, '.'),
      namespace: 'intent-42',
      policy,
      knownSecrets: ['replacement-secret'],
    });

    expect(first).not.toHaveProperty('namespace');
    expect(first.record.namespace).toBe('intent-42');
    expect(Object.isFrozen(first.record)).toBe(true);
    expect(first.record).toEqual(rotated.record);
    expect(JSON.stringify(first.record)).not.toContain('first-secret');

    const otherRoot = createLocalRunStorage({
      directory: await temporaryRoot(),
      namespace: 'intent-42',
      policy,
    });
    expect(otherRoot.record.eventStore.configDigest)
      .not.toBe(first.record.eventStore.configDigest);
    expect(otherRoot.record.artifactStore.configDigest)
      .not.toBe(first.record.artifactStore.configDigest);

    const eventLimitChanged = createLocalRunStorage({
      directory,
      namespace: 'intent-42',
      policy: { ...policy, maxEventPayloadBytes: policy.maxEventPayloadBytes + 1 },
    });
    expect(eventLimitChanged.record.eventStore.configDigest)
      .not.toBe(first.record.eventStore.configDigest);
    expect(eventLimitChanged.record.artifactStore.configDigest)
      .toBe(first.record.artifactStore.configDigest);

    const artifactLimitChanged = createLocalRunStorage({
      directory,
      namespace: 'intent-42',
      policy: { ...policy, maxArtifactBytes: policy.maxArtifactBytes + 1 },
    });
    expect(artifactLimitChanged.record.eventStore.configDigest)
      .toBe(first.record.eventStore.configDigest);
    expect(artifactLimitChanged.record.artifactStore.configDigest)
      .not.toBe(first.record.artifactStore.configDigest);
  });

  it('rejects a secret in local provider configuration before hashing it', async () => {
    const parent = await temporaryRoot();
    const secret = 'candidate-0427';

    expect(() => createLocalRunStorage({
      directory: join(parent, secret, 'store'),
      namespace: 'intent-42',
      policy,
      knownSecrets: [secret],
    })).toThrowError(expect.objectContaining({ code: 'KNOWN_SECRET' }));
    expect(await readdir(parent)).toEqual([]);
  });

  it.each([
    ['namespace', 'intent-secret', 'intent-secret', policy],
    ['numeric policy value', '64000', 'intent-42', policy],
  ] as const)('rejects a known secret in the derived record %s', (
    _label,
    secret,
    namespace,
    storagePolicy,
  ) => {
    expect(() => createLocalRunStorage({
      directory: '/tmp/obversa-safe-record-test',
      namespace,
      policy: storagePolicy,
      knownSecrets: [secret],
    })).toThrowError(expect.objectContaining({ code: 'KNOWN_SECRET' }));
  });

  it('uses one policy for the stored record and the live stores', async () => {
    const root = await temporaryRoot();
    const boundPolicy: RunStoragePolicy = {
      ...policy,
      maxEventPayloadBytes: 4_000,
      maxAppendBatchBytes: 8_000,
    };
    const stores = createLocalRunStorage({
      directory: root,
      namespace: 'intent-42',
      policy: boundPolicy,
    });

    const started = await persistRunDefinition(stores, {
      runId: 'bound-policy',
      eventId: 'bound-policy:start',
      timestamp: '2026-08-26T04:00:00.000Z',
      graphDefinition: graph.definition,
      resolvedPlan: plan,
      resolvedInputs: {},
      workspaceBinding: null,
      hostBinding: null,
    });

    expect(started.payload.definition.storage).toEqual(stores.record);
    await expect(stores.eventStore.append(
      { namespace: stores.record.namespace, streamId: 'bound-policy' },
      1,
      [{
        eventId: 'bound-policy:large',
        type: 'example:large',
        version: 1,
        timestamp: '2026-08-26T04:00:01.000Z',
        correlationId: 'bound-policy',
        causationId: 'bound-policy:start',
        payload: { text: 'x'.repeat(4_100) },
      }],
    )).rejects.toMatchObject({ code: 'STORAGE_LIMIT_EXCEEDED' });
  });

  it('rejects an unsafe run id before any storage write', async () => {
    const root = await temporaryRoot();
    const stores = binding(root);

    await expect(persistRunDefinition(stores, {
      runId: 'run/42',
      eventId: 'run-42:start',
      timestamp: '2026-08-26T04:00:00.000Z',
      graphDefinition: graph.definition,
      resolvedPlan: plan,
      resolvedInputs: {},
      workspaceBinding: null,
      hostBinding: null,
    })).rejects.toMatchObject({
      name: 'StorageError',
      code: 'INVALID_STORED_VALUE',
    });
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    ['missing fields', {
      graph: { definitionDigest: graph.definition.digest },
    }],
    ['unknown runtime fields', {
      ...plan.plan,
      unknownRuntimeField: true,
    }],
  ] as const)('rejects a self-consistent plan with %s before any storage write', async (
    _label,
    invalidPlan,
  ) => {
    const root = await temporaryRoot();
    const stores = binding(root);

    await expect(persistRunDefinition(stores, {
      runId: 'invalid-plan',
      eventId: 'invalid-plan:start',
      timestamp: '2026-08-26T04:00:00.000Z',
      graphDefinition: graph.definition,
      resolvedPlan: planSnapshot(invalidPlan as unknown as JsonValue) as never,
      resolvedInputs: {},
      workspaceBinding: null,
      hostBinding: null,
    })).rejects.toMatchObject({
      name: 'StorageError',
      code: 'INVALID_STORED_VALUE',
    });
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    ['graph id', {
      ...plan.plan,
      graph: { ...plan.plan.graph, id: 'another-graph' },
    }],
    ['definition version', {
      ...plan.plan,
      graph: { ...plan.plan.graph, definitionVersion: 2 },
    }],
  ] as const)('rejects a valid-shaped plan with a mismatched %s', async (
    _label,
    invalidPlan,
  ) => {
    const root = await temporaryRoot();
    const stores = binding(root);

    await expect(persistRunDefinition(stores, {
      runId: 'mismatched-plan-identity',
      eventId: 'mismatched-plan-identity:start',
      timestamp: '2026-08-26T04:00:00.000Z',
      graphDefinition: graph.definition,
      resolvedPlan: planSnapshot(invalidPlan as unknown as JsonValue) as never,
      resolvedInputs: {},
      workspaceBinding: null,
      hostBinding: null,
    })).rejects.toMatchObject({
      name: 'StorageError',
      code: 'INVALID_STORED_VALUE',
    });
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    ['oversized run-start event', {
      storagePolicy: {
        ...policy,
        maxEventPayloadBytes: 64,
        maxAppendBatchBytes: 128,
      },
      knownSecrets: [] as readonly string[],
      resolvedInputs: {},
      hostBinding: null,
    }],
    ['known secret in run-start event', {
      storagePolicy: policy,
      knownSecrets: ['run-start-secret'] as readonly string[],
      resolvedInputs: { title: 'run-start-secret' },
      hostBinding: null,
    }],
    ['known secret across serialized event fields', {
      storagePolicy: policy,
      knownSecrets: ['\",\"type\":\"graph:run-started'] as readonly string[],
      resolvedInputs: {},
      hostBinding: null,
    }],
    ['known secret in event-store metadata', {
      storagePolicy: policy,
      knownSecrets: ['\"segmentVersion\":1'] as readonly string[],
      resolvedInputs: {},
      hostBinding: null,
    }],
    ['known secret in host-binding bytes', {
      storagePolicy: policy,
      knownSecrets: ['host-binding-secret'] as readonly string[],
      resolvedInputs: {},
      hostBinding: {
        bytes: new TextEncoder().encode('host-binding-secret'),
        mediaType: 'application/octet-stream',
      },
    }],
  ] as const)('does not admit plan bytes when a %s is rejected', async (
    _label,
    fixture,
  ) => {
    const root = await temporaryRoot();
    const stores = binding(
      root,
      'intent-42',
      fixture.knownSecrets,
      fixture.storagePolicy,
    );

    await expect(persistRunDefinition(stores, {
      runId: 'rejected-start',
      eventId: 'rejected-start:event',
      timestamp: '2026-08-26T04:00:00.000Z',
      graphDefinition: graph.definition,
      resolvedPlan: plan,
      resolvedInputs: fixture.resolvedInputs,
      workspaceBinding: null,
      hostBinding: fixture.hostBinding,
    })).rejects.toBeInstanceOf(StorageError);

    await expect(stores.artifactStore.read(
      { namespace: 'intent-42', runId: 'rejected-start' },
      {
        schemaVersion: 1,
        digest: plan.digest,
        byteLength: Buffer.byteLength(plan.canonicalJson),
        mediaType: 'application/json',
        purpose: 'resolved-plan',
      },
    )).rejects.toMatchObject({ code: 'ARTIFACT_NOT_ADMITTED' });
  });

  it('persists artifacts first, then reopens the exact plan, inputs, and host bytes', async () => {
    const root = await temporaryRoot();
    const first = binding(root);
    const resolvedInputs = { request: { title: 'Review this change' } };
    const hostBytes = Uint8Array.from([0, 255, 1, 254, 2]);

    const write = persistRunDefinition(first, {
      runId: 'run-42',
      eventId: 'run-42:start',
      timestamp: '2026-08-26T04:00:00.000Z',
      graphDefinition: graph.definition,
      resolvedPlan: plan,
      resolvedInputs,
      workspaceBinding: {
        provider: 'outside-host',
        revisions: ['shared-a', 'project-b'],
      },
      hostBinding: {
        bytes: hostBytes,
        mediaType: 'application/octet-stream',
      },
    });

    resolvedInputs.request.title = 'Changed after start';
    hostBytes[1] = 0;

    const written = await write;
    const reopened = binding(root);
    const loaded = await loadRunDefinition(reopened, 'run-42');

    expect(written.revision).toBe(1);
    expect(loaded.record).toEqual(written);
    expect(loaded.resolvedPlan).toEqual(plan);
    expect(loaded.record.payload.definition.resolvedInputs).toEqual({
      request: { title: 'Review this change' },
    });
    expect(loaded.hostBindingBytes).toEqual(
      Uint8Array.from([0, 255, 1, 254, 2]),
    );
  });

  it('rejects a second start before admitting a different plan', async () => {
    const root = await temporaryRoot();
    const stores = binding(root);
    await persistRunDefinition(stores, {
      runId: 'single-start',
      eventId: 'single-start:first',
      timestamp: '2026-08-26T04:00:00.000Z',
      graphDefinition: graph.definition,
      resolvedPlan: plan,
      resolvedInputs: { attempt: 1 },
      workspaceBinding: null,
      hostBinding: null,
    });
    const replacementPackage = {
      ...packageIdentity,
      version: '1.0.1',
      digest: `sha256:${'4'.repeat(64)}` as const,
    };
    const replacementPlan = resolveGraphPlan(description, {
      package: replacementPackage,
      admission: { package: replacementPackage, permissions: [] },
      executionLanes: [],
    });

    await expect(persistRunDefinition(stores, {
      runId: 'single-start',
      eventId: 'single-start:second',
      timestamp: '2026-08-26T04:00:01.000Z',
      graphDefinition: graph.definition,
      resolvedPlan: replacementPlan,
      resolvedInputs: { attempt: 2 },
      workspaceBinding: null,
      hostBinding: null,
    })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });

    await expect(stores.artifactStore.read(
      { namespace: 'intent-42', runId: 'single-start' },
      {
        schemaVersion: 1,
        digest: replacementPlan.digest,
        byteLength: Buffer.byteLength(replacementPlan.canonicalJson),
        mediaType: 'application/json',
        purpose: 'resolved-plan',
      },
    )).rejects.toMatchObject({ code: 'ARTIFACT_NOT_ADMITTED' });
    const loaded = await loadRunDefinition(stores, 'single-start');
    expect(loaded.resolvedPlan).toEqual(plan);
    expect(loaded.record.payload.definition.resolvedInputs).toEqual({ attempt: 1 });
  });

  it('namespace isolation: persists and reopens the same run id independently over shared providers', async () => {
    const root = await temporaryRoot();
    const first = binding(root, 'intent-one');
    const second = binding(root, 'intent-two');

    await persistRunDefinition(first, {
      runId: 'same-run',
      eventId: 'same-run:start',
      timestamp: '2026-08-26T04:00:00.000Z',
      graphDefinition: graph.definition,
      resolvedPlan: plan,
      resolvedInputs: { owner: 'first' },
      workspaceBinding: null,
      hostBinding: { bytes: new TextEncoder().encode('first host'), mediaType: 'text/plain' },
    });

    await expect(loadRunDefinition(second, 'same-run')).rejects.toMatchObject({
      code: 'INVALID_STORED_VALUE',
    });

    await persistRunDefinition(second, {
      runId: 'same-run',
      eventId: 'same-run:start',
      timestamp: '2026-08-26T04:00:00.000Z',
      graphDefinition: graph.definition,
      resolvedPlan: plan,
      resolvedInputs: { owner: 'second' },
      workspaceBinding: null,
      hostBinding: { bytes: new TextEncoder().encode('second host'), mediaType: 'text/plain' },
    });

    const reopenedFirst = await loadRunDefinition(binding(root, 'intent-one'), 'same-run');
    const reopenedSecond = await loadRunDefinition(binding(root, 'intent-two'), 'same-run');
    expect(reopenedFirst.record.payload.definition.resolvedInputs).toEqual({ owner: 'first' });
    expect(reopenedSecond.record.payload.definition.resolvedInputs).toEqual({ owner: 'second' });
    expect(reopenedFirst.hostBindingBytes).toEqual(new TextEncoder().encode('first host'));
    expect(reopenedSecond.hostBindingBytes).toEqual(new TextEncoder().encode('second host'));
  });

  it('rejects a live binding record that differs from the stored record', async () => {
    const root = await temporaryRoot();
    const original = binding(root);
    await persistRunDefinition(original, {
      runId: 'record-bound',
      eventId: 'record-bound:start',
      timestamp: '2026-08-26T04:00:00.000Z',
      graphDefinition: graph.definition,
      resolvedPlan: plan,
      resolvedInputs: {},
      workspaceBinding: null,
      hostBinding: null,
    });

    const changedProvider: RunStorageBinding = {
      ...binding(root),
      record: {
        ...original.record,
        eventStore: { ...original.record.eventStore, version: '2' },
      },
    };
    await expect(loadRunDefinition(changedProvider, 'record-bound'))
      .rejects.toMatchObject({ code: 'INVALID_STORED_VALUE' });

    const changedPolicy: RunStorageBinding = {
      ...binding(root),
      record: {
        ...original.record,
        policy: {
          ...original.record.policy,
          maxEventPayloadBytes: original.record.policy.maxEventPayloadBytes + 1,
        },
      },
    };
    await expect(loadRunDefinition(changedPolicy, 'record-bound'))
      .rejects.toMatchObject({ code: 'INVALID_STORED_VALUE' });
  });

  it('rejects a stored plan that belongs to another graph', async () => {
    const root = await temporaryRoot();
    const stores = binding(root);
    const otherGraph = createGraphKernel({
      id: 'other',
      definitionVersion: 1,
      data: {},
      nodes: [{ id: 'review', data: {} }],
      edges: [],
    });
    const otherPlan = resolveGraphPlan({
      ...description,
      graph: {
        ...description.graph,
        id: 'other',
        definitionDigest: otherGraph.definition.digest,
      },
    }, {
      package: packageIdentity,
      admission: { package: packageIdentity, permissions: [] },
      executionLanes: [],
    });
    const scope = { namespace: 'intent-42', runId: 'mismatched-run' };
    const planReference = await stores.artifactStore.write(scope, {
      bytes: new TextEncoder().encode(otherPlan.canonicalJson),
      mediaType: 'application/json',
      purpose: 'resolved-plan',
      contentMode: 'state',
    });
    const mismatched = validateRunDefinition({
      schemaVersion: 1,
      runId: 'mismatched-run',
      graphDefinition: graph.definition,
      resolvedPlan: planReference,
      resolvedInputs: {},
      storage: stores.record,
      workspaceBinding: null,
      hostBinding: null,
    });
    await stores.eventStore.append(
      { namespace: 'intent-42', streamId: 'mismatched-run' },
      0,
      [{
        eventId: 'mismatched-run:start',
        type: 'graph:run-started',
        version: 1,
        timestamp: '2026-08-26T04:00:00.000Z',
        correlationId: 'mismatched-run',
        causationId: null,
        payload: { definition: mismatched },
      }],
    );

    await expect(loadRunDefinition(stores, 'mismatched-run')).rejects.toMatchObject({
      name: 'StorageError',
      code: 'INVALID_STORED_VALUE',
    });
  });

  it('rejects a stored plan with unknown runtime fields after reopening', async () => {
    const root = await temporaryRoot();
    const stores = binding(root);
    const unsafe = planSnapshot({
      ...plan.plan,
      unknownRuntimeField: true,
    } as unknown as JsonValue);
    const scope = { namespace: 'intent-42', runId: 'unknown-plan' };
    const planReference = await stores.artifactStore.write(scope, {
      bytes: new TextEncoder().encode(unsafe.canonicalJson),
      mediaType: 'application/json',
      purpose: 'resolved-plan',
      contentMode: 'state',
    });
    const stored = validateRunDefinition({
      schemaVersion: 1,
      runId: 'unknown-plan',
      graphDefinition: graph.definition,
      resolvedPlan: planReference,
      resolvedInputs: {},
      storage: stores.record,
      workspaceBinding: null,
      hostBinding: null,
    });
    await stores.eventStore.append(
      { namespace: 'intent-42', streamId: 'unknown-plan' },
      0,
      [{
        eventId: 'unknown-plan:start',
        type: 'graph:run-started',
        version: 1,
        timestamp: '2026-08-26T04:00:00.000Z',
        correlationId: 'unknown-plan',
        causationId: null,
        payload: { definition: stored },
      }],
    );

    await expect(loadRunDefinition(stores, 'unknown-plan')).rejects.toMatchObject({
      name: 'StorageError',
      code: 'INVALID_STORED_VALUE',
    });
  });

  it('adds event context when a referenced artifact cannot be read', async () => {
    const root = await temporaryRoot();
    const stores = binding(root);
    const record = await persistRunDefinition(stores, {
      runId: 'run-42',
      eventId: 'run-42:start',
      timestamp: '2026-08-26T04:00:00.000Z',
      graphDefinition: graph.definition,
      resolvedPlan: plan,
      resolvedInputs: {},
      workspaceBinding: null,
      hostBinding: null,
    });

    await stores.artifactStore.deleteRun({ namespace: 'intent-42', runId: 'run-42' });

    try {
      await loadRunDefinition(stores, 'run-42');
    } catch (error) {
      expect(error).toBeInstanceOf(StorageError);
      expect(error).toMatchObject({
        details: expect.objectContaining({
          streamId: 'run-42',
          revision: record.revision,
          eventId: record.eventId,
          referencePath: '/payload/definition/resolvedPlan',
        }),
      });
      return;
    }
    throw new Error('Expected the missing plan artifact to fail.');
  });
});
