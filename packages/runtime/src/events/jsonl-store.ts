import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
} from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';

import { canonicalJson } from '../graph/value.js';
import { StorageError } from '../storage/error.js';
import {
  validateDomainEventEnvelope,
  type DomainEventEnvelope,
  type EventStreamRef,
  type NewDomainEvent,
} from './envelope.js';
import {
  findKnownSecretInEvents,
  validateDomainEventBatch,
  validateEventStreamRef,
  validateStreamRevision,
  type DomainEventBatch,
  type EventStore,
} from './store.js';

const DEFAULT_MAX_EVENT_PAYLOAD_BYTES = 256 * 1024;
const DEFAULT_MAX_APPEND_BATCH_BYTES = 1024 * 1024;
const CHECKSUM_RECORD_ALLOWANCE = 1024;
const SEGMENT_NAME = /^(\d{16})\.jsonl$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export interface LocalEventStoreOptions {
  readonly root: string;
  readonly maxEventPayloadBytes?: number;
  readonly maxAppendBatchBytes?: number;
  readonly knownSecrets?: readonly string[];
}

interface ResolvedOptions {
  readonly root: string;
  readonly maxEventPayloadBytes: number;
  readonly maxAppendBatchBytes: number;
  readonly knownSecrets: readonly string[];
}

interface StreamDirectories {
  readonly segments: string;
  readonly temporary: string;
}

interface StreamState {
  readonly events: readonly DomainEventEnvelope[];
  readonly revision: number;
  readonly segments: ReadonlyMap<number, Buffer>;
}

interface SerializedSegment {
  readonly eventBytes: Buffer;
  readonly bytes: Buffer;
}

interface PreparedAppend {
  readonly stream: EventStreamRef;
  readonly expectedRevision: number;
  readonly events: DomainEventBatch;
  readonly segment: SerializedSegment;
  readonly alreadyCommitted: boolean;
}

interface SegmentChecksum {
  readonly segmentVersion: 1;
  readonly policyDigest: string;
  readonly startRevision: number;
  readonly endRevision: number;
  readonly eventCount: number;
  readonly sha256: string;
}

function storageError(
  code: 'INVALID_STORED_VALUE'
    | 'REVISION_CONFLICT'
    | 'DUPLICATE_EVENT_ID'
    | 'CORRUPT_EVENT_STREAM'
    | 'STORAGE_LIMIT_EXCEEDED'
    | 'KNOWN_SECRET'
    | 'UNSAFE_STORAGE_PATH',
  message: string,
  details = {},
): StorageError {
  return new StorageError(code, message, details);
}

function positiveLimit(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw storageError(
      'INVALID_STORED_VALUE',
      `${name} must be a positive safe integer.`,
      { path: `/${name}` },
    );
  }
  return value;
}

function resolveOptions(options: LocalEventStoreOptions): ResolvedOptions {
  if (typeof options.root !== 'string' || options.root.trim().length === 0) {
    throw storageError(
      'INVALID_STORED_VALUE',
      'Event-store root must be a non-empty path.',
      { path: '/root' },
    );
  }
  const knownSecrets = options.knownSecrets ?? [];
  if (
    !Array.isArray(knownSecrets)
    || knownSecrets.some((secret) => typeof secret !== 'string' || secret.length === 0)
  ) {
    throw storageError(
      'INVALID_STORED_VALUE',
      'Known secrets must be non-empty strings.',
      { path: '/knownSecrets' },
    );
  }
  return Object.freeze({
    root: resolve(options.root),
    maxEventPayloadBytes: positiveLimit(
      options.maxEventPayloadBytes,
      'maxEventPayloadBytes',
      DEFAULT_MAX_EVENT_PAYLOAD_BYTES,
    ),
    maxAppendBatchBytes: positiveLimit(
      options.maxAppendBatchBytes,
      'maxAppendBatchBytes',
      DEFAULT_MAX_APPEND_BATCH_BYTES,
    ),
    knownSecrets: Object.freeze([...knownSecrets]),
  });
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

async function existingDirectory(path: string): Promise<boolean> {
  try {
    const item = await lstat(path);
    if (item.isSymbolicLink() || !item.isDirectory()) {
      throw storageError(
        'UNSAFE_STORAGE_PATH',
        'Event-store path contains a symlink or non-directory component.',
        { path },
      );
    }
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

async function createContainedDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error;
  }
  if (!await existingDirectory(path)) {
    throw storageError(
      'UNSAFE_STORAGE_PATH',
      'Event-store directory disappeared during creation.',
      { path },
    );
  }
}

async function rootDirectory(options: ResolvedOptions): Promise<string> {
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  if (!await existingDirectory(options.root)) {
    throw storageError(
      'UNSAFE_STORAGE_PATH',
      'Event-store root disappeared during creation.',
      { path: options.root },
    );
  }
  const root = await realpath(options.root);
  const item = await lstat(root);
  if (!item.isDirectory()) {
    throw storageError(
      'UNSAFE_STORAGE_PATH',
      'Event-store root is not a directory.',
      { path: options.root },
    );
  }
  return root;
}

const PATH_PARTS = ['namespaces', 'streams', 'segments'] as const;

async function ensureStreamDirectories(
  options: ResolvedOptions,
  stream: EventStreamRef,
): Promise<StreamDirectories> {
  const root = await rootDirectory(options);
  const namespaces = join(root, PATH_PARTS[0]);
  await createContainedDirectory(namespaces);
  const namespace = join(namespaces, storagePathComponent(stream.namespace));
  await createContainedDirectory(namespace);
  const streams = join(namespace, PATH_PARTS[1]);
  await createContainedDirectory(streams);
  const streamDirectory = join(streams, storagePathComponent(stream.streamId));
  await createContainedDirectory(streamDirectory);
  const segments = join(streamDirectory, PATH_PARTS[2]);
  await createContainedDirectory(segments);
  const temporary = join(streamDirectory, '.tmp');
  await createContainedDirectory(temporary);
  return { segments, temporary };
}

async function findStreamSegments(
  options: ResolvedOptions,
  stream: EventStreamRef,
): Promise<string | null> {
  if (!await existingDirectory(options.root)) return null;
  const root = await realpath(options.root);
  const parts = [
    'namespaces',
    storagePathComponent(stream.namespace),
    'streams',
    storagePathComponent(stream.streamId),
    'segments',
  ];
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (!await existingDirectory(current)) return null;
  }
  return current;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function eventPolicyDigest(options: ResolvedOptions): string {
  return sha256(Buffer.from(canonicalJson({
    schemaVersion: 1,
    maxEventPayloadBytes: options.maxEventPayloadBytes,
    maxAppendBatchBytes: options.maxAppendBatchBytes,
  }), 'utf8'));
}

function storagePathComponent(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function readBoundedFile(
  path: string,
  maximumBytes: number,
): Promise<Buffer> {
  let file;
  try {
    file = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (isNodeError(error, 'ELOOP')) {
      throw storageError(
        'UNSAFE_STORAGE_PATH',
        'Event segment cannot be a symlink.',
        { path },
      );
    }
    throw error;
  }

  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > maximumBytes) {
      throw storageError(
        'CORRUPT_EVENT_STREAM',
        'Event segment size is invalid or exceeds the configured read bound.',
        { path, byteLength: before.size, maximumBytes },
      );
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    const extraRead = await file.read(extra, 0, 1, before.size);
    const after = await file.stat();
    if (
      offset !== bytes.length
      || extraRead.bytesRead !== 0
      || after.size !== before.size
    ) {
      throw storageError(
        'CORRUPT_EVENT_STREAM',
        'Event segment changed while it was being read.',
        { path },
      );
    }
    return bytes;
  } finally {
    await file.close();
  }
}

function parseJsonLine(line: string, path: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw storageError(
      'CORRUPT_EVENT_STREAM',
      'Event segment contains invalid JSON.',
      { path },
    );
  }
}

function validateChecksum(
  value: unknown,
  path: string,
): SegmentChecksum {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw storageError(
      'CORRUPT_EVENT_STREAM',
      'Event segment checksum must be an object.',
      { path },
    );
  }
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record).sort();
  const expected = [
    'endRevision',
    'eventCount',
    'policyDigest',
    'segmentVersion',
    'sha256',
    'startRevision',
  ];
  if (
    fields.length !== expected.length
    || fields.some((field, index) => field !== expected[index])
    || record.segmentVersion !== 1
    || typeof record.startRevision !== 'number'
    || !Number.isSafeInteger(record.startRevision)
    || record.startRevision < 1
    || typeof record.endRevision !== 'number'
    || !Number.isSafeInteger(record.endRevision)
    || record.endRevision < record.startRevision
    || typeof record.eventCount !== 'number'
    || !Number.isSafeInteger(record.eventCount)
    || record.eventCount < 1
    || typeof record.policyDigest !== 'string'
    || !SHA256.test(record.policyDigest)
    || typeof record.sha256 !== 'string'
    || !SHA256.test(record.sha256)
  ) {
    throw storageError(
      'CORRUPT_EVENT_STREAM',
      'Event segment checksum record is invalid.',
      { path },
    );
  }
  return record as unknown as SegmentChecksum;
}

function parseSegment(
  options: ResolvedOptions,
  bytes: Buffer,
  path: string,
  stream: EventStreamRef,
  expectedStart: number,
): readonly DomainEventEnvelope[] {
  let text: string;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    throw storageError(
      'CORRUPT_EVENT_STREAM',
      'Event segment contains invalid UTF-8.',
      { path },
    );
  }
  if (!text.endsWith('\n')) {
    throw storageError(
      'CORRUPT_EVENT_STREAM',
      'Event segment must end with a newline.',
      { path },
    );
  }
  const lines = text.slice(0, -1).split('\n');
  if (lines.length < 2 || lines.some((line) => line.length === 0)) {
    throw storageError(
      'CORRUPT_EVENT_STREAM',
      'Event segment must contain events followed by one checksum record.',
      { path },
    );
  }
  const eventLines = lines.slice(0, -1);
  const eventBytes = Buffer.from(`${eventLines.join('\n')}\n`, 'utf8');
  const checksum = validateChecksum(
    parseJsonLine(lines.at(-1)!, `${path}#checksum`),
    `${path}#checksum`,
  );
  if (checksum.policyDigest !== eventPolicyDigest(options)) {
    throw storageError(
      'INVALID_STORED_VALUE',
      'Event-store policy does not match the committed stream.',
      { path },
    );
  }
  if (
    checksum.startRevision !== expectedStart
    || checksum.endRevision !== expectedStart + eventLines.length - 1
    || checksum.eventCount !== eventLines.length
    || checksum.sha256 !== sha256(eventBytes)
  ) {
    throw storageError(
      'CORRUPT_EVENT_STREAM',
      'Event segment checksum or revision range does not match its events.',
      { path },
    );
  }

  return Object.freeze(eventLines.map((line, index) => {
    let envelope: DomainEventEnvelope;
    try {
      envelope = validateDomainEventEnvelope(
        parseJsonLine(line, `${path}#event-${index + 1}`),
      );
    } catch (error) {
      if (error instanceof StorageError) {
        throw storageError(
          'CORRUPT_EVENT_STREAM',
          `Event segment contains an invalid envelope: ${error.message}`,
          { path, eventIndex: index },
        );
      }
      throw error;
    }
    if (
      envelope.streamId !== stream.streamId
      || envelope.revision !== expectedStart + index
    ) {
      throw storageError(
        'CORRUPT_EVENT_STREAM',
        'Event envelope does not match its stream or revision position.',
        { path, eventIndex: index },
      );
    }
    return envelope;
  }));
}

async function segmentPaths(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (!SEGMENT_NAME.test(entry.name) || !entry.isFile()) {
      throw storageError(
        entry.isSymbolicLink()
          ? 'UNSAFE_STORAGE_PATH'
          : 'CORRUPT_EVENT_STREAM',
        'Event segment directory contains an invalid entry.',
        { path: join(directory, entry.name) },
      );
    }
    names.push(entry.name);
  }
  names.sort();
  return Object.freeze(names.map((name) => join(directory, name)));
}

async function readStreamStateFromDirectory(
  options: ResolvedOptions,
  stream: EventStreamRef,
  directory: string,
): Promise<StreamState> {
  const paths = await segmentPaths(directory);
  const events: DomainEventEnvelope[] = [];
  const eventIds = new Set<string>();
  const segments = new Map<number, Buffer>();
  let nextRevision = 1;
  for (const path of paths) {
    const filename = basename(path);
    const match = SEGMENT_NAME.exec(filename);
    const namedStart = Number(match?.[1]);
    if (namedStart !== nextRevision) {
      throw storageError(
        'CORRUPT_EVENT_STREAM',
        'Event segment filenames do not form one continuous stream.',
        { path, expectedRevision: nextRevision },
      );
    }
    const bytes = await readBoundedFile(
      path,
      options.maxAppendBatchBytes + CHECKSUM_RECORD_ALLOWANCE,
    );
    const segment = parseSegment(options, bytes, path, stream, nextRevision);
    segments.set(namedStart, bytes);
    for (const event of segment) {
      if (eventIds.has(event.eventId)) {
        throw storageError(
          'CORRUPT_EVENT_STREAM',
          'Committed event stream contains a duplicate event identity.',
          { path, eventId: event.eventId },
        );
      }
      eventIds.add(event.eventId);
      events.push(event);
    }
    nextRevision += segment.length;
  }
  return Object.freeze({
    events: Object.freeze(events),
    revision: nextRevision - 1,
    segments,
  });
}

async function readStreamState(
  options: ResolvedOptions,
  stream: EventStreamRef,
): Promise<StreamState> {
  const directory = await findStreamSegments(options, stream);
  if (directory === null) {
    return { events: [], revision: 0, segments: new Map() };
  }
  return readStreamStateFromDirectory(options, stream, directory);
}

function segmentFilename(startRevision: number): string {
  return `${String(startRevision).padStart(16, '0')}.jsonl`;
}

function serializedSegment(
  options: ResolvedOptions,
  envelopes: readonly DomainEventEnvelope[],
): SerializedSegment {
  const eventBytes = Buffer.from(
    `${envelopes.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  );
  const checksum: SegmentChecksum = {
    segmentVersion: 1,
    policyDigest: eventPolicyDigest(options),
    startRevision: envelopes[0]!.revision,
    endRevision: envelopes.at(-1)!.revision,
    eventCount: envelopes.length,
    sha256: sha256(eventBytes),
  };
  return {
    eventBytes,
    bytes: Buffer.concat([
      eventBytes,
      Buffer.from(`${JSON.stringify(checksum)}\n`, 'utf8'),
    ]),
  };
}

function validateLimitsAndSecrets(
  options: ResolvedOptions,
  events: DomainEventBatch,
  segment: SerializedSegment,
): void {
  for (const event of events) {
    const byteLength = Buffer.byteLength(canonicalJson(event.payload), 'utf8');
    if (byteLength > options.maxEventPayloadBytes) {
      throw storageError(
        'STORAGE_LIMIT_EXCEEDED',
        'Event payload exceeds maxEventPayloadBytes.',
        {
          eventId: event.eventId,
          byteLength,
          maximumBytes: options.maxEventPayloadBytes,
        },
      );
    }
  }
  if (segment.eventBytes.byteLength > options.maxAppendBatchBytes) {
    throw storageError(
      'STORAGE_LIMIT_EXCEEDED',
      'Event append exceeds maxAppendBatchBytes.',
      {
        byteLength: segment.eventBytes.byteLength,
        maximumBytes: options.maxAppendBatchBytes,
      },
    );
  }
  const exactBytes = segment.bytes.toString('utf8');
  const secret = findKnownSecretInEvents(
    options.knownSecrets,
    exactBytes,
    events,
  );
  if (secret !== undefined) {
    throw storageError(
      'KNOWN_SECRET',
      'Exact event bytes contain a configured known secret.',
      { eventIds: events.map((event) => event.eventId) },
    );
  }
}

function hasExactCommittedAppend(
  state: StreamState,
  expectedRevision: number,
  segment: SerializedSegment,
  eventCount: number,
): boolean {
  if (state.revision < expectedRevision + eventCount) return false;
  return state.segments.get(expectedRevision + 1)?.equals(segment.bytes)
    ?? false;
}

async function prepareAppend(
  options: ResolvedOptions,
  unsafeStream: EventStreamRef,
  unsafeExpectedRevision: number,
  unsafeEvents: DomainEventBatch,
  allowCommittedRetry = false,
): Promise<PreparedAppend> {
  const stream = validateEventStreamRef(unsafeStream);
  const expectedRevision = validateStreamRevision(
    unsafeExpectedRevision,
    '/expectedRevision',
  );
  const events = validateDomainEventBatch(unsafeEvents);
  if (expectedRevision + events.length > Number.MAX_SAFE_INTEGER) {
    throw storageError(
      'STORAGE_LIMIT_EXCEEDED',
      'Event append would exceed the maximum safe stream revision.',
      { expectedRevision, eventCount: events.length },
    );
  }

  const envelopes = Object.freeze(events.map((event, index) => (
    validateDomainEventEnvelope({
      ...event,
      envelopeVersion: 1,
      streamId: stream.streamId,
      revision: expectedRevision + index + 1,
    })
  )));
  const segment = serializedSegment(options, envelopes);
  validateLimitsAndSecrets(options, events, segment);

  const state = await readStreamState(options, stream);
  if (state.revision !== expectedRevision) {
    if (
      allowCommittedRetry
      && hasExactCommittedAppend(
        state,
        expectedRevision,
        segment,
        events.length,
      )
    ) {
      return {
        stream,
        expectedRevision,
        events,
        segment,
        alreadyCommitted: true,
      };
    }
    throw storageError(
      'REVISION_CONFLICT',
      'Event stream revision does not match the append expectation.',
      { expectedRevision, actualRevision: state.revision },
    );
  }
  const eventIds = new Set(state.events.map((event) => event.eventId));
  for (const event of events) {
    if (eventIds.has(event.eventId)) {
      throw storageError(
        'DUPLICATE_EVENT_ID',
        'Event identity is already present in this stream or append batch.',
        { eventId: event.eventId },
      );
    }
    eventIds.add(event.eventId);
  }

  return {
    stream,
    expectedRevision,
    events,
    segment,
    alreadyCommitted: false,
  };
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function commitSegment(
  directories: StreamDirectories,
  startRevision: number,
  bytes: Buffer,
): Promise<boolean> {
  const temporary = join(
    directories.temporary,
    `${segmentFilename(startRevision)}.${randomUUID()}.tmp`,
  );
  const target = join(directories.segments, segmentFilename(startRevision));
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
    await file.chmod(0o400);
    try {
      await link(temporary, target);
    } catch (error) {
      if (isNodeError(error, 'EEXIST')) return false;
      throw error;
    }
    await syncDirectory(directories.segments);
    return true;
  } finally {
    await file.close();
    await unlink(temporary).catch(() => undefined);
  }
}

class LocalEventStore implements EventStore {
  readonly #options: ResolvedOptions;

  constructor(options: LocalEventStoreOptions) {
    this.#options = resolveOptions(options);
  }

  async preflightAppend(
    stream: EventStreamRef,
    expectedRevision: number,
    events: DomainEventBatch,
  ): Promise<void> {
    await prepareAppend(this.#options, stream, expectedRevision, events);
  }

  async *read(
    unsafeStream: EventStreamRef,
    unsafeAfterRevision = 0,
  ): AsyncIterable<DomainEventEnvelope> {
    const stream = validateEventStreamRef(unsafeStream);
    const afterRevision = validateStreamRevision(
      unsafeAfterRevision,
      '/afterRevision',
    );
    const state = await readStreamState(this.#options, stream);
    for (const event of state.events) {
      if (event.revision > afterRevision) yield event;
    }
  }

  async append(
    unsafeStream: EventStreamRef,
    unsafeExpectedRevision: number,
    unsafeEvents: DomainEventBatch,
  ): Promise<number> {
    const prepared = await prepareAppend(
      this.#options,
      unsafeStream,
      unsafeExpectedRevision,
      unsafeEvents,
      true,
    );
    if (prepared.alreadyCommitted) {
      return prepared.expectedRevision + prepared.events.length;
    }
    const directories = await ensureStreamDirectories(
      this.#options,
      prepared.stream,
    );
    if (await commitSegment(
      directories,
      prepared.expectedRevision + 1,
      prepared.segment.bytes,
    )) {
      return prepared.expectedRevision + prepared.events.length;
    }

    const actual = await readStreamState(this.#options, prepared.stream);
    if (hasExactCommittedAppend(
      actual,
      prepared.expectedRevision,
      prepared.segment,
      prepared.events.length,
    )) {
      return prepared.expectedRevision + prepared.events.length;
    }
    throw storageError(
      'REVISION_CONFLICT',
      'Another writer committed the expected stream revision first.',
      {
        expectedRevision: prepared.expectedRevision,
        actualRevision: actual.revision,
      },
    );
  }
}

export function createLocalEventStore(
  options: LocalEventStoreOptions,
): EventStore {
  return new LocalEventStore(options);
}
