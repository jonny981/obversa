import {
  compileGraph,
  convergence,
  resolveGraphPlan,
  type ConvergenceDefinition,
  type ConvergenceEvent,
  type PlanResolution,
} from '@obversa/runtime';

const definition: ConvergenceDefinition = {
  id: 'release-review',
  definitionVersion: 1,
  data: {
    maxIterations: 2,
    maxReviewRestarts: 1,
    quorum: 2,
    requireDiversity: true,
    skippableSeats: [],
    seatConcurrency: 2,
    retryCapPerNode: 0,
  },
  nodes: [
    { id: 'draft', data: { role: 'generator' } },
    { id: 'done-check', data: { role: 'evaluator' } },
    { id: 'claude-review', data: { role: 'seat' } },
    { id: 'codex-review', data: { role: 'seat' } },
    { id: 'repair', data: { role: 'repair' } },
  ],
  edges: [],
};

const reviewEvidence = {
  inputHashes: { draft: 'sha256:release-draft' },
  workspaceFingerprint: 'sha256:release-workspace',
} as const;

const events: readonly ConvergenceEvent[] = [
  {
    type: 'node-dispatched',
    version: 1,
    payload: { nodeId: 'draft', position: 'convergence/1/draft/1' },
  },
  {
    type: 'node-completed',
    version: 1,
    payload: {
      nodeId: 'draft',
      position: 'convergence/1/draft/1',
      result: { summary: 'release draft' },
    },
  },
  {
    type: 'node-dispatched',
    version: 1,
    payload: { nodeId: 'done-check', position: 'convergence/1/done-check/1' },
  },
  {
    type: 'node-completed',
    version: 1,
    payload: {
      nodeId: 'done-check',
      position: 'convergence/1/done-check/1',
      result: { gateMet: true, ...reviewEvidence },
    },
  },
  {
    type: 'node-dispatched',
    version: 1,
    payload: { nodeId: 'claude-review', position: 'review/1/claude-review/1' },
  },
  {
    type: 'node-dispatched',
    version: 1,
    payload: { nodeId: 'codex-review', position: 'review/1/codex-review/1' },
  },
  {
    type: 'node-completed',
    version: 1,
    payload: {
      nodeId: 'claude-review',
      position: 'review/1/claude-review/1',
      result: {
        verdict: 'pass',
        confidence: 0.91,
        provider: 'anthropic',
        modelFamily: 'claude',
        ...reviewEvidence,
        findings: [],
      },
    },
  },
  {
    type: 'node-completed',
    version: 1,
    payload: {
      nodeId: 'codex-review',
      position: 'review/1/codex-review/1',
      result: {
        verdict: 'pass',
        confidence: 0.9,
        provider: 'openai',
        modelFamily: 'gpt',
        ...reviewEvidence,
        findings: [],
      },
    },
  },
];

const identity = {
  source: 'npm:@example/release-review',
  version: '1.0.0',
  digest: 'sha256:7777777777777777777777777777777777777777777777777777777777777777',
} as const;
const resolution: PlanResolution = {
  package: identity,
  admission: { package: identity, permissions: [] },
  executionLanes: [],
};
const graph = compileGraph(convergence, definition);
const state = events.reduce(graph.reduce, graph.initialState());
const plan = resolveGraphPlan(graph.describe(), resolution);

console.log(JSON.stringify({
  decision: graph.decide(state)[0],
  events: events.length,
  planDigest: plan.digest,
  bounds: plan.plan.bounds,
}));
