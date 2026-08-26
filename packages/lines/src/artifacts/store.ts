import { Buffer } from 'node:buffer';

import { StorageError } from '../storage/error.js';
import { validateStorageId } from '../storage/id.js';
import type { JsonObject, Sha256Digest } from '../graph/value.js';

export type ArtifactContentMode = 'exact' | 'state' | 'free-text';

export interface ArtifactScope {
  readonly namespace: string;
  readonly runId: string;
}

export interface NewArtifact {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly purpose: string;
  readonly contentMode: ArtifactContentMode;
  readonly sensitive?: boolean;
}

export type ArtifactBatch = readonly [NewArtifact, ...NewArtifact[]];

export interface ArtifactReference<Purpose extends string = string> extends JsonObject {
  readonly schemaVersion: 1;
  readonly digest: Sha256Digest;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly purpose: Purpose;
}

export interface ArtifactStore {
  preflightWrite(
    scope: ArtifactScope,
    artifacts: ArtifactBatch,
  ): Promise<readonly ArtifactReference[]>;
  write(scope: ArtifactScope, artifact: NewArtifact): Promise<ArtifactReference>;
  read(scope: ArtifactScope, reference: ArtifactReference): Promise<Uint8Array>;
  deleteRun(scope: ArtifactScope): Promise<void>;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const CONTENT_MODES = new Set<ArtifactContentMode>(['exact', 'state', 'free-text']);

function fail(path: string, message: string): never {
  throw new StorageError('INVALID_STORED_VALUE', message, { path });
}

function record(value: unknown, path: string, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  for (const field of required) {
    if (!Object.hasOwn(value, field)) {
      fail(`${path}/${field}`, `Required field "${field}" is missing.`);
    }
  }
  const allowed = new Set([...required, ...optional]);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      fail(`${path}/${field}`, `Unknown field "${field}" is not allowed.`);
    }
  }
}

function text(value: unknown, path: string, label: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || CONTROL_CHARACTER.test(value)
  ) {
    fail(path, `${label} must be a non-empty trimmed string without control characters.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        fail(path, `${label} must contain valid Unicode.`);
      }
      index += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail(path, `${label} must contain valid Unicode.`);
    }
  }
  return value;
}

function boundedText(
  value: unknown,
  path: string,
  label: string,
  maxBytes: number,
): string {
  const result = text(value, path, label);
  if (Buffer.byteLength(result, 'utf8') > maxBytes) {
    fail(path, `${label} must not exceed ${maxBytes} UTF-8 bytes.`);
  }
  return result;
}

function mediaType(value: unknown, path: string): string {
  const result = boundedText(value, path, 'Media type', 255);
  if (!MEDIA_TYPE.test(result)) fail(path, 'Media type must be a type/subtype value.');
  return result;
}

export function validateArtifactScope(value: unknown): ArtifactScope {
  const item = record(value, '', 'Artifact scope');
  exactFields(item, ['namespace', 'runId'], [], '');
  return Object.freeze({
    namespace: validateStorageId(item.namespace, '/namespace'),
    runId: validateStorageId(item.runId, '/runId'),
  });
}

export function validateNewArtifact(value: unknown): NewArtifact {
  const item = record(value, '', 'New artifact');
  exactFields(
    item,
    ['bytes', 'mediaType', 'purpose', 'contentMode'],
    ['sensitive'],
    '',
  );
  if (!(item.bytes instanceof Uint8Array)) {
    fail('/bytes', 'Artifact bytes must be a Uint8Array.');
  }
  if (!CONTENT_MODES.has(item.contentMode as ArtifactContentMode)) {
    fail('/contentMode', 'Content mode must be exact, state, or free-text.');
  }
  if (item.sensitive !== undefined && typeof item.sensitive !== 'boolean') {
    fail('/sensitive', 'Sensitive must be a boolean when supplied.');
  }

  return Object.freeze({
    bytes: Uint8Array.from(item.bytes),
    mediaType: mediaType(item.mediaType, '/mediaType'),
    purpose: boundedText(item.purpose, '/purpose', 'Purpose', 512),
    contentMode: item.contentMode as ArtifactContentMode,
    ...(item.sensitive === undefined ? {} : { sensitive: item.sensitive }),
  });
}

export function validateArtifactReference(value: unknown): ArtifactReference {
  const item = record(value, '', 'Artifact reference');
  exactFields(
    item,
    ['schemaVersion', 'digest', 'byteLength', 'mediaType', 'purpose'],
    [],
    '',
  );
  if (item.schemaVersion !== 1) {
    fail('/schemaVersion', 'Artifact reference schemaVersion must be 1.');
  }
  if (typeof item.digest !== 'string' || !DIGEST.test(item.digest)) {
    fail('/digest', 'Digest must be lowercase sha256 followed by 64 hexadecimal characters.');
  }
  if (!Number.isSafeInteger(item.byteLength) || (item.byteLength as number) < 0) {
    fail('/byteLength', 'Byte length must be a non-negative safe integer.');
  }

  return Object.freeze({
    schemaVersion: 1,
    digest: item.digest as Sha256Digest,
    byteLength: item.byteLength as number,
    mediaType: mediaType(item.mediaType, '/mediaType'),
    purpose: boundedText(item.purpose, '/purpose', 'Purpose', 512),
  });
}
