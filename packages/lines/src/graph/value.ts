import { createHash } from 'node:crypto';

export type JsonPrimitive = null | boolean | number | string;

export type JsonObject = { readonly [key: string]: JsonValue };

export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export type RunBrief = JsonObject;

export type Sha256Digest = `sha256:${string}`;

const MAX_JSON_DEPTH = 256;

export interface GraphValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export class JsonValueError extends TypeError {
  readonly code = 'INVALID_JSON_VALUE' as const;
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`Invalid JSON value at ${path || '<root>'}: ${reason}`);
    this.name = 'JsonValueError';
    this.path = path;
  }
}

export class GraphValidationError extends Error {
  readonly issues: readonly GraphValidationIssue[];

  constructor(message: string, issues: readonly GraphValidationIssue[]) {
    super(message);
    this.name = 'GraphValidationError';
    this.issues = Object.freeze(
      issues.map((issue) => Object.freeze({ ...issue })),
    );
  }
}

function pointer(path: string, token: string | number): string {
  const escaped = String(token).replaceAll('~', '~0').replaceAll('/', '~1');
  return `${path}/${escaped}`;
}

function assertUnicode(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new JsonValueError(path, 'strings must contain valid Unicode');
      }
      index += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new JsonValueError(path, 'strings must contain valid Unicode');
    }
  }
}

function invalidType(value: unknown): string {
  if (value === undefined) return 'undefined is not JSON';
  if (typeof value === 'number') return 'numbers must be finite';
  if (typeof value !== 'object' || value === null) {
    return `${typeof value} is not JSON`;
  }
  const name = value.constructor?.name;
  return `${name ? `${name} instances` : 'this object'} are not JSON`;
}

function cloneValue(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
  depth: number,
): JsonValue {
  if (depth > MAX_JSON_DEPTH) {
    throw new JsonValueError(
      path,
      `nesting must not exceed ${MAX_JSON_DEPTH} levels`,
    );
  }

  if (value === null || typeof value === 'boolean') return value;

  if (typeof value === 'string') {
    assertUnicode(value, path);
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new JsonValueError(path, invalidType(value));
    return Object.is(value, -0) ? 0 : value;
  }

  if (typeof value !== 'object') {
    throw new JsonValueError(path, invalidType(value));
  }

  if (ancestors.has(value)) {
    throw new JsonValueError(path, 'cycles are not JSON');
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new JsonValueError(path, 'symbol keys are not JSON');
      }

      for (const key of Object.getOwnPropertyNames(value)) {
        if (key === 'length') continue;
        const index = Number(key);
        if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key) {
          throw new JsonValueError(pointer(path, key), 'array properties must be indexes');
        }
      }

      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const itemPath = pointer(path, index);
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) {
          throw new JsonValueError(itemPath, 'sparse arrays are not JSON');
        }
        if (!('value' in descriptor) || !descriptor.enumerable) {
          throw new JsonValueError(itemPath, 'array items must be enumerable data values');
        }
        result.push(cloneValue(descriptor.value, itemPath, ancestors, depth + 1));
      }
      return Object.freeze(result);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new JsonValueError(path, invalidType(value));
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new JsonValueError(path, 'symbol keys are not JSON');
    }

    const result: Record<string, JsonValue> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      const keyPath = pointer(path, key);
      assertUnicode(key, keyPath);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        throw new JsonValueError(keyPath, 'object properties must be enumerable data values');
      }
      Object.defineProperty(result, key, {
        value: cloneValue(descriptor.value, keyPath, ancestors, depth + 1),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

export function cloneFrozenJson<Value extends JsonValue>(value: Value): Value {
  return cloneValue(value, '', new WeakSet<object>(), 0) as Value;
}

function encodeCanonical(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(encodeCanonical).join(',')}]`;
  }

  const objectValue = value as JsonObject;
  return `{${Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${encodeCanonical(objectValue[key]!)}`)
    .join(',')}}`;
}

export function canonicalJson(value: JsonValue): string {
  return encodeCanonical(cloneFrozenJson(value));
}

export function digestJson(value: JsonValue): Sha256Digest {
  const digest = createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
  return `sha256:${digest}`;
}
