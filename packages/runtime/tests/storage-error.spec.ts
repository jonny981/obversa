import { describe, expect, it } from 'vitest';

import { StorageError } from '../src/storage/error.js';

describe('StorageError', () => {
  it('keeps detached, frozen JSON details', () => {
    const details = { expected: 2, actual: 3, nested: { stream: 'run-1' } };
    const error = new StorageError(
      'REVISION_CONFLICT',
      'The stream changed.',
      details,
    );

    details.nested.stream = 'changed';

    expect(error).toMatchObject({
      name: 'StorageError',
      code: 'REVISION_CONFLICT',
      message: 'The stream changed.',
      details: { expected: 2, actual: 3, nested: { stream: 'run-1' } },
    });
    expect(Object.isFrozen(error.details)).toBe(true);
    expect(Object.isFrozen(error.details.nested)).toBe(true);
  });

  it('rejects details that cannot be saved as JSON', () => {
    expect(() => new StorageError(
      'INVALID_STORED_VALUE',
      'Bad details.',
      { cause: undefined } as never,
    )).toThrow(/invalid json value/i);
  });
});
