/**
 * The directed-state graph type: long-lived flows with named states, guarded
 * transitions, cycles, and explicit terminal states (roadmap D8).
 *
 * One node is one state, one action per state. Edges are guarded transitions
 * keyed by a route: a state's node completes with a typed transition result
 * carrying a route key, and the edge from the active state whose route
 * matches wins. A route key that matches no edge falls back to the declared
 * fallback route, so the route set stays closed (cookbook line 249).
 *
 * This is the pure form only: definition validation, state reduction,
 * decisions, bounds, and the plan description. The callback public surface
 * (gate, client, router, digests) is the runtime owner's; this file only
 * folds the events that surface records and decides while a callback is
 * pending.
 *
 * Event vocabulary (all JSON, recorded by the executor or the callback
 * surface into the durable `graph:` namespace):
 * - `node-dispatched`  — a node attempt started at a position
 * - `node-completed`   — a node attempt finished, result carries the route
 * - `node-failed`      — a node attempt failed with a typed code
 * - `callback-requested` — a callback gate on the active state awaits an answer
 * - `callback-released`  — the pending request was released for reassignment
 *
 * Positions are minted as `states/${state}/${attempt}` where the attempt
 * counter is the number of dispatches recorded for that state: a retry or a
 * re-entered cycle state always takes a fresh position. A dispatch counts
 * only when no attempt is in flight and it names the active state; a second
 * or foreign dispatch event is ignored.
 *
 * A completion or failure counts only for the attempt in flight at that
 * exact position; a stale event from an earlier attempt is ignored.
 */

import { isDeepStrictEqual } from 'node:util';

import type { GraphDefinition, GraphKernel, NodeId } from '../graph/kernel.js';
import type { ExecutionLaneDescription, GraphDescriptionInput } from '../graph/plan.js';
import type { GraphEvent, GraphType } from '../graph/type.js';
import { GraphValidationError, type GraphValidationIssue, type JsonObject } from '../graph/value.js';

/** The three explicit terminal kinds (roadmap D8). */
export type StateTerminalKind = 'complete' | 'fail' | 'pause';

type StateExecutionTargetData = {
  readonly adapter: string;
  readonly provider: string;
  readonly modelFamily: string;
  readonly model: string;
  readonly tools: readonly string[];
};

type StateExecutionLaneData = {
  readonly id: string;
  readonly requested: StateExecutionTargetData;
  readonly knownSubstitutions: readonly StateExecutionTargetData[];
};

export type StateNodeData = JsonObject & {
  /** Terminal kind; null means the state is an ordinary state. */
  readonly terminal: StateTerminalKind | null;
  /** Engine lane for this state action; omit it for a data-only action. */
  readonly lane?: StateExecutionLaneData;
};

export interface StateEdgeData extends JsonObject {
  /** Route key a completion result must carry to take this edge. */
  readonly route: string;
}

export interface DirectedStateData extends JsonObject {
  readonly initial: NodeId;
  /** Route taken when a result's route key matches no edge from the state. */
  readonly fallbackRoute: string;
}

export type DirectedStateDefinition = GraphDefinition<
  StateNodeData,
  StateEdgeData,
  DirectedStateData
>;

export interface StateNodeDispatchedPayload extends JsonObject {
  readonly nodeId: NodeId;
  readonly position: string;
}

export interface StateNodeCompletedPayload extends JsonObject {
  readonly nodeId: NodeId;
  readonly position: string;
  /** Route key of the typed transition result; null ends a terminal action. */
  readonly route: string | null;
}

export interface StateNodeFailedPayload extends JsonObject {
  readonly nodeId: NodeId;
  readonly position: string;
  readonly code: string;
}

export interface StateCallbackRequestedPayload extends JsonObject {
  readonly state: NodeId;
  readonly digest: string;
}

export interface StateCallbackReleasedPayload extends JsonObject {
  readonly state: NodeId;
}

export type DirectedStateEvent =
  | GraphEvent<'node-dispatched', StateNodeDispatchedPayload>
  | GraphEvent<'node-completed', StateNodeCompletedPayload>
  | GraphEvent<'node-failed', StateNodeFailedPayload>
  | GraphEvent<'callback-requested', StateCallbackRequestedPayload>
  | GraphEvent<'callback-released', StateCallbackReleasedPayload>;

export interface DirectedStateStatus extends JsonObject {
  readonly active: NodeId;
  /** Dispatch count per state; the source of fresh attempt positions. */
  readonly visits: Readonly<Record<NodeId, number>>;
  /** The active state's in-flight attempt position, or null. */
  readonly inFlight: string | null;
  /** A callback gate awaiting an answer, or null. */
  readonly pending: Readonly<{ state: NodeId; digest: string }> | null;
  /** A reached terminal, or null. */
  readonly settled: Readonly<{
    kind: StateTerminalKind;
    state: NodeId;
  }> | null;
}

export type DirectedStateRequirements = { readonly memory: 'unused' };

function issue(code: string, path: string, message: string): GraphValidationIssue {
  return { code, path, message };
}

function terminalKinds(definition: DirectedStateDefinition): Map<NodeId, StateTerminalKind> {
  const terminals = new Map<NodeId, StateTerminalKind>();
  for (const node of definition.nodes) {
    const kind = node.data.terminal;
    if (kind === 'complete' || kind === 'fail' || kind === 'pause') {
      terminals.set(node.id, kind);
    }
  }
  return terminals;
}

/** Form-level validation on top of the kernel's structural checks. */
function validateStateMachine(
  definition: DirectedStateDefinition,
  kernel: GraphKernel<DirectedStateDefinition>,
): ReadonlyMap<string, ExecutionLaneDescription> {
  const issues: GraphValidationIssue[] = [];
  const terminals = terminalKinds(definition);
  const nodeIds = new Set(definition.nodes.map((node) => node.id));
  const executionLanes = new Map<string, ExecutionLaneDescription>();

  for (const node of definition.nodes) {
    const kind = node.data.terminal;
    if (
      kind !== null
      && kind !== 'complete' && kind !== 'fail' && kind !== 'pause'
    ) {
      issues.push(issue(
        'INVALID_TERMINAL',
        `/nodes/${node.id}/data/terminal`,
        `Terminal kind must be complete, fail, pause, or null; received ${JSON.stringify(kind)}.`,
      ));
    }
    const lane = node.data.lane;
    if (lane !== undefined) {
      const declared = executionLanes.get(lane.id);
      if (declared !== undefined && !isDeepStrictEqual(declared, lane)) {
        issues.push(issue(
          'CONFLICTING_LANE',
          `/nodes/${node.id}/data/lane`,
          `Lane "${lane.id}" must have the same declaration on every node that uses it.`,
        ));
      } else {
        executionLanes.set(lane.id, lane);
      }
    }
  }

  if (!nodeIds.has(definition.data.initial)) {
    issues.push(issue(
      'INVALID_INITIAL',
      '/data/initial',
      `Initial state "${definition.data.initial}" is not declared.`,
    ));
  }

  if (typeof definition.data.fallbackRoute !== 'string' || definition.data.fallbackRoute.length === 0) {
    issues.push(issue(
      'INVALID_FALLBACK_ROUTE',
      '/data/fallbackRoute',
      'The fallback route must be a non-empty string.',
    ));
  }

  for (const node of definition.nodes) {
    const path = `/nodes/${node.id}`;
    const outbound = kernel.outboundEdges(node.id);
    if (terminals.has(node.id)) {
      if (outbound.length > 0) {
        issues.push(issue(
          'TERMINAL_HAS_EDGES',
          `${path}/edges`,
          `Terminal state "${node.id}" must not declare outgoing edges.`,
        ));
      }
      continue;
    }

    const routes = new Set<string>();
    let hasFallback = false;
    for (const edge of outbound) {
      const route = edge.data.route;
      if (typeof route !== 'string' || route.length === 0) {
        issues.push(issue(
          'INVALID_ROUTE',
          `${path}/edges/${edge.id}/data/route`,
          `Edge "${edge.id}" must declare a non-empty route.`,
        ));
        continue;
      }
      if (routes.has(route)) {
        issues.push(issue(
          'DUPLICATE_ROUTE',
          `${path}/edges/${edge.id}/data/route`,
          `Route "${route}" is declared more than once from state "${node.id}".`,
        ));
      }
      routes.add(route);
      if (route === definition.data.fallbackRoute) hasFallback = true;
    }
    if (!hasFallback) {
      issues.push(issue(
        'MISSING_FALLBACK_ROUTE',
        `${path}/edges`,
        `State "${node.id}" must declare the fallback route "${definition.data.fallbackRoute}".`,
      ));
    }
  }

  if (terminals.size > 0) {
    for (const node of definition.nodes) {
      if (reachesTerminal(node.id, kernel, terminals)) continue;
      issues.push(issue(
        'NO_TERMINAL_PATH',
        `/nodes/${node.id}`,
        `State "${node.id}" has no path to a terminal state.`,
      ));
    }
  } else {
    issues.push(issue(
      'NO_TERMINAL_PATH',
      '/nodes',
      'The machine declares no terminal state.',
    ));
  }

  if (issues.length > 0) {
    throw new GraphValidationError('Invalid directed-state definition.', issues);
  }
  return executionLanes;
}

function reachesTerminal(
  from: NodeId,
  kernel: GraphKernel<DirectedStateDefinition>,
  terminals: ReadonlyMap<NodeId, StateTerminalKind>,
): boolean {
  const seen = new Set<NodeId>([from]);
  const queue: NodeId[] = [from];
  while (queue.length > 0) {
    const state = queue.shift()!;
    if (terminals.has(state)) return true;
    for (const next of kernel.successors(state)) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}

function nextPosition(state: DirectedStateStatus): string {
  return `states/${state.active}/${(state.visits[state.active] ?? 0) + 1}`;
}

function positionSummary(state: DirectedStateStatus): string {
  return `state "${state.active}", attempt ${(state.visits[state.active] ?? 0) + 1}`;
}

/**
 * The directed-state graph type. Pure data operations only: no file, model,
 * process, clock, or storage services (the D2 contract).
 */
export const directedState: GraphType<
  DirectedStateDefinition,
  DirectedStateStatus,
  DirectedStateEvent,
  DirectedStateRequirements
> = {
  kind: 'directed-state',
  version: 1,
  compile(definition, kernel) {
    const executionLanes = validateStateMachine(definition, kernel);
    const terminals = terminalKinds(definition);

    return {
      requirements: { memory: 'unused' },
      initialState: () => ({
        active: definition.data.initial,
        visits: {},
        inFlight: null,
        pending: null,
        settled: null,
      }),
      reduce(state, event) {
        switch (event.type) {
          case 'node-dispatched': {
            if (state.inFlight !== null) return state;
            if (event.payload.nodeId !== state.active) return state;
            return {
              ...state,
              visits: {
                ...state.visits,
                [event.payload.nodeId]: (state.visits[event.payload.nodeId] ?? 0) + 1,
              },
              inFlight: event.payload.position,
            };
          }
          case 'node-completed': {
            if (state.inFlight !== event.payload.position) return state;
            const pending = state.pending?.state === event.payload.nodeId
              ? null
              : state.pending;
            if (terminals.has(state.active)) {
              return {
                ...state,
                pending,
                inFlight: null,
                settled: { kind: terminals.get(state.active)!, state: state.active },
              };
            }
            const route = event.payload.route;
            const outbound = kernel.outboundEdges(state.active);
            const edge = outbound.find((candidate) => candidate.data.route === route)
              ?? outbound.find((candidate) => candidate.data.route === definition.data.fallbackRoute);
            if (!edge) return { ...state, pending, inFlight: null };
            return {
              ...state,
              pending,
              inFlight: null,
              active: edge.target,
            };
          }
          case 'node-failed': {
            if (state.inFlight !== event.payload.position) return state;
            const pending = state.pending?.state === event.payload.nodeId
              ? null
              : state.pending;
            return { ...state, pending, inFlight: null };
          }
          case 'callback-requested': {
            if (event.payload.state !== state.active || state.settled !== null) {
              return state;
            }
            return {
              ...state,
              pending: { state: event.payload.state, digest: event.payload.digest },
            };
          }
          case 'callback-released': {
            if (state.pending?.state !== event.payload.state) return state;
            return { ...state, pending: null };
          }
          default:
            return state;
        }
      },
      decide(state) {
        if (state.inFlight !== null) return [];

        if (state.settled !== null) {
          if (state.settled.kind === 'complete') {
            return [{
              kind: 'complete',
              output: { terminal: state.settled.state },
            }];
          }
          if (state.settled.kind === 'fail') {
            return [{
              kind: 'fail',
              code: 'STATE_TERMINAL_FAIL',
              message: `The state machine settled in fail terminal "${state.settled.state}".`,
            }];
          }
          return [{
            kind: 'pause',
            reason: `The state machine settled in pause terminal "${state.settled.state}".`,
          }];
        }
        if (state.pending !== null) return [];
        return [{
          kind: 'dispatch',
          nodeId: state.active,
          input: { positionSummary: positionSummary(state) },
          position: nextPosition(state),
        }];
      },
      describe(): GraphDescriptionInput {
        return {
          inputContract: { route: 'string | null' },
          outputContract: { terminal: 'string' },
          phases: [{
            id: 'states',
            name: 'States',
            nodeIds: definition.nodes.map((node) => node.id),
          }],
          nodes: definition.nodes.map((node) => ({
            id: node.id,
            phaseId: 'states',
            inputContract: { route: 'string | null' },
            outputContract: { route: 'string' },
            laneId: node.data.lane?.id ?? null,
          })),
          policies: {
            retry: null,
            stop: null,
            concurrency: null,
            write: null,
            budget: null,
            action: null,
          },
          executionLanes: [...executionLanes.values()],
          requestedPermissions: [],
          bounds: {
            dispatches: {
              min: { kind: 'known', value: 1 },
              max: {
                kind: 'unknown',
                reason: 'a state machine may cycle without a declared bound',
              },
            },
            maxConcurrency: { kind: 'known', value: 1 },
            maxFanOut: { kind: 'known', value: 1 },
          },
        };
      },
    };
  },
};
