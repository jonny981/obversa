import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import type { EventStore } from '@obversa/runtime';
import { readSupervision, supervisionWriter, supervisedElapsedMs } from '../src/supervised-record.js';
import { createLocalRunStorage } from '@obversa/runtime/storage/local';
import { vi } from 'vitest';

// Real work: these tests write files to temporary directories on disk, so
// this file declares its own time limit; the suite default is a hang guard,
// not a speed bar.
vi.setConfig({ testTimeout: 30_000 });

const timestamp = (ms: number) => new Date(ms).toISOString();
const timed = (type: string, ms: number) => ({ type: `runner:${type}`, timestamp: timestamp(ms) });

it('sums execution across pauses without refilling on crash, backoff, or replacement', () => {
  const records = [
    timed('worker-launching', 10), timed('paused', 100),
    timed('worker-launching', 1_000), timed('worker-crashed', 1_050),
    timed('backoff', 1_060), timed('worker-launching', 1_100), timed('paused', 1_200),
    timed('paused', 2_000), timed('worker-launching', 3_000), timed('completed', 3_050),
  ];
  expect(supervisedElapsedMs(timestamp(0), records, 4_000)).toBe(350);
  expect(supervisedElapsedMs(timestamp(0), records.slice(0, 8), 2_900)).toBe(300);
  expect(supervisedElapsedMs(timestamp(0), records.slice(0, 9), 3_025)).toBe(325);
});

it.each(['completed', 'failed', 'stopped', 'timeout', 'budget-stop'])(
  'closes elapsed time at %s after a stored resumed launch', (terminal) => {
    expect(supervisedElapsedMs(timestamp(0), [
      timed('paused', 100), timed('worker-launching', 1_000), timed(terminal, 1_050),
    ], 4_000)).toBe(150);
  },
);

it('keeps failed resumes frozen when no worker launch was stored', () => {
  expect(supervisedElapsedMs(timestamp(0), [
    timed('paused', 100), timed('paused', 1_000), timed('failed', 3_000),
  ], 4_000)).toBe(100);
  expect(supervisedElapsedMs(timestamp(0), [], 50)).toBe(50);
});

it('persists a queued terminal record after an earlier append rejects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'obversa-supervision-record-'));
  try {
    const options = {
      directory, namespace: 'record-test',
      policy: {
        schemaVersion: 1, maxEventPayloadBytes: 8_192, maxAppendBatchBytes: 32_768,
        maxArtifactBytes: 65_536, maxTotalArtifactBytesPerRun: 131_072,
        retention: 'until-run-delete',
        sensitiveContent: { marked: 'reject', exact: 'reject', freeText: 'redact-before-hash' },
      },
    } as const;
    const storage = createLocalRunStorage(options);
    const failure = new Error('One append was refused');
    let failNext = false;
    const eventStore: EventStore = {
      read: storage.eventStore.read.bind(storage.eventStore),
      preflightAppend: storage.eventStore.preflightAppend.bind(storage.eventStore),
      append: async (...args) => {
        if (failNext) { failNext = false; throw failure; }
        return await storage.eventStore.append(...args);
      },
    };
    const append = supervisionWriter({ ...storage, eventStore }, 'run');
    await append('worker-launching', { restartCount: 0 });
    failNext = true;
    const rejected = append('worker-exited', { exitCode: 0 });
    const terminal = append('failed', { kind: 'fail', code: 'WATCHDOG_ERROR', phase: 'failed' });
    await expect(rejected).rejects.toBe(failure);
    await expect(terminal).resolves.toBeUndefined();

    const records = await readSupervision(createLocalRunStorage(options), 'run');
    expect(records.map(({ revision, type, payload }) => ({ revision, type, payload }))).toEqual([
      { revision: 1, type: 'runner:worker-launching', payload: { restartCount: 0 } },
      { revision: 2, type: 'runner:failed', payload: { kind: 'fail', code: 'WATCHDOG_ERROR', phase: 'failed' } },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
