import {
  cloneFrozenJson,
  JsonValueError,
  type JsonObject,
  type JsonValue,
} from '../graph/value.js';
import { StorageError } from '../storage/error.js';
import {
  validateNewDomainEvent,
  type DomainEventEnvelope,
  type EventStreamRef,
  type NewDomainEvent,
  type StreamRevision,
} from './envelope.js';

export type DomainEventBatch = readonly [
  NewDomainEvent,
  ...NewDomainEvent[],
];

export interface EventStore {
  preflightAppend(
    stream: EventStreamRef,
    expectedRevision: StreamRevision,
    events: DomainEventBatch,
  ): Promise<void>;

  read(
    stream: EventStreamRef,
    afterRevision?: StreamRevision,
  ): AsyncIterable<DomainEventEnvelope>;

  append(
    stream: EventStreamRef,
    expectedRevision: StreamRevision,
    events: DomainEventBatch,
  ): Promise<StreamRevision>;
}

const SAFE_STORAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function fail(message: string, path: string): never {
  throw new StorageError('INVALID_STORED_VALUE', message, { path });
}

export function validateStorageId(value: unknown, path: string): string {
  if (typeof value !== 'string' || !SAFE_STORAGE_ID.test(value)) {
    fail(
      'Storage id must use 1 to 128 ASCII letters, digits, dots, underscores, or hyphens.',
      path,
    );
  }
  return value;
}

export function validateEventStreamRef(value: unknown): EventStreamRef {
  let safe: JsonValue;
  try {
    safe = cloneFrozenJson(value as JsonValue);
  } catch (error) {
    if (!(error instanceof JsonValueError)) throw error;
    fail(error.message, error.path);
  }
  if (safe === null || typeof safe !== 'object' || Array.isArray(safe)) {
    fail('Event stream reference must be an object.', '');
  }
  const record = safe as JsonObject;
  const fields = Object.keys(record).sort();
  if (
    fields.length !== 2
    || fields[0] !== 'namespace'
    || fields[1] !== 'streamId'
  ) {
    fail(
      'Event stream reference must contain exactly namespace and streamId.',
      '',
    );
  }
  validateStorageId(record.namespace, '/namespace');
  validateStorageId(record.streamId, '/streamId');
  return record as unknown as EventStreamRef;
}

export function validateStreamRevision(
  value: unknown,
  path: string,
): StreamRevision {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('Stream revision must be a non-negative safe integer.', path);
  }
  return value;
}

export function validateDomainEventBatch(value: unknown): DomainEventBatch {
  let safe: JsonValue;
  try {
    safe = cloneFrozenJson(value as JsonValue);
  } catch (error) {
    if (!(error instanceof JsonValueError)) throw error;
    fail(error.message, `/events${error.path}`);
  }
  if (!Array.isArray(safe) || safe.length === 0) {
    fail('An append batch must contain at least one event.', '/events');
  }
  const events = safe.map((event) => validateNewDomainEvent(event));
  return Object.freeze(events) as unknown as DomainEventBatch;
}

function jsonContains(value: JsonValue, needle: string): boolean {
  if (typeof value === 'string') return value.includes(needle);
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((item) => jsonContains(item, needle));
  }
  return Object.entries(value).some(([key, item]) => (
    key.includes(needle) || jsonContains(item, needle)
  ));
}

export function findKnownSecretInEvents(
  knownSecrets: readonly string[],
  serializedBytes: string,
  events: readonly NewDomainEvent[],
): string | undefined {
  return knownSecrets.find((secret) => (
    serializedBytes.includes(secret)
    || events.some((event) => jsonContains(event as unknown as JsonValue, secret))
  ));
}
