import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  DomainEventEnvelope,
  EventStreamRef,
  NewDomainEvent,
} from '../src/events/envelope.js';
import { createLocalEventStore } from '../src/events/jsonl-store.js';
import { StorageError } from '../src/storage/error.js';

const roots: string[] = [];

async function temporaryRoot(prefix = 'lines-event-store-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

const stream: EventStreamRef = {
  namespace: 'intent-42',
  streamId: 'run-42',
};

function event(
  eventId: string,
  payload: NewDomainEvent['payload'] = {},
): NewDomainEvent {
  return {
    eventId,
    type: 'example:recorded',
    version: 1,
    timestamp: '2026-08-26T04:00:00.000Z',
    correlationId: 'run-42',
    causationId: null,
    payload,
  };
}

async function collect(
  values: AsyncIterable<DomainEventEnvelope>,
): Promise<readonly DomainEventEnvelope[]> {
  const result: DomainEventEnvelope[] = [];
  for await (const value of values) result.push(value);
  return result;
}

async function segmentFiles(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

function storagePathComponent(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

interface ChildInput {
  readonly mode: 'append' | 'orphan';
  readonly root: string;
  readonly stream: EventStreamRef;
  readonly barrier?: string;
  readonly expectedRevision?: number;
  readonly eventIds?: readonly string[];
}

interface ChildResult {
  readonly status: 'ok' | 'error';
  readonly revision?: number;
  readonly code?: string;
}

function startStoreChild(input: ChildInput): {
  readonly ready: Promise<void>;
  readonly result: Promise<ChildResult>;
} {
  const storeUrl = pathToFileURL(join(
    process.cwd(),
    'src/events/jsonl-store.ts',
  )).href;
  const program = `
    import { access, mkdir, writeFile } from 'node:fs/promises';
    import { createHash } from 'node:crypto';
    import { join } from 'node:path';
    import { setTimeout as delay } from 'node:timers/promises';
    import { createLocalEventStore } from ${JSON.stringify(storeUrl)};

    const input = JSON.parse(process.env.LINES_EVENT_CHILD_INPUT);
    console.log('READY');
    if (input.barrier) {
      for (;;) {
        try {
          await access(input.barrier);
          break;
        } catch {
          await delay(5);
        }
      }
    }
    if (input.mode === 'orphan') {
      const component = (value) => createHash('sha256')
        .update(value, 'utf8')
        .digest('hex');
      const temporary = join(
        input.root,
        'namespaces',
        component(input.stream.namespace),
        'streams',
        component(input.stream.streamId),
        '.tmp',
      );
      await mkdir(join(temporary, '..', 'segments'), { recursive: true });
      await mkdir(temporary, { recursive: true });
      await writeFile(join(temporary, 'uncommitted.tmp'), '{"partial":true}');
      console.log(JSON.stringify({ status: 'ok' }));
    } else {
      const store = createLocalEventStore({ root: input.root });
      const events = input.eventIds.map((eventId) => ({
        eventId,
        type: 'example:recorded',
        version: 1,
        timestamp: '2026-08-26T04:00:00.000Z',
        correlationId: 'run-42',
        causationId: null,
        payload: {},
      }));
      try {
        const revision = await store.append(
          input.stream,
          input.expectedRevision,
          events,
        );
        console.log(JSON.stringify({ status: 'ok', revision }));
      } catch (error) {
        console.log(JSON.stringify({
          status: 'error',
          code: error && typeof error === 'object' && 'code' in error
            ? error.code
            : 'UNKNOWN',
        }));
      }
    }
  `;
  const child = spawn(process.execPath, [
    '--import',
    'tsx',
    '--input-type=module',
    '--eval',
    program,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LINES_EVENT_CHILD_INPUT: JSON.stringify(input),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let readyResolved = false;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    if (!readyResolved && stdout.split('\n').includes('READY')) {
      readyResolved = true;
      resolveReady();
    }
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const result = new Promise<ChildResult>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Event-store child exited ${code}: ${stderr}`));
        return;
      }
      const lines = stdout.trim().split('\n');
      const value = lines.at(-1);
      if (!value || value === 'READY') {
        reject(new Error(`Event-store child returned no result: ${stderr}`));
        return;
      }
      resolve(JSON.parse(value) as ChildResult);
    });
  });
  return { ready, result };
}

describe('local event store', () => {
  it('uses revision zero for an empty stream and consecutive stored revisions', async () => {
    const store = createLocalEventStore({ root: await temporaryRoot() });

    expect(await collect(store.read(stream))).toEqual([]);
    await expect(store.append(stream, 0, [event('event-1'), event('event-2')]))
      .resolves.toBe(2);

    expect(await collect(store.read(stream))).toEqual([
      expect.objectContaining({
        envelopeVersion: 1,
        eventId: 'event-1',
        streamId: 'run-42',
        revision: 1,
      }),
      expect.objectContaining({
        envelopeVersion: 1,
        eventId: 'event-2',
        streamId: 'run-42',
        revision: 2,
      }),
    ]);
    expect(await collect(store.read(stream, 1))).toEqual([
      expect.objectContaining({ eventId: 'event-2', revision: 2 }),
    ]);
  });

  it('keeps each committed append immutable across reopen', async () => {
    const root = await temporaryRoot();
    const first = createLocalEventStore({ root });
    await first.append(stream, 0, [event('event-1')]);
    const [firstSegment] = await segmentFiles(root);
    const original = await readFile(firstSegment!);

    const reopened = createLocalEventStore({ root });
    await reopened.append(stream, 1, [event('event-2')]);

    expect(await readFile(firstSegment!)).toEqual(original);
    expect(await segmentFiles(root)).toHaveLength(2);
    expect((await collect(reopened.read(stream))).map((item) => item.eventId))
      .toEqual(['event-1', 'event-2']);
  });

  it('reads through one finite head when a later append commits', async () => {
    const store = createLocalEventStore({ root: await temporaryRoot() });
    await store.append(stream, 0, [event('event-1'), event('event-2')]);
    const iterator = store.read(stream)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: expect.objectContaining({ eventId: 'event-1' }),
    });
    await store.append(stream, 2, [event('event-3')]);

    const remaining: string[] = [];
    for (;;) {
      const item = await iterator.next();
      if (item.done) break;
      remaining.push(item.value.eventId);
    }
    expect(remaining).toEqual(['event-2']);
  });

  it('lets only one writer commit the same expected revision', async () => {
    const store = createLocalEventStore({ root: await temporaryRoot() });
    const results = await Promise.allSettled([
      store.append(stream, 0, [event('event-a')]),
      store.append(stream, 0, [event('event-b')]),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toEqual(expect.objectContaining({
      reason: expect.objectContaining({
        name: 'StorageError',
        code: 'REVISION_CONFLICT',
        details: { expectedRevision: 0, actualRevision: 1 },
      }),
    }));
    expect(await collect(store.read(stream))).toHaveLength(1);
  });

  it('rejects an empty append before changing the stream', async () => {
    const store = createLocalEventStore({ root: await temporaryRoot() });

    await expect(store.append(
      stream,
      0,
      [] as unknown as readonly [NewDomainEvent, ...NewDomainEvent[]],
    )).rejects.toEqual(expect.objectContaining({
      code: 'INVALID_STORED_VALUE',
    }));
    expect(await collect(store.read(stream))).toEqual([]);
  });

  it('rejects a sparse append before changing the stream', async () => {
    const store = createLocalEventStore({ root: await temporaryRoot() });
    const sparse = new Array<NewDomainEvent>(1);

    await expect(store.append(
      stream,
      0,
      sparse as unknown as readonly [NewDomainEvent, ...NewDomainEvent[]],
    )).rejects.toEqual(expect.objectContaining({
      code: 'INVALID_STORED_VALUE',
    }));
    expect(await collect(store.read(stream))).toEqual([]);
  });

  it('rejects duplicate event identities without committing part of a batch', async () => {
    const store = createLocalEventStore({ root: await temporaryRoot() });
    await store.append(stream, 0, [event('event-1')]);

    await expect(store.append(stream, 1, [
      event('event-2'),
      event('event-1'),
    ])).rejects.toEqual(expect.objectContaining({
      code: 'DUPLICATE_EVENT_ID',
    }));
    expect((await collect(store.read(stream))).map((item) => item.eventId))
      .toEqual(['event-1']);
  });

  it('keeps equal stream ids isolated by namespace', async () => {
    const store = createLocalEventStore({ root: await temporaryRoot() });
    const other = { ...stream, namespace: 'intent-43' };

    await store.append(stream, 0, [event('event-a')]);
    await store.append(other, 0, [event('event-b')]);

    expect((await collect(store.read(stream))).map((item) => item.eventId))
      .toEqual(['event-a']);
    expect((await collect(store.read(other))).map((item) => item.eventId))
      .toEqual(['event-b']);
  });

  it('keeps case-distinct namespaces isolated on a case-insensitive filesystem', async () => {
    const store = createLocalEventStore({ root: await temporaryRoot() });
    const upper = { ...stream, namespace: 'Intent-Case' };
    const lower = { ...stream, namespace: 'intent-case' };

    await store.append(upper, 0, [event('event-upper')]);
    await store.append(lower, 0, [event('event-lower')]);

    expect((await collect(store.read(upper))).map((item) => item.eventId))
      .toEqual(['event-upper']);
    expect((await collect(store.read(lower))).map((item) => item.eventId))
      .toEqual(['event-lower']);
  });

  it('rejects a fresh instance whose policy differs from the committed stream', async () => {
    const root = await temporaryRoot();
    const first = createLocalEventStore({
      root,
      maxEventPayloadBytes: 64,
      maxAppendBatchBytes: 8_192,
      knownSecrets: ['shared-secret'],
    });
    await first.append(stream, 0, [event('event-1')]);
    const changed = createLocalEventStore({
      root,
      maxEventPayloadBytes: 2_048,
      maxAppendBatchBytes: 8_192,
      knownSecrets: ['shared-secret'],
    });

    await expect(changed.append(stream, 1, [event('event-2')]))
      .rejects.toEqual(expect.objectContaining({ code: 'INVALID_STORED_VALUE' }));
    expect((await collect(first.read(stream))).map((item) => item.eventId))
      .toEqual(['event-1']);
  });

  it('allows secret rotation while applying the new secrets to later writes', async () => {
    const root = await temporaryRoot();
    const first = createLocalEventStore({
      root,
      knownSecrets: ['retired-secret'],
    });
    await first.append(stream, 0, [event('event-1')]);

    const rotated = createLocalEventStore({
      root,
      knownSecrets: ['replacement-secret'],
    });
    expect((await collect(rotated.read(stream))).map((item) => item.eventId))
      .toEqual(['event-1']);
    await expect(rotated.append(stream, 1, [
      event('event-2', { text: 'replacement-secret' }),
    ])).rejects.toEqual(expect.objectContaining({ code: 'KNOWN_SECRET' }));
    expect((await collect(rotated.read(stream))).map((item) => item.eventId))
      .toEqual(['event-1']);
  });

  it('accepts an event payload at its byte limit and rejects one byte more', async () => {
    const store = createLocalEventStore({
      root: await temporaryRoot(),
      maxEventPayloadBytes: 64,
      maxAppendBatchBytes: 8_192,
    });

    await expect(store.append(stream, 0, [
      event('payload-limit', { text: 'x'.repeat(53) }),
    ])).resolves.toBe(1);
    await expect(store.append(stream, 1, [
      event('payload-over', { text: 'x'.repeat(54) }),
    ])).rejects.toEqual(expect.objectContaining({
      code: 'STORAGE_LIMIT_EXCEEDED',
      details: expect.objectContaining({ byteLength: 65, maximumBytes: 64 }),
    }));
    expect((await collect(store.read(stream))).map((item) => item.eventId))
      .toEqual(['payload-limit']);
  });

  it('accepts an append at its byte limit and rejects one byte more', async () => {
    const store = createLocalEventStore({
      root: await temporaryRoot(),
      maxEventPayloadBytes: 64,
      maxAppendBatchBytes: 219,
    });

    await expect(store.append(stream, 0, [
      event('batch-a', { text: 'x' }),
    ])).resolves.toBe(1);
    await expect(store.append(stream, 1, [
      event('batch-b', { text: 'xx' }),
    ])).rejects.toEqual(expect.objectContaining({
      code: 'STORAGE_LIMIT_EXCEEDED',
      details: expect.objectContaining({ byteLength: 220, maximumBytes: 219 }),
    }));
    expect((await collect(store.read(stream))).map((item) => item.eventId))
      .toEqual(['batch-a']);
  });

  it('rejects payload, batch, and exact known-secret bytes before writing', async () => {
    const root = await temporaryRoot();
    const payloadLimited = createLocalEventStore({
      root,
      maxEventPayloadBytes: 20,
      maxAppendBatchBytes: 8_192,
    });
    await expect(payloadLimited.append(stream, 0, [
      event('large-payload', { text: 'x'.repeat(100) }),
    ])).rejects.toEqual(expect.objectContaining({
      code: 'STORAGE_LIMIT_EXCEEDED',
    }));

    const batchLimited = createLocalEventStore({
      root,
      maxEventPayloadBytes: 500,
      maxAppendBatchBytes: 1_000,
    });
    await expect(batchLimited.append(stream, 0, [
      event('batch-a', { text: 'x'.repeat(400) }),
      event('batch-b', { text: 'y'.repeat(400) }),
    ])).rejects.toEqual(expect.objectContaining({
      code: 'STORAGE_LIMIT_EXCEEDED',
    }));

    const secretStore = createLocalEventStore({
      root,
      knownSecrets: ['exact-secret-token'],
    });
    await expect(secretStore.append(stream, 0, [
      event('secret', { text: 'contains exact-secret-token here' }),
    ])).rejects.toEqual(expect.objectContaining({ code: 'KNOWN_SECRET' }));

    expect(await collect(secretStore.read(stream))).toEqual([]);
    const saved = await Promise.all((await segmentFiles(root)).map((path) => readFile(path, 'utf8')));
    expect(saved.join('\n')).not.toContain('exact-secret-token');
  });

  it.each([
    ['escaped string value', 'line\nbreak', { text: 'line\nbreak' }],
    ['escaped object key', 'quote"token', { 'quote"token': true }],
  ])('rejects a known secret in an %s', async (_name, knownSecret, payload) => {
    const root = await temporaryRoot();
    const store = createLocalEventStore({
      root,
      knownSecrets: [knownSecret],
    });

    await expect(store.append(stream, 0, [event('secret', payload)]))
      .rejects.toEqual(expect.objectContaining({ code: 'KNOWN_SECRET' }));
    expect(await collect(store.read(stream))).toEqual([]);
  });

  it('rejects a known secret in the stored segment checksum record', async () => {
    const root = await temporaryRoot();
    const store = createLocalEventStore({
      root,
      knownSecrets: ['\"segmentVersion\":1'],
    });

    await expect(store.append(stream, 0, [event('checksum-secret')]))
      .rejects.toEqual(expect.objectContaining({ code: 'KNOWN_SECRET' }));
    expect(await collect(store.read(stream))).toEqual([]);
    expect(await segmentFiles(root)).toEqual([]);
  });

  it.each([
    [{ namespace: '../escape', streamId: 'run-42' }, 'namespace'],
    [{ namespace: 'intent-42', streamId: '../escape' }, 'stream'],
  ])('rejects an unsafe %s id', async (unsafe) => {
    const store = createLocalEventStore({ root: await temporaryRoot() });
    await expect(store.append(unsafe, 0, [event('event-1')]))
      .rejects.toBeInstanceOf(StorageError);
  });

  it('rejects a namespace path that escapes through a symlink', async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot('lines-event-outside-');
    await mkdir(join(root, 'namespaces'), { recursive: true });
    await symlink(outside, join(
      root,
      'namespaces',
      storagePathComponent(stream.namespace),
    ));
    const store = createLocalEventStore({ root });

    await expect(store.append(stream, 0, [event('event-1')]))
      .rejects.toEqual(expect.objectContaining({ code: 'UNSAFE_STORAGE_PATH' }));
    expect(await readdir(outside)).toEqual([]);
  });

  it('rejects a symlinked storage root without writing through it', async () => {
    const container = await temporaryRoot();
    const outside = await temporaryRoot('lines-event-outside-');
    const root = join(container, 'event-root');
    await symlink(outside, root);
    const store = createLocalEventStore({ root });

    await expect(store.preflightAppend(stream, 0, [event('preflight')]))
      .rejects.toEqual(expect.objectContaining({ code: 'UNSAFE_STORAGE_PATH' }));
    await expect(store.append(stream, 0, [event('append')]))
      .rejects.toEqual(expect.objectContaining({ code: 'UNSAFE_STORAGE_PATH' }));
    await expect(collect(store.read(stream)))
      .rejects.toEqual(expect.objectContaining({ code: 'UNSAFE_STORAGE_PATH' }));
    expect(await readdir(outside)).toEqual([]);
  });

  it('creates every managed directory with owner-only permissions', async () => {
    const container = await temporaryRoot();
    const root = join(container, 'event-root');
    const store = createLocalEventStore({ root });

    await store.append(stream, 0, [event('event-1')]);

    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    const directories = [
      root,
      ...entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(entry.parentPath, entry.name)),
    ];
    const modes = await Promise.all(directories.map(async (path) =>
      (await stat(path)).mode & 0o777));
    expect(new Set(modes)).toEqual(new Set([0o700]));
  });

  it('fails closed on changed and oversized segment bytes', async () => {
    const root = await temporaryRoot();
    const store = createLocalEventStore({
      root,
      maxAppendBatchBytes: 1_024,
    });
    await store.append(stream, 0, [event('event-1')]);
    const [segment] = await segmentFiles(root);
    await chmod(segment!, 0o600);
    await writeFile(segment!, Buffer.alloc(2_048, 0x78));

    await expect(collect(store.read(stream))).rejects.toEqual(
      expect.objectContaining({ code: 'CORRUPT_EVENT_STREAM' }),
    );
  });

  it('rejects a temporary directory injected into committed segments', async () => {
    const root = await temporaryRoot();
    const store = createLocalEventStore({ root });
    await store.append(stream, 0, [event('event-1')]);
    const [segment] = await segmentFiles(root);
    await mkdir(join(dirname(segment!), '.tmp'));

    await expect(collect(store.read(stream))).rejects.toEqual(
      expect.objectContaining({ code: 'CORRUPT_EVENT_STREAM' }),
    );
  });

  it('rejects invalid UTF-8 before parsing even with a matching segment checksum', async () => {
    const root = await temporaryRoot();
    const store = createLocalEventStore({ root });
    await store.append(stream, 0, [event('event-1')]);
    const [segment] = await segmentFiles(root);
    const original = await readFile(segment!);
    const firstNewline = original.indexOf(0x0a);
    const eventBytes = Buffer.from(original.subarray(0, firstNewline + 1));
    const stringOffset = eventBytes.indexOf(Buffer.from('example:recorded'));
    eventBytes[stringOffset] = 0xff;
    const checksum = JSON.parse(
      original.subarray(firstNewline + 1).toString('utf8'),
    ) as { sha256: string };
    checksum.sha256 = `sha256:${createHash('sha256')
      .update(Buffer.from(eventBytes.toString('utf8'), 'utf8'))
      .digest('hex')}`;
    await chmod(segment!, 0o600);
    await writeFile(segment!, Buffer.concat([
      eventBytes,
      Buffer.from(`${JSON.stringify(checksum)}\n`),
    ]));

    await expect(collect(store.read(stream))).rejects.toEqual(
      expect.objectContaining({
        code: 'CORRUPT_EVENT_STREAM',
        message: expect.stringMatching(/UTF-8/u),
      }),
    );
  });

  it('commits one of two released child writers and reopens in a fresh process', async () => {
    const root = await temporaryRoot();
    const barrier = join(root, 'release');
    const left = startStoreChild({
      mode: 'append',
      root,
      stream,
      barrier,
      expectedRevision: 0,
      eventIds: ['process-left'],
    });
    const right = startStoreChild({
      mode: 'append',
      root,
      stream,
      barrier,
      expectedRevision: 0,
      eventIds: ['process-right'],
    });
    await Promise.all([left.ready, right.ready]);
    await writeFile(barrier, 'release');

    const firstResults = await Promise.all([left.result, right.result]);
    expect(firstResults.filter((result) => result.status === 'ok')).toEqual([
      expect.objectContaining({ revision: 1 }),
    ]);
    expect(firstResults.filter((result) => result.status === 'error')).toEqual([
      expect.objectContaining({ code: 'REVISION_CONFLICT' }),
    ]);

    const reopened = startStoreChild({
      mode: 'append',
      root,
      stream,
      expectedRevision: 1,
      eventIds: ['process-next'],
    });
    await reopened.ready;
    await expect(reopened.result).resolves.toEqual({ status: 'ok', revision: 2 });
    expect((await collect(createLocalEventStore({ root }).read(stream)))
      .map((item) => item.eventId)).toEqual([
      expect.stringMatching(/^process-(left|right)$/u),
      'process-next',
    ]);
  }, 15_000);

  it('ignores a pre-link child orphan and exposes a fully linked child batch', async () => {
    const root = await temporaryRoot();
    const orphan = startStoreChild({ mode: 'orphan', root, stream });
    await orphan.ready;
    await expect(orphan.result).resolves.toEqual({ status: 'ok' });
    expect(await collect(createLocalEventStore({ root }).read(stream))).toEqual([]);

    const committed = startStoreChild({
      mode: 'append',
      root,
      stream,
      expectedRevision: 0,
      eventIds: ['linked-a', 'linked-b'],
    });
    await committed.ready;
    await expect(committed.result).resolves.toEqual({ status: 'ok', revision: 2 });
    expect((await collect(createLocalEventStore({ root }).read(stream)))
      .map((item) => item.eventId)).toEqual(['linked-a', 'linked-b']);
  }, 15_000);
});
