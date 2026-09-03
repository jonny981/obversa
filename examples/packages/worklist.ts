import {
  boundedItem,
  compileGraph,
  resolveGraphPlan,
  type BoundedItemDefinition,
  type BoundedItemEvent,
  type PlanResolution,
} from '@obversa/runtime';

const definition: BoundedItemDefinition = {
  id: 'document-checks',
  definitionVersion: 1,
  data: {
    items: ['doc-1', 'doc-2'],
    globalConcurrency: 2,
    perStageConcurrency: 2,
    attemptCapPerStage: 1,
    failurePolicy: 'fail',
    aggregate: 'tally',
  },
  nodes: [
    { id: 'summarize', data: {} },
    { id: 'verify', data: {} },
    { id: 'tally', data: {} },
  ],
  edges: [
    { id: 'summarize-to-verify', source: 'summarize', target: 'verify', data: {} },
  ],
};

const events: readonly BoundedItemEvent[] = [
  { type: 'items-frozen', version: 1, payload: { items: ['doc-1', 'doc-2'] } },
  { type: 'item-claimed', version: 1, payload: { itemId: 'doc-1', stageId: 'summarize', attempt: 1 } },
  { type: 'item-claimed', version: 1, payload: { itemId: 'doc-2', stageId: 'summarize', attempt: 1 } },
  { type: 'item-stage-completed', version: 1, payload: { itemId: 'doc-1', stageId: 'summarize', attempt: 1, result: {} } },
  { type: 'item-stage-completed', version: 1, payload: { itemId: 'doc-2', stageId: 'summarize', attempt: 1, result: {} } },
  { type: 'item-claimed', version: 1, payload: { itemId: 'doc-1', stageId: 'verify', attempt: 1 } },
  { type: 'item-claimed', version: 1, payload: { itemId: 'doc-2', stageId: 'verify', attempt: 1 } },
  { type: 'item-stage-completed', version: 1, payload: { itemId: 'doc-1', stageId: 'verify', attempt: 1, result: {} } },
  { type: 'item-stage-completed', version: 1, payload: { itemId: 'doc-2', stageId: 'verify', attempt: 1, result: {} } },
  { type: 'aggregate-claimed', version: 1, payload: {} },
  { type: 'aggregate-completed', version: 1, payload: { result: { passed: 2 } } },
];

const identity = {
  source: 'npm:@example/document-checks',
  version: '1.0.0',
  digest: 'sha256:9999999999999999999999999999999999999999999999999999999999999999',
} as const;
const resolution: PlanResolution = {
  package: identity,
  admission: { package: identity, permissions: [] },
  executionLanes: [],
};
const graph = compileGraph(boundedItem, definition);
const state = events.reduce(graph.reduce, graph.initialState());
const plan = resolveGraphPlan(graph.describe(), resolution);

console.log(JSON.stringify({
  decision: graph.decide(state)[0],
  events: events.length,
  planDigest: plan.digest,
  bounds: plan.plan.bounds,
}));
