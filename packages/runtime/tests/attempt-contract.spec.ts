import { describe, expect, it } from 'vitest';

import {
  createAttemptIdentity,
  createRepeatKey,
} from '../src/runtime/attempt.ts';

const base = {
  namespace: 'tenant-a',
  streamId: 'run-1',
  nodeId: 'review',
  position: 'items/first',
};

describe('attempt identity', () => {
  it('is stable, copied, frozen, and changes with every identity field', () => {
    const first = createAttemptIdentity(base);
    const second = createAttemptIdentity({ ...base });

    expect(first).toEqual(second);
    expect(first.attemptId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);

    for (const [field, value] of [
      ['namespace', 'tenant-b'],
      ['streamId', 'run-2'],
      ['nodeId', 'repair'],
      ['position', 'items/second'],
    ] as const) {
      expect(
        createAttemptIdentity({ ...base, [field]: value }).attemptId,
      ).not.toBe(first.attemptId);
    }
  });

  it('derives stable effect keys without exposing the raw effect id', () => {
    const { attemptId } = createAttemptIdentity(base);
    const first = createRepeatKey(attemptId, 'provider-request');

    expect(first).toBe(createRepeatKey(attemptId, 'provider-request'));
    expect(first).not.toBe(createRepeatKey(attemptId, 'provider-receipt'));
    expect(first).not.toContain('provider-request');
  });

  it('rejects unsafe storage and graph identities', () => {
    expect(() => createAttemptIdentity({ ...base, namespace: '../tenant' }))
      .toThrow();
    expect(() => createAttemptIdentity({ ...base, streamId: 'run with space' }))
      .toThrow();
    expect(() => createAttemptIdentity({ ...base, nodeId: ' review' }))
      .toThrow('nodeId');
    expect(() => createAttemptIdentity({ ...base, position: 'items\u0000first' }))
      .toThrow('position');
    expect(() => createRepeatKey(createAttemptIdentity(base).attemptId, ''))
      .toThrow('effectId');
  });
});
