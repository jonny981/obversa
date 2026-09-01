import {
  cloneFrozenJson,
  digestJson,
  type JsonObject,
  type Sha256Digest,
} from '../graph/value.js';
import { validateStorageId } from '../storage/id.js';

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

export type AttemptId = Sha256Digest;
export type RepeatKey = Sha256Digest;

export interface AttemptIdentityInput {
  readonly namespace: string;
  readonly streamId: string;
  readonly nodeId: string;
  readonly position: string;
}

export interface AttemptIdentity extends JsonObject {
  readonly schemaVersion: 1;
  readonly namespace: string;
  readonly streamId: string;
  readonly nodeId: string;
  readonly position: string;
  readonly attemptId: AttemptId;
}

function identityText(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new TypeError(
      `${field} must be a non-empty trimmed string without control characters`,
    );
  }
  cloneFrozenJson(value);
  return value;
}

function attemptId(value: unknown): AttemptId {
  if (typeof value !== 'string' || !SHA256_DIGEST.test(value)) {
    throw new TypeError('attemptId must be a lowercase SHA-256 digest');
  }
  return value as AttemptId;
}

export function createAttemptIdentity(
  input: AttemptIdentityInput,
): AttemptIdentity {
  const identity = cloneFrozenJson({
    schemaVersion: 1,
    namespace: validateStorageId(input.namespace, '/namespace'),
    streamId: validateStorageId(input.streamId, '/streamId'),
    nodeId: identityText(input.nodeId, 'nodeId'),
    position: identityText(input.position, 'position'),
  } as const);

  return cloneFrozenJson({
    ...identity,
    attemptId: digestJson(identity),
  });
}

export function createRepeatKey(
  ownerAttemptId: AttemptId,
  effectId: string,
): RepeatKey {
  return digestJson({
    schemaVersion: 1,
    attemptId: attemptId(ownerAttemptId),
    effectId: identityText(effectId, 'effectId'),
  });
}
