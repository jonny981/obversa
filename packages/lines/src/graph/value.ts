import type { JsonObject } from '@obversa/engine';

export {
  JsonValueError,
  canonicalJson,
  cloneFrozenJson,
  digestJson,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  type Sha256Digest,
} from '@obversa/engine';

export type RunBrief = JsonObject;

export interface GraphValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
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
