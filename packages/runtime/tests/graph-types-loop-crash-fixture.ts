import { join } from 'node:path';

import { engineSelection } from '@obversa/engine';

import { convergence, type ConvergenceDefinition } from '../src/graph-types/loop.ts';
import { resolveGraphPlan, type ExecutionTarget } from '../src/graph/plan.ts';
import { compileGraph } from '../src/graph/type.ts';
import type { JsonObject } from '../src/graph/value.ts';
import { createGraphExecutor, type GraphEngineBinding, type GraphNodeBinding } from '../src/runtime/graph-executor.ts';
import { persistRunDefinition } from '../src/runtime/run-definition.ts';
import { createLocalRunStorage } from '../src/storage/local.ts';

export const runId = 'writer-crash';
export const writerPosition = 'convergence/1/generator/1';

function target(provider: string, modelFamily: string) {
  return { adapter: 'fixture', provider, modelFamily, model: `${modelFamily}-model`, tools: [] } satisfies ExecutionTarget;
}

export const writerTarget = target('writer-provider', 'writer-family');
export const writerSubstitute = target('substitute-provider', 'substitute-family');
export const reviewerTargets = [target('review-a', 'family-a'), target('review-b', 'family-b')];
const writerLane = {
  id: 'writer', requested: writerTarget, knownSubstitutions: [writerSubstitute],
};
const reviewLanes = reviewerTargets.map((requested, index) => ({
  id: `seat-${index}`, requested, knownSubstitutions: [],
}));
const definition: ConvergenceDefinition = {
  id: 'writer-crash-review',
  definitionVersion: 1,
  data: {
    maxIterations: 1, maxReviewRestarts: 0, quorum: 2, requireDiversity: true,
    skippableSeats: [], seatConcurrency: 1, retryCapPerNode: 0,
  },
  nodes: [
    { id: 'generator', data: { role: 'generator', lane: writerLane } },
    { id: 'evaluator', data: { role: 'evaluator' } },
    ...reviewLanes.map((lane) => ({ id: lane.id, data: { role: 'seat' as const, lane } })),
    { id: 'repair', data: { role: 'repair' } },
  ],
  edges: [],
};
const evidence = {
  inputHashes: { draft: 'sha256:draft' }, workspaceFingerprint: 'sha256:workspace',
  proofArtifactDigest: `sha256:${'a'.repeat(64)}`,
};

export function crashFixture(root: string, calls: string[], enterWriter?: () => Promise<void>) {
  const graph = compileGraph(convergence, definition);
  const storage = createLocalRunStorage({
    directory: join(root, 'storage'), namespace: 'writer-crash-tests',
    policy: {
      schemaVersion: 1, maxEventPayloadBytes: 64_000, maxAppendBatchBytes: 128_000,
      maxArtifactBytes: 1_000_000, maxTotalArtifactBytesPerRun: 4_000_000,
      retention: 'until-run-delete',
      sensitiveContent: { marked: 'reject', exact: 'reject', freeText: 'redact-before-hash' },
    },
  });
  const binding = (runData: GraphNodeBinding['runData']): GraphNodeBinding => ({
    prompt: runData === null ? () => 'Complete this node.' : null,
    scratchDirectory: root,
    workspace: { mode: 'none', directory: null, allowedPaths: [] },
    trustedCaller: {}, permissions: [],
    policy: {
      inputBytes: 100_000, outputBytes: 100_000, timeoutMs: 30_000, teardownGraceMs: 100,
      memoryBytes: 100_000_000, filesChanged: 0, linesChanged: 0, callTokens: null,
    },
    resultContract: null, runData, parseResult: null, tokenBudget: null,
    retrySafe: true,
    decideAction: async () => ({ kind: 'allow' }),
  });
  const engine = (requested: ExecutionTarget, result: JsonObject): GraphEngineBinding => {
    const selection = engineSelection({
      adapter: requested.adapter, provider: requested.provider,
      modelFamily: requested.modelFamily, model: requested.model,
    });
    return {
      target: requested, selection, hardTokenLimitEnforceable: false,
      engine: {
        name: 'fixture',
        async run() {
          calls.push(requested.model);
          if (requested === writerTarget) await enterWriter?.();
          return {
            parts: [{ kind: 'structured', value: result, final: true }],
            usage: { kind: 'reported', inputTokens: 1, outputTokens: 1 },
            requested: selection, effective: selection,
          };
        },
      },
    };
  };
  return {
    graph, storage, runId,
    nodes: {
      generator: binding(null),
      evaluator: binding(async () => ({ gateMet: true, ...evidence })),
      ...Object.fromEntries(reviewLanes.map((lane) => [lane.id, binding(null)])),
      repair: binding(async () => ({ repaired: true })),
    },
    engines: [
      engine(writerTarget, { draft: 'ready' }),
      engine(writerSubstitute, { draft: 'ready' }),
      ...reviewerTargets.map((requested) => engine(requested, {
        verdict: 'pass', confidence: 0.95, findings: [], ...evidence,
      })),
    ],
  };
}

if (process.argv[2] === '--writer-crash') {
  const root = process.argv[3];
  if (!root) throw new Error('The writer crash fixture requires a storage root.');
  const fixture = crashFixture(root, [], async () => {
    process.send!('writer-engine-entered');
    await new Promise<void>(() => {});
  });
  const identity = {
    source: 'file:writer-crash-test', version: '1.0.0',
    digest: `sha256:${'d'.repeat(64)}` as const,
  };
  await persistRunDefinition(fixture.storage, {
    runId, eventId: 'writer-crash-started', timestamp: '2026-01-01T00:00:00.000Z',
    graphDefinition: fixture.graph.definition,
    resolvedPlan: resolveGraphPlan(fixture.graph.describe(), {
      package: identity, admission: { package: identity, permissions: [] },
      executionLanes: [writerLane, ...reviewLanes].map((lane) => ({
        id: lane.id, effective: lane.requested, fallbacks: lane.knownSubstitutions,
      })),
    }),
    resolvedInputs: {}, workspaceBinding: null, hostBinding: null,
  });
  await (await createGraphExecutor(fixture)).run(new AbortController().signal);
  throw new Error('The writer returned before the parent killed it.');
}
