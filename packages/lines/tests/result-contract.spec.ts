import { describe, expect, it } from 'vitest';

import { digestJson, type JsonValue } from '../src/graph/value.ts';
import { defineResultContract } from '../src/runtime/result-contract.ts';

const schema = {
  type: 'object',
  required: ['answer'],
} as const;

function contract(validate = (value: unknown): JsonValue => value as JsonValue) {
  return defineResultContract({
    record: {
      name: 'answer',
      version: 1,
      schemaDigest: digestJson(schema),
    },
    schema,
    validate,
  });
}

describe('result contracts', () => {
  it('binds the schema digest and returns a copied frozen result', () => {
    const input = { answer: 42 };
    const result = contract().validate(input);

    input.answer = 7;
    expect(result).toEqual({ answer: 42 });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(contract().record)).toBe(true);
    expect(Object.isFrozen(contract().schema)).toBe(true);
  });

  it('rejects a record whose digest belongs to another schema', () => {
    expect(() => defineResultContract({
      record: {
        name: 'answer',
        version: 1,
        schemaDigest: digestJson({ type: 'string' }),
      },
      schema,
      validate: (value) => value as JsonValue,
    })).toThrow('schemaDigest');
  });

  it('gives validators frozen input and rejects non-JSON output', () => {
    const mutating = contract((value) => {
      (value as { answer: number }).answer = 0;
      return value as JsonValue;
    });
    expect(() => mutating.validate({ answer: 42 })).toThrow(TypeError);

    const invalid = contract(() => ({ answer: undefined }) as never);
    expect(() => invalid.validate({ answer: 42 })).toThrow('not JSON');
  });

  it('rejects unsafe names, versions, and digest syntax', () => {
    expect(() => defineResultContract({
      record: {
        name: ' answer',
        version: 0,
        schemaDigest: 'sha256:nope' as never,
      },
      schema,
      validate: (value) => value as JsonValue,
    })).toThrow();
  });
});
