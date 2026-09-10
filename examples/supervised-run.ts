import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import {
  compileGraph, createGitWorktreeProvider, dagGraphType, resolveGraphPlan,
} from '@obversa/runtime';
import { readSupervisedRunStatus, startSupervisedRun, type SupervisedRunHandle } from '@obversa/runner';
import { createLocalRunStorage } from '@obversa/runtime/storage/local';

const git = promisify(execFile);
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'obversa-supervised-example-')));
let handle: SupervisedRunHandle | undefined;
let startupAttempted = false;
let report;
try {
  const runRoot = join(temporary, 'workspace');
  await mkdir(runRoot);
  const hostBytes = await readFile(new URL('./supervised-host.mjs', import.meta.url));
  await writeFile(join(runRoot, 'host.mjs'), hostBytes);
  await writeFile(join(runRoot, '.gitignore'), 'node_modules/\n');
  await git('git', ['init', '-q', '-b', 'main'], { cwd: runRoot });
  await git('git', ['add', 'host.mjs', '.gitignore'], { cwd: runRoot });
  await git('git', [
    '-c', 'user.name=Example', '-c', 'user.email=example@example.com',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'chore: initialize disposable example',
  ], { cwd: runRoot });
  // Let the copied host import the same installed runtime as this example.
  await mkdir(join(runRoot, 'node_modules/@obversa'), { recursive: true });
  await symlink(
    dirname(createRequire(join(process.cwd(), 'package.json')).resolve('@obversa/runtime/package.json')),
    join(runRoot, 'node_modules/@obversa/runtime'),
    'junction',
  );

  const graph = compileGraph(dagGraphType, {
    id: 'offline-run', definitionVersion: 1,
    data: { globalConcurrency: 1, keyedConcurrency: {}, stopOnError: true, retryCapPerNode: 0 },
    nodes: [
      { id: 'draft', data: { kind: 'required', key: null } },
      { id: 'review', data: { kind: 'required', key: null } },
    ],
    edges: [{ id: 'next', source: 'draft', target: 'review', data: {} }],
  });
  const identity = {
    source: 'file:host.mjs', version: '1.0.0',
    digest: `sha256:${createHash('sha256').update(hostBytes).digest('hex')}`,
  } as const;
  const resolvedPlan = resolveGraphPlan(graph.describe(), {
    package: identity, admission: { package: identity, permissions: [] }, executionLanes: [],
  });
  const storage = {
    directory: join(temporary, 'storage'), namespace: 'offline-example',
    policy: {
      schemaVersion: 1, maxEventPayloadBytes: 128_000, maxAppendBatchBytes: 256_000,
      maxArtifactBytes: 1_000_000, maxTotalArtifactBytesPerRun: 4_000_000,
      retention: 'until-run-delete',
      sensitiveContent: { marked: 'reject', exact: 'reject', freeText: 'redact-before-hash' },
    },
  } as const;
  const directory = join(temporary, 'runner');
  startupAttempted = true;
  handle = await startSupervisedRun({
    directory, runRoot, module: './host.mjs', storage,
    workspace: createGitWorktreeProvider({ repositoryPath: runRoot }),
    definition: {
      runId: 'example', graphDefinition: graph.definition, resolvedPlan,
      resolvedInputs: { message: 'An offline supervised run.' },
    },
    limits: { timeoutMs: 20_000, maxDispatches: 2 },
    restart: { maxRestarts: 1, initialBackoffMs: 100, maxBackoffMs: 1_000 },
    teardownGraceMs: 100,
  });
  const result = await handle.done;
  assert.equal(result.kind, 'complete', JSON.stringify(result));
  const status = await readSupervisedRunStatus({ storage, runId: 'example' });
  assert.equal(status.phase, 'completed');
  assert.equal(status.workerAlive, false);
  assert.deepEqual(status.active, []);
  const results = [];
  for await (const event of createLocalRunStorage(storage).eventStore.read({
    namespace: storage.namespace, streamId: 'example',
  })) {
    if (event.type === 'graph:node-completed') results.push(event.payload);
  }
  assert.deepEqual(results, [
    { nodeId: 'draft', position: 'dag/draft/1', result: { node: 'draft', message: 'An offline supervised run.' } },
    { nodeId: 'review', position: 'dag/review/1', result: { node: 'review', message: 'An offline supervised run.' } },
  ]);
  for (const node of ['draft', 'review']) {
    assert.equal(await readFile(join(directory, 'scratch', `${node}.txt`), 'utf8'), 'An offline supervised run.');
  }
  report = { phase: status.phase, cleanupCapability: status.cleanupCapability, results };
} finally {
  // If teardown fails, retain the directory so its lock and lease remain intact.
  if (handle !== undefined) {
    await handle.stop();
    const status = await handle.status();
    assert.equal(status.cleanupVerified, true, 'Retain the directory when cleanup is unverified.');
    assert.equal(status.leaseRetained, false, 'Retain the directory while its workspace lease is held.');
  }
  // Startup can fail before returning a handle while retaining a lock and lease.
  if (!startupAttempted || handle !== undefined) {
    await rm(temporary, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ ...report, temporaryDirectoryRemoved: !existsSync(temporary) }, null, 2));
