import { describe, expect, it } from 'vitest';

import { createGraphKernel } from '../src/graph/kernel.js';
import { resolveGraphPlan, type GraphDescription } from '../src/graph/plan.js';
import type { ArtifactReference } from '../src/artifacts/store.js';
import { StorageError } from '../src/storage/error.js';
import {
  validateRunDefinition,
  validateRunStartRecord,
  validateRunStorageRecord,
  type RunDefinition,
  type RunStartRecord,
  type RunStorageRecord,
} from '../src/runtime/run-definition.js';

const graph = createGraphKernel({
  id: 'review-line',
  definitionVersion: 1,
  data: {},
  nodes: [{ id: 'review', data: {} }],
  edges: [],
});

const description: GraphDescription = {
  schemaVersion: 1,
  graph: {
    id: 'review-line',
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
    retry: {},
    stop: {},
    concurrency: {},
    write: {},
    budget: {},
    action: {},
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
  source: 'npm:@example/review-line',
  version: '1.0.0',
  digest: `sha256:${'2'.repeat(64)}` as const,
};

const plan = resolveGraphPlan(description, {
  package: packageIdentity,
  admission: { package: packageIdentity, permissions: [] },
  executionLanes: [],
});

const provider = {
  schemaVersion: 1 as const,
  name: 'local',
  version: '1',
  configDigest: `sha256:${'3'.repeat(64)}` as const,
};

const storage = {
  schemaVersion: 1,
  namespace: 'intent-42',
  eventStore: provider,
  artifactStore: provider,
  policy: {
    schemaVersion: 1,
    maxEventPayloadBytes: 32_000,
    maxAppendBatchBytes: 128_000,
    maxArtifactBytes: 1_000_000,
    maxTotalArtifactBytesPerRun: 10_000_000,
    retention: 'until-run-delete',
    sensitiveContent: {
      marked: 'reject',
      exact: 'reject',
      freeText: 'redact-before-hash',
    },
  },
} satisfies RunStorageRecord;

function artifact<Purpose extends string>(
  purpose: Purpose,
  digest = plan.digest,
): ArtifactReference<Purpose> {
  return {
    schemaVersion: 1,
    digest,
    byteLength: Buffer.byteLength(plan.canonicalJson),
    mediaType: 'application/json',
    purpose,
  };
}

function definition(): RunDefinition {
  return {
    schemaVersion: 1,
    runId: 'run-42',
    graphDefinition: graph.definition,
    resolvedPlan: artifact('resolved-plan'),
    resolvedInputs: { request: { title: 'Review this change' } },
    storage,
    workspaceBinding: {
      provider: 'outside-host',
      revisions: ['shared-a', 'project-b'],
      extension: { preserved: true },
    },
    hostBinding: {
      ...artifact('host-binding', `sha256:${'4'.repeat(64)}`),
      byteLength: 7,
      mediaType: 'application/octet-stream',
    },
  };
}

function runStarted(value = definition()): RunStartRecord {
  return {
    envelopeVersion: 1,
    eventId: 'run-42:start',
    streamId: 'run-42',
    revision: 1,
    type: 'graph:run-started',
    version: 1,
    timestamp: '2026-08-26T04:00:00.000Z',
    correlationId: 'run-42',
    causationId: null,
    payload: { definition: value },
  };
}

describe('run storage records', () => {
  it('returns a detached and deeply frozen safe record', () => {
    const source = structuredClone(storage);
    const result = validateRunStorageRecord(source);

    source.namespace = 'changed';
    source.policy.maxArtifactBytes = 1;

    expect(result).toEqual(storage);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.policy)).toBe(true);
    expect(Object.isFrozen(result.eventStore)).toBe(true);
  });

  it.each([
    ['record', { ...storage, extra: true }],
    ['provider', { ...storage, eventStore: { ...provider, extra: true } }],
    ['policy', { ...storage, policy: { ...storage.policy, extra: true } }],
  ])('rejects an unknown field in the %s wrapper', (_name, value) => {
    expect(() => validateRunStorageRecord(value)).toThrowError(
      expect.objectContaining({
        name: 'StorageError',
        code: 'INVALID_STORED_VALUE',
      }),
    );
  });

  it('rejects a namespace that cannot identify a stored stream', () => {
    expect(() => validateRunStorageRecord({
      ...storage,
      namespace: 'intent/42',
    })).toThrowError(expect.objectContaining({
      name: 'StorageError',
      code: 'INVALID_STORED_VALUE',
    }));
  });
});

describe('run definitions', () => {
  it('rejects a run id that cannot identify its event stream', () => {
    expect(() => validateRunDefinition({
      ...definition(),
      runId: 'run/42',
    })).toThrowError(expect.objectContaining({
      name: 'StorageError',
      code: 'INVALID_STORED_VALUE',
    }));
  });

  it('preserves exact opaque host data and freezes caller-owned inputs', () => {
    const source = definition();
    const result = validateRunDefinition(source);

    (source.resolvedInputs.request as { title: string }).title = 'Changed';
    (source.workspaceBinding!.extension as { preserved: boolean }).preserved = false;

    expect(result.resolvedInputs).toEqual({
      request: { title: 'Review this change' },
    });
    expect(result.workspaceBinding).toEqual({
      provider: 'outside-host',
      revisions: ['shared-a', 'project-b'],
      extension: { preserved: true },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.resolvedInputs.request)).toBe(true);
  });

  it('rejects a graph snapshot whose bytes or digest do not agree', () => {
    const source = definition();
    const badBytes = {
      ...source,
      graphDefinition: {
        ...source.graphDefinition,
        canonicalJson: '{"bad":true}',
      },
    };
    const badDigest = {
      ...source,
      graphDefinition: {
        ...source.graphDefinition,
        digest: `sha256:${'f'.repeat(64)}`,
      },
    };

    for (const value of [badBytes, badDigest]) {
      expect(() => validateRunDefinition(value)).toThrowError(
        expect.objectContaining({
          name: 'StorageError',
          code: 'INVALID_STORED_VALUE',
        }),
      );
    }
  });

  it('requires the exact plan and host-binding reference labels', () => {
    expect(() => validateRunDefinition({
      ...definition(),
      resolvedPlan: artifact('review-output'),
    })).toThrowError(StorageError);

    expect(() => validateRunDefinition({
      ...definition(),
      hostBinding: artifact('resolved-plan'),
    })).toThrowError(StorageError);
  });
});

describe('run-start records', () => {
  it('accepts the first event only when its run identity agrees everywhere', () => {
    expect(validateRunStartRecord(runStarted())).toEqual(runStarted());

    for (const value of [
      { ...runStarted(), revision: 2 },
      { ...runStarted(), streamId: 'another-run' },
      { ...runStarted(), correlationId: 'another-run' },
      { ...runStarted(), causationId: 'earlier-event' },
    ]) {
      expect(() => validateRunStartRecord(value)).toThrowError(
        expect.objectContaining({ code: 'INVALID_STORED_VALUE' }),
      );
    }
  });

  it('rejects unknown runtime-owned fields but preserves opaque bindings', () => {
    expect(() => validateRunStartRecord({
      ...runStarted(),
      extra: true,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_STORED_VALUE' }));

    expect(() => validateRunStartRecord({
      ...runStarted(),
      payload: { ...runStarted().payload, extra: true },
    })).toThrowError(expect.objectContaining({ code: 'INVALID_STORED_VALUE' }));

    expect(validateRunStartRecord(runStarted()).payload).toEqual({
      definition: expect.objectContaining({
        workspaceBinding: expect.objectContaining({
          extension: { preserved: true },
        }),
      }),
    });
  });
});
