import {
  compileGraph,
  GraphValidationError,
  resolveGraphPlan,
  type GraphEvent,
  type GraphType,
  type GraphDefinition,
  type JsonObject,
  type PlanResolution,
} from '@obversa/runtime';
import {
  runGraphTypeConformance,
  type GraphTypeConformanceFixture,
} from '@obversa/runtime/testing';

/**
 * The turn-taking example graph type (roadmap D5): two named roles alternate
 * until a deterministic gate passes. An example, not a built-in graph type —
 * it imports only the documented package entry points.
 *
 * The writer is a data-only node (no lane); the critic declares one engine
 * lane with one declared substitution, so the executor can route a later
 * attempt to the fallback when the requested model is recorded dead. The
 * example itself contains no routing code: its only lane knowledge is the
 * describe() declaration.
 *
 * The gate is the round count, so the whole trace is exact: with maxRounds 3
 * the run makes six dispatches and completes.
 */

interface TurnTakingData extends JsonObject {
  readonly maxRounds: number;
}

type TurnTakingDefinition = GraphDefinition<JsonObject, JsonObject, TurnTakingData>;

interface NodeDispatchedPayload extends JsonObject {
  readonly nodeId: string;
  readonly position: string;
}

interface NodeCompletedPayload extends JsonObject {
  readonly nodeId: string;
  readonly position: string;
  readonly result: JsonObject;
}

interface NodeFailedPayload extends JsonObject {
  readonly nodeId: string;
  readonly position: string;
  readonly code: string;
}

type TurnTakingEvent =
  | GraphEvent<'node-dispatched', NodeDispatchedPayload>
  | GraphEvent<'node-completed', NodeCompletedPayload>
  | GraphEvent<'node-failed', NodeFailedPayload>;

interface TurnTakingState extends JsonObject {
  readonly next: 'writer' | 'critic' | 'done' | 'failed';
  readonly round: number;
  readonly inFlight: string | null;
}

const CRITIC_LANE = 'critic-lane';
const REQUESTED_TARGET = {
  adapter: 'mock',
  provider: 'mock',
  modelFamily: 'mock-family',
  model: 'mock-primary',
  tools: [] as readonly string[],
};
const FALLBACK_TARGET = { ...REQUESTED_TARGET, model: 'mock-fallback' };

const definition: TurnTakingDefinition = {
  id: 'turn-taking',
  definitionVersion: 1,
  data: { maxRounds: 3 },
  nodes: [
    { id: 'writer', data: {} },
    { id: 'critic', data: {} },
  ],
  edges: [
    { id: 'writer-to-critic', source: 'writer', target: 'critic', data: {} },
    { id: 'critic-to-writer', source: 'critic', target: 'writer', data: {} },
  ],
};

const graphType: GraphType<
  TurnTakingDefinition,
  TurnTakingState,
  TurnTakingEvent,
  { readonly memory: 'unused' }
> = {
  kind: 'turn-taking',
  version: 1,
  compile(value) {
    if (!Number.isSafeInteger(value.data.maxRounds) || value.data.maxRounds < 1) {
      throw new GraphValidationError('Invalid turn-taking definition.', [
        {
          code: 'INVALID_MAX_ROUNDS',
          path: '/data/maxRounds',
          message: 'maxRounds must be a safe integer of at least 1.',
        },
      ]);
    }
    return {
      requirements: { memory: 'unused' },
      initialState: () => ({ next: 'writer', round: 1, inFlight: null }),
      reduce(state, event) {
        switch (event.type) {
          case 'node-dispatched': {
            if (state.inFlight !== null) return state;
            if (event.payload.nodeId !== state.next) return state;
            return { ...state, inFlight: event.payload.position };
          }
          case 'node-completed': {
            if (state.inFlight !== event.payload.position) return state;
            if (state.next === 'writer') {
              return { ...state, next: 'critic', inFlight: null };
            }
            if (state.next === 'critic') {
              return {
                ...state,
                next: state.round >= value.data.maxRounds ? 'done' : 'writer',
                round: state.round + 1,
                inFlight: null,
              };
            }
            return state;
          }
          case 'node-failed': {
            if (state.inFlight !== event.payload.position) return state;
            return { ...state, next: 'failed', inFlight: null };
          }
          default:
            return state;
        }
      },
      decide(state) {
        if (state.next === 'done') {
          return [{ kind: 'complete', output: { rounds: value.data.maxRounds } }];
        }
        if (state.next === 'failed') {
          return [{
            kind: 'fail',
            code: 'TURN_FAILED',
            message: `A turn failed at round ${state.round}.`,
          }];
        }
        if (state.inFlight !== null) return [];
        return [{
          kind: 'dispatch',
          nodeId: state.next,
          input: {
            positionSummary: `round ${state.round}, turn ${state.next}`,
          },
          position: `turns/${state.round}-${state.next}`,
        }];
      },
      describe() {
        return {
          inputContract: { brief: 'json' },
          outputContract: { rounds: 'number' },
          phases: [{
            id: 'turns',
            name: 'Turns',
            nodeIds: value.nodes.map((node) => node.id),
          }],
          nodes: value.nodes.map((node) => ({
            id: node.id,
            phaseId: 'turns',
            inputContract: { brief: 'json' },
            outputContract: { draft: 'json' },
            laneId: node.id === 'critic' ? CRITIC_LANE : null,
          })),
          policies: {
            retry: null,
            stop: null,
            concurrency: { global: 1 },
            write: null,
            budget: null,
            action: null,
          },
          executionLanes: [{
            id: CRITIC_LANE,
            requested: REQUESTED_TARGET,
            knownSubstitutions: [FALLBACK_TARGET],
          }],
          requestedPermissions: [],
          bounds: {
            dispatches: {
              min: { kind: 'known', value: 2 * value.data.maxRounds },
              max: { kind: 'known', value: 2 * value.data.maxRounds },
            },
            maxConcurrency: { kind: 'known', value: 1 },
            maxFanOut: { kind: 'known', value: 1 },
          },
        };
      },
    };
  },
};

const events: readonly TurnTakingEvent[] = [
  { type: 'node-dispatched', version: 1, payload: { nodeId: 'writer', position: 'turns/1-writer' } },
  { type: 'node-completed', version: 1, payload: { nodeId: 'writer', position: 'turns/1-writer', result: {} } },
  { type: 'node-dispatched', version: 1, payload: { nodeId: 'critic', position: 'turns/1-critic' } },
  { type: 'node-completed', version: 1, payload: { nodeId: 'critic', position: 'turns/1-critic', result: {} } },
  { type: 'node-dispatched', version: 1, payload: { nodeId: 'writer', position: 'turns/2-writer' } },
  { type: 'node-completed', version: 1, payload: { nodeId: 'writer', position: 'turns/2-writer', result: {} } },
  { type: 'node-dispatched', version: 1, payload: { nodeId: 'critic', position: 'turns/2-critic' } },
  { type: 'node-completed', version: 1, payload: { nodeId: 'critic', position: 'turns/2-critic', result: {} } },
  { type: 'node-dispatched', version: 1, payload: { nodeId: 'writer', position: 'turns/3-writer' } },
  { type: 'node-completed', version: 1, payload: { nodeId: 'writer', position: 'turns/3-writer', result: {} } },
  { type: 'node-dispatched', version: 1, payload: { nodeId: 'critic', position: 'turns/3-critic' } },
  { type: 'node-completed', version: 1, payload: { nodeId: 'critic', position: 'turns/3-critic', result: {} } },
];

const identity = {
  source: 'npm:@example/turn-taking',
  version: '1.0.0',
  digest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
} as const;
const resolution: PlanResolution = {
  package: identity,
  admission: { package: identity, permissions: [] },
  executionLanes: [{ id: CRITIC_LANE, effective: REQUESTED_TARGET }],
};

const fixture = {
  graphType,
  definition,
  events,
  invalidDefinitions: [
    { ...definition, nodes: [...definition.nodes, { id: 'writer', data: {} }] },
    { ...definition, data: { maxRounds: 0 } },
    {
      ...definition,
      edges: [
        ...definition.edges,
        { id: 'writer-to-nowhere', source: 'writer', target: 'editor', data: {} },
      ],
    },
  ] as const,
  planResolution: resolution,
  expected: {
    states: [
      { next: 'writer', round: 1, inFlight: null },
      { next: 'writer', round: 1, inFlight: 'turns/1-writer' },
      { next: 'critic', round: 1, inFlight: null },
      { next: 'critic', round: 1, inFlight: 'turns/1-critic' },
      { next: 'writer', round: 2, inFlight: null },
      { next: 'writer', round: 2, inFlight: 'turns/2-writer' },
      { next: 'critic', round: 2, inFlight: null },
      { next: 'critic', round: 2, inFlight: 'turns/2-critic' },
      { next: 'writer', round: 3, inFlight: null },
      { next: 'writer', round: 3, inFlight: 'turns/3-writer' },
      { next: 'critic', round: 3, inFlight: null },
      { next: 'critic', round: 3, inFlight: 'turns/3-critic' },
      { next: 'done', round: 4, inFlight: null },
    ],
    commands: [
      [{ kind: 'dispatch', nodeId: 'writer', input: { positionSummary: 'round 1, turn writer' }, position: 'turns/1-writer' }],
      [],
      [{ kind: 'dispatch', nodeId: 'critic', input: { positionSummary: 'round 1, turn critic' }, position: 'turns/1-critic' }],
      [],
      [{ kind: 'dispatch', nodeId: 'writer', input: { positionSummary: 'round 2, turn writer' }, position: 'turns/2-writer' }],
      [],
      [{ kind: 'dispatch', nodeId: 'critic', input: { positionSummary: 'round 2, turn critic' }, position: 'turns/2-critic' }],
      [],
      [{ kind: 'dispatch', nodeId: 'writer', input: { positionSummary: 'round 3, turn writer' }, position: 'turns/3-writer' }],
      [],
      [{ kind: 'dispatch', nodeId: 'critic', input: { positionSummary: 'round 3, turn critic' }, position: 'turns/3-critic' }],
      [],
      [{ kind: 'complete', output: { rounds: 3 } }],
    ],
    bounds: {
      dispatches: { min: { kind: 'known', value: 6 }, max: { kind: 'known', value: 6 } },
      maxConcurrency: { kind: 'known', value: 1 },
      maxFanOut: { kind: 'known', value: 1 },
    },
  },
} satisfies GraphTypeConformanceFixture<
  TurnTakingDefinition,
  TurnTakingState,
  TurnTakingEvent,
  { readonly memory: 'unused' }
>;

const conformance = runGraphTypeConformance(fixture);
if (!conformance.ok) throw new Error(JSON.stringify(conformance.failures));

const compiled = compileGraph(graphType, definition);
const state = events.reduce(compiled.reduce, compiled.initialState());
const plan = resolveGraphPlan(compiled.describe(), resolution);
// The declared substitution must be resolvable too: routing a later critic
// attempt to the fallback is exactly what the executor will do.
const fallbackPlan = resolveGraphPlan(compiled.describe(), {
  ...resolution,
  executionLanes: [{ id: CRITIC_LANE, effective: FALLBACK_TARGET }],
});
if (fallbackPlan.plan.executionLanes[0]?.effective.model !== 'mock-fallback') {
  throw new Error('The declared fallback substitution did not resolve.');
}

console.log(JSON.stringify({
  conformance: conformance.ok,
  cases: conformance.cases,
  state: state.next,
  decision: compiled.decide(state)[0]?.kind,
  planDigest: plan.digest,
  criticLane: plan.plan.executionLanes[0]?.effective.model,
  fallbackResolves: fallbackPlan.plan.executionLanes[0]?.effective.model,
  writerLane: plan.plan.nodes.find((node) => node.id === 'writer')?.laneId,
  dispatches: plan.plan.bounds.dispatches,
  maxConcurrency: plan.plan.bounds.maxConcurrency,
  maxFanOut: plan.plan.bounds.maxFanOut,
}, null, 2));
