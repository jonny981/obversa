import {
  cloneFrozenJson,
  digestJson,
  type JsonObject,
  type JsonValue,
  type Sha256Digest,
} from '../graph/value.js';

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

export interface ResultContractRecord extends JsonObject {
  readonly name: string;
  readonly version: number;
  readonly schemaDigest: Sha256Digest;
}

export interface ResultContract<
  Schema extends JsonValue = JsonValue,
  Result extends JsonValue = JsonValue,
> {
  readonly record: ResultContractRecord;
  readonly schema: Schema;
  validate(value: unknown): Result;
}

export interface ResultContractDefinition<
  Schema extends JsonValue,
  Result extends JsonValue,
> {
  readonly record: ResultContractRecord;
  readonly schema: Schema;
  readonly validate: (value: unknown) => Result;
}

function name(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new TypeError(
      'result contract name must be a non-empty trimmed string without control characters',
    );
  }
  cloneFrozenJson(value);
  return value;
}

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError('result contract version must be a positive safe integer');
  }
  return value as number;
}

function schemaDigest(value: unknown): Sha256Digest {
  if (typeof value !== 'string' || !SHA256_DIGEST.test(value)) {
    throw new TypeError(
      'result contract schemaDigest must be a lowercase SHA-256 digest',
    );
  }
  return value as Sha256Digest;
}

export function defineResultContract<
  Schema extends JsonValue,
  Result extends JsonValue,
>(
  definition: ResultContractDefinition<Schema, Result>,
): ResultContract<Schema, Result> {
  const schema = cloneFrozenJson(definition.schema);
  const record = cloneFrozenJson({
    name: name(definition.record.name),
    version: version(definition.record.version),
    schemaDigest: schemaDigest(definition.record.schemaDigest),
  } as const);

  if (record.schemaDigest !== digestJson(schema)) {
    throw new TypeError(
      'result contract schemaDigest does not match the supplied schema',
    );
  }
  if (typeof definition.validate !== 'function') {
    throw new TypeError('result contract validate must be a function');
  }

  return Object.freeze({
    record,
    schema,
    validate(value: unknown): Result {
      const input = cloneFrozenJson(value as JsonValue);
      return cloneFrozenJson(definition.validate(input));
    },
  });
}
