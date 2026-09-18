import { validateArtifactReference } from '../artifacts/store.js';
import type { NewDomainEvent } from '../events/envelope.js';
import { cloneFrozenJson, digestJson, type JsonObject, type JsonValue, type Sha256Digest } from '../json.js';
import type { WorkspaceAnchor } from '../workspace/provider.js';
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

export const acceptedResultSupport = Object.freeze({
  isObject,
  hasExactFields,
  bindingFrom,
  acceptedResultMatchesBinding,
});
