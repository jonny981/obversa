import { StorageError } from './error.js';

const SAFE_STORAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** Validate one namespace, stream, or run identity used by a storage port. */
export function validateStorageId(value: unknown, path: string): string {
  if (typeof value !== 'string' || !SAFE_STORAGE_ID.test(value)) {
    throw new StorageError(
      'INVALID_STORED_VALUE',
      'Storage id must contain 1 to 128 ASCII characters, start with a letter or digit, and otherwise use only letters, digits, dots, underscores, or hyphens.',
      { path },
    );
  }
  return value;
}
