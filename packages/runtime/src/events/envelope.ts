import {
  cloneFrozenJson,
  JsonValueError,
  type JsonObject,
  type JsonValue,
} from '../graph/value.js';
import { StorageError } from '../storage/error.js';

export type DomainEventId = string;
export type EventStreamId = string;
export type StorageNamespace = string;
export type StreamRevision = number;

export interface EventStreamRef {
  readonly namespace: StorageNamespace;
  readonly streamId: EventStreamId;
}

export interface NewDomainEvent<
  Type extends string = string,
  Version extends number = number,
  Payload extends JsonValue = JsonValue,
> {
  readonly eventId: DomainEventId;
  readonly type: Type;
  readonly version: Version;
  readonly timestamp: string;
  readonly correlationId: string;
  readonly causationId: DomainEventId | null;
  readonly payload: Payload;
}

export interface DomainEventEnvelope<
  Type extends string = string,
  Version extends number = number,
  Payload extends JsonValue = JsonValue,
> extends NewDomainEvent<Type, Version, Payload> {
  readonly envelopeVersion: 1;
  readonly streamId: EventStreamId;
  readonly revision: StreamRevision;
}

const NEW_EVENT_FIELDS = [
  'causationId',
  'correlationId',
  'eventId',
  'payload',
  'timestamp',
  'type',
  'version',
] as const;

const ENVELOPE_FIELDS = [
  ...NEW_EVENT_FIELDS,
  'envelopeVersion',
  'revision',
  'streamId',
].sort();

const SAFE_PATH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function fail(
  message: string,
  path: string,
  code: 'INVALID_STORED_VALUE' | 'UNSUPPORTED_ENVELOPE_VERSION' = 'INVALID_STORED_VALUE',
): never {
  throw new StorageError(code, message, { path });
}

function jsonObject(value: unknown, path: string): JsonObject {
  let cloned: JsonValue;
  try {
    cloned = cloneFrozenJson(value as JsonValue);
  } catch (error) {
    if (!(error instanceof JsonValueError)) throw error;
    fail(error.message, `${path}${error.path}`);
  }
  if (cloned === null || typeof cloned !== 'object' || Array.isArray(cloned)) {
    fail('Stored event value must be an object.', path);
  }
  return cloned as JsonObject;
}

function exactFields(
  value: JsonObject,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])
  ) {
    fail(
      `Stored event must contain exactly ${expected.join(', ')}.`,
      path,
    );
  }
}

function identifier(value: JsonValue | undefined, path: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || Buffer.byteLength(value, 'utf8') > 256
    || CONTROL_CHARACTER.test(value)
  ) {
    fail(
      'Identifier must be a non-empty trimmed string of at most 256 UTF-8 bytes without control characters.',
      path,
    );
  }
  return value;
}

function positiveVersion(value: JsonValue | undefined, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    fail('Version must be a positive safe integer.', path);
  }
  return value;
}

function timestamp(value: JsonValue | undefined, path: string): string {
  if (
    typeof value !== 'string'
    || !UTC_TIMESTAMP.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    fail('Timestamp must be an exact UTC ISO 8601 timestamp.', path);
  }
  return value;
}

function validateNewEventObject(value: JsonObject): NewDomainEvent {
  identifier(value.eventId, '/eventId');
  identifier(value.type, '/type');
  positiveVersion(value.version, '/version');
  timestamp(value.timestamp, '/timestamp');
  identifier(value.correlationId, '/correlationId');
  if (value.causationId !== null) identifier(value.causationId, '/causationId');
  return value as unknown as NewDomainEvent;
}

export function validateNewDomainEvent(value: unknown): NewDomainEvent {
  const event = jsonObject(value, '');
  exactFields(event, NEW_EVENT_FIELDS, '');
  return validateNewEventObject(event);
}

export function validateDomainEventEnvelope(
  value: unknown,
): DomainEventEnvelope {
  const event = jsonObject(value, '');
  exactFields(event, ENVELOPE_FIELDS, '');
  if (event.envelopeVersion !== 1) {
    fail(
      'Envelope version is not supported.',
      '/envelopeVersion',
      'UNSUPPORTED_ENVELOPE_VERSION',
    );
  }
  if (typeof event.streamId !== 'string' || !SAFE_PATH_ID.test(event.streamId)) {
    fail(
      'Stream id must use 1 to 128 ASCII letters, digits, dots, underscores, or hyphens.',
      '/streamId',
    );
  }
  positiveVersion(event.revision, '/revision');
  validateNewEventObject(event);
  return event as unknown as DomainEventEnvelope;
}
