import type { JsonObject, JsonValue, Sha256Digest } from './json.js';

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
