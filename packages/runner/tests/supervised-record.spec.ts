import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import type { EventStore } from '@obversa/runtime';
import { readSupervision, supervisionWriter } from '../src/supervised-record.js';
import { createLocalRunStorage } from '@obversa/runtime/storage/local';

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
