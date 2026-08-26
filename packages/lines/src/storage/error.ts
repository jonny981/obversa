import {
  cloneFrozenJson,
  type JsonObject,
} from '../graph/value.js';

export type StorageErrorCode =
  | 'INVALID_STORED_VALUE'
  | 'UNSUPPORTED_ENVELOPE_VERSION'
  | 'REVISION_CONFLICT'
  | 'DUPLICATE_EVENT_ID'
  | 'CORRUPT_EVENT_STREAM'
  | 'ARTIFACT_NOT_FOUND'
  | 'ARTIFACT_NOT_ADMITTED'
  | 'ARTIFACT_INTEGRITY'
  | 'STORAGE_LIMIT_EXCEEDED'
  | 'SENSITIVE_CONTENT'
  | 'KNOWN_SECRET'
  | 'UNSAFE_STORAGE_PATH';

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly details: JsonObject;

  constructor(
    code: StorageErrorCode,
    message: string,
    details: JsonObject = {},
  ) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.details = cloneFrozenJson(details);
  }
}
