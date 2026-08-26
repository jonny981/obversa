import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validateArtifactReference,
  type JsonObject,
  type JsonValue,
  type RunStorageBinding,
  type RunStoragePolicy,
} from '@obversa/lines';
import {
  runArtifactStoreConformance,
  runEventStoreConformance,
} from '@obversa/lines/testing';
import {
  createLocalArtifactStore,
  createLocalEventStore,
  createLocalRunStorage,
} from '@obversa/lines/storage/local';

const encoder = new TextEncoder();
const policy = {
  schemaVersion: 1,
  maxEventPayloadBytes: 8_192,
  maxAppendBatchBytes: 32_768,
  maxArtifactBytes: 131_072,
  maxTotalArtifactBytesPerRun: 1_048_576,
  retention: 'until-run-delete',
  sensitiveContent: {
    marked: 'reject',
    exact: 'reject',
    freeText: 'redact-before-hash',
  },
} as const satisfies RunStoragePolicy;

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function foldStoredState(binding: RunStorageBinding, runId: string) {
  const stream = { namespace: binding.record.namespace, streamId: runId };
  const scope = { namespace: binding.record.namespace, runId };
  let eventCount = 0;
  let artifactBytes = 0;
  let lastArtifactDigest: string | null = null;

  for await (const event of binding.eventStore.read(stream)) {
    if (
      event.type !== 'example:artifact-recorded'
      || !isJsonObject(event.payload)
    ) {
      throw new Error(`Unexpected stored event ${event.type}.`);
    }
    const reference = validateArtifactReference(event.payload.artifact);
    const bytes = await binding.artifactStore.read(scope, reference);
    eventCount += 1;
    artifactBytes += bytes.byteLength;
    lastArtifactDigest = reference.digest;
  }

  return { eventCount, artifactBytes, lastArtifactDigest };
}

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'obversa-storage-example-'));

  try {
    const runId = 'run-one';
    const storageOptions = {
      directory: join(directory, 'run-storage'),
      namespace: 'example-host',
      policy,
      knownSecrets: ['example-secret'],
    } as const;
    const first = createLocalRunStorage(storageOptions);
    const scope = { namespace: first.record.namespace, runId };
    const stream = { namespace: first.record.namespace, streamId: runId };
    const largeBytes = encoder.encode(JSON.stringify({
      schemaVersion: 1,
      kind: 'synthetic-result',
      text: 'x'.repeat(65_536),
    }));
    const reference = await first.artifactStore.write(scope, {
      bytes: largeBytes,
      mediaType: 'application/json',
      purpose: 'synthetic-result',
      contentMode: 'state',
    });

    await first.eventStore.append(stream, 0, [{
      eventId: 'artifact-recorded-1',
      type: 'example:artifact-recorded',
      version: 1,
      timestamp: '2026-08-26T04:00:00.000Z',
      correlationId: runId,
      causationId: null,
      payload: { artifact: reference },
    }]);

    const firstState = await foldStoredState(first, runId);
    const reopened = createLocalRunStorage(storageOptions);
    const reopenedState = await foldStoredState(reopened, runId);
    if (JSON.stringify(firstState) !== JSON.stringify(reopenedState)) {
      throw new Error('Fresh storage binding folded a different state.');
    }

    const eventConformance = await runEventStoreConformance((options) =>
      createLocalEventStore({
        root: join(directory, 'event-conformance'),
        ...options,
      }));
    const artifactConformance = await runArtifactStoreConformance((options) =>
      createLocalArtifactStore({
        root: join(directory, 'artifact-conformance'),
        ...options,
      }));
    if (!eventConformance.ok || !artifactConformance.ok) {
      throw new Error(JSON.stringify({ eventConformance, artifactConformance }));
    }

    console.log(JSON.stringify({
      storedArtifactBytes: reference.byteLength,
      eventPayloadBytes: encoder.encode(JSON.stringify({ artifact: reference })).byteLength,
      reopenedState,
      conformance: {
        events: eventConformance.cases,
        artifacts: artifactConformance.cases,
      },
    }, null, 2));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await main();
