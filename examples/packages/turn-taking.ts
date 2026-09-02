import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  compileGraph,
  createGraphExecutor,
  EngineError,
  GraphValidationError,
  persistRunDefinition,
  resolveGraphPlan,
  type EngineSelectionRecord,
  type GraphEvent,
  type GraphNodeBinding,
  type GraphType,
  type GraphDefinition,
  type JsonObject,
  type PlanResolution,
  type RunStoragePolicy,
} from '@obversa/runtime';
import {
  createGraphEventTrace,
  defineGraphDefinition,
  MockEngine,
  runGraphTypeConformance,
  type GraphTypeConformanceFixture,
} from '@obversa/runtime/testing';
import { createLocalRunStorage } from '@obversa/runtime/storage/local';

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

const definition: TurnTakingDefinition = defineGraphDefinition({
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
});

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

const events: readonly TurnTakingEvent[] = createGraphEventTrace<TurnTakingEvent>([
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
]).events;

const identity = {
  source: 'npm:@example/turn-taking',
  version: '1.0.0',
  digest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
} as const;
const resolution: PlanResolution = {
  package: identity,
  admission: { package: identity, permissions: [] },
  executionLanes: [{
    id: CRITIC_LANE,
    effective: REQUESTED_TARGET,
    fallbacks: [FALLBACK_TARGET],
  }],
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
  executionLanes: [{
    id: CRITIC_LANE,
    effective: FALLBACK_TARGET,
    fallbacks: [REQUESTED_TARGET],
  }],
});
if (fallbackPlan.plan.executionLanes[0]?.effective.model !== 'mock-fallback') {
  throw new Error('The declared fallback substitution did not resolve.');
}

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
  input: Pick<GraphNodeBinding, 'prompt' | 'runData'>,
): GraphNodeBinding {
  return {
    ...input,
    scratchDirectory: root,
    workspace: { mode: 'none', directory: null, allowedPaths: [] },
    trustedCaller: {},
    permissions: [],
    policy: {
      inputBytes: 100_000,
      outputBytes: 100_000,
      timeoutMs: 5_000,
      teardownGraceMs: 100,
      memoryBytes: 100_000_000,
      filesChanged: 0,
      linesChanged: 0,
      callTokens: null,
    },
    resultContract: null,
    parseResult: null,
    tokenBudget: null,
    decideAction: async () => ({ kind: 'allow' }),
  };
}

function mockSelection(model: string): EngineSelectionRecord {
  return {
    adapter: 'mock',
    adapterVersion: null,
    provider: null,
    modelFamily: null,
    model,
    executable: null,
    capabilities: [],
  };
}

const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'obversa-turn-taking-')));
let primaryCalls = 0;
let fallbackCalls = 0;
try {
  const storage = createLocalRunStorage({
    directory: join(temporaryRoot, 'storage'),
    namespace: 'turn-taking-example',
    policy: storagePolicy,
  });
  await persistRunDefinition(storage, {
    runId: 'turn-taking-run',
    eventId: 'turn-taking-started',
    timestamp: '2026-01-01T00:00:00.000Z',
    graphDefinition: compiled.definition,
    resolvedPlan: plan,
    resolvedInputs: {},
    workspaceBinding: null,
    hostBinding: null,
  });
  const primary = new MockEngine(() => {
    primaryCalls += 1;
    throw new EngineError({ kind: 'auth', message: 'The example primary is unavailable.' });
  });
  const fallback = new MockEngine(() => {
    fallbackCalls += 1;
    return 'accepted';
  });
  const executor = await createGraphExecutor({
    runId: 'turn-taking-run',
    graph: compiled,
    storage,
    nodes: {
      writer: nodeBinding(temporaryRoot, {
        prompt: null,
        runData: async ({ input }) => ({ draft: input }),
      }),
      critic: nodeBinding(temporaryRoot, {
        prompt: 'Review the current draft.',
        runData: null,
      }),
    },
    engines: [
      {
        target: REQUESTED_TARGET,
        selection: mockSelection('mock-primary'),
        engine: primary,
        hardTokenLimitEnforceable: false,
      },
      {
        target: FALLBACK_TARGET,
        selection: mockSelection('mock-fallback'),
        engine: fallback,
        hardTokenLimitEnforceable: false,
      },
    ],
  });
  const executorResult = await executor.run(new AbortController().signal);
  const storedEvents = [];
  for await (const event of storage.eventStore.read({
    namespace: storage.record.namespace,
    streamId: 'turn-taking-run',
  })) storedEvents.push(event);

  console.log(JSON.stringify({
    conformance: conformance.ok,
    cases: conformance.cases,
    state: state.next,
    decision: compiled.decide(state)[0]?.kind,
    executor: executorResult.kind,
    executorOutput: executorResult.kind === 'complete' ? executorResult.output : null,
    executorDispatches: storedEvents.filter((event) => event.type === 'graph:node-dispatched').length,
    primaryCalls,
    fallbackCalls,
    planDigest: plan.digest,
    criticLane: plan.plan.executionLanes[0]?.effective.model,
    fallbackResolves: fallbackPlan.plan.executionLanes[0]?.effective.model,
    writerLane: plan.plan.nodes.find((node) => node.id === 'writer')?.laneId,
    dispatches: plan.plan.bounds.dispatches,
    maxConcurrency: plan.plan.bounds.maxConcurrency,
    maxFanOut: plan.plan.bounds.maxFanOut,
  }, null, 2));
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
