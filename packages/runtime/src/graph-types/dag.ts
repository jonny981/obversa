/**
 * The DAG graph type (roadmap D6): dependency graphs, sequences, parallel
 * work, and readable pipelines on the common graph contract.
 *
 * One node is one DAG node; edges are dependencies (source must finish
 * before target runs). Required, optional, and finalizer kinds carry the
 * legacy failure policy: a required node failing blocks its dependents and
 * fails the run; an optional failure neither fails the run nor blocks
 * dependents; a completed node whose result carries `skipped: true` counts
 * as an expected skip, which is neutral and never blocks (the legacy unmet
 * `when` gate). With `stopOnError`, the first required failure stops
 * scheduling anything not already in flight; independent branches continue
 * without it. Finalizers run after everything else settles, on failure as
 * on success, and can never turn a failed run green.
 *
 * This is the pure form only: definition validation (including cycle
 * detection through the pinned `toposort`), state reduction, decisions,
 * bounds, and the plan description. Job execution, isolation, kickbacks,
 * and the sequence/parallel/pipeline authoring helpers are the runtime
 * owner's; this file only folds the standard node events and decides what
 * can run next.
 *
 * Event vocabulary (all JSON, the executor's standard node events, recorded
 * into the durable `graph:` namespace):
 * - `node-dispatched` — a node attempt started at a position
 * - `node-completed`  — a node attempt finished; a result carrying
 *   `skipped: true` is an expected skip
 * - `node-failed`     — a node attempt failed with a typed code
 * - `node-paused`     — a node attempt paused; the DAG waits
 * - `node-resumed`    — a paused node continues its attempt
 *
 * A dispatch, completion, or failure counts only for the node's attempt
 * currently in flight at that exact position; a stale event from an earlier
 * attempt is ignored. Positions are minted as `dag/${node}/${attempt}` where
 * the attempt number is the count of recorded dispatches for that node, so
 * every retry takes a fresh position. Retry is graph policy, declared as a
 * per-node cap: decide offers a fresh dispatch for a failed required node
 * while the cap allows, stopOnError suppresses retries as it stops
 * scheduling, and the DAG fails a node only once its cap is exhausted. A
 * late result for a superseded attempt is ignored.
 *
 * A paused node pauses the whole DAG, as the legacy scheduler does: while
 * any node is paused the decision is a pause command, and nothing else is
 * dispatched. A resumed node continues the same attempt.
 *
 * Each decision waits for every recorded attempt to settle, then dispatches
 * one ready batch that fits the global and keyed limits in declaration order.
 * Positions stay unique across the run; the form never re-emits a dispatch
 * for an attempt already recorded in the folded event history. Each dispatch
 * carries the named results of its direct predecessors. Completion returns
 * every completed node result by node name.
 */

import toposort from 'toposort';

import type { GraphCommand } from '../graph/commands.js';
import type { GraphDefinition, NodeId } from '../graph/kernel.js';
import type { ExecutionLaneDescription, GraphDescriptionInput } from '../graph/plan.js';
import type { GraphEvent, GraphType } from '../graph/type.js';
import { GraphValidationError, type GraphValidationIssue, type JsonObject, type JsonValue } from '../graph/value.js';

export type DagNodeKind = 'required' | 'optional' | 'finalizer';

export type DagNodeData = JsonObject & {
  readonly kind: DagNodeKind;
  /** Concurrency key; nodes sharing a key share its declared limit. */
  readonly key: string | null;
  /** Engine lane for this node; omit it for a data-only node. */
  readonly lane?: ExecutionLaneDescription;
};

export interface DagEdgeData extends JsonObject {}

export interface DagData extends JsonObject {
  /** Max node attempts running at once. The legacy default is 4. */
  readonly globalConcurrency: number;
  /** Per-key attempt caps; every node key must appear here. */
  readonly keyedConcurrency: Readonly<Record<string, number>>;
  /** When true, the first required failure stops scheduling anything not in flight. */
  readonly stopOnError: boolean;
  /** Retries offered per failed required node before the DAG fails. */
  readonly retryCapPerNode: number;
}

export type DagDefinition = GraphDefinition<DagNodeData, DagEdgeData, DagData>;

export interface NodeDispatchedPayload extends JsonObject {
  readonly nodeId: NodeId;
  readonly position: string;
}

export interface NodeCompletedPayload extends JsonObject {
  readonly nodeId: NodeId;
  readonly position: string;
  readonly result: JsonValue;
}

export interface NodeFailedPayload extends JsonObject {
  readonly nodeId: NodeId;
  readonly position: string;
  readonly code: string;
}

export interface NodePausedPayload extends JsonObject {
  readonly nodeId: NodeId;
  readonly position: string;
  readonly reason: string;
}

export interface NodeResumedPayload extends JsonObject {
  readonly nodeId: NodeId;
}

export type DagEvent =
  | GraphEvent<'node-dispatched', NodeDispatchedPayload>
  | GraphEvent<'node-completed', NodeCompletedPayload>
  | GraphEvent<'node-failed', NodeFailedPayload>
  | GraphEvent<'node-paused', NodePausedPayload>
  | GraphEvent<'node-resumed', NodeResumedPayload>;

export type DagNodeStatus =
  | 'pending'
  | 'in-flight'
  | 'paused'
  | 'passed'
  | 'skipped'
  | 'failed';

export interface DagNodeState extends JsonObject {
  readonly status: DagNodeStatus;
  /** Recorded dispatch count; the source of fresh attempt positions. */
  readonly attempts: number;
  /** The in-flight attempt position, or null. */
  readonly inFlight: string | null;
  /** The reason supplied by a paused attempt, or null. */
  readonly pauseReason: string | null;
  /** The completed payload, or null before a successful completion. */
  readonly result: JsonValue;
}

export interface DagStatus extends JsonObject {
  readonly nodes: Readonly<Record<NodeId, DagNodeState>>;
}

export type DagRequirements = { readonly memory: 'unused' };

function issue(code: string, path: string, message: string): GraphValidationIssue {
  return { code, path, message };
}

const NODE_KINDS = new Set<DagNodeKind>(['required', 'optional', 'finalizer']);

/** Form-level validation on top of the kernel's structural checks. */
function validateDag(definition: DagDefinition): void {
  const issues: GraphValidationIssue[] = [];
  const finalizers = new Set<NodeId>();
  const keys = new Set<string>();

  for (const node of definition.nodes) {
    if (!NODE_KINDS.has(node.data.kind)) {
      issues.push(issue(
        'INVALID_NODE_KIND',
        `/nodes/${node.id}/data/kind`,
        `Node kind must be required, optional, or finalizer; received ${JSON.stringify(node.data.kind)}.`,
      ));
    }
    if (node.data.kind === 'finalizer') finalizers.add(node.id);
    if (node.data.key !== null) keys.add(node.data.key);
  }

  if (
    !Number.isSafeInteger(definition.data.globalConcurrency)
    || definition.data.globalConcurrency < 1
  ) {
    issues.push(issue(
      'INVALID_LIMIT',
      '/data/globalConcurrency',
      'globalConcurrency must be a safe integer of at least 1.',
    ));
  }

  for (const [key, limit] of Object.entries(definition.data.keyedConcurrency)) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      issues.push(issue(
        'INVALID_LIMIT',
        `/data/keyedConcurrency/${key}`,
        `The limit for key "${key}" must be a safe integer of at least 1.`,
      ));
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(definition.data.keyedConcurrency, key)) {
      issues.push(issue(
        'MISSING_KEY_LIMIT',
        `/data/keyedConcurrency`,
        `Nodes with key "${key}" need a limit in keyedConcurrency.`,
      ));
    }
  }

  if (typeof definition.data.stopOnError !== 'boolean') {
    issues.push(issue(
      'INVALID_STOP_ON_ERROR',
      '/data/stopOnError',
      'stopOnError must be a boolean.',
    ));
  }

  if (
    !Number.isSafeInteger(definition.data.retryCapPerNode)
    || definition.data.retryCapPerNode < 0
  ) {
    issues.push(issue(
      'INVALID_LIMIT',
      '/data/retryCapPerNode',
      'retryCapPerNode must be a safe integer of at least 0.',
    ));
  }

  for (const edge of definition.edges) {
    if (finalizers.has(edge.source) || finalizers.has(edge.target)) {
      issues.push(issue(
        'FINALIZER_HAS_EDGES',
        `/edges/${edge.id}`,
        `Edge "${edge.id}" touches finalizer node "${finalizers.has(edge.source) ? edge.source : edge.target}"; finalizers are edge-free.`,
      ));
    }
  }

  try {
    toposort(definition.edges.map((edge) => [edge.source, edge.target] as [string, string]));
  } catch {
    issues.push(issue(
      'DAG_CYCLE',
      '/edges',
      'The dependency edges contain a cycle.',
    ));
  }

  if (issues.length > 0) {
    throw new GraphValidationError('Invalid dag definition.', issues);
  }
}

function isSkipped(result: JsonValue): boolean {
  return typeof result === 'object'
    && result !== null
    && !Array.isArray(result)
    && (result as { skipped?: unknown }).skipped === true;
}

function greenFor(
  nodeId: NodeId,
  nodes: Readonly<Record<NodeId, DagNodeState>>,
  kindOf: ReadonlyMap<NodeId, DagNodeKind>,
): boolean {
  const state = nodes[nodeId]!;
  if (state.status === 'passed' || state.status === 'skipped') return true;
  if (state.status === 'failed') return kindOf.get(nodeId) === 'optional';
  return false;
}

/**
 * The DAG graph type. Pure data operations only: no file, model, process,
 * clock, or storage services (the D2 contract).
 */
export const dag: GraphType<DagDefinition, DagStatus, DagEvent, DagRequirements> = {
  kind: 'dag',
  version: 1,
  compile(definition) {
    validateDag(definition);
    const kindOf = new Map(definition.nodes.map((node) => [node.id, node.data.kind]));
    const finalizers = definition.nodes.filter((node) => node.data.kind === 'finalizer');
    const workers = definition.nodes.filter((node) => node.data.kind !== 'finalizer');
    const predecessors = new Map<NodeId, readonly NodeId[]>(
      definition.nodes.map((node) => [node.id, definition.edges
        .filter((edge) => edge.target === node.id)
        .map((edge) => edge.source)]),
    );

    const inFlightCount = (state: DagStatus): number =>
      Object.values(state.nodes).filter((node) => node.status === 'in-flight').length;

    const claimable = (
      state: DagStatus,
      nodeId: NodeId,
      stopOnFailure: boolean,
    ): boolean => {
      const node = state.nodes[nodeId]!;
      if (node.status === 'failed') {
        return !definition.data.stopOnError
          && kindOf.get(nodeId) === 'required'
          && node.attempts <= definition.data.retryCapPerNode;
      }
      if (node.status !== 'pending') return false;
      if (stopOnFailure
        && definition.data.stopOnError
        && workers.some((worker) => state.nodes[worker.id]!.status === 'failed'
          && kindOf.get(worker.id) !== 'optional')) {
        return false;
      }
      return predecessors.get(nodeId)!.every((dep) => greenFor(dep, state.nodes, kindOf));
    };

    const anyInFlight = (state: DagStatus): boolean => inFlightCount(state) > 0;

    return {
      requirements: { memory: 'unused' },
      initialState: () => ({
        nodes: Object.fromEntries(definition.nodes.map((node) => [
          node.id,
          { status: 'pending', attempts: 0, inFlight: null, pauseReason: null, result: null },
        ])),
      }),
      reduce(state, event) {
        const node = state.nodes[event.payload.nodeId];
        if (node === undefined) return state;
        switch (event.type) {
          case 'node-dispatched': {
            const fresh = event.payload.position
              === `dag/${event.payload.nodeId}/${node.attempts + 1}`;
            if (!fresh) return state;
            if (node.status !== 'pending' && node.status !== 'failed') return state;
            return {
              ...state,
              nodes: {
                ...state.nodes,
                [event.payload.nodeId]: {
                  status: 'in-flight',
                  attempts: node.attempts + 1,
                  inFlight: event.payload.position,
                  pauseReason: null,
                  result: null,
                },
              },
            };
          }
          case 'node-completed': {
            if (node.status !== 'in-flight' || node.inFlight !== event.payload.position) {
              return state;
            }
            return {
              ...state,
              nodes: {
                ...state.nodes,
                [event.payload.nodeId]: {
                  status: isSkipped(event.payload.result) ? 'skipped' : 'passed',
                  attempts: node.attempts,
                  inFlight: null,
                  pauseReason: null,
                  result: event.payload.result,
                },
              },
            };
          }
          case 'node-failed': {
            if (node.status !== 'in-flight' || node.inFlight !== event.payload.position) {
              return state;
            }
            return {
              ...state,
              nodes: {
                ...state.nodes,
                [event.payload.nodeId]: {
                  status: 'failed',
                  attempts: node.attempts,
                  inFlight: null,
                  pauseReason: null,
                  result: null,
                },
              },
            };
          }
          case 'node-paused': {
            if (node.status !== 'in-flight' || node.inFlight !== event.payload.position) {
              return state;
            }
            return {
              ...state,
              nodes: {
                ...state.nodes,
                [event.payload.nodeId]: {
                  ...node,
                  status: 'paused',
                  pauseReason: event.payload.reason,
                },
              },
            };
          }
          case 'node-resumed': {
            if (node.status !== 'paused') return state;
            return {
              ...state,
              nodes: {
                ...state.nodes,
                [event.payload.nodeId]: {
                  ...node,
                  status: 'in-flight',
                  pauseReason: null,
                },
              },
            };
          }
          default:
            return state;
        }
      },
      decide(state) {
        const resultsFor = (nodeIds: readonly NodeId[]): JsonObject =>
          Object.fromEntries(nodeIds.flatMap((nodeId) => {
            const node = state.nodes[nodeId]!;
            return node.status === 'passed' || node.status === 'skipped'
              ? [[nodeId, node.result]]
              : [];
          }));
        const dispatch = (nodeId: NodeId): GraphCommand => {
          const node = state.nodes[nodeId]!;
          const results = resultsFor(predecessors.get(nodeId)!);
          return {
            kind: 'dispatch',
            nodeId,
            input: {
              positionSummary: `node ${nodeId}, attempt ${node.attempts + 1}`,
              ...(Object.keys(results).length === 0 ? {} : { results }),
            },
            position: `dag/${nodeId}/${node.attempts + 1}`,
          };
        };

        const paused = definition.nodes.find(
          (node) => state.nodes[node.id]!.status === 'paused',
        );
        if (paused !== undefined) {
          return [{
            kind: 'pause',
            reason: state.nodes[paused.id]!.pauseReason!,
          }];
        }

        const keyOf = (nodeId: NodeId): string | null =>
          definition.nodes.find((node) => node.id === nodeId)!.data.key;

        const collect = (
          candidates: readonly { id: NodeId }[],
          stopOnFailure: boolean,
        ): GraphCommand[] => {
          const commands: GraphCommand[] = [];
          let freeGlobal = definition.data.globalConcurrency;
          const keyFree = new Map<string, number>(
            Object.entries(definition.data.keyedConcurrency),
          );
          for (const candidate of candidates) {
            if (freeGlobal <= 0) break;
            if (!claimable(state, candidate.id, stopOnFailure)) continue;
            const key = keyOf(candidate.id);
            if (key !== null && (keyFree.get(key) ?? 0) <= 0) continue;
            commands.push(dispatch(candidate.id));
            freeGlobal -= 1;
            if (key !== null) keyFree.set(key, (keyFree.get(key) ?? 0) - 1);
          }
          return commands;
        };

        if (anyInFlight(state)) return [];

        const workerCommands = collect(workers, true);
        if (workerCommands.length > 0) return workerCommands;

        const finalizerCommands = collect(finalizers, false);
        if (finalizerCommands.length > 0) return finalizerCommands;

        const failedRequired = workers.filter(
          (worker) => state.nodes[worker.id]!.status === 'failed'
            && kindOf.get(worker.id) === 'required',
        );
        if (failedRequired.length > 0) {
          return [{
            kind: 'fail',
            code: 'DAG_NODE_FAILED',
            message: `Failed required nodes: ${failedRequired.map((node) => node.id).join(', ')}.`,
          }];
        }
        const failedFinalizers = finalizers.filter(
          (finalizer) => state.nodes[finalizer.id]!.status === 'failed',
        );
        if (failedFinalizers.length > 0) {
          return [{
            kind: 'fail',
            code: 'DAG_NODE_FAILED',
            message: `Failed finalizer nodes: ${failedFinalizers.map((node) => node.id).join(', ')}.`,
          }];
        }
        return [{
          kind: 'complete',
          output: {
            nodes: resultsFor(definition.nodes.map((node) => node.id)),
          },
        }];
      },
      describe(): GraphDescriptionInput {
        return {
          inputContract: { brief: 'json' },
          outputContract: { nodes: 'object' },
          phases: [{
            id: 'graph',
            name: 'Graph',
            nodeIds: definition.nodes.map((node) => node.id),
          }],
          nodes: definition.nodes.map((node) => ({
            id: node.id,
            phaseId: 'graph',
            inputContract: { brief: 'json' },
            outputContract: { result: 'json', skipped: 'boolean?' },
            laneId: node.data.lane?.id ?? null,
          })),
          policies: {
            retry: null,
            stop: null,
            concurrency: {
              global: definition.data.globalConcurrency,
              keyed: definition.data.keyedConcurrency,
            },
            write: null,
            budget: null,
            action: null,
          },
          executionLanes: definition.nodes.flatMap((node) =>
            node.data.lane === undefined ? [] : [node.data.lane]),
          requestedPermissions: [],
          bounds: {
            dispatches: {
              min: { kind: 'known', value: definition.nodes.length },
              max: {
                kind: 'known',
                value: definition.nodes.length
                  + workers.filter((worker) => worker.data.kind === 'required').length
                    * definition.data.retryCapPerNode,
              },
            },
            maxConcurrency: { kind: 'known', value: definition.data.globalConcurrency },
            maxFanOut: { kind: 'known', value: definition.data.globalConcurrency },
          },
        };
      },
    };
  },
};
