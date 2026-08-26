import { join, resolve } from 'node:path';

import {
  createLocalArtifactStore,
  type LocalArtifactStoreOptions,
} from '../artifacts/file-store.js';
import {
  createLocalEventStore,
  type LocalEventStoreOptions,
} from '../events/jsonl-store.js';
import {
  canonicalJson,
  digestJson,
  type JsonValue,
} from '../graph/value.js';
import {
  validateRunStorageRecord,
  validateRunStoragePolicy,
  type RunStorageBinding,
  type RunStoragePolicy,
} from '../runtime/run-definition.js';
import { StorageError } from './error.js';
import { validateStorageId } from './id.js';

export interface LocalRunStorageOptions {
  readonly directory: string;
  readonly namespace: string;
  readonly policy: RunStoragePolicy;
  readonly knownSecrets?: readonly string[];
}

function containsText(value: JsonValue, textValue: string): boolean {
  if (typeof value === 'string') return value.includes(textValue);
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsText(item, textValue));
  }
  return Object.entries(value).some(([key, item]) => (
    key.includes(textValue) || containsText(item, textValue)
  ));
}

function rejectKnownSecret(
  value: JsonValue,
  knownSecrets: readonly string[],
  label: string,
): void {
  const serialized = canonicalJson(value);
  if (knownSecrets.some((secret) => (
    serialized.includes(secret) || containsText(value, secret)
  ))) {
    throw new StorageError(
      'KNOWN_SECRET',
      `${label} contains a configured known secret.`,
    );
  }
}

export function createLocalRunStorage(
  options: LocalRunStorageOptions,
): RunStorageBinding {
  if (
    typeof options.directory !== 'string'
    || options.directory.trim().length === 0
  ) {
    throw new StorageError(
      'INVALID_STORED_VALUE',
      'Local storage directory must be a non-empty path.',
      { path: '/directory' },
    );
  }
  const knownSecrets = options.knownSecrets ?? [];
  if (
    !Array.isArray(knownSecrets)
    || knownSecrets.some((secret) => (
      typeof secret !== 'string' || secret.length === 0
    ))
  ) {
    throw new StorageError(
      'INVALID_STORED_VALUE',
      'Known secrets must be non-empty strings.',
      { path: '/knownSecrets' },
    );
  }
  const frozenSecrets = Object.freeze([...knownSecrets]);
  const namespace = validateStorageId(options.namespace, '/namespace');
  const policy = validateRunStoragePolicy(options.policy);
  const directory = resolve(options.directory);
  const eventRoot = join(directory, 'events');
  const artifactRoot = join(directory, 'artifacts');
  const eventOptions: LocalEventStoreOptions = {
    root: eventRoot,
    maxEventPayloadBytes: policy.maxEventPayloadBytes,
    maxAppendBatchBytes: policy.maxAppendBatchBytes,
    knownSecrets: frozenSecrets,
  };
  const artifactOptions: LocalArtifactStoreOptions = {
    root: artifactRoot,
    maxArtifactBytes: policy.maxArtifactBytes,
    maxTotalArtifactBytesPerRun: policy.maxTotalArtifactBytesPerRun,
    knownSecrets: frozenSecrets,
  };
  const eventConfiguration = {
    schemaVersion: 1,
    root: eventRoot,
    maxEventPayloadBytes: policy.maxEventPayloadBytes,
    maxAppendBatchBytes: policy.maxAppendBatchBytes,
  } as const;
  const artifactConfiguration = {
    schemaVersion: 1,
    root: artifactRoot,
    maxArtifactBytes: policy.maxArtifactBytes,
    maxTotalArtifactBytesPerRun: policy.maxTotalArtifactBytesPerRun,
  } as const;
  rejectKnownSecret(eventConfiguration, frozenSecrets, 'Event-store configuration');
  rejectKnownSecret(artifactConfiguration, frozenSecrets, 'Artifact-store configuration');
  const record = validateRunStorageRecord({
    schemaVersion: 1,
    namespace,
    eventStore: {
      schemaVersion: 1,
      name: 'local-jsonl',
      version: '1',
      configDigest: digestJson(eventConfiguration),
    },
    artifactStore: {
      schemaVersion: 1,
      name: 'local-files',
      version: '1',
      configDigest: digestJson(artifactConfiguration),
    },
    policy,
  });
  rejectKnownSecret(record, frozenSecrets, 'Storage binding record');
  return Object.freeze({
    record,
    knownSecrets: frozenSecrets,
    eventStore: createLocalEventStore(eventOptions),
    artifactStore: createLocalArtifactStore(artifactOptions),
  });
}

export {
  createLocalArtifactStore,
  createLocalEventStore,
};
export type {
  LocalArtifactStoreOptions,
  LocalEventStoreOptions,
};
