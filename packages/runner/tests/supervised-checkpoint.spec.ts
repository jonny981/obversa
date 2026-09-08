import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DomainEventEnvelope } from '@obversa/runtime';
import { localSupervisedCheckpoint } from '../src/supervised-checkpoint.js';

// Real work: these tests write files to temporary directories on disk, so
// this file declares its own time limit; the suite default is a hang guard,
// not a speed bar.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const event = (revision: number, type: string, payload: Record<string, unknown>): DomainEventEnvelope => ({
  envelopeVersion: 1, eventId: `event-${revision}`, type: `graph:${type}`, version: 1,
  timestamp: `2026-09-04T00:00:0${revision}.000Z`, correlationId: 'run', causationId: null,
  streamId: 'run', revision, payload: payload as DomainEventEnvelope['payload'],
});
const history = [
  event(1, 'run-started', {}),
  event(2, 'node-dispatched', { nodeId: 'a', position: 'opaque-a' }),
  event(3, 'node-attempt-started', { identity: { nodeId: 'a', position: 'opaque-a' } }),
];
const directories: string[] = [];
const activeState = {
  active: [{ nodeId: 'a', position: 'opaque-a', startedAt: '2026-09-04T00:00:03.000Z' }],
  paused: {},
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function diskCheckpoint() {
  const directory = await mkdtemp(join(tmpdir(), 'obversa-checkpoint-disk-'));
  directories.push(directory);
  expect(await localSupervisedCheckpoint(directory, 'namespace', history)).toEqual(activeState);
  const cacheDirectory = join(directory, 'runner-checkpoints');
  const files = await readdir(cacheDirectory);
  expect(files).toHaveLength(1);
  const path = join(cacheDirectory, files[0]!);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  expect(saved).toMatchObject({ namespace: 'namespace', streamId: 'run', revision: 3, lastEventId: 'event-3', state: activeState });
  return { directory, cacheDirectory, path, saved };
}

describe('supervision checkpoints', () => {
  it('a stale checkpoint is discarded and the state is rebuilt from events', async () => {
    const module = await import('../src/supervised-checkpoint.js');
    const fresh = module.foldSupervisedEvents('namespace', history);
    expect(fresh.state.active).toEqual([{ nodeId: 'a', position: 'opaque-a', startedAt: '2026-09-04T00:00:03.000Z' }]);
    const later = [...history, event(4, 'node-completed', { nodeId: 'a', position: 'opaque-a' })];
    for (const checkpoint of [fresh.checkpoint, '{broken', { schemaVersion: 1 }, { ...fresh.checkpoint, state: null }]) {
      const rebuilt = module.foldSupervisedEvents('namespace', later, checkpoint);
      expect(rebuilt.reused).toBe(false);
      expect(rebuilt.state.active).toEqual([]);
      expect(rebuilt.checkpoint.revision).toBe(4);
    }
    const cached = module.foldSupervisedEvents('namespace', history, fresh.checkpoint);
    expect(cached.reused).toBe(true);
    expect(cached.state).toEqual(fresh.state);
    expect(module.foldSupervisedEvents('different-namespace', history, fresh.checkpoint).reused).toBe(false);
  });

  it('creates a disk cache and reuses a fresh file without rewriting it', async () => {
    const { directory, path, saved } = await diskCheckpoint();
    const formatted = `${JSON.stringify(saved, null, 2)}\n`;
    await writeFile(path, formatted);
    const oldTime = new Date('2000-01-01T00:00:00.000Z');
    await utimes(path, oldTime, oldTime);
    const before = await stat(path);

    expect(await localSupervisedCheckpoint(directory, 'namespace', history)).toEqual(activeState);
    expect(await readFile(path, 'utf8')).toBe(formatted);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  });

  it.each(['invalid-json', 'malformed-state', 'wrong-digest'] as const)(
    'rebuilds a %s disk cache from recorded events', async (damage) => {
      const { directory, cacheDirectory, path, saved } = await diskCheckpoint();
      const broken = damage === 'invalid-json' ? '{unfinished'
        : JSON.stringify({ ...saved, state: damage === 'malformed-state' ? null : { active: [], paused: {} } });
      await writeFile(path, broken);

      expect(await localSupervisedCheckpoint(directory, 'namespace', history)).toEqual(activeState);
      const repaired = JSON.parse(await readFile(path, 'utf8'));
      expect(repaired).toMatchObject({ revision: 3, lastEventId: 'event-3', state: activeState });
      expect(await readdir(cacheDirectory)).toHaveLength(1);
    },
  );

  it('replaces stale disk state when later events finish the active occurrence', async () => {
    const { directory, cacheDirectory, path } = await diskCheckpoint();
    const later = [...history, event(4, 'node-completed', { nodeId: 'a', position: 'opaque-a', result: {} })];

    expect(await localSupervisedCheckpoint(directory, 'namespace', later)).toEqual({ active: [], paused: {} });
    const updated = JSON.parse(await readFile(path, 'utf8'));
    expect(updated).toMatchObject({ revision: 4, lastEventId: 'event-4', state: { active: [], paused: {} } });
    expect(await readdir(cacheDirectory)).toHaveLength(1);
  });
});
