import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertEventStoreConformance,
  runEventStoreConformance,
} from '../src/events/conformance.js';
import { createLocalEventStore } from '../src/events/jsonl-store.js';
import { StorageError } from '../src/storage/error.js';
import type {
  DomainEventEnvelope,
  EventStreamRef,
  NewDomainEvent,
} from '../src/events/envelope.js';
import type { EventStore } from '../src/events/store.js';
import { vi } from 'vitest';

// Real work: these tests write files to temporary directories on disk, so
// this file declares its own time limit; the suite default is a hang guard,
// not a speed bar.
vi.setConfig({ testTimeout: 30_000 });

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lines-event-conformance-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('event-store conformance kit', () => {
  it('accepts a fresh local store instance over the same backing data', async () => {
    const root = await temporaryRoot();
    const factory = (options: {
      readonly maxEventPayloadBytes: number;
      readonly maxAppendBatchBytes: number;
      readonly knownSecrets: readonly string[];
    }) => createLocalEventStore({ root, ...options });

    const report = await runEventStoreConformance(factory);

    expect(report).toEqual({
      ok: true,
      cases: expect.any(Number),
      failures: [],
    });
    await expect(assertEventStoreConformance(factory)).resolves.toBeUndefined();
  });

  it('reports an adapter that discards every append', async () => {
    const store: EventStore = {
      async *read() {},
      async preflightAppend() {},
      async append(_stream, expectedRevision) {
        return expectedRevision;
      },
    };
    const report = await runEventStoreConformance(() => store);

    expect(report.ok).toBe(false);
    expect(report.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ case: 'ordered durable append' }),
    ]));
  });

  it('reports a provider that locks only one opened instance', async () => {
    const streams = new Map<string, DomainEventEnvelope[]>();
    const key = (stream: EventStreamRef) => `${stream.namespace}\0${stream.streamId}`;
    const factory = () => {
      let pending = Promise.resolve();
      const store: EventStore = {
        async *read(stream, afterRevision = 0) {
          for (const event of streams.get(key(stream)) ?? []) {
            if (event.revision > afterRevision) yield event;
          }
        },
        async preflightAppend(stream, expectedRevision) {
          const saved = streams.get(key(stream)) ?? [];
          if (saved.length !== expectedRevision) {
            throw new StorageError('REVISION_CONFLICT', 'stale');
          }
        },
        append(stream, expectedRevision, events) {
          const operation = pending.then(async () => {
            const saved = streams.get(key(stream)) ?? [];
            if (saved.length !== expectedRevision) {
              throw new StorageError('REVISION_CONFLICT', 'stale');
            }
            await new Promise<void>((resolve) => setImmediate(resolve));
            const appended = events.map((event: NewDomainEvent, index) => ({
              ...event,
              envelopeVersion: 1 as const,
              streamId: stream.streamId,
              revision: expectedRevision + index + 1,
            }));
            streams.set(key(stream), [...saved, ...appended]);
            return expectedRevision + events.length;
          });
          pending = operation.then(() => undefined, () => undefined);
          return operation;
        },
      };
      return store;
    };

    const report = await runEventStoreConformance(factory);

    expect(report.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ case: 'atomic expected revision' }),
    ]));
  });

  it('reports a provider that does not pin committed numeric limits', async () => {
    const root = await temporaryRoot();
    const factory = () => createLocalEventStore({
      root,
      maxEventPayloadBytes: 1_024,
      maxAppendBatchBytes: 8_192,
      knownSecrets: ['conformance-secret'],
    });

    const report = await runEventStoreConformance(factory);

    expect(report.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ case: 'restart policy identity' }),
    ]));
  });

  it('reports a provider that misses escaped semantic known secrets', async () => {
    const root = await temporaryRoot();
    const factory = (options: {
      readonly maxEventPayloadBytes: number;
      readonly maxAppendBatchBytes: number;
      readonly knownSecrets: readonly string[];
    }) => createLocalEventStore({
      root,
      ...options,
      knownSecrets: options.knownSecrets.includes('line\nbreak')
        ? []
        : options.knownSecrets,
    });

    const report = await runEventStoreConformance(factory);

    expect(report.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ case: 'semantic known-secret rejection' }),
    ]));
  });
});
