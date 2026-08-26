import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rm,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { StorageError } from '../storage/error.js';
import { cloneFrozenJson } from '../graph/value.js';
import type { JsonObject, JsonValue, Sha256Digest } from '../graph/value.js';
import {
  validateArtifactReference,
  validateArtifactScope,
  validateNewArtifact,
  type ArtifactReference,
  type ArtifactBatch,
  type ArtifactScope,
  type ArtifactStore,
  type NewArtifact,
} from './store.js';

export interface LocalArtifactStoreOptions {
  readonly root: string;
  readonly maxArtifactBytes?: number;
  readonly maxTotalArtifactBytesPerRun?: number;
  readonly knownSecrets?: readonly string[];
}

interface Limits {
  readonly maxArtifactBytes: number;
  readonly maxTotalArtifactBytesPerRun: number;
}

interface LedgerEntry {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly limits: Limits;
  readonly policyDigest: Sha256Digest;
  readonly reference: ArtifactReference;
  readonly checksum: Sha256Digest;
}

type NewLedgerEntry = Omit<LedgerEntry, 'checksum'>;

interface PreparedArtifact {
  readonly bytes: Uint8Array;
  readonly reference: ArtifactReference;
}

interface RunPaths {
  readonly run: string;
  readonly blobs: string;
  readonly admissions: string;
}

const DEFAULT_LIMITS: Limits = {
  maxArtifactBytes: 1_048_576,
  maxTotalArtifactBytesPerRun: 16_777_216,
};
const ADMISSION_FILE = /^(\d{16})\.json$/u;
const MAX_ADMISSION_RECORD_BYTES = 4_096;
const MAX_ADMISSION_RETRIES = 1_000;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const CONTENT_POLICY_RULES = Object.freeze({
  exact: 'reject-known-secret-bytes-v1',
  stateJson: 'parse-json-and-reject-known-secret-bytes-keys-values-v1',
  stateOther: 'reject-known-secret-bytes-v1',
  freeText: 'redact-known-secrets-then-reject-known-secret-output-v1',
});
const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

function isJsonMediaType(mediaType: string): boolean {
  const value = mediaType.toLowerCase();
  return value === 'application/json'
    || (
      value.startsWith('application/')
      && value.endsWith('+json')
      && value.length > 'application/+json'.length
    );
}

function storageError(
  code: StorageError['code'],
  message: string,
  details: JsonObject = {},
): StorageError {
  return new StorageError(code, message, details);
}

function nodeCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

function digest(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function artifactPolicyDigest(
  limits: Limits,
): Sha256Digest {
  return digest(Buffer.from(JSON.stringify({
    schemaVersion: 1,
    limits: {
      maxArtifactBytes: limits.maxArtifactBytes,
      maxTotalArtifactBytesPerRun: limits.maxTotalArtifactBytesPerRun,
    },
    contentModeRules: CONTENT_POLICY_RULES,
  }), 'utf8'));
}

function admissionChecksum(entry: NewLedgerEntry): Sha256Digest {
  return digest(Buffer.from(JSON.stringify({
    schemaVersion: entry.schemaVersion,
    revision: entry.revision,
    limits: {
      maxArtifactBytes: entry.limits.maxArtifactBytes,
      maxTotalArtifactBytesPerRun: entry.limits.maxTotalArtifactBytesPerRun,
    },
    policyDigest: entry.policyDigest,
    reference: {
      schemaVersion: entry.reference.schemaVersion,
      digest: entry.reference.digest,
      byteLength: entry.reference.byteLength,
      mediaType: entry.reference.mediaType,
      purpose: entry.reference.purpose,
    },
  }), 'utf8'));
}

function admissionRecord(entry: NewLedgerEntry): LedgerEntry {
  return Object.freeze({
    schemaVersion: 1,
    revision: entry.revision,
    limits: Object.freeze({ ...entry.limits }),
    policyDigest: entry.policyDigest,
    reference: entry.reference,
    checksum: admissionChecksum(entry),
  });
}

function containsKnownSecret(
  bytes: Uint8Array,
  knownSecrets: readonly string[],
): boolean {
  const buffer = Buffer.from(bytes);
  return knownSecrets.some((value) => buffer.includes(Buffer.from(value, 'utf8')));
}

function assertSecretFree(
  bytes: Uint8Array,
  knownSecrets: readonly string[],
  message: string,
): void {
  if (containsKnownSecret(bytes, knownSecrets)) {
    throw storageError('KNOWN_SECRET', message);
  }
}

function screenedAdmissionBytes(
  entry: NewLedgerEntry,
  knownSecrets: readonly string[],
): Buffer {
  const record = admissionRecord(entry);
  for (const value of [
    record.policyDigest,
    record.checksum,
    record.reference.digest,
    record.reference.mediaType,
    record.reference.purpose,
  ]) {
    assertSecretFree(
      Buffer.from(value, 'utf8'),
      knownSecrets,
      'Artifact admission metadata contains a known secret.',
    );
  }
  const bytes = Buffer.from(JSON.stringify(record), 'utf8');
  assertSecretFree(
    bytes,
    knownSecrets,
    'Artifact admission metadata contains a known secret.',
  );
  return bytes;
}

function jsonContainsKnownSecret(
  value: JsonValue,
  knownSecrets: readonly string[],
): boolean {
  if (typeof value === 'string') {
    return containsKnownSecret(Buffer.from(value, 'utf8'), knownSecrets);
  }
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((item) => jsonContainsKnownSecret(item, knownSecrets));
  }
  return Object.entries(value).some(([key, item]) =>
    containsKnownSecret(Buffer.from(key, 'utf8'), knownSecrets)
    || jsonContainsKnownSecret(item, knownSecrets));
}

function hashedPathPart(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validateLimits(options: LocalArtifactStoreOptions): Limits {
  const limits = {
    maxArtifactBytes: options.maxArtifactBytes ?? DEFAULT_LIMITS.maxArtifactBytes,
    maxTotalArtifactBytesPerRun:
      options.maxTotalArtifactBytesPerRun
      ?? DEFAULT_LIMITS.maxTotalArtifactBytesPerRun,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw storageError(
        'INVALID_STORED_VALUE',
        `${name} must be a positive safe integer.`,
        { path: `/${name}` },
      );
    }
  }
  if (limits.maxTotalArtifactBytesPerRun < limits.maxArtifactBytes) {
    throw storageError(
      'INVALID_STORED_VALUE',
      'The per-run artifact limit cannot be smaller than the single-artifact limit.',
      { path: '/maxTotalArtifactBytesPerRun' },
    );
  }
  return Object.freeze(limits);
}

function validateKnownSecrets(values: readonly string[] | undefined): readonly string[] {
  const result = [...new Set(values ?? [])];
  if (result.some((value) =>
    typeof value !== 'string'
    || value.length === 0
    || /[\ud800-\udfff]/u.test(value))) {
    throw storageError(
      'INVALID_STORED_VALUE',
      'Known secrets must be non-empty well-formed strings.',
      { path: '/knownSecrets' },
    );
  }
  return Object.freeze(result.sort((left, right) => right.length - left.length));
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (nodeCode(error) !== 'EEXIST') throw error;
  }
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    throw storageError('UNSAFE_STORAGE_PATH', 'Managed storage directory is unavailable.', {
      path,
      cause: nodeCode(error) ?? 'unknown',
    });
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw storageError(
      'UNSAFE_STORAGE_PATH',
      'Managed storage path must be a real directory.',
      { path },
    );
  }
}

async function existingDirectory(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw storageError(
        'UNSAFE_STORAGE_PATH',
        'Managed storage path must be a real directory.',
        { path },
      );
    }
    return true;
  } catch (error) {
    if (nodeCode(error) === 'ENOENT') return false;
    throw error;
  }
}

async function assertRegularFile(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw storageError(
        'UNSAFE_STORAGE_PATH',
        'Managed storage path must be a regular file.',
        { path },
      );
    }
    return true;
  } catch (error) {
    if (nodeCode(error) === 'ENOENT') return false;
    throw error;
  }
}

function parseAdmission(
  value: unknown,
  expectedRevision: number,
  path: string,
): LedgerEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw storageError('ARTIFACT_INTEGRITY', 'Artifact admission is not an object.', {
      path,
    });
  }
  const item = value as Record<string, unknown>;
  const fields = [
    'schemaVersion',
    'revision',
    'limits',
    'policyDigest',
    'reference',
    'checksum',
  ];
  if (
    Object.keys(item).length !== fields.length
    || fields.some((field) => !Object.hasOwn(item, field))
    || item.schemaVersion !== 1
    || item.revision !== expectedRevision
  ) {
    throw storageError('ARTIFACT_INTEGRITY', 'Artifact admission is invalid.', {
      path,
    });
  }
  if (item.limits === null || typeof item.limits !== 'object' || Array.isArray(item.limits)) {
    throw storageError('ARTIFACT_INTEGRITY', 'Artifact admission limits are invalid.', {
      path,
    });
  }
  const rawLimits = item.limits as Record<string, unknown>;
  if (
    Object.keys(rawLimits).length !== 2
    || !Number.isSafeInteger(rawLimits.maxArtifactBytes)
    || (rawLimits.maxArtifactBytes as number) < 1
    || !Number.isSafeInteger(rawLimits.maxTotalArtifactBytesPerRun)
    || (rawLimits.maxTotalArtifactBytesPerRun as number) < 1
    || (rawLimits.maxTotalArtifactBytesPerRun as number)
      < (rawLimits.maxArtifactBytes as number)
  ) {
    throw storageError('ARTIFACT_INTEGRITY', 'Artifact admission limits are invalid.', {
      path,
    });
  }
  let reference: ArtifactReference;
  try {
    reference = validateArtifactReference(item.reference);
  } catch (error) {
    throw storageError('ARTIFACT_INTEGRITY', 'Artifact admission reference is invalid.', {
      path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (typeof item.policyDigest !== 'string' || !SHA256_DIGEST.test(item.policyDigest)) {
    throw storageError(
      'ARTIFACT_INTEGRITY',
      'Artifact admission policy digest is invalid.',
      { path },
    );
  }
  const entry: NewLedgerEntry = {
    schemaVersion: 1,
    revision: expectedRevision,
    limits: {
      maxArtifactBytes: rawLimits.maxArtifactBytes as number,
      maxTotalArtifactBytesPerRun: rawLimits.maxTotalArtifactBytesPerRun as number,
    },
    policyDigest: item.policyDigest as Sha256Digest,
    reference,
  };
  if (item.checksum !== admissionChecksum(entry)) {
    throw storageError('ARTIFACT_INTEGRITY', 'Artifact admission checksum is invalid.', {
      path,
    });
  }
  return admissionRecord(entry);
}

async function readBoundedFile(
  handle: FileHandle,
  path: string,
  maxByteLength: number,
  expectedByteLength?: number,
  details: JsonObject = {},
): Promise<Buffer> {
  const before = await handle.stat();
  if (!before.isFile()) {
    throw storageError(
      'UNSAFE_STORAGE_PATH',
      'Managed storage path must be a regular file.',
      { ...details, path },
    );
  }
  if (
    !Number.isSafeInteger(before.size)
    || before.size > maxByteLength
    || (expectedByteLength !== undefined && before.size !== expectedByteLength)
  ) {
    throw storageError('ARTIFACT_INTEGRITY', 'Stored bytes have an invalid length.', {
      ...details,
      path,
      actualByteLength: before.size,
      maxByteLength,
      ...(expectedByteLength === undefined ? {} : { expectedByteLength }),
    });
  }

  const bytes = Buffer.alloc(before.size);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
    if (read.bytesRead === 0) {
      throw storageError('ARTIFACT_INTEGRITY', 'Stored bytes changed while being read.', {
        ...details,
        path,
        actualByteLength: offset,
        expectedByteLength: before.size,
      });
    }
    offset += read.bytesRead;
  }

  const extra = Buffer.allocUnsafe(1);
  const extraRead = await handle.read(extra, 0, 1, bytes.byteLength);
  const after = await handle.stat();
  if (extraRead.bytesRead !== 0 || after.size !== before.size) {
    throw storageError('ARTIFACT_INTEGRITY', 'Stored bytes changed while being read.', {
      ...details,
      path,
      actualByteLength: after.size,
      expectedByteLength: before.size,
    });
  }
  return bytes;
}

async function readAdmission(path: string, revision: number): Promise<LedgerEntry> {
  if (!(await assertRegularFile(path))) {
    throw storageError('ARTIFACT_INTEGRITY', 'Artifact admission disappeared.', { path });
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const text = (await readBoundedFile(
      handle,
      path,
      MAX_ADMISSION_RECORD_BYTES,
    )).toString('utf8');
    try {
      return parseAdmission(JSON.parse(text), revision, path);
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw storageError('ARTIFACT_INTEGRITY', 'Artifact admission contains invalid JSON.', {
        path,
      });
    }
  } catch (error) {
    if (nodeCode(error) === 'ELOOP') {
      throw storageError('UNSAFE_STORAGE_PATH', 'Artifact admission is a symlink.', { path });
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readAdmissions(directory: string): Promise<readonly LedgerEntry[]> {
  const records: { readonly path: string; readonly revision: number }[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw storageError(
        'UNSAFE_STORAGE_PATH',
        'Artifact admission path must be a regular file.',
        { path },
      );
    }
    if (entry.name.startsWith('.tmp-')) continue;
    const match = ADMISSION_FILE.exec(entry.name);
    const revision = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw storageError('ARTIFACT_INTEGRITY', 'Artifact admission filename is invalid.', {
        path,
      });
    }
    records.push({ path, revision });
  }
  records.sort((left, right) => left.revision - right.revision);

  const result: LedgerEntry[] = [];
  for (const [index, record] of records.entries()) {
    const expectedRevision = index + 1;
    if (record.revision !== expectedRevision) {
      throw storageError('ARTIFACT_INTEGRITY', 'Artifact admission revisions are not contiguous.', {
        expectedRevision,
        actualRevision: record.revision,
      });
    }
    result.push(await readAdmission(record.path, expectedRevision));
  }
  return result;
}

function admissionFilename(revision: number): string {
  return `${String(revision).padStart(16, '0')}.json`;
}

async function commitAdmission(
  directory: string,
  entry: NewLedgerEntry,
  knownSecrets: readonly string[],
): Promise<'committed' | 'conflict'> {
  const temporary = join(directory, `.tmp-${randomUUID()}`);
  const destination = join(directory, admissionFilename(entry.revision));
  const bytes = screenedAdmissionBytes(entry, knownSecrets);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_WRONLY
        | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o400);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, destination);
      return 'committed';
    } catch (error) {
      if (nodeCode(error) === 'EEXIST') return 'conflict';
      throw error;
    }
  } finally {
    await handle?.close();
    await unlink(temporary).catch((error) => {
      if (nodeCode(error) !== 'ENOENT') throw error;
    });
  }
}

async function readBlob(path: string, reference: ArtifactReference): Promise<Uint8Array> {
  if (!(await assertRegularFile(path))) {
    throw storageError('ARTIFACT_NOT_FOUND', 'Admitted artifact bytes are missing.', {
      digest: reference.digest,
    });
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const bytes = await readBoundedFile(
      handle,
      path,
      reference.byteLength,
      reference.byteLength,
      { digest: reference.digest },
    );
    if (digest(bytes) !== reference.digest) {
      throw storageError('ARTIFACT_INTEGRITY', 'Artifact bytes do not match their reference.', {
        digest: reference.digest,
      });
    }
    return Uint8Array.from(bytes);
  } finally {
    await handle?.close();
  }
}

async function commitBlob(
  directory: string,
  reference: ArtifactReference,
  bytes: Uint8Array,
): Promise<void> {
  const path = join(directory, reference.digest.slice('sha256:'.length));
  if (await assertRegularFile(path)) {
    await readBlob(path, reference);
    return;
  }

  const temporary = join(directory, `.tmp-${randomUUID()}`);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_WRONLY
        | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o400);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, path);
    } catch (error) {
      if (nodeCode(error) !== 'EEXIST') throw error;
      await readBlob(path, reference);
    }
  } finally {
    await handle?.close();
    await unlink(temporary).catch((error) => {
      if (nodeCode(error) !== 'ENOENT') throw error;
    });
  }
}

async function assertTreeHasNoSymlink(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    const stat = await lstat(child);
    if (stat.isSymbolicLink()) {
      throw storageError('UNSAFE_STORAGE_PATH', 'Managed storage contains a symlink.', {
        path: child,
      });
    }
    if (stat.isDirectory()) await assertTreeHasNoSymlink(child);
  }
}

class LocalArtifactStore implements ArtifactStore {
  readonly #root: string;
  readonly #limits: Limits;
  readonly #knownSecrets: readonly string[];
  readonly #policyDigest: Sha256Digest;

  constructor(options: LocalArtifactStoreOptions) {
    if (typeof options.root !== 'string' || options.root.trim() === '') {
      throw storageError('INVALID_STORED_VALUE', 'Artifact store root must be a path.', {
        path: '/root',
      });
    }
    this.#root = resolve(options.root);
    this.#limits = validateLimits(options);
    this.#knownSecrets = validateKnownSecrets(options.knownSecrets);
    this.#policyDigest = artifactPolicyDigest(this.#limits);
  }

  async preflightWrite(
    scopeValue: ArtifactScope,
    artifactValues: ArtifactBatch,
  ): Promise<readonly ArtifactReference[]> {
    const scope = validateArtifactScope(scopeValue);
    if (!Array.isArray(artifactValues) || artifactValues.length === 0) {
      throw storageError(
        'INVALID_STORED_VALUE',
        'Artifact preflight requires a non-empty array.',
        { path: '/artifacts' },
      );
    }
    const prepared = artifactValues.map((artifact) => this.#prepareArtifact(artifact));
    const paths = await this.#paths(scope, false);
    const entries = paths ? await readAdmissions(paths.admissions) : [];
    this.#assertAdmissionPolicy(entries);

    if (paths) {
      const verified = new Set<Sha256Digest>();
      for (const item of prepared) {
        if (verified.has(item.reference.digest)) continue;
        verified.add(item.reference.digest);
        if (await assertRegularFile(this.#blobPath(paths, item.reference))) {
          await readBlob(this.#blobPath(paths, item.reference), item.reference);
        }
      }
    }
    return this.#simulateAdmissions(entries, prepared);
  }

  async write(scopeValue: ArtifactScope, artifactValue: NewArtifact): Promise<ArtifactReference> {
    const scope = validateArtifactScope(scopeValue);
    const prepared = this.#prepareArtifact(artifactValue);
    const { bytes, reference } = prepared;
    const paths = await this.#paths(scope, true);
    const initialEntries = await readAdmissions(paths.admissions);
    this.#assertAdmissionPolicy(initialEntries);
    if (initialEntries.some((entry) =>
      isDeepStrictEqual(entry.reference, reference))) {
      await readBlob(this.#blobPath(paths, reference), reference);
      return reference;
    }

    // Screen the exact first candidate before any bytes are committed. A
    // concurrent admission can change its revision, so every retry screens its
    // newly encoded candidate again below.
    this.#assertAdmissionSafe(this.#newAdmission(reference, initialEntries.length + 1));

    // Commit bytes before their admission. A crash can leave an orphan, but an
    // orphan cannot be read through this store.
    await commitBlob(paths.blobs, reference, bytes);

    for (let attempt = 0; attempt < MAX_ADMISSION_RETRIES; attempt += 1) {
      const entries = await readAdmissions(paths.admissions);
      this.#assertAdmissionPolicy(entries);
      if (entries.some((entry) => isDeepStrictEqual(entry.reference, reference))) {
        await readBlob(this.#blobPath(paths, reference), reference);
        return reference;
      }

      const entry = this.#newAdmission(reference, entries.length + 1);
      this.#assertAdmissionSafe(entry);
      this.#assertQuota(entries, reference);
      const result = await commitAdmission(paths.admissions, entry, this.#knownSecrets);
      if (result === 'committed') return reference;
      // Another writer won this revision. Re-read all immutable records before
      // calculating the quota and next revision again.
    }
    throw storageError(
      'REVISION_CONFLICT',
      'Artifact admission changed too often to complete this write.',
    );
  }

  async read(scopeValue: ArtifactScope, referenceValue: ArtifactReference): Promise<Uint8Array> {
    const scope = validateArtifactScope(scopeValue);
    const reference = validateArtifactReference(referenceValue);
    const paths = await this.#paths(scope, false);
    if (!paths) {
      throw storageError('ARTIFACT_NOT_ADMITTED', 'Artifact is not admitted for this run.', {
        digest: reference.digest,
      });
    }

    const entries = await readAdmissions(paths.admissions);
    this.#assertAdmissionPolicy(entries);
    if (!entries.some((entry) => isDeepStrictEqual(entry.reference, reference))) {
      throw storageError('ARTIFACT_NOT_ADMITTED', 'Artifact is not admitted for this run.', {
        digest: reference.digest,
      });
    }
    return readBlob(this.#blobPath(paths, reference), reference);
  }

  async deleteRun(scopeValue: ArtifactScope): Promise<void> {
    const scope = validateArtifactScope(scopeValue);
    const paths = await this.#paths(scope, false);
    if (!paths) return;
    await assertTreeHasNoSymlink(paths.run);
    await rm(paths.run, { recursive: true });
  }

  #safeBytes(artifact: NewArtifact): Uint8Array {
    const source = Uint8Array.from(artifact.bytes);
    if (artifact.contentMode === 'exact') {
      assertSecretFree(
        source,
        this.#knownSecrets,
        'Exact artifact bytes contain a known secret.',
      );
      return source;
    }

    if (artifact.contentMode === 'state') {
      assertSecretFree(
        source,
        this.#knownSecrets,
        'State artifact bytes contain a known secret.',
      );
      if (!isJsonMediaType(artifact.mediaType)) return source;

      let parsed: JsonValue;
      try {
        const text = decoder.decode(source);
        parsed = cloneFrozenJson(JSON.parse(text) as JsonValue);
      } catch {
        throw storageError(
          'INVALID_STORED_VALUE',
          'JSON state artifact bytes must contain strict JSON encoded as UTF-8.',
          { path: '/bytes' },
        );
      }
      if (jsonContainsKnownSecret(parsed, this.#knownSecrets)) {
        throw storageError(
          'KNOWN_SECRET',
          'JSON state contains a known secret in a key or value.',
        );
      }
      return source;
    }

    let text: string;
    try {
      text = decoder.decode(source);
    } catch {
      throw storageError(
        'INVALID_STORED_VALUE',
        'Free-text artifact bytes must contain valid UTF-8.',
        { path: '/bytes' },
      );
    }
    for (const value of this.#knownSecrets) text = text.split(value).join('[redacted]');
    const redacted = encoder.encode(text);
    assertSecretFree(
      redacted,
      this.#knownSecrets,
      'Redacted free text still contains a known secret.',
    );
    return redacted;
  }

  #prepareArtifact(artifactValue: NewArtifact): PreparedArtifact {
    const artifact = validateNewArtifact(artifactValue);
    if (artifact.sensitive) {
      throw storageError('SENSITIVE_CONTENT', 'Marked-sensitive content cannot be stored.');
    }

    const bytes = this.#safeBytes(artifact);
    if (bytes.byteLength > this.#limits.maxArtifactBytes) {
      throw storageError('STORAGE_LIMIT_EXCEEDED', 'Artifact exceeds the single-artifact limit.', {
        byteLength: bytes.byteLength,
        maxArtifactBytes: this.#limits.maxArtifactBytes,
      });
    }
    const reference = Object.freeze({
      schemaVersion: 1 as const,
      digest: digest(bytes),
      byteLength: bytes.byteLength,
      mediaType: artifact.mediaType,
      purpose: artifact.purpose,
    });
    return Object.freeze({ bytes, reference });
  }

  #newAdmission(reference: ArtifactReference, revision: number): NewLedgerEntry {
    return Object.freeze({
      schemaVersion: 1,
      revision,
      limits: this.#limits,
      policyDigest: this.#policyDigest,
      reference,
    });
  }

  #assertAdmissionSafe(entry: NewLedgerEntry): void {
    screenedAdmissionBytes(entry, this.#knownSecrets);
  }

  #assertQuota(
    entries: readonly LedgerEntry[],
    reference: ArtifactReference,
  ): void {
    const unique = new Map<string, number>();
    for (const entry of entries) {
      unique.set(entry.reference.digest, entry.reference.byteLength);
    }
    const total = [...unique.values()].reduce((sum, size) => sum + size, 0);
    if (
      !unique.has(reference.digest)
      && total + reference.byteLength > this.#limits.maxTotalArtifactBytesPerRun
    ) {
      throw storageError('STORAGE_LIMIT_EXCEEDED', 'Artifact exceeds the per-run storage limit.', {
        byteLength: reference.byteLength,
        admittedBytes: total,
        maxTotalArtifactBytesPerRun: this.#limits.maxTotalArtifactBytesPerRun,
      });
    }
  }

  #simulateAdmissions(
    entries: readonly LedgerEntry[],
    artifacts: readonly PreparedArtifact[],
  ): readonly ArtifactReference[] {
    const simulated = [...entries];
    const unique = new Map<string, number>();
    for (const entry of entries) {
      unique.set(entry.reference.digest, entry.reference.byteLength);
    }
    let total = [...unique.values()].reduce((sum, size) => sum + size, 0);
    const references: ArtifactReference[] = [];

    for (const artifact of artifacts) {
      const { reference } = artifact;
      references.push(reference);
      if (simulated.some((entry) => isDeepStrictEqual(entry.reference, reference))) continue;

      const entry = this.#newAdmission(reference, simulated.length + 1);
      this.#assertAdmissionSafe(entry);
      if (
        !unique.has(reference.digest)
        && total + reference.byteLength > this.#limits.maxTotalArtifactBytesPerRun
      ) {
        throw storageError(
          'STORAGE_LIMIT_EXCEEDED',
          'Artifact batch exceeds the per-run storage limit.',
          {
            byteLength: reference.byteLength,
            admittedBytes: total,
            maxTotalArtifactBytesPerRun: this.#limits.maxTotalArtifactBytesPerRun,
          },
        );
      }
      if (!unique.has(reference.digest)) {
        unique.set(reference.digest, reference.byteLength);
        total += reference.byteLength;
      }
      simulated.push(admissionRecord(entry));
    }

    return Object.freeze(references);
  }

  #assertAdmissionIntegrity(entries: readonly LedgerEntry[]): void {
    const first = entries[0];
    if (entries.some((entry) =>
      !isDeepStrictEqual(entry.limits, first?.limits)
      || entry.policyDigest !== first?.policyDigest)) {
      throw storageError('ARTIFACT_INTEGRITY', 'Artifact admissions change the run policy.');
    }
  }

  #assertAdmissionPolicy(entries: readonly LedgerEntry[]): void {
    this.#assertAdmissionIntegrity(entries);
    const first = entries[0];
    if (first && !isDeepStrictEqual(first.limits, this.#limits)) {
      throw storageError(
        'INVALID_STORED_VALUE',
        'Artifact-store limits do not match the run admissions.',
      );
    }
    if (first && first.policyDigest !== this.#policyDigest) {
      throw storageError(
        'INVALID_STORED_VALUE',
        'Artifact-store behavior does not match the run admissions.',
      );
    }
  }

  #blobPath(paths: RunPaths, reference: ArtifactReference): string {
    return join(paths.blobs, reference.digest.slice('sha256:'.length));
  }

  async #paths(scope: ArtifactScope, create: true): Promise<RunPaths>;
  async #paths(scope: ArtifactScope, create: false): Promise<RunPaths | undefined>;
  async #paths(scope: ArtifactScope, create: boolean): Promise<RunPaths | undefined> {
    if (create) await mkdir(this.#root, { recursive: true, mode: 0o700 });
    if (!(await existingDirectory(this.#root))) return undefined;
    const namespaces = join(this.#root, 'namespaces');
    const namespace = join(namespaces, hashedPathPart(scope.namespace));
    const runs = join(namespace, 'runs');
    const run = join(runs, hashedPathPart(scope.runId));
    const blobs = join(run, 'blobs');
    const admissions = join(run, 'admissions');
    for (const path of [namespaces, namespace, runs, run, blobs, admissions]) {
      if (create) await ensureDirectory(path);
      else if (!(await existingDirectory(path))) return undefined;
    }
    return {
      run,
      blobs,
      admissions,
    };
  }
}

export function createLocalArtifactStore(
  options: LocalArtifactStoreOptions,
): ArtifactStore {
  return new LocalArtifactStore(options);
}
