import { describe, expect, it } from 'vitest';

import {
  validateDomainEventEnvelope,
  validateNewDomainEvent,
} from '../src/events/envelope.js';
import { StorageError } from '../src/storage/error.js';

function newEvent() {
  return {
    eventId: 'event-1',
    type: 'example:recorded',
    version: 1,
    timestamp: '2026-08-26T04:00:00.000Z',
    correlationId: 'run-1',
    causationId: null,
    payload: {
      extension: {
        preserved: true,
      },
    },
  };
}

function envelope() {
  return {
    envelopeVersion: 1,
    streamId: 'run-1',
    revision: 1,
    ...newEvent(),
  };
}

describe('new domain events', () => {
  it('preserves graph-owned payload fields in a detached frozen value', () => {
    const source = newEvent();
    const result = validateNewDomainEvent(source);

    source.payload.extension.preserved = false;

    expect(result.payload).toEqual({
      extension: {
        preserved: true,
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.payload)).toBe(true);
    expect(Object.isFrozen(
      (result.payload as { extension: object }).extension,
    )).toBe(true);
  });

  it('rejects unknown runtime-owned fields', () => {
    expect(() => validateNewDomainEvent({
      ...newEvent(),
      extra: true,
    })).toThrowError(expect.objectContaining({
      name: 'StorageError',
      code: 'INVALID_STORED_VALUE',
    }));
  });

  it.each([
    ['empty event id', { ...newEvent(), eventId: '' }],
    ['invalid event version', { ...newEvent(), version: 0 }],
    ['non-canonical timestamp', {
      ...newEvent(),
      timestamp: '2026-08-26T04:00:00Z',
    }],
    ['invalid causation id', { ...newEvent(), causationId: ' bad ' }],
    ['non-json payload', { ...newEvent(), payload: { value: undefined } }],
  ])('rejects %s with a typed error', (_name, value) => {
    expect(() => validateNewDomainEvent(value)).toThrowError(StorageError);
  });
});

describe('domain event envelopes', () => {
  it('accepts the exact versioned envelope shape', () => {
    expect(validateDomainEventEnvelope(envelope())).toEqual(envelope());
  });

  it.each([
    ['unknown envelope field', { ...envelope(), extra: true }],
    ['unsupported envelope version', { ...envelope(), envelopeVersion: 2 }],
    ['zero revision', { ...envelope(), revision: 0 }],
    ['unsafe stream id', { ...envelope(), streamId: '../run-1' }],
  ])('rejects %s', (_name, value) => {
    expect(() => validateDomainEventEnvelope(value)).toThrowError(StorageError);
  });

  it('uses a distinct code for an unsupported envelope version', () => {
    expect(() => validateDomainEventEnvelope({
      ...envelope(),
      envelopeVersion: 2,
    })).toThrowError(expect.objectContaining({
      code: 'UNSUPPORTED_ENVELOPE_VERSION',
    }));
  });
});
