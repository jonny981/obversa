import { fork } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import type { DomainEventEnvelope } from '../src/events/envelope.ts';
import type { ExecutionTarget } from '../src/graph/plan.ts';
import type { JsonObject } from '../src/graph/value.ts';
import { createGraphExecutor } from '../src/runtime/graph-executor.ts';
import {
  crashFixture, reviewerTargets, runId, writerPosition, writerTarget,
} from './graph-types-loop-crash-fixture.ts';

const identity = ({ adapter, provider, modelFamily, model }: ExecutionTarget) => ({
  adapter, provider, modelFamily, model,
});

it('resumes an engine-backed writer killed before its receipt and completes with distinct reviewers', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'obversa-writer-crash-')));
  const child = fork(fileURLToPath(new URL('./graph-types-loop-crash-fixture.ts', import.meta.url)), [
    '--writer-crash', root,
  ], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    execArgv: ['--import', import.meta.resolve('tsx')],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Writer did not enter engine.run: ${stderr}`)), 10_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`Writer exited before readiness (${code}/${signal}): ${stderr}`));
      });
      child.once('message', (message) => {
        clearTimeout(timer);
        if (message !== 'writer-engine-entered') reject(new Error(`Unexpected writer marker: ${String(message)}`));
        else resolve();
      });
    });
    expect(child.kill('SIGKILL')).toBe(true);
    expect(await closed).toEqual({ code: null, signal: 'SIGKILL' });

    const calls: string[] = [];
    const fixture = crashFixture(root, calls);
    const readEvents = async (): Promise<DomainEventEnvelope[]> => {
      const events: DomainEventEnvelope[] = [];
      for await (const event of fixture.storage.eventStore.read({
        namespace: fixture.storage.record.namespace, streamId: runId,
      })) events.push(event);
      return events;
    };
    const before = await readEvents();
    expect(before.map((event) => event.type)).toEqual([
      'graph:run-started', 'graph:node-dispatched', 'graph:node-attempt-started',
    ]);
    expect(before.at(-1)!.payload).toMatchObject({ retrySafe: true });

    const fresh = await createGraphExecutor(fixture);
    const outcome = await fresh.resume(writerPosition, new AbortController().signal);
    expect(outcome).toMatchObject({
      kind: 'complete', output: { seats: { 'seat-0': 'accepted', 'seat-1': 'accepted' } },
    });
    expect(calls).toEqual([writerTarget.model, ...reviewerTargets.map((target) => target.model)]);
    const after = await readEvents();
    const receipts = after.filter((event) => event.type === 'graph:engine-attempt-recorded');
    expect(receipts.map((event) => ({ version: event.version, payload: event.payload }))).toEqual([
      { version: 1, payload: {
        nodeId: 'generator', position: writerPosition, sequence: 1, requested: null, effective: null,
      } },
      { version: 1, payload: {
        nodeId: 'generator', position: writerPosition, sequence: 2,
        requested: identity(writerTarget), effective: identity(writerTarget),
      } },
      ...reviewerTargets.map((target, index) => ({ version: 1, payload: {
        nodeId: `seat-${index}`, position: `review/1/seat-${index}/1`, sequence: 1,
        requested: identity(target), effective: identity(target),
      } })),
    ]);
    expect(after.filter((event) => event.type === 'graph:node-dispatched'
      && (event.payload as JsonObject).nodeId === 'generator')).toHaveLength(1);

    const replayed = await createGraphExecutor(crashFixture(root, calls));
    await expect(replayed.run(new AbortController().signal)).resolves.toEqual(outcome);
    expect(calls).toHaveLength(3);
    expect(await readEvents()).toEqual(after);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
