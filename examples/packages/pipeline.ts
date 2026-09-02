import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  compileGraph,
  createGraphExecutor,
  dagGraphType,
  persistRunDefinition,
  resolveGraphPlan,
  type DagDefinition,
  type GraphNodeBinding,
  type PlanResolution,
  type RunStoragePolicy,
} from '@obversa/runtime';
import { defineGraphDefinition } from '@obversa/runtime/testing';
import { createLocalRunStorage } from '@obversa/runtime/storage/local';

const definition: DagDefinition = defineGraphDefinition({
  id: 'release-pipeline',
  definitionVersion: 1,
  data: {
    globalConcurrency: 1,
    keyedConcurrency: {},
    stopOnError: true,
    retryCapPerNode: 0,
  },
  nodes: [
    { id: 'draft', data: { kind: 'required', key: null } },
    { id: 'review', data: { kind: 'required', key: null } },
    { id: 'publish', data: { kind: 'required', key: null } },
  ],
  edges: [
    { id: 'draft-to-review', source: 'draft', target: 'review', data: {} },
    { id: 'review-to-publish', source: 'review', target: 'publish', data: {} },
  ],
});

const packageIdentity = {
  source: 'npm:@example/release-pipeline',
  version: '1.0.0',
  digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
} as const;
const resolution: PlanResolution = {
  package: packageIdentity,
  admission: { package: packageIdentity, permissions: [] },
  executionLanes: [],
};
const graph = compileGraph(dagGraphType, definition);
const plan = resolveGraphPlan(graph.describe(), resolution);

const storagePolicy = {
  schemaVersion: 1,
  maxEventPayloadBytes: 64_000,
  maxAppendBatchBytes: 128_000,
  maxArtifactBytes: 1_000_000,
  maxTotalArtifactBytesPerRun: 4_000_000,
  retention: 'until-run-delete',
  sensitiveContent: {
    marked: 'reject',
    exact: 'reject',
    freeText: 'redact-before-hash',
  },
} as const satisfies RunStoragePolicy;

function nodeBinding(
  root: string,
  runData: NonNullable<GraphNodeBinding['runData']>,
): GraphNodeBinding {
  return {
    prompt: null,
    scratchDirectory: root,
    workspace: { mode: 'none', directory: null, allowedPaths: [] },
    trustedCaller: {},
    permissions: [],
    policy: {
      inputBytes: 10_000,
      outputBytes: 10_000,
      timeoutMs: 5_000,
      teardownGraceMs: 100,
      memoryBytes: 10_000_000,
      filesChanged: 0,
      linesChanged: 0,
      callTokens: null,
    },
    resultContract: null,
    runData,
    parseResult: null,
    tokenBudget: null,
    decideAction: async () => ({ kind: 'allow' }),
  };
}

const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'obversa-pipeline-')));
const order: string[] = [];
try {
  const storage = createLocalRunStorage({
    directory: join(temporaryRoot, 'storage'),
    namespace: 'pipeline-example',
    policy: storagePolicy,
  });
  await persistRunDefinition(storage, {
    runId: 'release-pipeline-run',
    eventId: 'release-pipeline-started',
    timestamp: '2026-01-01T00:00:00.000Z',
    graphDefinition: graph.definition,
    resolvedPlan: plan,
    resolvedInputs: {},
    workspaceBinding: null,
    hostBinding: null,
  });

  const executor = await createGraphExecutor({
    runId: 'release-pipeline-run',
    graph,
    storage,
    nodes: {
      draft: nodeBinding(temporaryRoot, async () => {
        order.push('draft');
        return { article: 'ready' };
      }),
      review: nodeBinding(temporaryRoot, async ({ input }) => {
        order.push('review');
        const draft = (input as {
          readonly results: { readonly draft: { readonly article: string } };
        }).results.draft;
        return { approved: draft.article === 'ready' };
      }),
      publish: nodeBinding(temporaryRoot, async ({ input }) => {
        order.push('publish');
        const review = (input as {
          readonly results: { readonly review: { readonly approved: boolean } };
        }).results.review;
        return { published: review.approved };
      }),
    },
    engines: [],
  });
  const result = await executor.run(new AbortController().signal);
  const storedEvents = [];
  for await (const event of storage.eventStore.read({
    namespace: storage.record.namespace,
    streamId: 'release-pipeline-run',
  })) storedEvents.push(event);

  console.log(JSON.stringify({
    executor: result.kind,
    output: result.kind === 'complete' ? result.output : null,
    dispatches: storedEvents.filter(
      (event) => event.type === 'graph:node-dispatched',
    ).length,
    order,
    planDigest: plan.digest,
    bounds: plan.plan.bounds,
  }));
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
