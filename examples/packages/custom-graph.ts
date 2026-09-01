import {
  compileGraph,
  resolveGraphPlan,
  type GraphDefinition,
  type GraphEvent,
  type GraphType,
  type PlanResolution,
} from '@obversa/runtime';
import {
  runGraphTypeConformance,
  type GraphTypeConformanceFixture,
} from '@obversa/runtime/testing';

const definition: GraphDefinition = {
  id: 'draft-review',
  definitionVersion: 1,
  data: {},
  nodes: [
    { id: 'draft', data: {} },
    { id: 'review', data: {} },
  ],
  edges: [
    { id: 'draft-to-review', source: 'draft', target: 'review', data: {} },
  ],
};

type State = { readonly next: 'draft' | 'review' | 'done' };
type Event = GraphEvent<
  'node-completed',
  { readonly nodeId: 'draft' | 'review' }
>;

const graphType: GraphType<
  GraphDefinition,
  State,
  Event,
  { readonly memory: 'unused' }
> = {
  kind: 'draft-review',
  version: 1,
  compile(value) {
    return {
      requirements: { memory: 'unused' },
      initialState: () => ({ next: 'draft' }),
      reduce: (state, event) =>
        event.payload.nodeId === state.next
          ? { next: state.next === 'draft' ? 'review' : 'done' }
          : state,
      decide: (state) =>
        state.next === 'done'
          ? [{ kind: 'complete', output: { approved: true } }]
          : [{
              kind: 'dispatch',
              nodeId: state.next,
              input: {},
              position: `work/${state.next}`,
            }],
      describe: () => ({
        inputContract: {},
        outputContract: {},
        phases: [{
          id: 'work',
          name: 'Draft and review',
          nodeIds: value.nodes.map((node) => node.id),
        }],
        nodes: value.nodes.map((node) => ({
          id: node.id,
          phaseId: 'work',
          inputContract: {},
          outputContract: {},
          laneId: null,
        })),
        policies: {
          retry: null,
          stop: null,
          concurrency: null,
          write: null,
          budget: null,
          action: null,
        },
        executionLanes: [],
        requestedPermissions: [],
        bounds: {
          dispatches: {
            min: { kind: 'known', value: 2 },
            max: { kind: 'known', value: 2 },
          },
          maxConcurrency: { kind: 'known', value: 1 },
          maxFanOut: { kind: 'known', value: 1 },
        },
      }),
    };
  },
};

const events: readonly Event[] = [
  { type: 'node-completed', version: 1, payload: { nodeId: 'draft' } },
  { type: 'node-completed', version: 1, payload: { nodeId: 'review' } },
];
const identity = {
  source: 'npm:@example/draft-review',
  version: '1.0.0',
  digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
} as const;
const resolution: PlanResolution = {
  package: identity,
  admission: { package: identity, permissions: [] },
  executionLanes: [],
};
const fixture = {
  graphType,
  definition,
  events,
  invalidDefinitions: [{
    ...definition,
    nodes: [...definition.nodes, { id: 'draft', data: {} }],
  }] as const,
  planResolution: resolution,
  expected: {
    states: [
      { next: 'draft' },
      { next: 'review' },
      { next: 'done' },
    ],
    commands: [
      [{ kind: 'dispatch', nodeId: 'draft', input: {}, position: 'work/draft' }],
      [{ kind: 'dispatch', nodeId: 'review', input: {}, position: 'work/review' }],
      [{ kind: 'complete', output: { approved: true } }],
    ],
    bounds: {
      dispatches: {
        min: { kind: 'known', value: 2 },
        max: { kind: 'known', value: 2 },
      },
      maxConcurrency: { kind: 'known', value: 1 },
      maxFanOut: { kind: 'known', value: 1 },
    },
  },
} satisfies GraphTypeConformanceFixture<
  GraphDefinition,
  State,
  Event,
  { readonly memory: 'unused' }
>;

const conformance = runGraphTypeConformance(fixture);
if (!conformance.ok) throw new Error(JSON.stringify(conformance.failures));

const compiled = compileGraph(graphType, definition);
const state = events.reduce(compiled.reduce, compiled.initialState());
const plan = resolveGraphPlan(compiled.describe(), resolution);

console.log(JSON.stringify({
  conformance: conformance.ok,
  cases: conformance.cases,
  state: state.next,
  decision: compiled.decide(state)[0]?.kind,
  planDigest: plan.digest,
  dispatches: plan.plan.bounds.dispatches,
  maxConcurrency: plan.plan.bounds.maxConcurrency,
  maxFanOut: plan.plan.bounds.maxFanOut,
}, null, 2));
