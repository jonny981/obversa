import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';
import { compileGraph, dagGraphType, persistRunDefinition, resolveGraphPlan } from '@obversa/runtime';
import { createLocalRunStorage } from '@obversa/runtime/storage/local';

import { readSupervisedRunStatus } from '../src/index.js';
import { resolveHostModule } from '../src/supervised-record.js';

const roots: string[] = [];
const policy = {
  schemaVersion: 1,
  maxEventPayloadBytes: 64_000,
  maxAppendBatchBytes: 128_000,
  maxArtifactBytes: 1_000_000,
  maxTotalArtifactBytesPerRun: 4_000_000,
  retention: 'until-run-delete',
  sensitiveContent: { marked: 'reject', exact: 'reject', freeText: 'redact-before-hash' },
} as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('refuses host modules outside the run root, including through a symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'obversa-host-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'obversa-host-outside-'));
  roots.push(root, outside);
  await writeFile(join(outside, 'host.mjs'), 'export const bindRun = () => ({});\n');
  await mkdir(join(root, 'inside'));
  await symlink(outside, join(root, 'inside', 'escape'));

  expect(() => resolveHostModule(root, '../host.mjs')).toThrowError(expect.objectContaining({
    name: 'SupervisedRunError', code: 'HOST_MODULE',
  }));
  expect(() => resolveHostModule(root, './inside/escape/host.mjs')).toThrowError(expect.objectContaining({
    name: 'SupervisedRunError', code: 'HOST_MODULE',
  }));
});

it('reports a missing host module as a supervised run error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'obversa-host-missing-'));
  roots.push(root);
  expect(() => resolveHostModule(root, './missing.mjs')).toThrowError(
    expect.objectContaining({
      name: 'SupervisedRunError',
      code: 'HOST_MODULE',
      message: 'The host module does not exist.',
      cause: expect.objectContaining({ code: 'ENOENT' }),
    }),
  );
});

it('reports a stored run without a host binding as a supervised run error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'obversa-host-status-'));
  roots.push(root);
  const storageOptions = { directory: join(root, 'storage'), namespace: 'host-validation', policy };
  const storage = createLocalRunStorage(storageOptions);
  const graph = compileGraph(dagGraphType, {
    id: 'host-validation', definitionVersion: 1,
    data: { globalConcurrency: 1, keyedConcurrency: {}, stopOnError: true, retryCapPerNode: 0 },
    nodes: [{ id: 'only', data: { kind: 'required', key: null } }], edges: [],
  });
  const identity = {
    source: 'file:host-validation', version: '1.0.0', digest: `sha256:${'1'.repeat(64)}` as const,
  };
  await persistRunDefinition(storage, {
    runId: 'without-host', eventId: randomUUID(), timestamp: new Date().toISOString(),
    graphDefinition: graph.definition,
    resolvedPlan: resolveGraphPlan(graph.describe(), {
      package: identity, admission: { package: identity, permissions: [] }, executionLanes: [],
    }),
    resolvedInputs: {}, workspaceBinding: null, hostBinding: null,
  });

  await expect(readSupervisedRunStatus({ storage: storageOptions, runId: 'without-host' }))
    .rejects.toMatchObject({ name: 'SupervisedRunError', code: 'HOST_MODULE' });
});
