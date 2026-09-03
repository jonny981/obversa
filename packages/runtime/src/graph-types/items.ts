/**
 * The bounded-item graph type, stage-sequence shape: large fixed worklists
 * with stable identity and controlled batches (roadmap D9).
 *
 * One node is one stage; every item runs the same fixed linear sequence of
 * stages, declared as a chain of edges. Items are declared in the definition
 * and frozen at run start, so the item set cannot grow while the run is
 * active. A recorded stage pass advances that item. The next dispatch batch
 * waits for every recorded attempt in the current batch to settle.
 *
 * This is the pure form only: definition validation, state reduction,
 * decisions, bounds, and the plan description. The child-graph variant, the
 * run-start freeze record, budgets, and progress summaries are the runtime
 * owner's; this file only folds the events that surface records and decides
 * what can run next.
 *
 * Event vocabulary (all JSON, recorded into the durable `graph:` namespace):
 * - `items-frozen`          — the run-start freeze of the item list
 * - `item-claimed`         — an item's stage attempt started at an attempt number
 * - `item-stage-completed` — an item's stage attempt passed, result recorded
 * - `item-stage-failed`    — an item's stage attempt failed with a typed code
 * - `item-reopened`        — an item re-entered at a declared stage, claimable again
 * - `item-paused`          — an item's attempt paused, not claimable until resumed
 * - `item-resumed`         — a paused item is claimable again
 * - `aggregate-claimed`    — the optional aggregate node started
 * - `aggregate-completed`  — the aggregate node passed, result recorded
 * - `aggregate-failed`     — the aggregate node failed with a typed code
 *
 * The item list arrives as a run-start freeze event that must repeat the
 * declared list exactly, in order; a mismatch fails the fold, and a second
 * freeze is ignored, so the set cannot grow after the run starts.
 *
 * A stage completion, failure, or pause counts only for the item's attempt
 * currently in flight at that exact stage and attempt number; a stale event
 * from an earlier attempt is ignored. A failed stage attempt is retryable up
 * to the per-stage attempt cap — the next claim takes a fresh attempt number
 * — and at the cap the item settles as failed without a further dispatch.
 * Reopening an item resets its attempt-cap budget, while the lifetime claim
 * counts keep positions unique across the whole run. An item error is a
 * recorded item outcome, never a run abort: siblings keep running, and the
 * failure surfaces in the final verdict. Positions are minted as
 * `items/${item}/${stage}/${attempt}` where the attempt number is the count
 * of recorded claims for that item and stage, so a retry or a reopened stage
 * always takes a fresh position.
 *
 * Each decision dispatches one batch of claimable items, in declaration
 * order, within the global and per-stage slots. A later decision waits until
 * every recorded attempt in that batch settles. This keeps a restarted
 * executor from dispatching new work beside attempts it does not own.
 */

import { isDeepStrictEqual } from 'node:util';

import type { GraphCommand } from '../graph/commands.js';
import type { GraphDefinition, NodeId } from '../graph/kernel.js';
import type { ExecutionLaneDescription, GraphDescriptionInput } from '../graph/plan.js';
import type { GraphEvent, GraphType } from '../graph/type.js';
import { GraphValidationError, type GraphValidationIssue, type JsonValue, type JsonObject } from '../graph/value.js';

type ItemExecutionTargetData = {
  readonly adapter: string;
  readonly provider: string;
  readonly modelFamily: string;
  readonly model: string;
  readonly tools: readonly string[];
};

type ItemExecutionLaneData = {
  readonly id: string;
  readonly requested: ItemExecutionTargetData;
  readonly knownSubstitutions: readonly ItemExecutionTargetData[];
};

export type BoundedItemStageData = JsonObject & {
  /** Engine lane for this stage; omit it for a data-only stage. */
  readonly lane?: ItemExecutionLaneData;
};

export interface BoundedItemSequenceEdgeData extends JsonObject {}

export interface BoundedItemData extends JsonObject {
  /** The frozen worklist: unique, non-empty item identifiers. */
  readonly items: readonly string[];
  /** Concurrent stage attempts allowed at once, across all items. */
  readonly globalConcurrency: number;
  /** Concurrent stage attempts allowed per stage. */
  readonly perStageConcurrency: number;
  /** Attempts an item may record at one stage before it counts as failed. */
  readonly attemptCapPerStage: number;
  /** `fail`: any failed item fails the run after the rest settle. `complete`: failures are recorded in the output. */
  readonly failurePolicy: 'fail' | 'complete';
  /** Optional aggregate node that runs once after every item settles; null when absent. */
  readonly aggregate: NodeId | null;
}

export type BoundedItemDefinition = GraphDefinition<
  BoundedItemStageData,
  BoundedItemSequenceEdgeData,
  BoundedItemData
>;

export interface ItemsFrozenPayload extends JsonObject {
  readonly items: readonly string[];
}

export interface ItemClaimedPayload extends JsonObject {
  readonly itemId: string;
  readonly stageId: NodeId;
  readonly attempt: number;
}

export interface ItemStageCompletedPayload extends JsonObject {
  readonly itemId: string;
  readonly stageId: NodeId;
  readonly attempt: number;
  readonly result: JsonValue;
}

export interface ItemStageFailedPayload extends JsonObject {
  readonly itemId: string;
  readonly stageId: NodeId;
  readonly attempt: number;
  readonly code: string;
}

export interface ItemReopenedPayload extends JsonObject {
  readonly itemId: string;
  readonly stageId: NodeId;
}

export interface ItemPausedPayload extends JsonObject {
  readonly itemId: string;
  readonly stageId: NodeId;
  readonly attempt: number;
  readonly reason: string;
}

export interface ItemResumedPayload extends JsonObject {
  readonly itemId: string;
}

export interface AggregateCompletedPayload extends JsonObject {
  readonly result: JsonValue;
}

export interface AggregateFailedPayload extends JsonObject {
  readonly code: string;
}

export type BoundedItemEvent =
  | GraphEvent<'items-frozen', ItemsFrozenPayload>
  | GraphEvent<'item-claimed', ItemClaimedPayload>
  | GraphEvent<'item-stage-completed', ItemStageCompletedPayload>
  | GraphEvent<'item-stage-failed', ItemStageFailedPayload>
  | GraphEvent<'item-reopened', ItemReopenedPayload>
  | GraphEvent<'item-paused', ItemPausedPayload>
  | GraphEvent<'item-resumed', ItemResumedPayload>
  | GraphEvent<'aggregate-claimed', Record<string, never>>
  | GraphEvent<'aggregate-completed', AggregateCompletedPayload>
  | GraphEvent<'aggregate-failed', AggregateFailedPayload>;

export type ItemStatus =
  | 'pending'
  | 'in-flight'
  | 'paused'
  | 'done'
  | 'failed';

export interface ItemProgress extends JsonObject {
  readonly status: ItemStatus;
  /** Index of the next stage to run in the fixed sequence. */
  readonly nextStage: number;
  /** Lifetime claims per stage index; the source of fresh attempt numbers. */
  readonly attempts: Readonly<Record<string, number>>;
  /** Claims per stage index since the last reopen; the attempt-cap budget. */
  readonly capAttempts: Readonly<Record<string, number>>;
}

export interface BoundedItemStatus extends JsonObject {
  /** The run-start freeze record; null until the freeze event folds. */
  readonly frozen: readonly string[] | null;
  readonly items: Readonly<Record<string, ItemProgress>>;
  readonly aggregate: 'not-run' | 'in-flight' | 'done' | 'failed';
  readonly aggregateResult: JsonValue;
}

export type BoundedItemRequirements = { readonly memory: 'unused' };

function issue(code: string, path: string, message: string): GraphValidationIssue {
  return { code, path, message };
}

interface StageChain {
  readonly stages: readonly NodeId[];
  readonly index: ReadonlyMap<NodeId, number>;
}

function stageChain(definition: BoundedItemDefinition): StageChain | undefined {
  const aggregate = definition.data.aggregate ?? null;
  const stageNodes = definition.nodes
    .map((node) => node.id)
    .filter((id) => id !== aggregate);
  if (stageNodes.length === 0) return undefined;

  const inbound = new Map<NodeId, number>();
  const outbound = new Map<NodeId, NodeId>();
  for (const id of stageNodes) {
    inbound.set(id, 0);
  }
  for (const edge of definition.edges) {
    if (!inbound.has(edge.source) || !inbound.has(edge.target)) return undefined;
    inbound.set(edge.target, (inbound.get(edge.target) ?? 0) + 1);
    if (outbound.has(edge.source)) return undefined;
    outbound.set(edge.source, edge.target);
  }

  const heads = stageNodes.filter((id) => (inbound.get(id) ?? 0) === 0);
  if (heads.length !== 1) return undefined;
  const stages: NodeId[] = [];
  const seen = new Set<NodeId>();
  let current: NodeId | undefined = heads[0];
  while (current !== undefined) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    stages.push(current);
    current = outbound.get(current);
  }
  if (seen.size !== stageNodes.length) return undefined;
  return { stages, index: new Map(stages.map((id, position) => [id, position])) };
}

/** Form-level validation on top of the kernel's structural checks. */
function validateWorklist(definition: BoundedItemDefinition): Readonly<{
  chain: StageChain;
  executionLanes: ReadonlyMap<string, ExecutionLaneDescription>;
}> {
  const issues: GraphValidationIssue[] = [];
  const nodeIds = new Set(definition.nodes.map((node) => node.id));
  const executionLanes = new Map<string, ExecutionLaneDescription>();

  for (const node of definition.nodes) {
    const lane = node.data.lane;
    if (lane === undefined) continue;
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

  if (!Array.isArray(definition.data.items) || definition.data.items.length === 0) {
    issues.push(issue('INVALID_ITEMS', '/data/items', 'The worklist must be a non-empty array of item identifiers.'));
  } else {
    const seen = new Set<string>();
    for (const [position, id] of definition.data.items.entries()) {
      if (typeof id !== 'string' || id.length === 0 || id !== id.trim()) {
        issues.push(issue('INVALID_ITEM', `/data/items/${position}`, 'An item identifier must be a non-empty trimmed string.'));
      } else if (seen.has(id)) {
        issues.push(issue('DUPLICATE_ITEM', `/data/items/${position}`, `Item identifier "${id}" is declared more than once.`));
      } else {
        seen.add(id);
      }
    }
  }

  for (const [field, minimum] of [
    ['globalConcurrency', 1],
    ['perStageConcurrency', 1],
    ['attemptCapPerStage', 1],
  ] as const) {
    const value = (definition.data as Record<string, unknown>)[field];
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
      issues.push(issue('INVALID_LIMIT', `/data/${field}`, `${field} must be a safe integer of at least ${minimum}.`));
    }
  }

  if (definition.data.failurePolicy !== 'fail' && definition.data.failurePolicy !== 'complete') {
    issues.push(issue('INVALID_FAILURE_POLICY', '/data/failurePolicy', 'failurePolicy must be fail or complete.'));
  }

  if (definition.data.aggregate !== null && !nodeIds.has(definition.data.aggregate)) {
    issues.push(issue('INVALID_AGGREGATE', '/data/aggregate', `Aggregate node "${String(definition.data.aggregate)}" is not declared.`));
  }

  const chain = stageChain(definition);
  if (chain === undefined) {
    issues.push(issue('INVALID_STAGE_SEQUENCE', '/edges', 'The stage nodes must form one fixed linear sequence with a single first stage.'));
  }

  if (issues.length > 0) {
    throw new GraphValidationError('Invalid bounded-item definition.', issues);
  }
  return { chain: chain!, executionLanes };
}

function initialItems(items: readonly string[]): Record<string, ItemProgress> {
  const progress: Record<string, ItemProgress> = {};
  for (const id of items) {
    progress[id] = { status: 'pending', nextStage: 0, attempts: {}, capAttempts: {} };
  }
  return progress;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

/**
 * The bounded-item graph type, stage-sequence shape. Pure data operations
 * only: no file, model, process, clock, or storage services (the D2
 * contract).
 */
export const boundedItem: GraphType<
  BoundedItemDefinition,
  BoundedItemStatus,
  BoundedItemEvent,
  BoundedItemRequirements
> = {
  kind: 'bounded-item',
  version: 1,
  compile(definition) {
    const { chain, executionLanes } = validateWorklist(definition);
    const stages = chain.stages;
    const lastStage = stages.length - 1;

    const stageOf = (item: ItemProgress): NodeId => stages[item.nextStage]!;

    const inFlightCount = (state: BoundedItemStatus): number =>
      Object.values(state.items).filter((item) => item.status === 'in-flight').length;

    const inFlightAtStage = (state: BoundedItemStatus, stageId: NodeId): number =>
      Object.values(state.items).filter((item) => item.status === 'in-flight' && stageOf(item) === stageId).length;

    const claimable = (item: ItemProgress): boolean =>
      item.status === 'pending'
      && (item.capAttempts[item.nextStage] ?? 0) < definition.data.attemptCapPerStage;

    const allSettled = (state: BoundedItemStatus): boolean =>
      Object.values(state.items).every((item) =>
        item.status === 'done'
        || item.status === 'failed'
        || (item.status === 'pending'
          && (item.capAttempts[item.nextStage] ?? 0) >= definition.data.attemptCapPerStage));

    const anyPaused = (state: BoundedItemStatus): boolean =>
      Object.values(state.items).some((item) => item.status === 'paused');

    const failedIds = (state: BoundedItemStatus): readonly string[] =>
      Object.entries(state.items)
        .filter(([id, item]) =>
          item.status === 'failed'
          || (item.status === 'pending'
            && (item.capAttempts[item.nextStage] ?? 0) >= definition.data.attemptCapPerStage))
        .map(([id]) => id);

    const itemSummary = (state: BoundedItemStatus): Record<string, string> => {
      const summary: Record<string, string> = {};
      for (const [id, item] of Object.entries(state.items)) {
        summary[id] = item.status === 'pending'
          && (item.capAttempts[item.nextStage] ?? 0) >= definition.data.attemptCapPerStage
          ? 'failed'
          : item.status;
      }
      return summary;
    };

    return {
      requirements: { memory: 'unused' },
      initialState: () => ({
        frozen: null,
        items: {},
        aggregate: 'not-run',
        aggregateResult: null,
      }),
      reduce(state, event) {
        switch (event.type) {
          case 'items-frozen': {
            if (state.frozen !== null) return state;
            const declared = definition.data.items;
            const frozenList = event.payload.items;
            const matches = Array.isArray(frozenList)
              && frozenList.length === declared.length
              && frozenList.every((id, index) => id === declared[index]);
            if (!matches) {
              throw new GraphValidationError(
                'The frozen item list does not match the definition.',
                [{
                  code: 'ITEMS_FROZEN_MISMATCH',
                  path: '/items',
                  message: 'The run-start freeze must repeat the declared item list exactly, in order.',
                }],
              );
            }
            return {
              ...state,
              frozen: [...frozenList],
              items: initialItems(frozenList),
            };
          }
          case 'item-claimed': {
            const item = state.items[event.payload.itemId];
            if (
              item === undefined
              || item.status !== 'pending'
              || stageOf(item) !== event.payload.stageId
              || !isPositiveInteger(event.payload.attempt)
              || event.payload.attempt !== (item.attempts[item.nextStage] ?? 0) + 1
            ) {
              return state;
            }
            return {
              ...state,
              items: {
                ...state.items,
                [event.payload.itemId]: {
                  ...item,
                  status: 'in-flight',
                  attempts: {
                    ...item.attempts,
                    [item.nextStage]: event.payload.attempt,
                  },
                  capAttempts: {
                    ...item.capAttempts,
                    [item.nextStage]: (item.capAttempts[item.nextStage] ?? 0) + 1,
                  },
                },
              },
            };
          }
          case 'item-stage-completed': {
            const item = state.items[event.payload.itemId];
            if (
              item === undefined
              || item.status !== 'in-flight'
              || stageOf(item) !== event.payload.stageId
              || item.attempts[item.nextStage] !== event.payload.attempt
            ) {
              return state;
            }
            const nextStage = item.nextStage + 1;
            return {
              ...state,
              items: {
                ...state.items,
                [event.payload.itemId]: {
                  ...item,
                  status: nextStage > lastStage ? 'done' : 'pending',
                  nextStage,
                  attempts: { ...item.attempts },
                },
              },
            };
          }
          case 'item-stage-failed': {
            const item = state.items[event.payload.itemId];
            if (
              item === undefined
              || item.status !== 'in-flight'
              || stageOf(item) !== event.payload.stageId
              || item.attempts[item.nextStage] !== event.payload.attempt
            ) {
              return state;
            }
            return {
              ...state,
              items: {
                ...state.items,
                [event.payload.itemId]: { ...item, status: 'pending' },
              },
            };
          }
          case 'item-reopened': {
            const item = state.items[event.payload.itemId];
            const stageIndex = chain.index.get(event.payload.stageId);
            if (
              item === undefined
              || stageIndex === undefined
              || item.status === 'in-flight'
              || item.status === 'paused'
            ) {
              return state;
            }
            return {
              ...state,
              items: {
                ...state.items,
                [event.payload.itemId]: {
                  status: 'pending',
                  nextStage: stageIndex,
                  attempts: { ...item.attempts },
                  capAttempts: {},
                },
              },
            };
          }
          case 'item-paused': {
            const item = state.items[event.payload.itemId];
            if (
              item === undefined
              || item.status !== 'in-flight'
              || stageOf(item) !== event.payload.stageId
              || item.attempts[item.nextStage] !== event.payload.attempt
            ) {
              return state;
            }
            return {
              ...state,
              items: {
                ...state.items,
                [event.payload.itemId]: { ...item, status: 'paused' },
              },
            };
          }
          case 'item-resumed': {
            const item = state.items[event.payload.itemId];
            if (item === undefined || item.status !== 'paused') return state;
            return {
              ...state,
              items: {
                ...state.items,
                [event.payload.itemId]: { ...item, status: 'pending' },
              },
            };
          }
          case 'aggregate-claimed': {
            if (state.aggregate !== 'not-run') return state;
            return { ...state, aggregate: 'in-flight' };
          }
          case 'aggregate-completed': {
            if (state.aggregate !== 'in-flight') return state;
            return { ...state, aggregate: 'done', aggregateResult: event.payload.result };
          }
          case 'aggregate-failed': {
            if (state.aggregate !== 'in-flight') return state;
            return { ...state, aggregate: 'failed' };
          }
          default:
            return state;
        }
      },
      decide(state) {
        if (state.frozen === null) return [];
        if (inFlightCount(state) > 0 || state.aggregate === 'in-flight') return [];

        if (allSettled(state) && state.aggregate !== 'not-run') {
          const failed = failedIds(state);
          if (state.aggregate === 'failed') {
            return [{
              kind: 'fail',
              code: 'AGGREGATE_FAILED',
              message: 'The aggregate node failed after every item settled.',
            }];
          }
          if (definition.data.failurePolicy === 'fail' && failed.length > 0) {
            return [{
              kind: 'fail',
              code: 'ITEMS_FAILED',
              message: `Failed items: ${failed.join(', ')}.`,
            }];
          }
          return [{
            kind: 'complete',
            output: { items: itemSummary(state), aggregate: state.aggregateResult },
          }];
        }

        if (allSettled(state) && state.aggregate === 'not-run') {
          if (definition.data.aggregate === null) {
            const failed = failedIds(state);
            if (definition.data.failurePolicy === 'fail' && failed.length > 0) {
              return [{
                kind: 'fail',
                code: 'ITEMS_FAILED',
                message: `Failed items: ${failed.join(', ')}.`,
              }];
            }
            return [{
              kind: 'complete',
              output: { items: itemSummary(state), aggregate: null },
            }];
          }
          return [{
            kind: 'dispatch',
            nodeId: definition.data.aggregate,
            input: { positionSummary: 'aggregate, attempt 1' },
            position: 'aggregate/1',
          }];
        }

        const commands: GraphCommand[] = [];
        let freeGlobal = definition.data.globalConcurrency - inFlightCount(state);
        const perStageFree = new Map<NodeId, number>();
        for (const id of stages) {
          perStageFree.set(
            id,
            definition.data.perStageConcurrency - inFlightAtStage(state, id),
          );
        }
        for (const id of state.frozen) {
          if (freeGlobal <= 0) break;
          const item = state.items[id]!;
          if (!claimable(item)) continue;
          const stageId = stageOf(item);
          if ((perStageFree.get(stageId) ?? 0) <= 0) continue;
          const attempt = (item.attempts[item.nextStage] ?? 0) + 1;
          commands.push({
            kind: 'dispatch',
            nodeId: stageId,
            input: { positionSummary: `item ${id}, stage ${stageId}, attempt ${attempt}` },
            position: `items/${id}/${stageId}/${attempt}`,
          });
          freeGlobal -= 1;
          perStageFree.set(stageId, (perStageFree.get(stageId) ?? 0) - 1);
        }
        if (commands.length === 0 && inFlightCount(state) === 0 && anyPaused(state)) {
          return [{
            kind: 'pause',
            reason: 'Every remaining item is paused; nothing else can run.',
          }];
        }
        return commands;
      },
      describe(): GraphDescriptionInput {
        const aggregate = definition.data.aggregate ?? null;
        return {
          inputContract: { items: 'string[]' },
          outputContract: { items: 'object', aggregate: 'json | null' },
          phases: [{
            id: 'worklist',
            name: 'Worklist',
            nodeIds: definition.nodes.map((node) => node.id),
          }],
          nodes: definition.nodes.map((node) => ({
            id: node.id,
            phaseId: 'worklist',
            inputContract: { item: 'string', stage: 'string', attempt: 'number' },
            outputContract: { result: 'json' },
            laneId: node.data.lane?.id ?? null,
          })),
          policies: {
            retry: null,
            stop: null,
            concurrency: {
              global: definition.data.globalConcurrency,
              perStage: definition.data.perStageConcurrency,
            },
            write: null,
            budget: null,
            action: null,
          },
          executionLanes: [...executionLanes.values()],
          requestedPermissions: [],
          bounds: {
            dispatches: {
              min: {
                kind: 'known',
                value: definition.data.items.length
                  + (aggregate === null ? 0 : 1),
              },
              max: {
                kind: 'known',
                value: definition.data.items.length * stages.length
                  * definition.data.attemptCapPerStage
                  + (aggregate === null ? 0 : 1),
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
