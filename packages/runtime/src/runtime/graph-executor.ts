import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { Memory } from '@obversa/memory';

import type { GraphCommand } from '../graph/commands.js';
import type { CompiledGraphType, GraphEvent } from '../graph/type.js';
import {
  canonicalJson,
  cloneFrozenJson,
  type JsonObject,
  type JsonValue,
} from '../graph/value.js';
import type { ExecutionTarget, ResolvedExecutionLane } from '../graph/plan.js';
import {
  validateDomainEventBatch,
  type DomainEventBatch,
} from '../events/store.js';
import type { DomainEventEnvelope, NewDomainEvent } from '../events/envelope.js';
import type {
  AgentResultPart,
  Engine,
  EngineSelectionRecord,
} from '../engines/engine.js';
import { LANE_DEAD_FAILURES, type EngineFailureKind } from '../engines/failure.js';
import { StorageError } from '../storage/error.js';
import { createAttemptIdentity, type AttemptIdentity } from './attempt.js';
import type { AttemptBudgetPolicy, TokenBudget } from './budget.js';
import {
  executeNodeAttempt,
  type ActionDecision,
  type ModelUnavailableFact,
  type NodeDataContext,
  type PreparedEngineLane,
} from './node-lifecycle.js';
import type { ResultContract } from './result-contract.js';
import { engineSelection } from './result-parts.js';
import {
  loadRunDefinition,
  type RunStorageBinding,
} from './run-definition.js';
import type { NodeWorkspacePolicy } from './workspace-policy.js';

export type GraphExecutionErrorCode =
  | 'ABORTED'
  | 'DUPLICATE_POSITION'
  | 'EMPTY_DECISION'
  | 'INVALID_EVENT'
  | 'MISSING_ENGINE_BINDING'
  | 'MISSING_MEMORY'
  | 'MISSING_NODE_BINDING'
  | 'PROTOCOL'
  | 'STORED_GRAPH_MISMATCH';

export class GraphExecutionError extends Error {
  readonly code: GraphExecutionErrorCode;

  constructor(code: GraphExecutionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GraphExecutionError';
    this.code = code;
  }
}

export interface GraphNodeBinding {
  readonly prompt: ((input: JsonValue) => string) | null;
  readonly scratchDirectory: string;
  readonly workspace: NodeWorkspacePolicy;
  readonly trustedCaller: JsonObject;
  readonly permissions: readonly string[];
  readonly policy: AttemptBudgetPolicy;
  readonly resultContract: ResultContract | null;
  readonly runData: ((context: NodeDataContext) => Promise<JsonValue>) | null;
  readonly parseResult:
    | ((part: AgentResultPart, parts: readonly AgentResultPart[]) => JsonValue)
    | null;
  readonly tokenBudget: TokenBudget | null;
  decideAction(): Promise<ActionDecision>;
}

export interface GraphEngineBinding {
  readonly target: ExecutionTarget;
  readonly selection: EngineSelectionRecord;
  readonly engine: Engine;
  readonly hardTokenLimitEnforceable: boolean;
}

export interface GraphExecutorOptions {
  readonly runId: string;
  readonly graph: CompiledGraphType;
  readonly storage: RunStorageBinding;
  readonly nodes: Readonly<Record<string, GraphNodeBinding>>;
  readonly engines: readonly GraphEngineBinding[];
  readonly bindings?: {
    readonly memory?: Memory;
  };
}

export type GraphExecutorResult =
  | Extract<GraphCommand, { readonly kind: 'pause' | 'complete' | 'fail' }>
  | {
      readonly kind: 'waiting';
      readonly positions: readonly string[];
    };

interface FoldedRun {
  readonly revision: number;
  readonly state: JsonValue;
  readonly dispatched: ReadonlySet<string>;
  readonly inFlight: readonly string[];
  readonly unavailable: ReadonlySet<string>;
}

interface PreparedDispatch {
  readonly command: Extract<GraphCommand, { readonly kind: 'dispatch' }>;
  readonly binding: GraphNodeBinding;
  readonly prompt: string | null;
  readonly route: readonly [PreparedEngineLane] | readonly [PreparedEngineLane, PreparedEngineLane] | null;
  readonly allEnginesUnavailable: boolean;
}

type StoredRecord = Readonly<Record<string, JsonValue>>;

const GRAPH_PREFIX = 'graph:';

function fail(code: GraphExecutionErrorCode, message: string, cause?: unknown): never {
  throw new GraphExecutionError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function record(value: unknown, label: string): StoredRecord {
  let safe: JsonValue;
  try {
    safe = cloneFrozenJson(value as JsonValue);
  } catch (error) {
    fail('INVALID_EVENT', `${label} must be valid JSON.`, error);
  }
  if (safe === null || typeof safe !== 'object' || Array.isArray(safe)) {
    fail('INVALID_EVENT', `${label} must be an object.`);
  }
  return safe as StoredRecord;
}

function exactFields(value: StoredRecord, fields: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])
  ) {
    fail('INVALID_EVENT', `${label} must contain exactly ${expected.join(', ')}.`);
  }
}

function text(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail('INVALID_EVENT', `${label} must be a non-empty string without control characters.`);
  }
  return value;
}

function targetKey(target: ExecutionTarget): string {
  return canonicalJson(target as unknown as JsonValue);
}

function availabilityKey(selection: EngineSelectionRecord): string {
  return canonicalJson({ provider: selection.provider, model: selection.model });
}

function assertTargetSelection(
  target: ExecutionTarget,
  selection: EngineSelectionRecord,
): void {
  if (
    target.adapter !== selection.adapter
    || (selection.provider !== null && target.provider !== selection.provider)
    || (selection.modelFamily !== null && target.modelFamily !== selection.modelFamily)
    || target.model !== selection.model
    || !isDeepStrictEqual(target.tools, selection.capabilities)
  ) {
    fail(
      'MISSING_ENGINE_BINDING',
      `The engine identity for ${target.adapter}/${target.provider}/${target.model} does not match its exact plan target.`,
    );
  }
}

function validMemory(value: unknown): value is Memory {
  return (
    value !== null
    && typeof value === 'object'
    && typeof (value as { readonly scope?: unknown }).scope === 'string'
    && (value as { readonly scope: string }).scope.trim().length > 0
    && typeof (value as { readonly execute?: unknown }).execute === 'function'
  );
}

function validateFact(
  envelope: DomainEventEnvelope,
  runId: string,
  namespace: string,
  plannedAvailability: ReadonlySet<string>,
): ModelUnavailableFact {
  if (envelope.version !== 1) {
    fail('INVALID_EVENT', 'A model-unavailable event must use version 1.');
  }
  const payload = record(envelope.payload, 'A model-unavailable payload');
  exactFields(
    payload,
    ['schemaVersion', 'identity', 'selection', 'effective', 'failure'],
    'A model-unavailable payload',
  );
  if (payload.schemaVersion !== 1) {
    fail('INVALID_EVENT', 'A model-unavailable payload must use schemaVersion 1.');
  }
  const identityRecord = record(payload.identity, 'A model-unavailable identity');
  const identity = createAttemptIdentity({
    namespace: text(identityRecord.namespace, 'identity.namespace'),
    streamId: text(identityRecord.streamId, 'identity.streamId'),
    nodeId: text(identityRecord.nodeId, 'identity.nodeId'),
    position: text(identityRecord.position, 'identity.position'),
  });
  if (
    canonicalJson(identity) !== canonicalJson(identityRecord)
    || identity.namespace !== namespace
    || identity.streamId !== runId
  ) {
    fail('INVALID_EVENT', 'A model-unavailable identity must belong to this stored run.');
  }
  let selected: EngineSelectionRecord;
  let effective: EngineSelectionRecord;
  try {
    selected = engineSelection(payload.selection as unknown as EngineSelectionRecord);
    effective = engineSelection(payload.effective as unknown as EngineSelectionRecord);
  } catch (error) {
    fail('INVALID_EVENT', 'A model-unavailable engine identity is invalid.', error);
  }
  if (!plannedAvailability.has(availabilityKey(selected))) {
    fail('INVALID_EVENT', 'A model-unavailable event selected an engine outside the stored plan.');
  }
  if (
    typeof payload.failure !== 'string'
    || !LANE_DEAD_FAILURES.has(payload.failure as EngineFailureKind)
  ) {
    fail('INVALID_EVENT', 'A model-unavailable event must record a lane-dead failure.');
  }
  return Object.freeze({
    schemaVersion: 1,
    identity,
    selection: selected,
    effective,
    failure: payload.failure as EngineFailureKind,
  });
}

function validateStandardEvent(
  envelope: DomainEventEnvelope,
  type: string,
  nodeIds: ReadonlySet<string>,
): GraphEvent {
  if (envelope.version !== 1) {
    fail('INVALID_EVENT', `${envelope.type} must use version 1.`);
  }
  const payload = record(envelope.payload, `${envelope.type} payload`);
  if (type === 'node-dispatched') {
    exactFields(payload, ['nodeId', 'position'], `${envelope.type} payload`);
  } else if (type === 'node-completed') {
    exactFields(payload, ['nodeId', 'position', 'result'], `${envelope.type} payload`);
  } else if (type === 'node-paused') {
    exactFields(
      payload,
      ['nodeId', 'position', 'reason', 'request'],
      `${envelope.type} payload`,
    );
    text(payload.reason, `${envelope.type}.reason`);
  } else {
    exactFields(payload, ['nodeId', 'position', 'code'], `${envelope.type} payload`);
    text(payload.code, `${envelope.type}.code`);
  }
  const nodeId = text(payload.nodeId, `${envelope.type}.nodeId`);
  text(payload.position, `${envelope.type}.position`);
  if (!nodeIds.has(nodeId)) {
    fail('INVALID_EVENT', `${envelope.type} refers to an unknown node.`);
  }
  return Object.freeze({ type, version: 1, payload });
}

function newEvent(
  runId: string,
  type: string,
  payload: JsonObject,
): NewDomainEvent {
  return {
    eventId: randomUUID(),
    type: `${GRAPH_PREFIX}${type}`,
    version: 1,
    timestamp: new Date().toISOString(),
    correlationId: runId,
    causationId: null,
    payload: cloneFrozenJson(payload),
  };
}

/** Build one executor from the stored definition and frozen execution plan. */
export async function createGraphExecutor(
  options: GraphExecutorOptions,
): Promise<Readonly<{ run(signal: AbortSignal): Promise<GraphExecutorResult> }>> {
  const loaded = await loadRunDefinition(options.storage, options.runId);
  const storedDefinition = loaded.record.payload.definition.graphDefinition;
  if (
    storedDefinition.digest !== options.graph.definition.digest
    || storedDefinition.canonicalJson !== options.graph.definition.canonicalJson
    || !isDeepStrictEqual(loaded.resolvedPlan.plan.graph, options.graph.describe().graph)
  ) {
    fail('STORED_GRAPH_MISMATCH', 'The compiled graph does not match this run\'s stored definition and plan.');
  }
  if (
    loaded.resolvedPlan.plan.requirements.memory === 'required'
    && !validMemory(options.bindings?.memory)
  ) {
    fail('MISSING_MEMORY', 'This stored graph requires a live Memory binding.');
  }
  const memory = loaded.resolvedPlan.plan.requirements.memory === 'required'
    ? options.bindings!.memory!
    : null;

  const nodeIds = new Set(loaded.resolvedPlan.plan.nodes.map((node) => node.id));
  const nodesById = new Map(loaded.resolvedPlan.plan.nodes.map((node) => [node.id, node]));
  const lanesById = new Map(loaded.resolvedPlan.plan.executionLanes.map((lane) => [lane.id, lane]));
  const plannedTargets = new Set<string>();
  for (const lane of loaded.resolvedPlan.plan.executionLanes) {
    for (const target of [lane.effective, ...lane.fallbacks]) {
      plannedTargets.add(targetKey(target));
    }
  }

  const enginesByTarget = new Map<string, GraphEngineBinding>();
  const plannedAvailability = new Set<string>();
  for (const rawBinding of options.engines) {
    let selection: EngineSelectionRecord;
    try {
      selection = engineSelection(rawBinding.selection);
    } catch (error) {
      fail('MISSING_ENGINE_BINDING', 'An engine binding has an invalid identity.', error);
    }
    assertTargetSelection(rawBinding.target, selection);
    const key = targetKey(rawBinding.target);
    if (!plannedTargets.has(key)) {
      fail('MISSING_ENGINE_BINDING', 'An engine binding target is outside the stored plan.');
    }
    if (
      enginesByTarget.has(key)
      || typeof rawBinding.engine?.run !== 'function'
      || typeof rawBinding.hardTokenLimitEnforceable !== 'boolean'
    ) {
      fail('MISSING_ENGINE_BINDING', 'Engine bindings must be valid and unique.');
    }
    const binding = Object.freeze({ ...rawBinding, selection });
    enginesByTarget.set(key, binding);
    plannedAvailability.add(availabilityKey(selection));
  }
  for (const target of plannedTargets) {
    if (!enginesByTarget.has(target)) {
      fail('MISSING_ENGINE_BINDING', 'Every target in the stored route needs an exact engine binding.');
    }
  }

  const stream = {
    namespace: options.storage.record.namespace,
    streamId: options.runId,
  };
  let appendRevision = loaded.record.revision;
  let appendTail: Promise<void> = Promise.resolve();
  let running = false;

  const readFolded = async (): Promise<FoldedRun> => {
    let state = options.graph.initialState();
    let revision = 0;
    const dispatched = new Set<string>();
    const settled = new Set<string>();
    const unavailable = new Set<string>();
    for await (const envelope of options.storage.eventStore.read(stream)) {
      revision = envelope.revision;
      if (!envelope.type.startsWith(GRAPH_PREFIX)) continue;
      const type = envelope.type.slice(GRAPH_PREFIX.length);
      if (type === 'run-started') continue;
      if (type === 'model-unavailable') {
        const fact = validateFact(
          envelope,
          options.runId,
          stream.namespace,
          plannedAvailability,
        );
        unavailable.add(availabilityKey(fact.selection));
        unavailable.add(availabilityKey(fact.effective));
        continue;
      }
      let graphEvent: GraphEvent;
      if (
        type === 'node-dispatched'
        || type === 'node-completed'
        || type === 'node-failed'
        || type === 'node-paused'
      ) {
        graphEvent = validateStandardEvent(envelope, type, nodeIds);
        const position = (graphEvent.payload as JsonObject).position as string;
        if (type === 'node-dispatched') {
          if (dispatched.has(position)) {
            fail('INVALID_EVENT', `Dispatch position "${position}" is recorded more than once.`);
          }
          dispatched.add(position);
        } else {
          if (!dispatched.has(position) || settled.has(position)) {
            fail('INVALID_EVENT', `The result for position "${position}" has no single recorded dispatch.`);
          }
          settled.add(position);
        }
      } else {
        graphEvent = Object.freeze({
          type,
          version: envelope.version,
          payload: cloneFrozenJson(envelope.payload),
        });
      }
      state = options.graph.reduce(state, graphEvent);
    }
    const inFlight = [...dispatched].filter((position) => !settled.has(position));
    appendRevision = revision;
    return Object.freeze({ revision, state, dispatched, inFlight, unavailable });
  };

  const appendBatch = async (
    expectedRevision: number,
    events: readonly NewDomainEvent[],
  ): Promise<void> => {
    const batch = validateDomainEventBatch(events) as DomainEventBatch;
    appendRevision = await options.storage.eventStore.append(stream, expectedRevision, batch);
  };

  const enqueueAppend = (event: NewDomainEvent): Promise<void> => {
    const current = appendTail
      .catch(() => undefined)
      .then(async () => appendBatch(appendRevision, [event]));
    appendTail = current.then(() => undefined, () => undefined);
    return current;
  };

  const routeFor = (
    lane: ResolvedExecutionLane,
    unavailable: ReadonlySet<string>,
  ): readonly [PreparedEngineLane] | readonly [PreparedEngineLane, PreparedEngineLane] | null => {
    const live: PreparedEngineLane[] = [];
    for (const target of [lane.effective, ...lane.fallbacks]) {
      const binding = enginesByTarget.get(targetKey(target))!;
      if (unavailable.has(availabilityKey(binding.selection))) continue;
      live.push({
        engine: binding.engine,
        selection: binding.selection,
        hardTokenLimitEnforceable: binding.hardTokenLimitEnforceable,
      });
      if (live.length === 2) break;
    }
    if (live.length === 0) return null;
    if (live.length === 1) return [live[0]!];
    return [live[0]!, live[1]!];
  };

  const prepareDispatch = (
    command: Extract<GraphCommand, { readonly kind: 'dispatch' }>,
    unavailable: ReadonlySet<string>,
  ): PreparedDispatch => {
    const node = nodesById.get(command.nodeId);
    const binding = options.nodes[command.nodeId];
    if (!node || !binding) {
      fail('MISSING_NODE_BINDING', `No node behaviour is bound for "${command.nodeId}".`);
    }
    const prompt = binding.prompt?.(command.input) ?? null;
    if (node.laneId === null) {
      return { command, binding, prompt, route: null, allEnginesUnavailable: false };
    }
    const lane = lanesById.get(node.laneId);
    if (!lane) {
      fail('STORED_GRAPH_MISMATCH', `The stored lane for "${command.nodeId}" is missing.`);
    }
    const route = routeFor(lane, unavailable);
    return { command, binding, prompt, route, allEnginesUnavailable: route === null };
  };

  const appendOutcome = async (
    prepared: PreparedDispatch,
    signal: AbortSignal,
  ): Promise<void> => {
    const { command, binding, prompt, route } = prepared;
    const appendResult = async (event: NewDomainEvent): Promise<void> => {
      try {
        await enqueueAppend(event);
      } catch (error) {
        if (!(error instanceof StorageError) || error.code !== 'STORAGE_LIMIT_EXCEEDED') {
          throw error;
        }
        await enqueueAppend(newEvent(options.runId, 'node-failed', {
          nodeId: command.nodeId,
          position: command.position,
          code: 'RESULT_TOO_LARGE',
        }));
      }
    };
    if (prepared.allEnginesUnavailable) {
      await appendResult(newEvent(options.runId, 'node-failed', {
        nodeId: command.nodeId,
        position: command.position,
        code: 'ENGINE_UNAVAILABLE',
      }));
      return;
    }
    const identity: AttemptIdentity = createAttemptIdentity({
      namespace: stream.namespace,
      streamId: stream.streamId,
      nodeId: command.nodeId,
      position: command.position,
    });
    const result = await executeNodeAttempt({
      identity,
      nodeId: command.nodeId,
      input: command.input,
      memory,
      prompt,
      scratchDirectory: binding.scratchDirectory,
      workspace: binding.workspace,
      trustedCaller: binding.trustedCaller,
      permissions: binding.permissions,
      policy: binding.policy,
      resultContract: binding.resultContract,
      engineRoute: route,
      runData: binding.runData,
      parseResult: binding.parseResult,
      tokenBudget: binding.tokenBudget,
      recordModelUnavailable: async (fact) => {
        await enqueueAppend(newEvent(
          options.runId,
          'model-unavailable',
          fact as unknown as JsonObject,
        ));
      },
      decideAction: binding.decideAction,
    }, signal);
    if (result.status === 'completed') {
      await appendResult(newEvent(options.runId, 'node-completed', {
        nodeId: command.nodeId,
        position: command.position,
        result: result.result,
      }));
      return;
    }
    if (result.status === 'paused' && result.decision?.kind === 'wait') {
      await appendResult(newEvent(options.runId, 'node-paused', {
        nodeId: command.nodeId,
        position: command.position,
        reason: result.decision.reason,
        request: result.decision.request,
      }));
      return;
    }
    await appendResult(newEvent(options.runId, 'node-failed', {
      nodeId: command.nodeId,
      position: command.position,
      code: result.status === 'denied'
        ? 'DENIED'
        : result.failure?.code ?? 'ACTION_POLICY',
    }));
  };

  const run = async (signal: AbortSignal): Promise<GraphExecutorResult> => {
    if (running) fail('PROTOCOL', 'This graph executor is already running.');
    running = true;
    try {
      for (;;) {
        if (signal.aborted) fail('ABORTED', 'The graph run was aborted.');
        const folded = await readFolded();
        const commands = options.graph.decide(folded.state);
        if (commands.length === 0) {
          if (folded.inFlight.length === 0) {
            fail('EMPTY_DECISION', 'The graph returned an empty decision with no recorded attempt in flight.');
          }
          return Object.freeze({ kind: 'waiting', positions: Object.freeze([...folded.inFlight]) });
        }
        const terminal = commands.find((command) => command.kind !== 'dispatch');
        if (terminal) {
          if (folded.inFlight.length > 0) {
            fail('PROTOCOL', 'The graph returned a terminal result while recorded work is still in flight.');
          }
          return terminal;
        }
        if (folded.inFlight.length > 0) {
          fail('PROTOCOL', 'The graph dispatched more work while recorded work is still in flight.');
        }
        const dispatches = commands as readonly Extract<GraphCommand, { readonly kind: 'dispatch' }>[];
        for (const command of dispatches) {
          if (folded.dispatched.has(command.position)) {
            fail('DUPLICATE_POSITION', `Dispatch position "${command.position}" is already recorded.`);
          }
        }
        const prepared = dispatches.map((command) => prepareDispatch(command, folded.unavailable));
        try {
          await appendBatch(
            folded.revision,
            dispatches.map((command) => newEvent(options.runId, 'node-dispatched', {
              nodeId: command.nodeId,
              position: command.position,
            })),
          );
        } catch (error) {
          if (error instanceof StorageError && error.code === 'REVISION_CONFLICT') {
            continue;
          }
          throw error;
        }
        await Promise.all(prepared.map(async (attempt) => appendOutcome(attempt, signal)));
      }
    } finally {
      running = false;
    }
  };

  return Object.freeze({ run });
}
