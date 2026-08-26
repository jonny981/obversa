import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { StorageError, type StorageErrorCode } from '../storage/error.js';
import type {
  DomainEventEnvelope,
  EventStreamRef,
  NewDomainEvent,
} from './envelope.js';
import type { DomainEventBatch, EventStore } from './store.js';

export interface EventStoreConformanceOptions {
  readonly maxEventPayloadBytes: number;
  readonly maxAppendBatchBytes: number;
  readonly knownSecrets: readonly string[];
}

export type EventStoreConformanceFactory = (
  options: EventStoreConformanceOptions,
) => EventStore | Promise<EventStore>;

interface EventStoreConformanceFixture {
  readonly maxEventPayloadBytes: number;
  readonly maxAppendBatchBytes: number;
  readonly knownSecret: string;
  open(): EventStore | Promise<EventStore>;
}

export interface EventStoreConformanceFailure {
  readonly case: string;
  readonly message: string;
}

export interface EventStoreConformanceReport {
  readonly ok: boolean;
  readonly cases: number;
  readonly failures: readonly EventStoreConformanceFailure[];
}

interface ConformanceCase {
  readonly name: string;
  run(): Promise<void>;
}

const DEFAULT_OPTIONS: EventStoreConformanceOptions = {
  maxEventPayloadBytes: 1_024,
  maxAppendBatchBytes: 8_192,
  knownSecrets: ['conformance-secret'],
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assert(condition: unknown, failure: string): asserts condition {
  if (!condition) throw new Error(failure);
}

async function collect(
  values: AsyncIterable<DomainEventEnvelope>,
): Promise<readonly DomainEventEnvelope[]> {
  const result: DomainEventEnvelope[] = [];
  for await (const value of values) result.push(value);
  return result;
}

async function expectStorageError(
  action: () => Promise<unknown>,
  code: StorageErrorCode,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof StorageError && error.code === code) return;
    throw new Error(
      `Expected StorageError ${code}, received ${message(error)}.`,
    );
  }
  throw new Error(`Expected StorageError ${code}, but the operation succeeded.`);
}

function conformanceId(prefix: string): string {
  return `${prefix}-${randomUUID().replaceAll('-', '')}`;
}

function stream(prefix: string): EventStreamRef {
  return {
    namespace: conformanceId('namespace'),
    streamId: conformanceId(prefix),
  };
}

function event(
  eventId: string,
  payload: NewDomainEvent['payload'] = {},
): NewDomainEvent {
  return {
    eventId,
    type: 'conformance:recorded',
    version: 1,
    timestamp: '2026-08-26T04:00:00.000Z',
    correlationId: 'conformance-run',
    causationId: null,
    payload,
  };
}

function batchPastLimit(maximumBytes: number): DomainEventBatch {
  const events: NewDomainEvent[] = [];
  let bytes = 0;
  while (bytes <= maximumBytes) {
    const next = event(`batch-${events.length}`, { text: 'x' });
    events.push(next);
    const envelope = {
      ...next,
      envelopeVersion: 1,
      streamId: 'batch-limit',
      revision: events.length,
    };
    bytes += Buffer.byteLength(`${JSON.stringify(envelope)}\n`, 'utf8');
  }
  return events as unknown as DomainEventBatch;
}

function validateFixture(fixture: EventStoreConformanceFixture): void {
  for (const [name, value] of [
    ['maxEventPayloadBytes', fixture.maxEventPayloadBytes],
    ['maxAppendBatchBytes', fixture.maxAppendBatchBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 64 || value > 1_000_000) {
      throw new Error(`${name} must be a safe integer from 64 through 1000000 for conformance.`);
    }
  }
  if (
    typeof fixture.knownSecret !== 'string'
    || fixture.knownSecret.length === 0
  ) {
    throw new Error('knownSecret must be a non-empty configured secret.');
  }
}

/** Run framework-free checks against an outside EventStore implementation. */
export async function runEventStoreConformance(
  factory: EventStoreConformanceFactory,
): Promise<EventStoreConformanceReport> {
  const fixture: EventStoreConformanceFixture = {
    maxEventPayloadBytes: DEFAULT_OPTIONS.maxEventPayloadBytes,
    maxAppendBatchBytes: DEFAULT_OPTIONS.maxAppendBatchBytes,
    knownSecret: DEFAULT_OPTIONS.knownSecrets[0]!,
    open: () => factory(DEFAULT_OPTIONS),
  };
  validateFixture(fixture);
  const cases: readonly ConformanceCase[] = [
    {
      name: 'side-effect-free preflight',
      async run() {
        const target = stream('preflight');
        const store = await fixture.open();
        const candidate = event(conformanceId('event'));
        await store.preflightAppend(target, 0, [candidate]);
        assert(
          (await collect(store.read(target))).length === 0,
          'Preflight made an event visible.',
        );
        const revision = await store.append(target, 0, [candidate]);
        assert(revision === 1, 'Preflight changed the later append revision.');
      },
    },
    {
      name: 'ordered durable append',
      async run() {
        const target = stream('ordered');
        const first = await fixture.open();
        const source = event(conformanceId('event'), {
          extension: { preserved: true },
        });
        const second = event(conformanceId('event'));
        const firstId = source.eventId;
        const secondId = second.eventId;
        const revision = await first.append(target, 0, [source, second]);
        assert(revision === 2, `Append returned revision ${revision} instead of 2.`);

        (source.payload as { extension: { preserved: boolean } })
          .extension.preserved = false;
        const reopened = await fixture.open();
        const all = await collect(reopened.read(target));
        assert(all.length === 2, `Reopened stream returned ${all.length} events instead of 2.`);
        assert(
          all[0]?.eventId === firstId
            && all[0].revision === 1
            && all[1]?.eventId === secondId
            && all[1].revision === 2,
          'Reopened stream changed event order or assigned revisions.',
        );
        assert(
          isDeepStrictEqual(all[0]?.payload, {
            extension: { preserved: true },
          }),
          'Stored event changed caller-owned or graph-owned payload data.',
        );
        const after = await collect(reopened.read(target, 1));
        assert(
          after.length === 1 && after[0]?.eventId === secondId,
          'Exclusive afterRevision read returned the wrong events.',
        );
      },
    },
    {
      name: 'restart policy identity',
      async run() {
        const target = stream('policy');
        const first = await fixture.open();
        const recorded = event(conformanceId('event'));
        await first.append(target, 0, [recorded]);

        const rotatedSecrets = await factory({
          ...DEFAULT_OPTIONS,
          knownSecrets: ['replacement-conformance-secret'],
        });
        assert(
          (await collect(rotatedSecrets.read(target)))[0]?.eventId
            === recorded.eventId,
          'Changing live secret screening made committed events unreadable.',
        );

        const changedLimits = await factory({
          ...DEFAULT_OPTIONS,
          maxEventPayloadBytes: DEFAULT_OPTIONS.maxEventPayloadBytes + 1,
        });
        await expectStorageError(
          () => collect(changedLimits.read(target)),
          'INVALID_STORED_VALUE',
        );
      },
    },
    {
      name: 'atomic expected revision',
      async run() {
        const target = stream('concurrent');
        const left = await fixture.open();
        const right = await fixture.open();
        const results = await Promise.allSettled([
          left.append(target, 0, [event(conformanceId('event'))]),
          right.append(target, 0, [event(conformanceId('event'))]),
        ]);
        assert(
          results.filter((result) => result.status === 'fulfilled').length === 1,
          'Two writers committed the same expected revision.',
        );
        const rejected = results.find((result) => result.status === 'rejected');
        assert(
          rejected?.status === 'rejected'
            && rejected.reason instanceof StorageError
            && rejected.reason.code === 'REVISION_CONFLICT',
          'Losing writer did not receive REVISION_CONFLICT.',
        );
        assert(
          (await collect((await fixture.open()).read(target))).length === 1,
          'Concurrent append exposed a partial or duplicate batch.',
        );
      },
    },
    {
      name: 'duplicate event identity',
      async run() {
        const target = stream('duplicate');
        const store = await fixture.open();
        const duplicate = event(conformanceId('event'));
        await store.append(target, 0, [duplicate]);
        await expectStorageError(
          () => store.append(target, 1, [duplicate]),
          'DUPLICATE_EVENT_ID',
        );
        assert(
          (await collect(store.read(target))).length === 1,
          'Rejected duplicate append changed the stream.',
        );
      },
    },
    {
      name: 'namespace isolation',
      async run() {
        const streamId = conformanceId('shared-stream');
        const left = { namespace: conformanceId('left'), streamId };
        const right = { namespace: conformanceId('right'), streamId };
        const store = await fixture.open();
        const leftEvent = event(conformanceId('left-event'));
        const rightEvent = event(conformanceId('right-event'));
        await store.append(left, 0, [leftEvent]);
        await store.append(right, 0, [rightEvent]);
        assert(
          (await collect(store.read(left)))[0]?.eventId === leftEvent.eventId
            && (await collect(store.read(right)))[0]?.eventId === rightEvent.eventId,
          'Equal stream ids in separate namespaces collided.',
        );
      },
    },
    {
      name: 'bounded append',
      async run() {
        const store = await fixture.open();
        const payloadTarget = stream('payload-limit');
        await expectStorageError(
          () => store.append(payloadTarget, 0, [event(
            conformanceId('event'),
            { text: 'x'.repeat(fixture.maxEventPayloadBytes) },
          )]),
          'STORAGE_LIMIT_EXCEEDED',
        );
        const batchTarget = stream('batch-limit');
        await expectStorageError(
          () => store.append(
            batchTarget,
            0,
            batchPastLimit(fixture.maxAppendBatchBytes),
          ),
          'STORAGE_LIMIT_EXCEEDED',
        );
        assert(
          (await collect(store.read(payloadTarget))).length === 0
            && (await collect(store.read(batchTarget))).length === 0,
          'Rejected oversized append changed a stream.',
        );
      },
    },
    {
      name: 'known-secret rejection',
      async run() {
        const target = stream('known-secret');
        const store = await fixture.open();
        const secretEvent = event(
          conformanceId('event'),
          { text: `before ${fixture.knownSecret} after` },
        );
        await expectStorageError(
          () => store.preflightAppend(target, 0, [secretEvent]),
          'KNOWN_SECRET',
        );
        await expectStorageError(
          () => store.append(target, 0, [secretEvent]),
          'KNOWN_SECRET',
        );
        assert(
          (await collect(store.read(target))).length === 0,
          'Known-secret rejection persisted an event.',
        );
      },
    },
    {
      name: 'semantic known-secret rejection',
      async run() {
        const target = stream('semantic-known-secret');
        const options = {
          ...DEFAULT_OPTIONS,
          knownSecrets: ['line\nbreak'],
        };
        const store = await factory(options);
        const secretEvent = event(
          conformanceId('event'),
          { text: 'before line\nbreak after' },
        );
        const failures: string[] = [];
        for (const operation of [
          () => store.preflightAppend(target, 0, [secretEvent]),
          () => store.append(target, 0, [secretEvent]),
        ]) {
          try {
            await expectStorageError(operation, 'KNOWN_SECRET');
          } catch (error) {
            failures.push(message(error));
          }
        }
        const reopened = await factory(options);
        if ((await collect(reopened.read(target))).length !== 0) {
          failures.push('Escaped known-secret rejection persisted an event.');
        }
        assert(failures.length === 0, failures.join(' '));
      },
    },
  ];

  const failures: EventStoreConformanceFailure[] = [];
  for (const item of cases) {
    try {
      await item.run();
    } catch (error) {
      failures.push({ case: item.name, message: message(error) });
    }
  }
  return Object.freeze({
    ok: failures.length === 0,
    cases: cases.length,
    failures: Object.freeze(failures.map((failure) => Object.freeze(failure))),
  });
}

/** Throw one readable error when an outside EventStore breaks the contract. */
export async function assertEventStoreConformance(
  factory: EventStoreConformanceFactory,
): Promise<void> {
  const report = await runEventStoreConformance(factory);
  if (report.ok) return;
  const detail = report.failures
    .map((failure) => `${failure.case}: ${failure.message}`)
    .join('; ');
  throw new Error(`Event store conformance failed: ${detail}`);
}
