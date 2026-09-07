import { fork } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, expect, it, vi } from 'vitest';

const approvalDefinition = vi.hoisted(() => ({ version: undefined as number | undefined }));
vi.mock('@obversa/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@obversa/runtime')>();
  return {
    ...actual,
    createApprovalCallbackGate(...[definition, subject]: Parameters<typeof actual.createApprovalCallbackGate>) {
      return actual.createApprovalCallbackGate(approvalDefinition.version === undefined
        ? definition : { ...definition, gateVersion: approvalDefinition.version }, subject);
    },
  };
});
afterEach(() => { approvalDefinition.version = undefined; });

import { openSafeChangeRun } from '../../../examples/safe-change/recipe.js';
import {
  seedSafeChangeFixture, sourcePath, sourceStream, targetPath, targetStream,
} from '../../../examples/safe-change/file-adapter.js';
import type { DomainEventEnvelope, EventStreamRef } from '../src/events/envelope.js';
import type { ArtifactReference } from '../src/artifacts/store.js';
import type { JsonObject } from '../src/graph/value.js';

type SafeChangeRun = Awaited<ReturnType<typeof openSafeChangeRun>>;
type StoredEvent = DomainEventEnvelope<string, number, JsonObject>;
const signal = () => new AbortController().signal;

async function events(run: SafeChangeRun, stream: EventStreamRef): Promise<StoredEvent[]> {
  const values: StoredEvent[] = [];
  for await (const event of run.storage.eventStore.read(stream)) values.push(event as StoredEvent);
  return values;
}

it.each([[0, false, false], [1, false, false], [0, true, false], [0, false, true]] as const)(
  'reconciles outward write %i after SIGKILL without applying it twice (missing witness: %s, changed request: %s)', async (index, missingWitness, changedRequest) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'obversa-safe-change-crash-')));
  const runId = `crash-${index}`;
  let child: ReturnType<typeof fork> | undefined;
  let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  try {
    const input = await seedSafeChangeFixture(directory);
    const selected = input.destinations[index]!;
    const sourceBytes = await Promise.all(input.sourceIds.map((id) => readFile(sourcePath(directory, id))));
    const targetBytes = await Promise.all(input.destinations.map(({ id }) => readFile(targetPath(directory, id))));
    const run = await openSafeChangeRun({ directory, runId, input });
    expect(await run.executor.run(signal())).toMatchObject({ kind: 'pause' });
    const sourceHistory = await Promise.all(input.sourceIds.map((id) => events(run, sourceStream(id))));
    await run.approve();
    const originalApproval = changedRequest ? await run.requestApproval() : null;

    child = fork(fileURLToPath(new URL('./safe-change-crash-fixture.ts', import.meta.url)), [
      directory, runId, selected.id,
    ], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      execArgv: ['--import', import.meta.resolve('tsx')],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.stdout!.resume();
    closed = new Promise((resolve) => child!.once('close', (code, childSignal) => resolve({ code, signal: childSignal })));
    const written = await new Promise<{ actionId: string; targetId: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Target write did not finish: ${stderr}`)), 10_000);
      child!.once('error', (error) => { clearTimeout(timer); reject(error); });
      child!.once('exit', (code, childSignal) => {
        clearTimeout(timer);
        reject(new Error(`Child exited before target write (${code}/${childSignal}): ${stderr}`));
      });
      child!.once('message', (message) => {
        clearTimeout(timer);
        resolve(message as { actionId: string; targetId: string });
      });
    });
    expect(written.targetId).toBe(selected.id);
    expect(child.kill('SIGKILL')).toBe(true);
    expect(await closed).toEqual({ code: null, signal: 'SIGKILL' });
    if (changedRequest) approvalDefinition.version = 2;

    const committedBytes = await readFile(targetPath(directory, selected.id));
    const committed = JSON.parse(committedBytes.toString('utf8'));
    expect(committed).toMatchObject({
      revision: selected.expectedRevision + 1,
      content: selected.content,
      lastAction: { actionId: written.actionId },
    });
    const pendingBytes = missingWitness
      ? Buffer.from(JSON.stringify({ ...committed, lastAction: null }))
      : committedBytes;
    if (missingWitness) await writeFile(targetPath(directory, selected.id), pendingBytes);
    const fresh = await openSafeChangeRun({ directory, runId });
    if (changedRequest) {
      const changedApproval = await fresh.requestApproval();
      expect(changedApproval.requestId).not.toBe(originalApproval!.requestId);
      expect(changedApproval.digest).not.toBe(originalApproval!.digest);
    }
    const targetBefore = await events(fresh, targetStream(selected.id));
    expect(targetBefore.map((event) => event.type)).toEqual(['safe-change:intent']);
    const backup = JSON.parse(new TextDecoder().decode(await fresh.storage.artifactStore.read(
      { namespace: fresh.storage.record.namespace, runId },
      targetBefore[0]!.payload.backup as unknown as ArtifactReference,
    )));
    expect(backup).toEqual({
      sources: input.sourceIds.map((id, sourceIndex) => ({ id, bytes: sourceBytes[sourceIndex]!.toString('utf8') })),
      targets: input.destinations.map(({ id }, targetIndex) => ({ id, bytes: targetBytes[targetIndex]!.toString('utf8') })),
    });
    const restored = await mkdtemp(join(directory, 'restored-after-crash-'));
    for (const [kind, originals] of [['sources', sourceBytes], ['targets', targetBytes]] as const) {
      for (const [recordIndex, record] of (backup[kind] as { id: string; bytes: string }[]).entries()) {
        const path = join(restored, `${kind}-${record.id}.json`);
        await writeFile(path, record.bytes);
        expect(await readFile(path)).toEqual(originals[recordIndex]);
      }
    }
    const position = fresh.actionPositions[index]!;
    expect(await fresh.executor.run(signal())).toMatchObject({ kind: 'waiting', positions: [position] });
    expect(await fresh.executor.resume(position, signal())).toMatchObject({ kind: 'pause' });
    const recoveryEvents = await events(fresh, { namespace: fresh.storage.record.namespace, streamId: runId });
    const started = recoveryEvents.find((event) => event.type === 'graph:node-attempt-started'
      && (event.payload.identity as JsonObject).position === position)!;
    expect(recoveryEvents.find((event) => event.type === 'graph:node-paused' && event.payload.position === position)?.payload)
      .toMatchObject({ request: { kind: 'reconcile-attempt', attemptId: (started.payload.identity as JsonObject).attemptId } });
    expect(await readFile(targetPath(directory, selected.id))).toEqual(pendingBytes);
    expect(await events(fresh, targetStream(selected.id))).toEqual(targetBefore);

    if (changedRequest) {
      const next = input.destinations[1]!;
      const nextBefore = await readFile(targetPath(directory, next.id));
      expect(await fresh.executor.resume(position, signal())).toMatchObject({ kind: 'pause' });
      const after = await events(fresh, { namespace: fresh.storage.record.namespace, streamId: runId });
      expect(after.some((event) => event.type === 'graph:node-completed' && event.payload.position === position)).toBe(false);
      expect((await events(fresh, targetStream(selected.id))).some((event) => event.payload.outcome === 'verified')).toBe(false);
      expect(await readFile(targetPath(directory, selected.id))).toEqual(committedBytes);
      expect(await readFile(targetPath(directory, next.id))).toEqual(nextBefore);
      expect(await events(fresh, targetStream(next.id))).toEqual([]);
      return;
    }

    if (missingWitness) {
      const next = input.destinations[1]!;
      const nextBefore = await readFile(targetPath(directory, next.id));
      expect(await fresh.executor.resume(position, signal())).toMatchObject({ kind: 'pause' });
      expect(await readFile(targetPath(directory, selected.id))).toEqual(pendingBytes);
      expect(await readFile(targetPath(directory, next.id))).toEqual(nextBefore);
      expect(await events(fresh, targetStream(next.id))).toEqual([]);
      expect((await events(fresh, targetStream(selected.id))).some((event) => event.payload.outcome === 'verified')).toBe(false);
      await writeFile(targetPath(directory, selected.id), committedBytes);
      const repaired = await openSafeChangeRun({ directory, runId });
      expect(await repaired.executor.resume(position, signal())).toMatchObject({ kind: 'pause' });
      expect(await readFile(targetPath(directory, selected.id))).toEqual(committedBytes);
      expect(await readFile(targetPath(directory, next.id))).toEqual(nextBefore);
      expect(await events(repaired, targetStream(next.id))).toEqual([]);
      return;
    }

    const recovered = await fresh.executor.resume(position, signal());
    expect(await readFile(targetPath(directory, selected.id))).toEqual(committedBytes);
    expect(recovered).toMatchObject({ kind: 'complete' });
    const completedTargets = await Promise.all(input.destinations.map(async (destination) => {
      const bytes = await readFile(targetPath(directory, destination.id));
      const target = JSON.parse(bytes.toString('utf8'));
      expect(target.revision).toBe(destination.expectedRevision + 1);
      expect(target.content).toBe(destination.content);
      const records = JSON.parse(target.content);
      expect(records).toEqual(input.mappings.filter((mapping) => mapping.targetId === destination.id)
        .map((mapping) => JSON.parse(sourceBytes[input.sourceIds.indexOf(mapping.sourceId)]!.toString('utf8'))));
      const history = await events(fresh, targetStream(destination.id));
      expect(history.map((event) => event.type)).toEqual(['safe-change:intent', 'safe-change:result']);
      expect(history[1]!.payload).toMatchObject({ actionId: target.lastAction.actionId, outcome: 'verified' });
      return { bytes, history };
    }));
    for (const [sourceIndex, id] of input.sourceIds.entries()) {
      expect(await readFile(sourcePath(directory, id))).toEqual(sourceBytes[sourceIndex]);
      expect(await events(fresh, sourceStream(id))).toEqual(sourceHistory[sourceIndex]);
    }
    const graphStream = { namespace: fresh.storage.record.namespace, streamId: runId };
    const graphBeforeReplay = await events(fresh, graphStream);
    const replay = await openSafeChangeRun({ directory, runId });
    expect(await replay.executor.run(signal())).toMatchObject({ kind: 'complete' });
    expect(await events(replay, graphStream)).toEqual(graphBeforeReplay);
    for (const [targetIndex, destination] of input.destinations.entries()) {
      expect(await readFile(targetPath(directory, destination.id))).toEqual(completedTargets[targetIndex]!.bytes);
      expect(await events(replay, targetStream(destination.id))).toEqual(completedTargets[targetIndex]!.history);
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (closed) await closed;
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it.each(['changed content', 'malformed JSON'] as const)(
  'keeps a recorded readback mismatch paused after bytes are repaired and plain resume is called (%s)', async (damage) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'obversa-safe-change-mismatch-')));
  const runId = 'readback-mismatch';
  try {
    const input = await seedSafeChangeFixture(directory);
    const first = input.destinations[0]!;
    const second = input.destinations[1]!;
    const secondBefore = await readFile(targetPath(directory, second.id));
    let approvedBytes: Buffer | undefined;
    const run = await openSafeChangeRun({ directory, runId, input, hooks: {
      async afterTargetWrite(_actionId, targetId) {
        if (targetId !== first.id) return;
        approvedBytes = await readFile(targetPath(directory, targetId));
        if (damage === 'malformed JSON') {
          await writeFile(targetPath(directory, targetId), '{"incomplete":');
        } else {
          const target = JSON.parse(approvedBytes.toString('utf8'));
          target.content = '[]';
          await writeFile(targetPath(directory, targetId), JSON.stringify(target));
        }
      },
    } });
    expect(await run.executor.run(signal())).toMatchObject({ kind: 'pause' });
    await run.approve();
    expect(await run.executor.resume(run.approvalPosition, signal())).toMatchObject({ kind: 'pause' });
    const history = await events(run, targetStream(first.id));
    expect(history.find((event) => event.type === 'safe-change:result')?.payload).toMatchObject({ outcome: 'mismatch' });
    expect(await readFile(targetPath(directory, second.id))).toEqual(secondBefore);
    expect(await events(run, targetStream(second.id))).toEqual([]);
    expect(approvedBytes).toBeDefined();
    await writeFile(targetPath(directory, first.id), approvedBytes!);
    const reopened = await openSafeChangeRun({ directory, runId });
    expect(await reopened.executor.resume(reopened.verificationPositions[0]!, signal())).toMatchObject({ kind: 'pause' });
    expect(await events(reopened, targetStream(first.id))).toEqual(history);
    expect(await events(reopened, targetStream(second.id))).toEqual([]);
    expect(await readFile(targetPath(directory, second.id))).toEqual(secondBefore);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('fails when readback cannot run instead of recording a content-mismatch pause', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'obversa-safe-change-read-error-')));
  const runId = 'readback-error';
  try {
    const input = await seedSafeChangeFixture(directory);
    const first = input.destinations[0]!;
    const second = input.destinations[1]!;
    const secondBefore = await readFile(targetPath(directory, second.id));
    const run = await openSafeChangeRun({ directory, runId, input, hooks: {
      async afterTargetWrite(_actionId, targetId) {
        if (targetId === first.id) await rm(targetPath(directory, targetId));
      },
    } });
    expect(await run.executor.run(signal())).toMatchObject({ kind: 'pause' });
    await run.approve();
    expect(await run.executor.resume(run.approvalPosition, signal())).toMatchObject({ kind: 'fail' });
    expect(await readFile(targetPath(directory, second.id))).toEqual(secondBefore);
    expect(await events(run, targetStream(second.id))).toEqual([]);
    expect((await events(run, targetStream(first.id))).some((event) => event.payload.outcome === 'mismatch')).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(['source', 'target version', 'destination activity'] as const)(
  'rechecks %s after the first action and refuses a second write', async (drift) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'obversa-safe-change-recheck-')));
    const runId = 'per-action-recheck';
    try {
      const input = await seedSafeChangeFixture(directory);
      const first = input.destinations[0]!;
      const second = input.destinations[1]!;
      let secondAfterDrift: Buffer | undefined;
      const run = await openSafeChangeRun({ directory, runId, input, hooks: {
        async afterTargetWrite(_actionId, targetId) {
          if (targetId !== first.id) return;
          if (drift === 'source') {
            const path = sourcePath(directory, input.sourceIds.at(-1)!);
            const source = JSON.parse(await readFile(path, 'utf8'));
            source.body += '\nA changed historical entry.';
            await writeFile(path, JSON.stringify(source));
          } else {
            const path = targetPath(directory, second.id);
            const target = JSON.parse(await readFile(path, 'utf8'));
            if (drift === 'target version') target.revision += 1;
            else target.active = false;
            await writeFile(path, JSON.stringify(target));
          }
          secondAfterDrift = await readFile(targetPath(directory, second.id));
        },
      } });
      expect(await run.executor.run(signal())).toMatchObject({ kind: 'pause' });
      await run.approve();
      expect(await run.executor.resume(run.approvalPosition, signal())).toMatchObject({ kind: 'fail' });
      expect(secondAfterDrift).toBeDefined();
      expect(await readFile(targetPath(directory, second.id))).toEqual(secondAfterDrift);
      expect((await events(run, targetStream(first.id))).find((event) => event.type === 'safe-change:result')?.payload)
        .toMatchObject({ outcome: 'verified' });
      expect((await events(run, targetStream(second.id))).some((event) => event.type === 'safe-change:result')).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
