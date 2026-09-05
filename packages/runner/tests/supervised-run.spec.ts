import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectOwnedProcessTree } from '@obversa/engine/command';

import * as runtime from '@obversa/runtime';
import * as runner from '../src/index.js';
import { createLocalRunStorage } from '@obversa/runtime/storage/local';
import { readSupervision, supervisionWriter } from '../src/supervised-record.js';
import { tmpRepo, cleanupRepos } from './git-helpers.js';

const roots: string[] = [];
const handles: runner.SupervisedRunHandle[] = [];
const policy = {
  schemaVersion: 1,
  maxEventPayloadBytes: 128_000,
  maxAppendBatchBytes: 256_000,
  maxArtifactBytes: 1_000_000,
  maxTotalArtifactBytesPerRun: 4_000_000,
  retention: 'until-run-delete',
  sensitiveContent: { marked: 'reject', exact: 'reject', freeText: 'redact-before-hash' },
} as const;

async function fixture(withEngine = false, nodeCount = 2) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'obversa-supervised-')));
  roots.push(root);
  const runRoot = await realpath(await tmpRepo());
  await mkdir(join(runRoot, 'node_modules/@obversa'), { recursive: true });
  await symlink(dirname(fileURLToPath(import.meta.resolve('@obversa/runtime/package.json'))), join(runRoot, 'node_modules/@obversa/runtime'));
  await writeFile(join(runRoot, '.gitignore'), 'node_modules/\n');
  await writeFile(join(runRoot, 'host.mjs'), await readFile(new URL('./fixtures/supervised-host.mjs', import.meta.url)));
  const target = { adapter: 'fixture', provider: 'fixture', modelFamily: 'fixture', model: 'fixture', tools: [] };
  const lane = { id: 'fixture-engine', requested: target, knownSubstitutions: [] };
  const graph = runtime.compileGraph(runtime.dagGraphType, {
    id: 'runner-fixture', definitionVersion: 1,
    data: { globalConcurrency: 1, keyedConcurrency: {}, stopOnError: true, retryCapPerNode: 0 },
    nodes: (nodeCount === 2 ? ['first', 'last'] : Array.from({ length: nodeCount }, (_, index) => `node-${index}`))
      .map((id) => ({ id, data: { kind: 'required' as const, key: null, ...(withEngine ? { lane } : {}) } })),
    edges: nodeCount === 2 ? [{ id: 'next', source: 'first', target: 'last', data: {} }] : [],
  });
  const identity = { source: 'file:host.mjs', version: '1.0.0', digest: `sha256:${'1'.repeat(64)}` } as const;
  const resolvedPlan = runtime.resolveGraphPlan(graph.describe(), {
    package: identity, admission: { package: identity, permissions: [] },
    executionLanes: withEngine ? [{ id: lane.id, effective: target }] : [],
  });
  const storage = { directory: join(root, 'storage'), namespace: 'runner-tests', policy };
  return {
    root,
    options: {
      directory: join(root, 'runner'), runRoot, module: './host.mjs', storage,
      workspace: runtime.createGitWorktreeProvider({ repositoryPath: runRoot }),
      definition: { runId: 'fixture', graphDefinition: graph.definition, resolvedPlan, resolvedInputs: {} },
      limits: { timeoutMs: 20_000, maxDispatches: 10 },
      restart: { maxRestarts: 2, initialBackoffMs: 10, maxBackoffMs: 50 },
      teardownGraceMs: 100,
    },
  };
}

async function startFixture(options: runner.SupervisedRunOptions) {
  const handle = await runner.startSupervisedRun(options);
  handles.push(handle);
  return handle;
}

async function nodeStarted(directory: string, node = 'first') {
  const path = join(directory, 'scratch', `${node}.started`);
  await expect.poll(() => readFile(path, 'utf8').catch(() => ''), { timeout: 5_000 }).not.toBe('');
  const pid = Number((await readFile(path, 'utf8')).trim().split('\n').at(-1));
  return pid;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(handles.splice(0).map((handle) => handle.stop()));
  cleanupRepos();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('supervised local runs', () => {
  it('a failed workspace capture starts no node and creates no partial run', async () => {
    const { root, options } = await fixture();
    const start = Reflect.get(runner, 'startSupervisedRun');
    expect(start).toBeTypeOf('function');
    const notARepository = join(root, 'not-a-repository');
    await mkdir(notARepository);

    await expect(start({
      ...options,
      workspace: runtime.createGitWorktreeProvider({ repositoryPath: notARepository }),
    })).rejects.toMatchObject({ code: 'WORKSPACE_CAPTURE' });

    const store = createLocalRunStorage(options.storage);
    const events = [];
    for await (const event of store.eventStore.read({ namespace: 'runner-tests', streamId: 'fixture' })) events.push(event);
    expect(events).toEqual([]);
    expect(await readdir(options.storage.directory).catch(() => [])).toEqual([]);
    expect(await readdir(join(options.directory, 'scratch')).catch(() => [])).toEqual([]);
  });

  it('starts from the stored definition and completes real node work', async () => {
    const { options } = await fixture();
    const start = Reflect.get(runner, 'startSupervisedRun');
    expect(start).toBeTypeOf('function');
    const handle = await start(options);
    const result = await handle.done;
    expect(result, JSON.stringify(result)).toMatchObject({ kind: 'complete' });
    const status = await handle.status();
    expect(status.phase).toBe('completed');
    expect(status.restartCount).toBe(0);
    expect(status.workerAlive).toBe(false);
    const store = createLocalRunStorage(options.storage);
    const events = [];
    for await (const event of store.eventStore.read({ namespace: 'runner-tests', streamId: 'fixture' })) events.push(event);
    expect(events.filter((event) => event.type === 'graph:node-completed').map((event) => event.payload)).toEqual([
      { nodeId: 'first', position: 'dag/first/1', result: { node: 'first', value: 'original' } },
      { nodeId: 'last', position: 'dag/last/1', result: { node: 'last', value: 'original' } },
    ]);
  });

  it('a second start on the same run is refused by the process lock', async () => {
    const { options } = await fixture();
    const slow = { ...options, definition: { ...options.definition, resolvedInputs: { delayMs: 250 } } };
    const handle = await startFixture(slow);
    await nodeStarted(options.directory);
    await expect(runner.startSupervisedRun({ ...slow, directory: `${options.directory}-other` }))
      .rejects.toMatchObject({ code: 'PROCESS_LOCKED' });
    await expect(handle.done).resolves.toMatchObject({ kind: 'complete' });
  });

  it('a completed DAG whose aggregate results exceed the event payload limit completes', async () => {
    const { options } = await fixture(false, 10);
    const handle = await startFixture({
      ...options, definition: { ...options.definition, resolvedInputs: { resultBytes: 15_000 } },
    });
    const result = await handle.done;
    const storage = createLocalRunStorage(options.storage);
    const completed = [];
    for await (const event of storage.eventStore.read({ namespace: 'runner-tests', streamId: 'fixture' })) {
      if (event.type === 'graph:node-completed') completed.push(event);
    }
    expect(completed).toHaveLength(10);
    expect(completed.every((event) => Buffer.byteLength(JSON.stringify(event.payload)) < 128_000)).toBe(true);
    const output = { nodes: Object.fromEntries(Array.from({ length: 10 }, (_, index) => [
      `node-${index}`, { node: `node-${index}`, value: 'x'.repeat(15_000) },
    ])) };
    expect(Buffer.byteLength(JSON.stringify(output))).toBeGreaterThan(128_000);
    expect(result.kind, JSON.stringify(result.kind === 'fail' ? result : { kind: result.kind })).toBe('complete');
    expect(result).toEqual({ kind: 'complete', output });
    expect((await handle.status()).phase).toBe('completed');
    const terminal = (await readSupervision(storage, 'fixture'))
      .filter((event) => ['runner:worker-result', 'runner:completed'].includes(event.type));
    expect(terminal).toHaveLength(2);
    expect(terminal.every((event) => Buffer.byteLength(JSON.stringify(event.payload)) < 128_000)).toBe(true);
    const references = terminal.map((event) => runtime.validateArtifactReference((event.payload as runtime.JsonObject).outputArtifact));
    expect(references[0]).toEqual(references[1]);
    const bytes = await storage.artifactStore.read(
      { namespace: 'runner-tests', runId: 'fixture' }, references[0]!,
    );
    expect(JSON.parse(Buffer.from(bytes).toString('utf8'))).toEqual(output);
  });

  it('a terminal artifact whose digest does not match is a typed failure, not a silent result', async () => {
    const { options } = await fixture();
    const storage = createLocalRunStorage(options.storage);
    const artifactPrototype = Object.getPrototypeOf(storage.artifactStore) as typeof storage.artifactStore;
    const read = artifactPrototype.read;
    let corrupted = false;
    vi.spyOn(artifactPrototype, 'read').mockImplementation(async function (this: typeof storage.artifactStore, scope, reference) {
      if (reference.purpose === 'runner-output') {
        const artifactRoot = join(options.storage.directory, 'artifacts');
        const files = await readdir(artifactRoot, { recursive: true });
        const blob = files.find((file) => file.endsWith(`/blobs/${reference.digest.slice('sha256:'.length)}`));
        if (blob === undefined) throw new Error('The terminal artifact was not written.');
        const path = join(artifactRoot, blob);
        const bytes = await readFile(path);
        const valueOffset = bytes.indexOf('original');
        expect(valueOffset).toBeGreaterThanOrEqual(0);
        bytes[valueOffset] = 't'.charCodeAt(0);
        expect(() => JSON.parse(bytes.toString('utf8'))).not.toThrow();
        await chmod(path, 0o600);
        await writeFile(path, bytes);
        corrupted = true;
      }
      return await read.call(this, scope, reference);
    });
    const handle = await startFixture(options);
    await expect(handle.done).resolves.toMatchObject({ kind: 'fail', code: 'TERMINAL_ARTIFACT' });
    expect(corrupted).toBe(true);
    expect((await handle.status()).phase).toBe('failed');
    const events = await readSupervision(storage, 'fixture');
    expect(events.some((event) => event.type === 'runner:completed')).toBe(false);
    expect(events.at(-1)?.payload).toMatchObject({ kind: 'fail', code: 'TERMINAL_ARTIFACT' });
    const lease = await options.workspace.acquireLease('after-corruption', 'fixture', await options.workspace.capture());
    expect(lease.ok).toBe(true);
    if (lease.ok) await options.workspace.releaseLease(lease.token);
    expect(await readdir(join(options.storage.directory, 'runner-locks/runner-tests'))).toEqual([]);
  });

  it('a 200 KB engine success under a 128000 event policy completes the node', async () => {
    const { options } = await fixture(true);
    const handle = await startFixture({
      ...options, definition: { ...options.definition, resolvedInputs: { enginePartBytes: 200_000, resultBytes: 70_000 } },
    });
    const result = await handle.done;
    expect(result.kind, JSON.stringify(result.kind === 'fail' ? result : { kind: result.kind })).toBe('complete');
    expect(result).toEqual({ kind: 'complete', output: { nodes: {
      first: { node: 'first', value: 'z'.repeat(70_000) },
      last: { node: 'last', value: 'z'.repeat(70_000) },
    } } });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(128_000);
    const storage = createLocalRunStorage(options.storage);
    const events = [];
    for await (const event of storage.eventStore.read({ namespace: 'runner-tests', streamId: 'fixture' })) events.push(event);
    expect(events.filter((event) => event.type === 'graph:node-completed')).toHaveLength(2);
    const supervision = await readSupervision(storage, 'fixture');
    expect([...events, ...supervision].every((event) => Buffer.byteLength(JSON.stringify(event.payload)) <= 128_000)).toBe(true);
    const engineEvents = supervision.filter((event) => event.type === 'runner:engine-completed');
    expect(engineEvents).toHaveLength(2);
    for (const event of engineEvents) {
      expect(event.payload).not.toHaveProperty('parts');
      const reference = runtime.validateArtifactReference((event.payload as runtime.JsonObject).partsArtifact);
      const bytes = await storage.artifactStore.read({ namespace: 'runner-tests', runId: 'fixture' }, reference);
      expect(JSON.parse(Buffer.from(bytes).toString('utf8'))).toEqual([{ kind: 'assistant', text: 'z'.repeat(200_000), final: true }]);
    }
    expect((await handle.status()).phase).toBe('completed');
  });

  it('stop kills the worker, records the stop, and releases the workspace', async () => {
    const { options } = await fixture();
    const handle = await startFixture({
      ...options, definition: { ...options.definition, resolvedInputs: { delayMs: 4_000 } },
    });
    const pid = await nodeStarted(options.directory);
    await handle.stop();
    await expect(handle.done).resolves.toMatchObject({ kind: 'fail', code: 'STOPPED' });
    expect(() => process.kill(pid, 0)).toThrow();
    const lease = await options.workspace.acquireLease('after-stop', 'fixture', await options.workspace.capture());
    expect(lease.ok).toBe(true);
    if (lease.ok) await options.workspace.releaseLease(lease.token);
  });

  it('a long fixture survives runner restart and continues from events', async () => {
    const { options } = await fixture();
    const handle = await startFixture({
      ...options, definition: { ...options.definition, resolvedInputs: { delayMs: 200 } },
    });
    process.kill(await nodeStarted(options.directory, 'last'), 'SIGKILL');
    await expect(handle.done).resolves.toMatchObject({ kind: 'complete' });
    expect((await handle.status()).restartCount).toBe(1);
    expect((await readFile(join(options.directory, 'scratch/first.started'), 'utf8')).trim().split('\n')).toHaveLength(1);
    expect((await readFile(join(options.directory, 'scratch/last.started'), 'utf8')).trim().split('\n')).toHaveLength(2);
  });

  it('a forced runner death is detected by the watchdog which sweeps an observed detached child before capture release and restart', async () => {
    const { options } = await fixture();
    let childPid: number | undefined;
    let held: string | undefined;
    let captures = 0;
    let acquisitions = 0;
    const order: string[] = [];
    const workspace: runtime.WorkspaceProvider = {
      ...options.workspace,
      capture: async (...args) => {
        captures += 1;
        if (captures > 1) {
          expect(held).toBeDefined();
          expect(() => process.kill(childPid!, 0)).toThrow();
          order.push('capture after sweep');
        }
        return await options.workspace.capture(...args);
      },
      acquireLease: async (...args) => {
        acquisitions += 1;
        if (acquisitions > 1) {
          expect(held).toBeUndefined();
          order.push('reacquire');
        }
        const lease = await options.workspace.acquireLease(...args);
        if (lease.ok) held = lease.token;
        return lease;
      },
      releaseLease: async (token) => {
        expect(token).toBe(held);
        if (acquisitions === 1) {
          const records = await readSupervision(createLocalRunStorage(options.storage), 'fixture');
          expect(records.at(-1)?.type).toBe('runner:restart-anchor');
          expect(() => process.kill(childPid!, 0)).toThrow();
          order.push('release recorded anchor');
        }
        const released = await options.workspace.releaseLease(token);
        if (released.ok) held = undefined;
        return released;
      },
    };
    const handle = await startFixture({
      ...options, workspace, definition: { ...options.definition, resolvedInputs: { child: true, detachedChild: true, delayMs: 700 } },
    });
    const pid = await nodeStarted(options.directory);
    await expect.poll(() => readFile(join(options.directory, 'scratch/first.child'), 'utf8').catch(() => '')).not.toBe('');
    childPid = Number((await readFile(join(options.directory, 'scratch/first.child'), 'utf8')).trim());
    await expect.poll(async () => (await handle.status()).processes.some((item) => item.pid === childPid)).toBe(true);
    await delay(150); // Give the watchdog's own ancestry sampler an observation before detachment loses the parent.
    process.kill(pid, 'SIGKILL');
    await expect(handle.done).resolves.toMatchObject({ kind: 'complete' });
    expect(order).toEqual(['capture after sweep', 'release recorded anchor', 'reacquire']);
    expect(acquisitions).toBe(2);
    expect((await handle.status()).restartCount).toBe(1);
  });

  it('a restart with changed host-module bytes is refused typed', async () => {
    const { options } = await fixture();
    const handle = await startFixture({
      ...options, definition: { ...options.definition, resolvedInputs: { delayMs: 200 } },
    });
    const pid = await nodeStarted(options.directory);
    const modulePath = join(options.runRoot, 'host.mjs');
    await writeFile(modulePath, (await readFile(modulePath, 'utf8')).replace("const value = 'original'", "const value = 'edited'"));
    process.kill(pid, 'SIGKILL');
    await expect(handle.done).resolves.toMatchObject({ kind: 'fail', code: 'HOST_MODULE_CHANGED' });
    expect((await readFile(join(options.directory, 'scratch/first.started'), 'utf8')).trim().split('\n')).toHaveLength(1);
    await expect(readFile(join(options.directory, 'scratch/last.started'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it("an edit after import leaves the running worker's bindings unchanged", async () => {
    const { options } = await fixture();
    const handle = await startFixture({
      ...options, definition: { ...options.definition, resolvedInputs: { delayMs: 200 } },
    });
    await nodeStarted(options.directory);
    const modulePath = join(options.runRoot, 'host.mjs');
    await writeFile(modulePath, (await readFile(modulePath, 'utf8')).replace("const value = 'original'", "const value = 'edited'"));
    await expect(handle.done).resolves.toMatchObject({ kind: 'complete' });
    const results = [];
    for await (const event of createLocalRunStorage(options.storage).eventStore.read({
      namespace: 'runner-tests', streamId: 'fixture',
    })) if (event.type === 'graph:node-completed') results.push(event.payload);
    expect(results).toEqual([
      { nodeId: 'first', position: 'dag/first/1', result: { node: 'first', value: 'original' } },
      { nodeId: 'last', position: 'dag/last/1', result: { node: 'last', value: 'original' } },
    ]);
  });

  it('an unattended denial records its trusted context and starts no effect', async () => {
    for (const input of [{ deny: true, wait: false }, { deny: false, wait: true }]) {
      const { options } = await fixture();
      const handle = await startFixture({ ...options, definition: { ...options.definition, resolvedInputs: input } });
      await expect(handle.done).resolves.toMatchObject({ kind: 'fail' });
      expect((await handle.status()).phase).toBe('failed');
      await expect(readFile(join(options.directory, 'scratch/first.started'))).rejects.toMatchObject({ code: 'ENOENT' });
      const records = await readSupervision(createLocalRunStorage(options.storage), 'fixture');
      expect(records.find((event) => event.type === 'runner:action-denied')?.payload).toMatchObject({
        nodeId: 'first', trustedCaller: { actor: 'fixture', provenance: 'local-test' }, permissions: [],
      });
    }
  });

  it('exhausted backoff is a typed terminal with descendants cleaned', async () => {
    const { options } = await fixture();
    const handle = await startFixture({ ...options, definition: { ...options.definition, resolvedInputs: { crash: true } } });
    await expect(handle.done).resolves.toMatchObject({ kind: 'fail', code: 'RESTART_EXHAUSTED' });
    expect((await handle.status()).restartCount).toBe(2);
    const pids = (await readFile(join(options.directory, 'scratch/first.started'), 'utf8')).trim().split('\n').map(Number);
    expect(pids).toHaveLength(3);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  });

  it('a dispatch budget stops before the next node starts', async () => {
    const { options } = await fixture();
    const handle = await startFixture({ ...options, limits: { ...options.limits, maxDispatches: 1 } });
    await expect(handle.done).resolves.toMatchObject({ kind: 'fail', code: 'BUDGET_STOP' });
    await expect(readFile(join(options.directory, 'scratch/last.started'))).rejects.toMatchObject({ code: 'ENOENT' });
    const records = await readSupervision(createLocalRunStorage(options.storage), 'fixture');
    expect(records.some((event) => event.type === 'runner:budget-stop')).toBe(true);
  });

  it('status matches the record and the live process tree during nested work', async () => {
    const { options } = await fixture();
    const handle = await startFixture({
      ...options, definition: { ...options.definition, resolvedInputs: { delayMs: 1_500, child: true } },
    });
    const pid = await nodeStarted(options.directory);
    const childPath = join(options.directory, 'scratch/first.child');
    await expect.poll(() => readFile(childPath, 'utf8').catch(() => '')).not.toBe('');
    const childPid = Number((await readFile(childPath, 'utf8')).trim());
    const status = await handle.status();
    expect(status.phase).toBe('running');
    expect(status.workerAlive).toBe(true);
    expect(status.cleanupCapability).toBe(process.platform === 'linux' ? 'inherited-owner' : 'observed-processes');
    expect(status.active).toHaveLength(1);
    expect(status.active[0]).toMatchObject({
      nodeId: 'first', position: 'dag/first/1', phase: { name: 'Graph' }, usage: { kind: 'unknown' },
    });
    expect(status.active[0]!.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(status.active[0]!.remainingTimeoutMs).toBeGreaterThan(0);
    expect(status.processes).toEqual(expect.arrayContaining([
      expect.objectContaining({ pid, parentPid: process.pid }),
      expect.objectContaining({ pid: childPid, parentPid: pid }),
    ]));
    const readStatus = Reflect.get(runner, 'readSupervisedRunStatus');
    expect(readStatus).toBeTypeOf('function');
    expect((await readStatus({ storage: options.storage, runId: 'fixture' })).active[0]!.position).toBe('dag/first/1');
    await handle.stop();
    const stopped = await handle.status();
    expect(stopped.workerAlive).toBe(false);
    expect(stopped.processes).toEqual([]);
    expect(stopped.active).toEqual([]);
  });

  it('backoff timeout stop crash budget stop and completion have distinct records; all owned child processes are gone after each terminal path', async () => {
    for (const path of ['completion', 'stop', 'timeout', 'crash', 'budget'] as const) {
      const { options } = await fixture();
      const handle = await startFixture({
        ...options,
        definition: { ...options.definition, resolvedInputs: {
          child: true, delayMs: path === 'stop' || path === 'timeout' ? 4_000 : 10, crash: path === 'crash',
        } },
        limits: { timeoutMs: path === 'timeout' ? 1_000 : 2_000, maxDispatches: path === 'budget' ? 1 : 10 },
        restart: { ...options.restart, maxRestarts: path === 'crash' ? 1 : 0 },
      });
      const childPath = join(options.directory, 'scratch/first.child');
      await expect.poll(() => readFile(childPath, 'utf8').catch(() => ''), { timeout: 1_500 }).not.toBe('');
      if (path === 'stop') await handle.stop();
      const result = await handle.done;
      if (path === 'completion') expect(result, JSON.stringify(result)).toMatchObject({ kind: 'complete' });
      else expect(result).toMatchObject({ kind: 'fail', code: {
        stop: 'STOPPED', timeout: 'TIMEOUT', crash: 'RESTART_EXHAUSTED', budget: 'BUDGET_STOP',
      }[path] });
      const pids = (await readFile(childPath, 'utf8')).trim().split('\n').map(Number);
      const lastChildren = await readFile(join(options.directory, 'scratch/last.child'), 'utf8').catch(() => '');
      pids.push(...lastChildren.trim().split('\n').filter(Boolean).map(Number));
      for (const pid of pids) expect(() => process.kill(pid, 0), `${path} child ${pid}`).toThrow();
      const types = (await readSupervision(createLocalRunStorage(options.storage), 'fixture')).map((event) => event.type)
        .filter((type) => ['runner:completed', 'runner:stopped', 'runner:timeout', 'runner:worker-crashed', 'runner:restart-anchor', 'runner:backoff', 'runner:budget-stop', 'runner:failed'].includes(type));
      expect(types).toEqual({
        completion: ['runner:completed'], stop: ['runner:stopped'], timeout: ['runner:timeout'], budget: ['runner:budget-stop'],
        crash: ['runner:worker-crashed', 'runner:restart-anchor', 'runner:backoff', 'runner:worker-crashed', 'runner:failed'],
      }[path]);
    }
  }, 30_000);

  it('a node timeout is recorded typed and the watchdog cleans its children', async () => {
    const { options } = await fixture();
    const handle = await startFixture({
      ...options, definition: { ...options.definition, resolvedInputs: { child: true, delayMs: 4_000, nodeTimeoutMs: 200 } },
    });
    await expect(handle.done).resolves.toMatchObject({ kind: 'fail' });
    const events = [];
    for await (const event of createLocalRunStorage(options.storage).eventStore.read({ namespace: 'runner-tests', streamId: 'fixture' })) events.push(event);
    expect(events.find((event) => event.type === 'graph:node-failed')?.payload).toMatchObject({ nodeId: 'first', code: 'TIMEOUT' });
    const pid = Number((await readFile(join(options.directory, 'scratch/first.child'), 'utf8')).trim());
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await handle.status()).toMatchObject({ phase: 'failed', cleanupVerified: true, leaseRetained: false });
  });

  it('the runner resolves the run once and a source edit after start leaves the stored plan and inputs unchanged', async () => {
    const { options } = await fixture();
    const source = join(options.runRoot, 'input.json');
    await writeFile(source, JSON.stringify({ value: 'resolved', delayMs: 200 }));
    const definition = structuredClone({ ...options.definition, resolvedInputs: JSON.parse(await readFile(source, 'utf8')) });
    const original = structuredClone(definition);
    const handle = await startFixture({ ...options, definition });
    const pid = await nodeStarted(options.directory, 'last');
    await writeFile(source, JSON.stringify({ value: 'edited', delayMs: 0 }));
    definition.resolvedInputs.value = 'caller-mutated';
    Object.assign(definition.resolvedPlan, { digest: `sha256:${'0'.repeat(64)}`, canonicalJson: '{}' });
    process.kill(pid, 'SIGKILL');
    await expect(handle.done).resolves.toMatchObject({ kind: 'complete' });
    const storage = createLocalRunStorage(options.storage);
    const loaded = await runtime.loadRunDefinition(storage, 'fixture');
    expect(loaded.resolvedPlan).toEqual(original.resolvedPlan);
    expect(loaded.record.payload.definition.resolvedInputs).toEqual({ value: 'resolved', delayMs: 200 });
    const events = [];
    for await (const event of storage.eventStore.read({ namespace: 'runner-tests', streamId: 'fixture' })) events.push(event);
    expect(events.filter((event) => event.type === 'graph:run-started')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'graph:node-completed').map((event) => event.payload)).toEqual([
      { nodeId: 'first', position: 'dag/first/1', result: { node: 'first', value: 'resolved' } },
      { nodeId: 'last', position: 'dag/last/1', result: { node: 'last', value: 'resolved' } },
    ]);
    const evaluations = (await readFile(join(options.runRoot, 'module-evaluations.log'), 'utf8')).trim().split('\n');
    expect(evaluations).toHaveLength(2);
    expect(new Set(evaluations).size).toBe(2);
  });

  it('status preserves measured engine usage on completion and incomplete failure', async () => {
    for (const engineFail of [false, true]) {
      const { options } = await fixture(true);
      const handle = await startFixture({ ...options, definition: { ...options.definition, resolvedInputs: { engineFail } } });
      await expect(handle.done).resolves.toMatchObject({ kind: engineFail ? 'fail' : 'complete' });
      const status = await handle.status();
      expect(status.usage).toEqual([
        { nodeId: 'first', usage: { kind: 'reported', inputTokens: 7, outputTokens: 3 } },
        { nodeId: 'last', usage: engineFail ? { kind: 'unknown' } : { kind: 'reported', inputTokens: 7, outputTokens: 3 } },
      ]);
      const storage = createLocalRunStorage(options.storage);
      const records = await readSupervision(storage, 'fixture');
      if (engineFail) {
        const payload = records.find((event) => event.type === 'runner:engine-failed')!.payload as runtime.JsonObject;
        expect(payload).toMatchObject({
          usage: { kind: 'reported', inputTokens: 7, outputTokens: 3 },
          effective: { model: 'fixture' }, transportFailure: { kind: 'timeout', exitCode: 9 },
        });
        expect(payload).not.toHaveProperty('parts');
        const bytes = await storage.artifactStore.read(
          { namespace: 'runner-tests', runId: 'fixture' }, runtime.validateArtifactReference(payload.partsArtifact),
        );
        expect(JSON.parse(Buffer.from(bytes).toString('utf8'))).toEqual([{ kind: 'assistant', text: 'partial', final: false }]);
      }
    }
  });

  it('a failed scratch setup leaves no partial run', async () => {
    const { root, options } = await fixture();
    const directory = join(root, 'not-a-directory');
    await writeFile(directory, 'keep');
    await expect(runner.startSupervisedRun({ ...options, directory })).rejects.toBeDefined();
    const events = [];
    for await (const event of createLocalRunStorage(options.storage).eventStore.read({ namespace: 'runner-tests', streamId: 'fixture' })) events.push(event);
    expect(events).toEqual([]);
    expect(await readFile(directory, 'utf8')).toBe('keep');
  });

  it('a startup failure retains the process lock when its lease cannot be released', async () => {
    const { root, options } = await fixture();
    const directory = join(root, 'not-a-directory');
    await writeFile(directory, 'keep');
    let token: string | undefined;
    const workspace: runtime.WorkspaceProvider = {
      ...options.workspace,
      acquireLease: async (...args) => {
        const acquired = await options.workspace.acquireLease(...args);
        if (acquired.ok) token = acquired.token;
        return acquired;
      },
      releaseLease: async () => ({ ok: false, kind: 'not-owner' }),
    };
    try {
      await expect(startFixture({ ...options, workspace, directory })).rejects.toMatchObject({ code: 'WORKSPACE_RELEASE' });
      expect(await readdir(join(options.storage.directory, 'runner-locks/runner-tests'))).toEqual(['fixture']);
    } finally {
      if (token !== undefined) await options.workspace.releaseLease(token);
    }
  });

  it('a storage preflight failure creates no run or artifact and starts no worker', async () => {
    const { options } = await fixture();
    const storage = { ...options.storage, policy: { ...options.storage.policy, maxArtifactBytes: 1 } };
    await expect(startFixture({ ...options, storage })).rejects.toMatchObject({ code: 'RUN_STORAGE' });
    expect(await readdir(join(storage.directory, 'artifacts')).catch(() => [])).toEqual([]);
    const events = [];
    for await (const event of createLocalRunStorage(storage).eventStore.read({ namespace: storage.namespace, streamId: 'fixture' })) events.push(event);
    expect(events).toEqual([]);
    await expect(readFile(join(options.runRoot, 'module-evaluations.log'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a publication failure starts no worker and retains its evidence', async () => {
    for (const failure of ['artifact', 'event'] as const) {
      const { options } = await fixture();
      const storage = createLocalRunStorage(options.storage);
      const scope = { namespace: 'runner-tests', runId: 'fixture' };
      const existing = await storage.artifactStore.write(scope, {
        bytes: Buffer.from('keep existing evidence'), mediaType: 'text/plain', purpose: 'existing', contentMode: 'exact',
      });
      const artifactPrototype = Object.getPrototypeOf(storage.artifactStore) as typeof storage.artifactStore;
      const write = artifactPrototype.write;
      const published: { reference: typeof existing; bytes: Uint8Array }[] = [];
      const artifactSpy = vi.spyOn(artifactPrototype, 'write').mockImplementation(async function (this: typeof storage.artifactStore, scope, artifact) {
        if (failure === 'artifact' && artifact.purpose === 'host-binding') throw new Error('injected artifact write failure');
        const reference = await write.call(this, scope, artifact);
        published.push({ reference, bytes: Uint8Array.from(artifact.bytes) });
        return reference;
      });
      const eventPrototype = Object.getPrototypeOf(storage.eventStore) as typeof storage.eventStore;
      const append = eventPrototype.append;
      const eventSpy = vi.spyOn(eventPrototype, 'append').mockImplementation(async function (this: typeof storage.eventStore, ...args) {
        const result = await append.apply(this, args);
        if (failure === 'event' && args[2][0].type === 'graph:run-started') throw new Error('injected failure after visible event append');
        return result;
      });
      try {
        await expect(startFixture(options)).rejects.toMatchObject({ code: 'RUN_STORAGE' });
      } finally {
        artifactSpy.mockRestore();
        eventSpy.mockRestore();
      }
      expect(Buffer.from(await storage.artifactStore.read(scope, existing)).toString()).toBe('keep existing evidence');
      expect(published).toHaveLength(failure === 'artifact' ? 1 : 2);
      for (const item of published) expect(await storage.artifactStore.read(scope, item.reference)).toEqual(item.bytes);
      const events = [];
      for await (const event of storage.eventStore.read({ namespace: scope.namespace, streamId: scope.runId })) events.push(event);
      expect(events.map((event) => event.type)).toEqual(failure === 'artifact' ? [] : ['graph:run-started']);
      expect(await readSupervision(storage, 'fixture')).toEqual([]);
      await expect(readFile(join(options.runRoot, 'module-evaluations.log'))).rejects.toMatchObject({ code: 'ENOENT' });
      const lease = await options.workspace.acquireLease('after-failure', 'fixture', await options.workspace.capture());
      expect(lease.ok).toBe(true);
      if (lease.ok) await options.workspace.releaseLease(lease.token);
      expect(await readdir(join(options.storage.directory, 'runner-locks/runner-tests'))).toEqual([]);
    }
  });

  it('invalid combined timer bounds are refused before storage or a lease', async () => {
    const { options } = await fixture();
    await expect(startFixture({ ...options, limits: { ...options.limits, timeoutMs: 2_147_483_647 } }))
      .rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(await readdir(options.storage.directory).catch(() => [])).toEqual([]);
    const lease = await options.workspace.acquireLease('test', 'test', await options.workspace.capture());
    expect(lease.ok).toBe(true);
    if (lease.ok) await options.workspace.releaseLease(lease.token);
  });

  it('a file changed between the restart capture and the reacquire pauses typed', async () => {
    const { options } = await fixture();
    const handle = await startFixture({
      ...options,
      definition: { ...options.definition, resolvedInputs: { delayMs: 200 } },
      restart: { ...options.restart, initialBackoffMs: 800, maxBackoffMs: 800 },
    });
    process.kill(await nodeStarted(options.directory), 'SIGKILL');
    await expect.poll(async () => (await handle.status()).phase).toBe('backoff');
    await writeFile(join(options.runRoot, 'outside-edit.txt'), 'someone else changed this');
    await expect(handle.done).resolves.toMatchObject({ kind: 'pause', code: 'WORKSPACE_DRIFT' });
    expect((await handle.status()).phase).toBe('paused');
    expect((await readFile(join(options.directory, 'scratch/first.started'), 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('a refused replacement lease has a durable failed status', async () => {
    const { options } = await fixture();
    let acquisitions = 0;
    const workspace = {
      ...options.workspace,
      acquireLease: async (...args: Parameters<runtime.WorkspaceProvider['acquireLease']>) => {
        acquisitions += 1;
        if (acquisitions > 1) return { ok: false as const, kind: 'held' as const, owner: 'someone-else' };
        return await options.workspace.acquireLease(...args);
      },
    };
    const handle = await startFixture({ ...options, workspace, definition: { ...options.definition, resolvedInputs: { crash: true } } });
    await expect(handle.done).resolves.toMatchObject({ kind: 'fail', code: 'WORKSPACE_LEASE' });
    const status = await handle.status();
    expect(status.phase).toBe('failed');
    expect(status.backoff).toBeNull();
    expect(status.workerAlive).toBe(false);
  });

  it('an output limit records failure and releases a fully cleaned workspace', async () => {
    const { options } = await fixture();
    const handle = await startFixture({ ...options, definition: { ...options.definition, resolvedInputs: { noisy: true, child: true } } });
    await expect(handle.done).resolves.toMatchObject({ kind: 'fail', code: 'OUTPUT_LIMIT' });
    expect((await handle.status()).phase).toBe('failed');
    const lease = await options.workspace.acquireLease('after-output', 'fixture', await options.workspace.capture());
    expect(lease.ok).toBe(true);
    if (lease.ok) await options.workspace.releaseLease(lease.token);
    expect(await readdir(join(options.storage.directory, 'runner-locks/runner-tests'))).toEqual([]);
  });

  it('an output limit followed by a failed lease release keeps both failure records', async () => {
    const { options } = await fixture();
    let token: string | undefined;
    const workspace: runtime.WorkspaceProvider = {
      ...options.workspace,
      acquireLease: async (...args) => {
        const acquired = await options.workspace.acquireLease(...args);
        if (acquired.ok) token = acquired.token;
        return acquired;
      },
      releaseLease: async () => ({ ok: false, kind: 'not-owner' }),
    };
    try {
      const handle = await startFixture({ ...options, workspace, definition: { ...options.definition, resolvedInputs: { noisy: true } } });
      await expect(handle.done).resolves.toMatchObject({ kind: 'fail', code: 'OUTPUT_LIMIT' });
      expect(await handle.status()).toMatchObject({ phase: 'failed', cleanupVerified: true, leaseRetained: true });
      const terminal = (await readSupervision(createLocalRunStorage(options.storage), 'fixture')).at(-1)!;
      expect(terminal.type).toBe('runner:failed');
      expect(terminal.payload).toMatchObject({ code: 'OUTPUT_LIMIT', releaseFailure: 'WORKSPACE_RELEASE' });
      expect(await readdir(join(options.storage.directory, 'runner-locks/runner-tests'))).toEqual(['fixture']);
    } finally {
      if (token !== undefined) await options.workspace.releaseLease(token);
    }
  });

  it('a workspace provider for another root is refused before any run is stored', async () => {
    const { options } = await fixture();
    const otherRoot = await realpath(await tmpRepo());
    await expect(startFixture({ ...options, workspace: runtime.createGitWorktreeProvider({ repositoryPath: otherRoot }) }))
      .rejects.toMatchObject({ code: 'WORKSPACE_ROOT' });
    expect(await readdir(options.storage.directory).catch(() => [])).toEqual([]);
  });

  it('status shows recorded surviving children after the worker exits', async () => {
    const { options } = await fixture();
    const handle = await startFixture(options);
    await handle.done;
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      const processes = await inspectOwnedProcessTree({
        attemptId: `sha256:${'a'.repeat(64)}`, rootPid: child.pid!, rootProcessGroupId: child.pid!,
      });
      const identity = processes.find((item) => item.pid === child.pid)!;
      expect(identity).toBeDefined();
      // Reproduce the durable teardown-error payload with a real surviving process.
      await supervisionWriter(createLocalRunStorage(options.storage), 'fixture')('failed', {
        kind: 'fail', code: 'TEARDOWN_INCOMPLETE', phase: 'failed',
        cleanupSafe: false, leaseRetained: true, remainingProcesses: [identity],
      });
      const status = await handle.status();
      expect(status.workerAlive).toBe(false);
      expect(status.processes).toContainEqual(identity);
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
  });

  it('failed child termination retains the lease and lock with a truthful terminal status', async () => {
    const { options } = await fixture();
    let token: string | undefined;
    const workspace: runtime.WorkspaceProvider = {
      ...options.workspace,
      acquireLease: async (...args) => {
        const lease = await options.workspace.acquireLease(...args);
        if (lease.ok) token = lease.token;
        return lease;
      },
    };
    const handle = await startFixture({
      ...options, workspace, definition: { ...options.definition, resolvedInputs: { child: true, detachedChild: true, delayMs: 4_000 } },
    });
    await nodeStarted(options.directory);
    await expect.poll(() => readFile(join(options.directory, 'scratch/first.child'), 'utf8').catch(() => '')).not.toBe('');
    const childPid = Number((await readFile(join(options.directory, 'scratch/first.child'), 'utf8')).trim());
    await delay(150);
    const kill = process.kill.bind(process);
    // Inject an ineffective termination only for this real child. The watchdog
    // still performs its normal discovery, deadline, readback, and recording.
    const signals = vi.spyOn(process, 'kill').mockImplementation((pid, signal) =>
      pid === childPid && signal !== 0 ? true : kill(pid, signal));
    try {
      await expect(handle.stop()).resolves.toMatchObject({ kind: 'fail', code: 'TEARDOWN_INCOMPLETE' });
      const status = await handle.status();
      expect(status).toMatchObject({ phase: 'failed', cleanupVerified: false, leaseRetained: true, workerAlive: false });
      expect(status.processes.some((item) => item.pid === childPid)).toBe(true);
      expect(await readdir(join(options.storage.directory, 'runner-locks/runner-tests'))).toEqual(['fixture']);
      const lease = await options.workspace.acquireLease('other', 'fixture', await options.workspace.capture());
      expect(lease).toMatchObject({ ok: false, kind: 'held' });
    } finally {
      signals.mockRestore();
      kill(childPid, 'SIGKILL');
      await expect.poll(() => { try { kill(childPid, 0); return true; } catch { return false; } }).toBe(false);
      if (token !== undefined) await options.workspace.releaseLease(token);
    }
  }, 15_000);
});
