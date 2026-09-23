import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  compileGraph, convergence, createGitWorktreeProvider, dagGraphType,
  resolveGraphPlan,
} from '@obversa/runtime';
import { startSupervisedRun, type SupervisedRunHandle } from '../src/index.js';
import { createLocalRunStorage } from '@obversa/runtime/storage/local';
import { cleanupRepos, tmpRepo } from './git-helpers.js';
import { supervisionStream } from '../src/supervised-record.js';

const commandEvidence = vi.hoisted(() => ({ calls: 0, failures: [] as unknown[] }));
vi.mock('@obversa/core/command', async (importOriginal) => {
  const original = await importOriginal<typeof import('@obversa/core/command')>();
  return {
    ...original,
    runOwnedCommand: async (...args: Parameters<typeof original.runOwnedCommand>) => {
      commandEvidence.calls += 1;
      try { return await original.runOwnedCommand(...args); }
      catch (error) {
        if (error instanceof original.OwnedCommandError && commandEvidence.failures.length < 4) {
          commandEvidence.failures.push({
            code: error.code, message: error.message.slice(0, 500),
            stack: error.stack?.split('\n').slice(0, 6).join('\n').slice(0, 1_500),
            remainingProcesses: error.remainingProcesses.slice(0, 16),
          });
        }
        throw error;
      }
    },
  };
});

// Real work: these tests create temporary Git repositories and write files
// to disk, so this file declares its own time limit; the suite default is a
// hang guard, not a speed bar.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const roots: string[] = [];
const handles: SupervisedRunHandle[] = [];
const policy = {
  schemaVersion: 1, maxEventPayloadBytes: 128_000, maxAppendBatchBytes: 256_000,
  maxArtifactBytes: 1_000_000, maxTotalArtifactBytesPerRun: 4_000_000,
  retention: 'until-run-delete',
  sensitiveContent: { marked: 'reject', exact: 'reject', freeText: 'redact-before-hash' },
} as const;

afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.stop()));
  cleanupRepos();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function graphFor(form: 'dag' | 'convergence') {
  if (form === 'dag') return compileGraph(dagGraphType, {
    id: 'crash-dag', definitionVersion: 1,
    data: { globalConcurrency: 1, keyedConcurrency: {}, stopOnError: true, retryCapPerNode: 0 },
    nodes: ['first', 'last'].map((id) => ({ id, data: { kind: 'required' as const, key: null } })),
    edges: [{ id: 'next', source: 'first', target: 'last', data: {} }],
  });
  return compileGraph(convergence, {
    id: 'crash-convergence', definitionVersion: 1,
    data: {
      maxIterations: 1, maxReviewRestarts: 0, quorum: 1, requireDiversity: false,
      skippableSeats: [], seatConcurrency: 1, retryCapPerNode: 0,
    },
    nodes: (['generator', 'evaluator', 'seat', 'repair'] as const).map((id) => ({ id, data: { role: id } })),
    edges: [
      { id: 'evaluate', source: 'generator', target: 'evaluator', data: {} },
      { id: 'review', source: 'evaluator', target: 'seat', data: {} },
    ],
  });
}

describe.each(['dag', 'convergence'] as const)('supervised %s crash recovery', (form) => {
  it.each([1, 2, 3, 4])('preserves outward effects across D10 boundary %i', async (boundary) => {
    commandEvidence.calls = 0;
    commandEvidence.failures.length = 0;
    const root = await realpath(await mkdtemp(join(tmpdir(), 'obversa-supervised-crash-')));
    roots.push(root);
    const runRoot = await realpath(await tmpRepo());
    await mkdir(join(runRoot, 'node_modules/@obversa'), { recursive: true });
    await symlink(dirname(fileURLToPath(import.meta.resolve('@obversa/runtime/package.json'))), join(runRoot, 'node_modules/@obversa/runtime'));
    await writeFile(join(runRoot, '.gitignore'), 'node_modules/\n');
    await writeFile(join(runRoot, 'host.mjs'), await readFile(new URL('./fixtures/supervised-crash-host.mjs', import.meta.url)));
    const graph = graphFor(form);
    const identity = { source: 'file:host.mjs', version: '1.0.0', digest: `sha256:${'3'.repeat(64)}` } as const;
    const resolvedPlan = resolveGraphPlan(graph.describe(), {
      package: identity, admission: { package: identity, permissions: [] }, executionLanes: [],
    });
    const storage = { directory: join(root, 'storage'), namespace: 'crash-tests', policy };
    const directory = join(root, 'runner');
    const handle = await startSupervisedRun({
      directory, runRoot, module: './host.mjs', storage,
      workspace: createGitWorktreeProvider({ repositoryPath: runRoot }),
      definition: {
        runId: 'crash', graphDefinition: graph.definition, resolvedPlan,
        resolvedInputs: { form, boundary, storage },
      },
      limits: { timeoutMs: 30_000, maxDispatches: 10 },
      restart: { maxRestarts: 1, initialBackoffMs: 10, maxBackoffMs: 50 },
      teardownGraceMs: 100,
    });
    handles.push(handle);
    const result = await handle.done;
    if (result.kind !== (boundary === 3 ? 'pause' : 'complete')) {
      try {
        const records = [];
        for await (const event of createLocalRunStorage(storage).eventStore.read({
          namespace: storage.namespace, streamId: supervisionStream('crash'),
        })) {
          const payload = event.payload as Record<string, unknown>;
          records.push({
            type: event.type, revision: event.revision, timestamp: event.timestamp,
            cleanupSafe: payload.cleanupSafe, leaseRetained: payload.leaseRetained,
            remainingProcesses: payload.remainingProcesses, restartCount: payload.restartCount,
            exitCode: payload.exitCode,
          });
          if (records.length === 32) break;
        }
        // Only this fixed fixture's lifecycle and process identities; no env, prompts or output.
        console.error('Supervised crash evidence:', JSON.stringify({
          form, boundary, platform: process.platform, arch: process.arch,
          node: process.version, commandEvidence, records,
        }).slice(0, 16_384));
      } catch {
        console.error('Supervised crash evidence unavailable:', JSON.stringify({ form, boundary }));
      }
    }
    expect(commandEvidence.calls).toBeGreaterThan(0);
    expect(result, JSON.stringify(result)).toMatchObject({ kind: boundary === 3 ? 'pause' : 'complete' });
    const status = await handle.status();
    expect(status.restartCount).toBe(1);
    expect(status.workerAlive).toBe(false);
    expect(status.phase).toBe(boundary === 3 ? 'paused' : 'completed');

    const crash = JSON.parse(await readFile(join(directory, 'scratch/crash.json'), 'utf8'));
    expect(crash.boundary).toBe(boundary);
    expect(crash.types).toEqual([
      ['graph:run-started'],
      ['graph:run-started', 'graph:node-dispatched'],
      ['graph:run-started', 'graph:node-dispatched', 'graph:node-attempt-started'],
      ['graph:run-started', 'graph:node-dispatched', 'graph:node-attempt-started', 'graph:node-completed'],
    ][boundary - 1]);
    expect(crash.effects).toHaveLength(boundary < 3 ? 0 : 1);
    expect(() => process.kill(crash.pid, 0)).toThrow();
    const effects = (await readFile(join(directory, 'scratch/effects.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const expectedNodes = form === 'dag' ? ['first', 'last'] : ['generator', 'evaluator', 'seat'];
    expect(effects.map((effect) => effect.nodeId)).toEqual(boundary === 3 ? expectedNodes.slice(0, 1) : expectedNodes);

    const events = [];
    for await (const event of createLocalRunStorage(storage).eventStore.read({ namespace: storage.namespace, streamId: 'crash' })) events.push(event);
    const dispatches = events.filter((event) => event.type === 'graph:node-dispatched');
    expect(dispatches.map((event) => (event.payload as { nodeId: string }).nodeId)).toEqual(boundary === 3 ? expectedNodes.slice(0, 1) : expectedNodes);
    expect(events.filter((event) => event.type === 'graph:node-failed')).toEqual([]);
    const completed = events.filter((event) => event.type === 'graph:node-completed');
    expect(completed.map((event) => (event.payload as { nodeId: string }).nodeId)).toEqual(boundary === 3 ? [] : expectedNodes);
    const paused = events.filter((event) => event.type === 'graph:node-paused');
    if (boundary === 3) {
      expect(paused).toHaveLength(1);
      expect(paused[0]!.payload).toMatchObject({ request: { kind: 'reconcile-attempt' } });
      expect(events.filter((event) => event.type === 'graph:node-resumed')).toEqual([]);
    } else expect(paused).toEqual([]);
  }, 40_000);
});
