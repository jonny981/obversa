import { randomUUID } from 'node:crypto';

import { validateArtifactReference } from '../artifacts/store.js';
import type {
  DomainEventEnvelope,
  NewDomainEvent,
} from '../events/envelope.js';
import {
  cloneFrozenJson,
  digestJson,
  type JsonObject,
  type JsonValue,
  type Sha256Digest,
} from '../graph/value.js';
import type { WorkspaceAnchor } from '../workspace/provider.js';
import {
  appendRunEvent,
  readRunEvents,
} from '../runtime/run-event.js';
import {
  loadRunDefinition,
  type RunStorageBinding,
} from '../runtime/run-definition.js';
import { StorageError } from '../storage/error.js';
import type { ProofArtifactReference } from './artifact.js';

export interface AcceptedResultGraph extends JsonObject {
  readonly definitionDigest: Sha256Digest;
  readonly typeVersion: number;
}

export interface AcceptedResultBindingInput {
  readonly inputHashes: Readonly<Record<string, Sha256Digest>>;
  readonly proofScope: JsonObject;
  readonly proofArtifact: ProofArtifactReference;
  readonly graph: AcceptedResultGraph;
  readonly workspaceAnchor: WorkspaceAnchor;
  readonly reviewerIdentity: JsonObject;
}

export interface AcceptedResultBinding extends JsonObject {
  readonly inputHashes: Readonly<Record<string, Sha256Digest>>;
  readonly proofScope: JsonObject;
  readonly proofArtifact: ProofArtifactReference;
  readonly graph: AcceptedResultGraph;
  readonly workspaceAnchor: WorkspaceAnchor;
  readonly reviewerIdentity: JsonObject;
  readonly reviewerFingerprint: Sha256Digest;
}

export interface AcceptedResultRecord extends JsonObject {
  readonly schemaVersion: 1;
  readonly result: JsonValue;
  readonly resultDigest: Sha256Digest;
  readonly binding: AcceptedResultBinding;
  readonly bindingDigest: Sha256Digest;
}

export interface AcceptedResultEventPayload extends JsonObject {
  readonly position: string;
  readonly record: AcceptedResultRecord;
}

export type NewAcceptedResultEvent = NewDomainEvent<
  'proof:result-accepted',
  1,
  AcceptedResultEventPayload
>;

export interface CreateAcceptedResultRecordInput extends AcceptedResultBindingInput {
  readonly result: JsonValue;
}

export type AcceptedResultResolution =
  | Readonly<{ readonly kind: 'accepted'; readonly record: AcceptedResultRecord }>
  | Readonly<{ readonly kind: 'wait'; readonly reason: string }>;

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactFields(value: JsonObject, fields: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length
    && actual.every((field, index) => field === expected[index]);
}

function isDigest(value: JsonValue | undefined): value is Sha256Digest {
  return typeof value === 'string' && SHA256_DIGEST.test(value);
}

function bindingFrom(input: AcceptedResultBindingInput): AcceptedResultBinding {
  const reviewerIdentity = cloneFrozenJson(input.reviewerIdentity) as JsonObject;
  return cloneFrozenJson({
    inputHashes: input.inputHashes,
    proofScope: input.proofScope,
    proofArtifact: input.proofArtifact,
    graph: input.graph,
    workspaceAnchor: input.workspaceAnchor,
    reviewerIdentity,
    reviewerFingerprint: digestJson(reviewerIdentity),
  }) as AcceptedResultBinding;
}

export function validateAcceptedResultRecord(value: unknown): AcceptedResultRecord {
  const record = cloneFrozenJson(value as JsonValue);
  if (!isObject(record)) {
    throw new TypeError('invalid accepted-result record');
  }
  const { binding } = record;
  if (!hasExactFields(record, [
      'schemaVersion',
      'result',
      'resultDigest',
      'binding',
      'bindingDigest',
    ])
    || record.schemaVersion !== 1
    || record.result === undefined
    || !isDigest(record.resultDigest)
    || record.resultDigest !== digestJson(record.result)
    || !isObject(binding)
    || !isDigest(record.bindingDigest)) {
    throw new TypeError('invalid accepted-result record');
  }

  if (!hasExactFields(binding, [
    'inputHashes',
    'proofScope',
    'proofArtifact',
    'graph',
    'workspaceAnchor',
    'reviewerIdentity',
    'reviewerFingerprint',
  ])
    || !isObject(binding.inputHashes)
    || Object.values(binding.inputHashes).some((hash) => !isDigest(hash))
    || !isObject(binding.proofScope)
    || !isObject(binding.proofArtifact)
    || !isObject(binding.graph)
    || !hasExactFields(binding.graph, ['definitionDigest', 'typeVersion'])
    || !isDigest(binding.graph.definitionDigest)
    || typeof binding.graph.typeVersion !== 'number'
    || !Number.isSafeInteger(binding.graph.typeVersion)
    || binding.graph.typeVersion < 1
    || !isObject(binding.workspaceAnchor)
    || !isObject(binding.reviewerIdentity)
    || !isDigest(binding.reviewerFingerprint)
    || binding.reviewerFingerprint !== digestJson(binding.reviewerIdentity)
    || record.bindingDigest !== digestJson(binding)) {
    throw new TypeError('invalid accepted-result binding');
  }
  const proofArtifact = validateArtifactReference(binding.proofArtifact);
  if (proofArtifact.purpose !== 'proof-packet') {
    throw new TypeError('accepted result needs a proof-packet artifact');
  }

  return record as AcceptedResultRecord;
}

function acceptedPayloadAt(
  events: readonly DomainEventEnvelope[],
  position: string,
): JsonObject | null | undefined {
  let payload: JsonObject | undefined;
  for (const event of events) {
    if (event.type !== 'proof:result-accepted' || event.version !== 1) continue;
    if (!isObject(event.payload) || event.payload.position !== position) continue;
    if (payload !== undefined) return null;
    payload = event.payload;
  }
  return payload;
}

function hasOneStoredDispatch(
  events: readonly DomainEventEnvelope[],
  position: string,
  nodeIds: ReadonlySet<string>,
): boolean {
  const matching = events.filter((event) => (
    event.type === 'graph:node-dispatched'
      && isObject(event.payload)
      && event.payload.position === position
  ));
  if (matching.length !== 1) return false;
  const [event] = matching;
  const payload = event?.payload;
  return event?.version === 1
    && isObject(payload)
    && hasExactFields(payload, ['nodeId', 'position'])
    && typeof payload.nodeId === 'string'
    && nodeIds.has(payload.nodeId);
}

export async function createAcceptedResultRecord(
  storage: RunStorageBinding,
  runId: string,
  position: string,
  input: CreateAcceptedResultRecordInput,
): Promise<AcceptedResultRecord> {
  if (typeof position !== 'string'
    || position.length === 0
    || position !== position.trim()
    || CONTROL_CHARACTER.test(position)) {
    throw new TypeError(
      'accepted-result position must be a non-empty trimmed string without control characters',
    );
  }
  const binding = bindingFrom(input);
  const record = validateAcceptedResultRecord({
    schemaVersion: 1,
    result: input.result,
    resultDigest: digestJson(input.result),
    binding,
    bindingDigest: digestJson(binding),
  });
  const stored = await loadRunDefinition(storage, runId);
  const storedGraph = stored.resolvedPlan.plan.graph;
  if (binding.graph.definitionDigest !== storedGraph.definitionDigest
    || binding.graph.typeVersion !== storedGraph.typeVersion) {
    throw new StorageError(
      'INVALID_STORED_VALUE',
      'The accepted result graph does not match the run plan.',
      { position },
    );
  }
  const nodeIds = new Set(stored.resolvedPlan.plan.nodes.map((node) => node.id));
  const event: NewAcceptedResultEvent = {
    eventId: randomUUID(),
    type: 'proof:result-accepted',
    version: 1,
    timestamp: new Date().toISOString(),
    correlationId: runId,
    causationId: null,
    payload: { position, record },
  };
  await appendRunEvent(storage, runId, event, (events) => {
    if (!hasOneStoredDispatch(events, position, nodeIds)) {
      throw new StorageError(
        'INVALID_STORED_VALUE',
        `Accepted result position "${position}" needs exactly one stored node dispatch.`,
        { position },
      );
    }
    const payload = acceptedPayloadAt(events, position);
    if (payload === undefined) return 'append';
    try {
      if (payload !== null
        && hasExactFields(payload, ['position', 'record'])
        && digestJson(validateAcceptedResultRecord(payload.record)) === digestJson(record)) {
        return 'already-stored';
      }
    } catch {
      // A corrupt record at this position still owns the key.
    }
    throw new StorageError(
      'REVISION_CONFLICT',
      `A different accepted result is already stored at position "${position}".`,
      { position },
    );
  });
  return record;
}

export function acceptedResultMatches(
  record: AcceptedResultRecord,
  current: AcceptedResultBindingInput,
): boolean {
  return acceptedResultMatchesBinding(record, bindingFrom(current));
}

function acceptedResultMatchesBinding(
  record: AcceptedResultRecord,
  current: AcceptedResultBinding,
): boolean {
  try {
    const stored = validateAcceptedResultRecord(record);
    return stored.bindingDigest === digestJson(current);
  } catch {
    return false;
  }
}

export async function resolveAcceptedResult(
  storage: RunStorageBinding,
  runId: string,
  position: string,
  current: AcceptedResultBindingInput,
): Promise<AcceptedResultResolution> {
  const currentBinding = bindingFrom(current);
  const stored = await loadRunDefinition(storage, runId);
  const loaded = await readRunEvents(storage, runId);
  const storedGraph = stored.resolvedPlan.plan.graph;
  const nodeIds = new Set(stored.resolvedPlan.plan.nodes.map((node) => node.id));
  const payload = acceptedPayloadAt(loaded.events, position);
  if (currentBinding.graph.definitionDigest === storedGraph.definitionDigest
    && currentBinding.graph.typeVersion === storedGraph.typeVersion
    && hasOneStoredDispatch(loaded.events, position, nodeIds)
    && payload !== undefined
    && payload !== null
    && hasExactFields(payload, ['position', 'record'])
    && acceptedResultMatchesBinding(
      payload.record as AcceptedResultRecord,
      currentBinding,
    )) {
    return Object.freeze({
      kind: 'accepted',
      record: validateAcceptedResultRecord(payload.record),
    });
  }
  return Object.freeze({
    kind: 'wait',
    reason: 'accepted result no longer matches the bytes under review',
  });
}
