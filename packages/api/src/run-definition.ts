import { compileGraphDefinition } from './graph-kernel.js';
import type { CompiledGraphDefinition, GraphDefinition, RunBrief } from './graph-contract.js';
import { cloneFrozenJson, JsonValueError, type JsonObject, type JsonValue, type Sha256Digest } from './json.js';
import { validateArtifactReference, type ArtifactReference, type ArtifactStore } from './artifacts/store.js';
import { validateDomainEventEnvelope, type DomainEventEnvelope, type NewDomainEvent } from './events/envelope.js';
import type { EventStore } from './events/store.js';
import { StorageError } from './storage/error.js';
import { validateStorageId } from './storage/id.js';

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
    rebuilt = compileGraphDefinition(item.value as GraphDefinition);
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

export const runDefinitionSupport = Object.freeze({
  fail,
  json,
  record,
  text,
  digest,
  validateCompiledDefinition,
});
