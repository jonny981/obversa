import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  createGraphKernel,
  type CompiledGraphDefinition,
  type GraphDefinition,
} from '../graph/kernel.js';
import {
  canonicalJson,
  cloneFrozenJson,
  digestJson,
  GraphValidationError,
  JsonValueError,
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
  type ArtifactStore,
  type NewArtifact,
  type ArtifactReference,
} from '../artifacts/store.js';
import {
  validateDomainEventEnvelope,
  validateNewDomainEvent,
  type DomainEventEnvelope,
  type NewDomainEvent,
} from '../events/envelope.js';
import {
  findKnownSecretInEvents,
  type EventStore,
} from '../events/store.js';
import { StorageError } from '../storage/error.js';
import { validateStorageId } from '../storage/id.js';

export interface StorageProviderRecord extends JsonObject {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly version: string;
  readonly configDigest: Sha256Digest;
}

export interface SensitiveContentPolicy extends JsonObject {
  readonly marked: 'reject';
  readonly exact: 'reject';
  readonly freeText: 'redact-before-hash';
}

export interface RunStoragePolicy extends JsonObject {
  readonly schemaVersion: 1;
  readonly maxEventPayloadBytes: number;
  readonly maxAppendBatchBytes: number;
  readonly maxArtifactBytes: number;
  readonly maxTotalArtifactBytesPerRun: number;
  readonly retention: 'until-run-delete';
  readonly sensitiveContent: SensitiveContentPolicy;
}

export interface RunStorageRecord extends JsonObject {
  readonly schemaVersion: 1;
  readonly namespace: string;
  readonly eventStore: StorageProviderRecord;
  readonly artifactStore: StorageProviderRecord;
  readonly policy: RunStoragePolicy;
}

export interface RunDefinition extends JsonObject {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly graphDefinition: CompiledGraphDefinition;
  readonly resolvedPlan: ArtifactReference<'resolved-plan'>;
  readonly resolvedInputs: RunBrief;
  readonly storage: RunStorageRecord;
  readonly workspaceBinding: JsonObject | null;
  readonly hostBinding: ArtifactReference<'host-binding'> | null;
}

export interface RunStartedPayload extends JsonObject {
  readonly definition: RunDefinition;
}

export type NewRunStartedEvent = NewDomainEvent<
  'graph:run-started',
  1,
  RunStartedPayload
>;

export type RunStartRecord = DomainEventEnvelope<
  'graph:run-started',
  1,
  RunStartedPayload
>;

export interface RunStorageBinding {
  readonly record: RunStorageRecord;
  readonly eventStore: EventStore;
  readonly artifactStore: ArtifactStore;
  readonly knownSecrets: readonly string[];
}

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

type RecordValue = Readonly<Record<string, JsonValue>>;

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function fail(path: string, message: string): never {
  throw new StorageError('INVALID_STORED_VALUE', message, { path });
}

function json(value: unknown, path: string): JsonValue {
  try {
    return cloneFrozenJson(value as JsonValue);
  } catch (error) {
    if (!(error instanceof JsonValueError)) throw error;
    fail(`${path}${error.path}`, error.message);
  }
}

function record(value: unknown, path: string, label: string): RecordValue {
  const parsed = json(value, path);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(path, `${label} must be an object.`);
  }
  return parsed as RecordValue;
}

function exactFields(
  value: RecordValue,
  fields: readonly string[],
  path: string,
): void {
  const expected = new Set(fields);
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) {
      fail(`${path}/${field}`, `Required field "${field}" is missing.`);
    }
  }
  for (const field of Object.keys(value)) {
    if (!expected.has(field)) {
      fail(`${path}/${field}`, `Unknown field "${field}" is not allowed.`);
    }
  }
}

function text(value: unknown, path: string, label: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || CONTROL_CHARACTER.test(value)
  ) {
    fail(path, `${label} must be a non-empty trimmed string without control characters.`);
  }
  return value;
}

function version(value: unknown, path: string, expected = 1): number {
  if (!Number.isSafeInteger(value) || value !== expected) {
    fail(path, `Version must be ${expected}.`);
  }
  return value as number;
}

function positiveLimit(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(path, 'A storage limit must be a positive safe integer.');
  }
  return value as number;
}

function digest(value: unknown, path: string): Sha256Digest {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    fail(path, 'Digest must be lowercase sha256 followed by 64 hexadecimal characters.');
  }
  return value as Sha256Digest;
}

function validateProvider(value: unknown, path: string): StorageProviderRecord {
  const item = record(value, path, 'Storage provider');
  exactFields(item, ['schemaVersion', 'name', 'version', 'configDigest'], path);
  return Object.freeze({
    schemaVersion: version(item.schemaVersion, `${path}/schemaVersion`) as 1,
    name: text(item.name, `${path}/name`, 'Provider name'),
    version: text(item.version, `${path}/version`, 'Provider version'),
    configDigest: digest(item.configDigest, `${path}/configDigest`),
  });
}

function validatePolicy(value: unknown, path: string): RunStoragePolicy {
  const item = record(value, path, 'Storage policy');
  exactFields(item, [
    'schemaVersion',
    'maxEventPayloadBytes',
    'maxAppendBatchBytes',
    'maxArtifactBytes',
    'maxTotalArtifactBytesPerRun',
    'retention',
    'sensitiveContent',
  ], path);

  const sensitive = record(
    item.sensitiveContent,
    `${path}/sensitiveContent`,
    'Sensitive-content policy',
  );
  exactFields(sensitive, ['marked', 'exact', 'freeText'], `${path}/sensitiveContent`);
  if (sensitive.marked !== 'reject') {
    fail(`${path}/sensitiveContent/marked`, 'Marked-sensitive content must be rejected.');
  }
  if (sensitive.exact !== 'reject') {
    fail(`${path}/sensitiveContent/exact`, 'Exact content must reject known secrets.');
  }
  if (sensitive.freeText !== 'redact-before-hash') {
    fail(`${path}/sensitiveContent/freeText`, 'Free text must redact before hashing.');
  }

  const maxEventPayloadBytes = positiveLimit(
    item.maxEventPayloadBytes,
    `${path}/maxEventPayloadBytes`,
  );
  const maxAppendBatchBytes = positiveLimit(
    item.maxAppendBatchBytes,
    `${path}/maxAppendBatchBytes`,
  );
  const maxArtifactBytes = positiveLimit(
    item.maxArtifactBytes,
    `${path}/maxArtifactBytes`,
  );
  const maxTotalArtifactBytesPerRun = positiveLimit(
    item.maxTotalArtifactBytesPerRun,
    `${path}/maxTotalArtifactBytesPerRun`,
  );
  if (maxAppendBatchBytes < maxEventPayloadBytes) {
    fail(path, 'The append-batch limit cannot be smaller than the event-payload limit.');
  }
  if (maxTotalArtifactBytesPerRun < maxArtifactBytes) {
    fail(path, 'The per-run artifact limit cannot be smaller than the single-artifact limit.');
  }
  if (item.retention !== 'until-run-delete') {
    fail(`${path}/retention`, 'D3 artifacts must be retained until their run is deleted.');
  }

  return Object.freeze({
    schemaVersion: version(item.schemaVersion, `${path}/schemaVersion`) as 1,
    maxEventPayloadBytes,
    maxAppendBatchBytes,
    maxArtifactBytes,
    maxTotalArtifactBytesPerRun,
    retention: 'until-run-delete',
    sensitiveContent: Object.freeze({
      marked: 'reject',
      exact: 'reject',
      freeText: 'redact-before-hash',
    }),
  });
}

export function validateRunStoragePolicy(value: unknown): RunStoragePolicy {
  return validatePolicy(value, '');
}

export function validateRunStorageRecord(value: unknown): RunStorageRecord {
  const item = record(value, '', 'Run storage record');
  exactFields(item, [
    'schemaVersion',
    'namespace',
    'eventStore',
    'artifactStore',
    'policy',
  ], '');

  return Object.freeze({
    schemaVersion: version(item.schemaVersion, '/schemaVersion') as 1,
    namespace: validateStorageId(item.namespace, '/namespace'),
    eventStore: validateProvider(item.eventStore, '/eventStore'),
    artifactStore: validateProvider(item.artifactStore, '/artifactStore'),
    policy: validatePolicy(item.policy, '/policy'),
  });
}

function validateCompiledDefinition(value: unknown): CompiledGraphDefinition {
  const item = record(value, '/graphDefinition', 'Compiled graph definition');
  exactFields(item, ['value', 'canonicalJson', 'digest'], '/graphDefinition');

  let rebuilt: CompiledGraphDefinition;
  try {
    rebuilt = createGraphKernel(item.value as GraphDefinition).definition;
  } catch (error) {
    fail('/graphDefinition/value', error instanceof Error ? error.message : String(error));
  }

  if (item.canonicalJson !== rebuilt.canonicalJson) {
    fail('/graphDefinition/canonicalJson', 'Graph definition bytes do not match its value.');
  }
  if (item.digest !== rebuilt.digest) {
    fail('/graphDefinition/digest', 'Graph definition digest does not match its value.');
  }
  return rebuilt;
}

function artifactReference<Purpose extends string>(
  value: unknown,
  path: string,
  purpose: Purpose,
): ArtifactReference<Purpose> {
  let reference: ArtifactReference;
  try {
    reference = validateArtifactReference(value);
  } catch (error) {
    if (!(error instanceof StorageError)) throw error;
    fail(path, error.message);
  }
  if (reference.purpose !== purpose) {
    fail(`${path}/purpose`, `Artifact purpose must be "${purpose}".`);
  }
  return reference as ArtifactReference<Purpose>;
}

export function validateRunDefinition(value: unknown): RunDefinition {
  const item = record(value, '', 'Run definition');
  exactFields(item, [
    'schemaVersion',
    'runId',
    'graphDefinition',
    'resolvedPlan',
    'resolvedInputs',
    'storage',
    'workspaceBinding',
    'hostBinding',
  ], '');

  const resolvedPlan = artifactReference(
    item.resolvedPlan,
    '/resolvedPlan',
    'resolved-plan',
  );
  if (resolvedPlan.mediaType !== 'application/json') {
    fail('/resolvedPlan/mediaType', 'The resolved plan must use application/json.');
  }

  const resolvedInputs = json(item.resolvedInputs, '/resolvedInputs');
  if (
    resolvedInputs === null
    || typeof resolvedInputs !== 'object'
    || Array.isArray(resolvedInputs)
  ) {
    fail('/resolvedInputs', 'Resolved inputs must be an object.');
  }

  const workspaceBinding = item.workspaceBinding === null
    ? null
    : record(item.workspaceBinding, '/workspaceBinding', 'Workspace binding');
  const hostBinding = item.hostBinding === null
    ? null
    : artifactReference(item.hostBinding, '/hostBinding', 'host-binding');

  return Object.freeze({
    schemaVersion: version(item.schemaVersion, '/schemaVersion') as 1,
    runId: validateStorageId(item.runId, '/runId'),
    graphDefinition: validateCompiledDefinition(item.graphDefinition),
    resolvedPlan,
    resolvedInputs: resolvedInputs as RunBrief,
    storage: validateRunStorageRecord(item.storage),
    workspaceBinding: workspaceBinding as JsonObject | null,
    hostBinding,
  });
}

export function validateRunStartRecord(value: unknown): RunStartRecord {
  const envelope = validateDomainEventEnvelope(value);
  if (envelope.type !== 'graph:run-started' || envelope.version !== 1) {
    fail('/type', 'The run-start record must be graph:run-started version 1.');
  }
  if (envelope.revision !== 1) {
    fail('/revision', 'The run-start record must be the first stream event.');
  }

  const payload = record(envelope.payload, '/payload', 'Run-start payload');
  exactFields(payload, ['definition'], '/payload');
  const definition = validateRunDefinition(payload.definition);
  if (envelope.streamId !== definition.runId) {
    fail('/streamId', 'The run-start stream must match the run id.');
  }
  if (envelope.correlationId !== definition.runId) {
    fail('/correlationId', 'The run-start correlation id must match the run id.');
  }
  if (envelope.causationId !== null) {
    fail('/causationId', 'The run-start event cannot have a cause.');
  }

  return cloneFrozenJson({
    ...envelope,
    type: 'graph:run-started',
    version: 1,
    payload: { definition },
  }) as RunStartRecord;
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
