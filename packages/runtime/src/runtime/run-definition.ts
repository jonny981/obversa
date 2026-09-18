import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  validateRunDefinition,
  validateRunStartRecord,
  validateRunStorageRecord,
  type CompiledGraphDefinition,
  type RunStorageBinding,
  type RunStorageRecord,
  type RunStoragePolicy,
  type RunStartRecord,
  type NewRunStartedEvent,
} from '@obversa/api';
import { runDefinitionSupport } from '@obversa/api/run-definition-support';
import {
  canonicalJson,
  digestJson,
  GraphValidationError,
  type JsonObject,
  type JsonValue,
  type RunBrief,
  type Sha256Digest,
} from '../graph/value.js';
import {
  validateResolvedPlan,
  type ResolvedPlan,
  type ResolvedPlanSnapshot,
} from '../graph/plan.js';
import {
  validateArtifactReference,
  validateNewArtifact,
  type ArtifactBatch,
  type NewArtifact,
  type ArtifactReference,
} from '../artifacts/store.js';
import {
  validateDomainEventEnvelope,
  validateNewDomainEvent,
  type DomainEventEnvelope,
} from '../events/envelope.js';
import { findKnownSecretInEvents } from '../events/store.js';
import { StorageError } from '../storage/error.js';
import { validateStorageId } from '../storage/id.js';

export {
  validateRunDefinition,
  validateRunStartRecord,
  validateRunStoragePolicy,
  validateRunStorageRecord,
  type StorageProviderRecord,
  type SensitiveContentPolicy,
  type RunStoragePolicy,
  type RunStorageRecord,
  type RunDefinition,
  type RunStartedPayload,
  type NewRunStartedEvent,
  type RunStartRecord,
  type RunStorageBinding,
} from '@obversa/api';

const fail: (path: string, message: string) => never = runDefinitionSupport.fail;
const { json, record, text, digest, validateCompiledDefinition } = runDefinitionSupport;

export interface PersistRunDefinitionInput {
  readonly runId: string;
  readonly eventId: string;
  readonly timestamp: string;
  readonly graphDefinition: CompiledGraphDefinition;
  readonly resolvedPlan: ResolvedPlanSnapshot;
  readonly resolvedInputs: RunBrief;
  readonly workspaceBinding: JsonObject | null;
  readonly hostBinding: {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
  } | null;
}

export interface LoadedRunDefinition {
  readonly record: RunStartRecord;
  readonly resolvedPlan: ResolvedPlanSnapshot;
  readonly hostBindingBytes: Uint8Array | null;
}

function validateResolvedPlanSnapshot(
  value: ResolvedPlanSnapshot,
): ResolvedPlanSnapshot {
  const plan = json(value.plan, '/resolvedPlan/plan');
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    fail('/resolvedPlan/plan', 'Resolved plan must be an object.');
  }
  const stable = canonicalJson(plan);
  if (value.canonicalJson !== stable) {
    fail('/resolvedPlan/canonicalJson', 'Resolved plan bytes do not match its value.');
  }
  const planDigest = digestJson(plan);
  if (value.digest !== planDigest) {
    fail('/resolvedPlan/digest', 'Resolved plan digest does not match its value.');
  }
  const validatedPlan = storedResolvedPlan(plan, '/resolvedPlan/plan');
  return Object.freeze({
    plan: validatedPlan,
    canonicalJson: stable,
    digest: planDigest,
  });
}

function storedResolvedPlan(value: unknown, path: string): ResolvedPlan {
  try {
    return validateResolvedPlan(value);
  } catch (error) {
    if (!(error instanceof GraphValidationError)) throw error;
    const first = error.issues[0];
    fail(`${path}${first?.path ?? ''}`, first?.message ?? error.message);
  }
}

function validateResolvedPlanGraph(
  plan: ResolvedPlan,
  definition: CompiledGraphDefinition,
): void {
  const graph = record(plan.graph, '/resolvedPlan/graph', 'Resolved plan graph');
  if (
    digest(graph.definitionDigest, '/resolvedPlan/graph/definitionDigest')
    !== definition.digest
  ) {
    fail('/resolvedPlan/graph/definitionDigest', 'Resolved plan belongs to another graph definition.');
  }
  if (graph.id !== definition.value.id) {
    fail('/resolvedPlan/graph/id', 'Resolved plan belongs to another graph id.');
  }
  if (graph.definitionVersion !== definition.value.definitionVersion) {
    fail('/resolvedPlan/graph/definitionVersion', 'Resolved plan belongs to another graph definition version.');
  }
}

function validateBinding(
  binding: RunStorageBinding,
  storedRecord?: RunStorageRecord,
): {
  readonly record: RunStorageRecord;
  readonly knownSecrets: readonly string[];
} {
  const bindingRecord = validateRunStorageRecord(binding.record);
  if (
    storedRecord !== undefined
    && !isDeepStrictEqual(bindingRecord, storedRecord)
  ) {
    fail('/storage', 'Stored and live storage records must match.');
  }
  const knownSecrets = json(binding.knownSecrets, '/binding/knownSecrets');
  if (
    !Array.isArray(knownSecrets)
    || knownSecrets.some((secret) => (
      typeof secret !== 'string' || secret.length === 0
    ))
  ) {
    fail('/binding/knownSecrets', 'Known secrets must be non-empty strings.');
  }
  const secrets = knownSecrets as readonly string[];
  const serializedRecord = canonicalJson(bindingRecord);
  if (secrets.some((secret) => (
    serializedRecord.includes(secret)
    || jsonValueContainsText(bindingRecord, secret)
  ))) {
    throw new StorageError(
      'KNOWN_SECRET',
      'Storage binding record contains a configured known secret.',
    );
  }
  return {
    record: bindingRecord,
    knownSecrets: secrets,
  };
}

function jsonValueContainsText(value: JsonValue, textValue: string): boolean {
  if (typeof value === 'string') return value.includes(textValue);
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((item) => jsonValueContainsText(item, textValue));
  }
  return Object.entries(value).some(([key, item]) => (
    key.includes(textValue) || jsonValueContainsText(item, textValue)
  ));
}

function expectedArtifactReference(
  artifact: NewArtifact,
): ArtifactReference {
  return validateArtifactReference({
    schemaVersion: 1,
    digest: `sha256:${createHash('sha256').update(artifact.bytes).digest('hex')}`,
    byteLength: artifact.bytes.byteLength,
    mediaType: artifact.mediaType,
    purpose: artifact.purpose,
  });
}

function preflightArtifacts(
  artifacts: readonly NewArtifact[],
  policy: RunStoragePolicy,
  knownSecrets: readonly string[],
): void {
  const uniqueBytes = new Map<string, number>();
  for (const artifact of artifacts) {
    if (artifact.bytes.byteLength > policy.maxArtifactBytes) {
      throw new StorageError(
        'STORAGE_LIMIT_EXCEEDED',
        'Run-start artifact exceeds maxArtifactBytes.',
        {
          purpose: artifact.purpose,
          byteLength: artifact.bytes.byteLength,
          maximumBytes: policy.maxArtifactBytes,
        },
      );
    }
    const bytes = Buffer.from(artifact.bytes);
    if (knownSecrets.some((secret) => bytes.includes(Buffer.from(secret, 'utf8')))) {
      throw new StorageError(
        'KNOWN_SECRET',
        'Exact run-start artifact contains a configured known secret.',
        { purpose: artifact.purpose },
      );
    }
    const reference = expectedArtifactReference(artifact);
    uniqueBytes.set(reference.digest, reference.byteLength);
  }
  const total = [...uniqueBytes.values()].reduce((sum, size) => sum + size, 0);
  if (total > policy.maxTotalArtifactBytesPerRun) {
    throw new StorageError(
      'STORAGE_LIMIT_EXCEEDED',
      'Run-start artifacts exceed maxTotalArtifactBytesPerRun.',
      { byteLength: total, maximumBytes: policy.maxTotalArtifactBytesPerRun },
    );
  }
}

function preflightRunStartEvent(
  event: NewRunStartedEvent,
  policy: RunStoragePolicy,
  knownSecrets: readonly string[],
): void {
  const payloadByteLength = Buffer.byteLength(canonicalJson(event.payload), 'utf8');
  if (payloadByteLength > policy.maxEventPayloadBytes) {
    throw new StorageError(
      'STORAGE_LIMIT_EXCEEDED',
      'Run-start payload exceeds maxEventPayloadBytes.',
      { byteLength: payloadByteLength, maximumBytes: policy.maxEventPayloadBytes },
    );
  }
  const envelope = validateDomainEventEnvelope({
    ...event,
    envelopeVersion: 1,
    streamId: event.correlationId,
    revision: 1,
  });
  const serializedEvent = `${JSON.stringify(envelope)}\n`;
  const appendByteLength = Buffer.byteLength(serializedEvent, 'utf8');
  if (appendByteLength > policy.maxAppendBatchBytes) {
    throw new StorageError(
      'STORAGE_LIMIT_EXCEEDED',
      'Run-start append exceeds maxAppendBatchBytes.',
      { byteLength: appendByteLength, maximumBytes: policy.maxAppendBatchBytes },
    );
  }
  const secret = findKnownSecretInEvents(
    knownSecrets,
    serializedEvent,
    [event],
  );
  if (secret !== undefined) {
    throw new StorageError(
      'KNOWN_SECRET',
      'Run-start event contains a configured known secret.',
      { eventId: event.eventId },
    );
  }
}

function artifactError(
  error: StorageError,
  record: RunStartRecord,
  referencePath: string,
): StorageError {
  return new StorageError(error.code, error.message, {
    ...error.details,
    streamId: record.streamId,
    revision: record.revision,
    eventId: record.eventId,
    referencePath,
  });
}

function readPlanBytes(bytes: Uint8Array, referencePath: string): string {
  let textValue: string;
  try {
    textValue = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(referencePath, 'Resolved plan bytes must be valid UTF-8.');
  }
  return textValue;
}

function parseStoredPlan(
  bytes: Uint8Array,
  digestValue: Sha256Digest,
): ResolvedPlanSnapshot {
  const textValue = readPlanBytes(bytes, '/resolvedPlan');
  let parsed: unknown;
  try {
    parsed = JSON.parse(textValue);
  } catch {
    fail('/resolvedPlan', 'Resolved plan bytes must contain JSON.');
  }
  const plan = json(parsed, '/resolvedPlan');
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    fail('/resolvedPlan', 'Resolved plan must be an object.');
  }
  if (canonicalJson(plan) !== textValue) {
    fail('/resolvedPlan', 'Resolved plan bytes must use stable JSON encoding.');
  }
  if (digestJson(plan) !== digestValue) {
    fail('/resolvedPlan', 'Resolved plan digest does not match its bytes.');
  }
  const validatedPlan = storedResolvedPlan(plan, '/resolvedPlan');
  return Object.freeze({
    plan: validatedPlan,
    canonicalJson: textValue,
    digest: digestValue,
  });
}

export async function persistRunDefinition(
  binding: RunStorageBinding,
  input: PersistRunDefinitionInput,
): Promise<RunStartRecord> {
  const { record: storage, knownSecrets } = validateBinding(binding);
  const graphDefinition = validateCompiledDefinition(input.graphDefinition);
  const resolvedPlan = validateResolvedPlanSnapshot(input.resolvedPlan);
  validateResolvedPlanGraph(resolvedPlan.plan, graphDefinition);
  const resolvedInputs = record(
    input.resolvedInputs,
    '/resolvedInputs',
    'Resolved inputs',
  ) as RunBrief;
  const workspaceBinding = input.workspaceBinding === null
    ? null
    : record(input.workspaceBinding, '/workspaceBinding', 'Workspace binding');
  const hostBinding = input.hostBinding === null
    ? null
    : Object.freeze({
      bytes: Uint8Array.from(input.hostBinding.bytes),
      mediaType: text(input.hostBinding.mediaType, '/hostBinding/mediaType', 'Host-binding media type'),
    });
  const runId = validateStorageId(input.runId, '/runId');
  const scope = { namespace: storage.namespace, runId };
  const resolvedPlanArtifact = validateNewArtifact({
    bytes: new TextEncoder().encode(resolvedPlan.canonicalJson),
    mediaType: 'application/json',
    purpose: 'resolved-plan',
    contentMode: 'state',
  });
  const hostBindingArtifact = hostBinding === null
    ? null
    : validateNewArtifact({
      bytes: hostBinding.bytes,
      mediaType: hostBinding.mediaType,
      purpose: 'host-binding',
      contentMode: 'exact',
    });
  preflightArtifacts(
    hostBindingArtifact === null
      ? [resolvedPlanArtifact]
      : [resolvedPlanArtifact, hostBindingArtifact],
    storage.policy,
    knownSecrets,
  );
  const artifacts: ArtifactBatch = hostBindingArtifact === null
    ? [resolvedPlanArtifact]
    : [resolvedPlanArtifact, hostBindingArtifact];
  const expectedPlanReference = expectedArtifactReference(
    resolvedPlanArtifact,
  ) as ArtifactReference<'resolved-plan'>;
  const expectedHostReference = hostBindingArtifact === null
    ? null
    : expectedArtifactReference(hostBindingArtifact) as ArtifactReference<'host-binding'>;
  const expectedReferences = expectedHostReference === null
    ? [expectedPlanReference]
    : [expectedPlanReference, expectedHostReference];
  const predictedReferences = await binding.artifactStore.preflightWrite(
    scope,
    artifacts,
  );
  if (!isDeepStrictEqual(predictedReferences, expectedReferences)) {
    throw new StorageError(
      'ARTIFACT_INTEGRITY',
      'Artifact store predicted the wrong run-start references.',
      { expected: expectedReferences, actual: predictedReferences },
    );
  }
  const definition = validateRunDefinition({
    schemaVersion: 1,
    runId,
    graphDefinition,
    resolvedPlan: expectedPlanReference,
    resolvedInputs,
    storage,
    workspaceBinding,
    hostBinding: expectedHostReference,
  });
  const event = validateNewDomainEvent({
    eventId: input.eventId,
    type: 'graph:run-started',
    version: 1,
    timestamp: input.timestamp,
    correlationId: runId,
    causationId: null,
    payload: { definition },
  }) as NewRunStartedEvent;
  preflightRunStartEvent(event, storage.policy, knownSecrets);
  await binding.eventStore.preflightAppend(
    { namespace: storage.namespace, streamId: runId },
    0,
    [event],
  );

  const resolvedPlanReference = await binding.artifactStore.write(scope, {
    ...resolvedPlanArtifact,
  });
  if (!isDeepStrictEqual(resolvedPlanReference, expectedPlanReference)) {
    throw new StorageError(
      'ARTIFACT_INTEGRITY',
      'Resolved plan store returned the wrong reference.',
      { expected: expectedPlanReference, actual: resolvedPlanReference },
    );
  }

  const hostBindingReference = hostBindingArtifact === null
    ? null
    : await binding.artifactStore.write(scope, {
      ...hostBindingArtifact,
    });
  if (!isDeepStrictEqual(hostBindingReference, expectedHostReference)) {
    throw new StorageError(
      'ARTIFACT_INTEGRITY',
      'Host-binding store returned the wrong reference.',
      { expected: expectedHostReference, actual: hostBindingReference },
    );
  }
  const revision = await binding.eventStore.append(
    { namespace: storage.namespace, streamId: runId },
    0,
    [event],
  );
  return validateRunStartRecord({
    envelopeVersion: 1,
    streamId: runId,
    revision,
    ...event,
  });
}

export async function loadRunDefinition(
  binding: RunStorageBinding,
  runId: string,
): Promise<LoadedRunDefinition> {
  const live = validateBinding(binding);
  const streamId = validateStorageId(runId, '/runId');
  let first: DomainEventEnvelope | undefined;
  for await (const event of binding.eventStore.read({
    namespace: live.record.namespace,
    streamId,
  })) {
    first = event;
    break;
  }
  if (!first) {
    fail('/runId', `Run "${streamId}" has no stored definition.`);
  }
  const record = validateRunStartRecord(first);
  validateBinding(binding, record.payload.definition.storage);
  const scope = { namespace: live.record.namespace, runId: streamId };

  let planBytes: Uint8Array;
  try {
    planBytes = await binding.artifactStore.read(
      scope,
      record.payload.definition.resolvedPlan,
    );
  } catch (error) {
    if (!(error instanceof StorageError)) throw error;
    throw artifactError(error, record, '/payload/definition/resolvedPlan');
  }
  const resolvedPlan = parseStoredPlan(
    planBytes,
    record.payload.definition.resolvedPlan.digest,
  );
  validateResolvedPlanGraph(
    resolvedPlan.plan,
    record.payload.definition.graphDefinition,
  );

  let hostBindingBytes: Uint8Array | null = null;
  const hostBinding = record.payload.definition.hostBinding;
  if (hostBinding !== null) {
    try {
      hostBindingBytes = await binding.artifactStore.read(scope, hostBinding);
    } catch (error) {
      if (!(error instanceof StorageError)) throw error;
      throw artifactError(error, record, '/payload/definition/hostBinding');
    }
  }

  return Object.freeze({
    record,
    resolvedPlan,
    hostBindingBytes,
  });
}
