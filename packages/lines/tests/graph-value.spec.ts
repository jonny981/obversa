import { describe, expect, it } from 'vitest';

import {
  JsonValueError,
  canonicalJson,
  cloneFrozenJson,
  digestJson,
  type JsonObject,
} from '../src/graph/value.js';

describe('graph JSON values', () => {
  it('returns a detached, deeply frozen copy', () => {
    const input: {
      label: string;
      nested: { enabled: boolean };
      items: Array<number | { name: string }>;
    } = {
      label: 'review',
      nested: { enabled: true },
      items: [1, { name: 'second' }],
    };

    const frozen = cloneFrozenJson(input);

    expect(frozen).toEqual(input);
    expect(frozen).not.toBe(input);
    expect(frozen.nested).not.toBe(input.nested);
    expect(frozen.items).not.toBe(input.items);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.nested)).toBe(false);
    expect(Object.isFrozen(input.items)).toBe(false);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.nested)).toBe(true);
    expect(Object.isFrozen(frozen.items)).toBe(true);
    expect(Object.isFrozen(frozen.items[1])).toBe(true);

    input.nested.enabled = false;
    input.items.push(3);

    expect(frozen).toEqual({
      label: 'review',
      nested: { enabled: true },
      items: [1, { name: 'second' }],
    });
  });

  it('uses stable JSON bytes and a lowercase SHA-256 digest', () => {
    const value = {
      z: [3, { 'β': 'two', a: true }],
      n: -0,
      a: null,
    } satisfies JsonObject;

    expect(canonicalJson(value)).toBe(
      '{"a":null,"n":0,"z":[3,{"a":true,"β":"two"}]}',
    );
    expect(digestJson(value)).toBe(
      'sha256:0dfb54f8c4d09d8fa8a12889ae9f6a1af7bca0ff78db5f8d5a4d7b01925e9556',
    );
  });

  it('normalizes negative zero to the value represented by its stable JSON bytes', () => {
    const frozen = cloneFrozenJson({ root: -0, nested: [-0] });

    expect(Object.is(frozen.root, -0)).toBe(false);
    expect(Object.is(frozen.nested[0], -0)).toBe(false);
    expect(frozen).toEqual({ root: 0, nested: [0] });
    expect(canonicalJson(frozen)).toBe('{"nested":[0],"root":0}');
  });

  it('accepts null-prototype records as JSON objects', () => {
    const value = Object.create(null) as Record<string, unknown>;
    value.second = 2;
    value.first = 1;

    const frozen = cloneFrozenJson(value as JsonObject);

    expect(frozen).toEqual({ first: 1, second: 2 });
    expect(Object.getPrototypeOf(frozen)).toBe(Object.prototype);
    expect(canonicalJson(frozen)).toBe('{"first":1,"second":2}');
  });

  it.each([
    ['undefined', { bad: undefined }, '/bad'],
    ['bigint', { bad: 1n }, '/bad'],
    ['symbol', { bad: Symbol('bad') }, '/bad'],
    ['function', { bad: () => undefined }, '/bad'],
    ['NaN', { bad: Number.NaN }, '/bad'],
    ['positive infinity', { bad: Number.POSITIVE_INFINITY }, '/bad'],
    ['negative infinity', { bad: Number.NEGATIVE_INFINITY }, '/bad'],
    ['Date', { bad: new Date(0) }, '/bad'],
    ['Map', { bad: new Map() }, '/bad'],
    ['Set', { bad: new Set() }, '/bad'],
    ['class instance', { bad: new (class Value {})() }, '/bad'],
    ['lone high surrogate', { bad: '\ud800' }, '/bad'],
    ['lone low surrogate', { bad: '\udfff' }, '/bad'],
  ])('rejects %s with its JSON Pointer path', (_name, input, path) => {
    expect(() => cloneFrozenJson(input as never)).toThrowError(JsonValueError);

    try {
      cloneFrozenJson(input as never);
    } catch (error) {
      expect(error).toMatchObject({
        code: 'INVALID_JSON_VALUE',
        path,
      });
      expect((error as Error).message).toMatch(
        new RegExp(`^Invalid JSON value at ${path}: `),
      );
    }
  });

  it('rejects a cycle at the reference that closes it', () => {
    const input: Record<string, unknown> = {};
    input.self = input;

    expect(() => cloneFrozenJson(input as never)).toThrowError(
      expect.objectContaining({
        code: 'INVALID_JSON_VALUE',
        path: '/self',
      }),
    );
  });

  it('rejects sparse arrays and names the missing index', () => {
    const items = new Array(2) as unknown[];
    items[1] = 'present';

    expect(() => cloneFrozenJson({ items } as never)).toThrowError(
      expect.objectContaining({
        code: 'INVALID_JSON_VALUE',
        path: '/items/0',
      }),
    );
  });

  it('rejects accessors without invoking them', () => {
    let reads = 0;
    const input = Object.defineProperty({}, 'hidden', {
      enumerable: true,
      get() {
        reads += 1;
        return 'secret';
      },
    });

    expect(() => cloneFrozenJson(input as never)).toThrowError(
      expect.objectContaining({
        code: 'INVALID_JSON_VALUE',
        path: '/hidden',
      }),
    );
    expect(reads).toBe(0);
  });

  it('rejects symbol keys and non-index array properties', () => {
    const symbolObject = { visible: true } as Record<PropertyKey, unknown>;
    symbolObject[Symbol('hidden')] = true;

    const arrayWithProperty = ['item'] as unknown[] & { hidden?: boolean };
    arrayWithProperty.hidden = true;

    expect(() => cloneFrozenJson(symbolObject as never)).toThrowError(
      expect.objectContaining({ path: '' }),
    );
    expect(() => cloneFrozenJson(arrayWithProperty as never)).toThrowError(
      expect.objectContaining({ path: '/hidden' }),
    );
  });

  it('escapes JSON Pointer tokens in errors', () => {
    expect(() =>
      cloneFrozenJson({ 'a/b~c': undefined } as never),
    ).toThrowError(
      expect.objectContaining({
        path: '/a~1b~0c',
      }),
    );
  });
});
