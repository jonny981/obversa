import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { openSafeChangeRun } from '../../../examples/safe-change/recipe.js';
import {
  seedSafeChangeFixture, sourcePath, sourceStream, targetPath, targetStream,
} from '../../../examples/safe-change/file-adapter.js';
import type { ArtifactReference } from '../src/artifacts/store.js';
import type { DomainEventEnvelope, EventStreamRef } from '../src/events/envelope.js';
import type { JsonObject } from '../src/graph/value.js';

// Real work: these tests write files to temporary directories on disk, so
// this file declares its own time limit; the suite default is a hang guard,
// not a speed bar.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

type StoredEvent = DomainEventEnvelope<string, number, JsonObject>;

it('merges exact protected records through ordinary nodes and retains target results without importing source histories', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'obversa-file-merge-')));
  const runId = 'file-merge';
  try {
    const input = await seedSafeChangeFixture(directory);
    const originalSources = await Promise.all(input.sourceIds.map(async (id) => ({
      id, bytes: await readFile(sourcePath(directory, id), 'utf8'),
    })));
    const originalTargets = await Promise.all(input.destinations.map(async ({ id }) => ({
      id, bytes: await readFile(targetPath(directory, id), 'utf8'),
    })));
    const run = await openSafeChangeRun({ directory, runId, input });
    const events = async (stream: EventStreamRef): Promise<StoredEvent[]> => {
      const values: StoredEvent[] = [];
      for await (const event of run.storage.eventStore.read(stream)) values.push(event as StoredEvent);
      return values;
    };
    expect(await run.executor.run(new AbortController().signal)).toMatchObject({ kind: 'pause' });
    const sourceHistory = await Promise.all(input.sourceIds.map((id) => events(sourceStream(id))));
    expect(sourceHistory.map((history) => history.map((event) => event.type)))
      .toEqual(input.sourceIds.map(() => ['safe-change:source-recorded']));
    await run.approve();
    expect(await run.executor.resume(run.approvalPosition, new AbortController().signal))
      .toMatchObject({ kind: 'complete' });

    const graphEvents = await events({ namespace: run.storage.record.namespace, streamId: runId });
    for (const position of run.actionPositions) {
      expect(graphEvents.filter((event) => event.payload.position === position
        || (event.payload.identity as JsonObject | undefined)?.position === position).map((event) => event.type))
        .toEqual(['graph:node-dispatched', 'graph:node-attempt-started', 'graph:node-completed']);
    }
    const allSourceIds = new Set(sourceHistory.flat().map((event) => event.eventId));
    const scope = { namespace: run.storage.record.namespace, runId };
    for (const destination of input.destinations) {
      const target = JSON.parse(await readFile(targetPath(directory, destination.id), 'utf8'));
      expect(target.content).toBe(destination.content);
      expect(target.revision).toBe(destination.expectedRevision + 1);
      const mapped = input.mappings.filter((mapping) => mapping.targetId === destination.id);
      expect(JSON.parse(target.content)).toEqual(mapped.map((mapping) => JSON.parse(
        originalSources.find((source) => source.id === mapping.sourceId)!.bytes,
      )));
      const history = await events(targetStream(destination.id));
      expect(history.map((event) => event.type)).toEqual(['safe-change:intent', 'safe-change:result']);
      expect(history.some((event) => allSourceIds.has(event.eventId))).toBe(false);
      const [intent, result] = history;
      expect(result!.payload).toMatchObject({
        actionId: target.lastAction.actionId,
        targetId: destination.id,
        outcome: 'verified',
        protectedFacts: mapped.length,
      });
      expect(intent!.payload).toMatchObject({
        actionId: target.lastAction.actionId,
        proposalDigest: target.lastAction.proposalDigest,
        expectedRevision: destination.expectedRevision,
      });
      expect(result!.payload.before).toEqual(intent!.payload.before);
      expect(result!.payload.backup).toEqual(intent!.payload.backup);
      const backupRef = result!.payload.backup as unknown as ArtifactReference;
      const backupBytes = await run.storage.artifactStore.read(scope, backupRef);
      expect(`sha256:${createHash('sha256').update(backupBytes).digest('hex')}`).toBe(backupRef.digest);
      const backup = JSON.parse(new TextDecoder().decode(backupBytes));
      expect(backup).toEqual({ sources: originalSources, targets: originalTargets });
      const restored = await mkdtemp(join(directory, 'restored-'));
      for (const [kind, records] of [['source', originalSources], ['target', originalTargets]] as const) {
        for (const original of records) {
          const saved = backup[kind === 'source' ? 'sources' : 'targets']
            .find((record: { id: string; bytes: string }) => record.id === original.id);
          const path = join(restored, `${kind}-${original.id}.json`);
          await writeFile(path, saved.bytes);
          expect(await readFile(path)).toEqual(Buffer.from(original.bytes));
        }
      }
      const before = await run.storage.artifactStore.read(scope, result!.payload.before as unknown as ArtifactReference);
      expect(Buffer.from(before)).toEqual(Buffer.from(originalTargets.find(({ id }) => id === destination.id)!.bytes));
      expect(target.lastAction.beforeDigest).toBe(`sha256:${createHash('sha256').update(before).digest('hex')}`);
      expect(target.lastAction.afterDigest).toBe(`sha256:${createHash('sha256').update(destination.content).digest('hex')}`);
      const after = await run.storage.artifactStore.read(scope, result!.payload.after as unknown as ArtifactReference);
      expect(Buffer.from(after)).toEqual(await readFile(targetPath(directory, destination.id)));
    }
    const reopened = await openSafeChangeRun({ directory, runId });
    for (const [index, original] of originalSources.entries()) {
      expect(await readFile(sourcePath(directory, original.id))).toEqual(Buffer.from(original.bytes));
      const history: DomainEventEnvelope[] = [];
      for await (const event of reopened.storage.eventStore.read(sourceStream(original.id))) history.push(event);
      expect(history).toEqual(sourceHistory[index]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
