import {
  compileGraph,
  createCallbackClient,
  createCallbackGate,
  directedState,
  directRouter,
  resolveGraphPlan,
  type DirectedStateDefinition,
  type DirectedStateEvent,
  type PlanResolution,
} from '@obversa/runtime';

const definition: DirectedStateDefinition = {
  id: 'release-approval',
  definitionVersion: 1,
  data: { initial: 'draft', fallbackRoute: 'hold' },
  nodes: [
    { id: 'draft', data: { terminal: null } },
    { id: 'await-approval', data: { terminal: null } },
    { id: 'approved', data: { terminal: 'complete' } },
  ],
  edges: [
    { id: 'draft-ready', source: 'draft', target: 'await-approval', data: { route: 'ready' } },
    { id: 'draft-hold', source: 'draft', target: 'draft', data: { route: 'hold' } },
    { id: 'approval-yes', source: 'await-approval', target: 'approved', data: { route: 'approved' } },
    { id: 'approval-hold', source: 'await-approval', target: 'await-approval', data: { route: 'hold' } },
  ],
};

const callback = createCallbackGate({
  gateId: 'release-approval',
  gateVersion: 1,
  decisionText: 'Approve release abc123?',
  responseSchema: {
    type: 'object',
    properties: { approved: { type: 'boolean' } },
    required: ['approved'],
  },
  input: { revision: 'abc123' },
});
const client = createCallbackClient();
client.post(callback);
const submitted = await directRouter(
  client,
  callback,
  'direct-router',
  () => ({ approved: true }),
);
if (!submitted.ok) throw new Error(submitted.reason);
const answer = submitted.response as Readonly<Record<string, unknown>>;
const approved = answer.approved === true;

const events: readonly DirectedStateEvent[] = [
  {
    type: 'node-dispatched',
    version: 1,
    payload: { nodeId: 'draft', position: 'states/draft/1' },
  },
  {
    type: 'node-completed',
    version: 1,
    payload: { nodeId: 'draft', position: 'states/draft/1', route: 'ready' },
  },
  {
    type: 'node-dispatched',
    version: 1,
    payload: { nodeId: 'await-approval', position: 'states/await-approval/1' },
  },
  {
    type: 'callback-requested',
    version: 1,
    payload: { state: 'await-approval', digest: callback.digest },
  },
  {
    type: 'node-completed',
    version: 1,
    payload: {
      nodeId: 'await-approval',
      position: 'states/await-approval/1',
      route: approved ? 'approved' : 'hold',
    },
  },
  {
    type: 'node-dispatched',
    version: 1,
    payload: { nodeId: 'approved', position: 'states/approved/1' },
  },
  {
    type: 'node-completed',
    version: 1,
    payload: { nodeId: 'approved', position: 'states/approved/1', route: null },
  },
];

const identity = {
  source: 'npm:@example/release-approval',
  version: '1.0.0',
  digest: 'sha256:8888888888888888888888888888888888888888888888888888888888888888',
} as const;
const resolution: PlanResolution = {
  package: identity,
  admission: { package: identity, permissions: [] },
  executionLanes: [],
};
const graph = compileGraph(directedState, definition);
const state = events.reduce(graph.reduce, graph.initialState());
const plan = resolveGraphPlan(graph.describe(), resolution);

console.log(JSON.stringify({
  callback: submitted.ok ? 'accepted' : 'refused',
  callbackEvents: client.history().map((event) => event.kind),
  decision: graph.decide(state)[0],
  events: events.length,
  planDigest: plan.digest,
  bounds: plan.plan.bounds,
}));
