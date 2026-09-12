import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

import type { Memory } from '@obversa/memory';

import type { GraphCommand } from '../graph/commands.js';
import type {
  CompiledGraphType,
  EngineAttemptRecordedPayload,
  GraphEngineIdentity,
  GraphEvent,
} from '../graph/type.js';
import {
  canonicalJson,
  cloneFrozenJson,
  digestJson,
  type JsonObject,
  type JsonValue,
} from '../graph/value.js';
import type { ExecutionTarget, ResolvedExecutionLane } from '../graph/plan.js';
import {
  validateDomainEventBatch,
  type DomainEventBatch,
} from '../events/store.js';
import {
  validateDomainEventId,
  validateNewDomainEvent,
  type DomainEventEnvelope,
  type NewDomainEvent,
} from '../events/envelope.js';
import {
  EngineError,
  type AgentRequest,
  type AgentResultPart,
  type AttemptMetadata,
  type Engine,
  type EngineSelectionRecord,
} from '../engines/engine.js';
import {
  classifyEngineFailure,
  LANE_DEAD_FAILURES,
  type EngineFailureKind,
} from '../engines/failure.js';
import type { ArtifactReference } from '../artifacts/store.js';
import { preflightEngine, type PreflightResult } from '../engines/preflight.js';
import { StorageError } from '../storage/error.js';
import { createAttemptIdentity, type AttemptIdentity } from './attempt.js';
import {
  validateAttemptBudgetPolicy,
  type AttemptBudgetPolicy,
  type TokenBudget,
} from './budget.js';
import {
  executeNodeAttempt,
  validateScratchDirectory,
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
import {
  validateWorkspacePolicy,
  type NodeWorkspacePolicy,
} from './workspace-policy.js';
import {
  EngineIdentityUnresolvedError,
  engineFailureExclusionKeys,
  isEngineExcluded,
  matchesEngineTarget,
  type EngineExclusionKey,
} from './engine-availability.js';
import {
  loadRunPreflight,
  type CompletedProbe,
  type LiveOutcome,
  type LoadedRunPreflight,
  type PreflightFailureResult,
  type PreflightPauseResult,
  type ProbeFinishPayload,
  type ProbeStartPayload,
  type StaticOutcome,
} from './preflight-record.js';

export type GraphExecutionErrorCode =
  | 'ABORTED'
  | 'DUPLICATE_POSITION'
  | 'EMPTY_DECISION'
  | 'ENGINE_IDENTITY_UNRESOLVED'
  | 'INVALID_EVENT'
  | 'INVALID_PREFLIGHT_CONFIG'
  | 'MISSING_ENGINE_BINDING'
  | 'MISSING_MEMORY'
  | 'MISSING_NODE_BINDING'
  | 'PROTOCOL'
  | 'RESUME_EVENT_MISMATCH'
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
  /** Whether node code may run again after a crash leaves its outcome unknown. */
  readonly retrySafe?: boolean;
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
  readonly preflightScratchDirectory?: string;
  readonly bindings?: {
    readonly memory?: Memory;
  };
}

export type GraphExecutorResult =
  | Extract<GraphCommand, { readonly kind: 'pause' | 'complete' | 'fail' }>
  | PreflightPauseResult
  | PreflightFailureResult
  | {
      readonly kind: 'waiting';
      readonly positions: readonly string[];
    };

export interface GraphExecutor {
  run(signal: AbortSignal): Promise<GraphExecutorResult>;
  resume(target: string | { readonly preflightEventId: string }, signal: AbortSignal): Promise<GraphExecutorResult>;
}

interface FoldedAttempt {
  readonly command: Extract<GraphCommand, { readonly kind: 'dispatch' }>;
  readonly started: Readonly<{
    readonly identity: AttemptIdentity;
    readonly retrySafe: boolean;
  }> | null;
  readonly status: 'in-flight' | 'paused' | 'settled';
  readonly engineSequence: number;
}

interface FoldedRun {
  readonly revision: number;
  readonly preflight: LoadedRunPreflight;
  readonly state: JsonValue;
  readonly dispatched: ReadonlySet<string>;
  readonly inFlight: readonly string[];
  readonly unavailable: ReadonlySet<EngineExclusionKey>;
  readonly attempts: ReadonlyMap<string, FoldedAttempt>;
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

function validateEngineIdentity(value: JsonValue, label: string): GraphEngineIdentity {
  const identity = record(value, label);
  exactFields(identity, ['adapter', 'provider', 'modelFamily', 'model'], label);
  const nullable = (field: string): string | null => identity[field] === null
    ? null
    : text(identity[field], `${label}.${field}`);
  return Object.freeze({
    adapter: text(identity.adapter, `${label}.adapter`),
    provider: nullable('provider'),
    modelFamily: nullable('modelFamily'),
    model: nullable('model'),
  });
}

function validateEngineAttemptRecorded(envelope: DomainEventEnvelope): EngineAttemptRecordedPayload {
  if (envelope.version !== 1) fail('INVALID_EVENT', 'Unsupported engine-attempt-recorded version.');
  const payload = record(envelope.payload, envelope.type);
  exactFields(payload, ['nodeId', 'position', 'sequence', 'requested', 'effective'], envelope.type);
  if (!Number.isSafeInteger(payload.sequence) || (payload.sequence as number) < 1) {
    fail('INVALID_EVENT', 'An engine attempt sequence must be a positive safe integer.');
  }
  const requested = payload.requested === null ? null : validateEngineIdentity(payload.requested!, 'requested');
  const effective = payload.effective === null ? null : validateEngineIdentity(payload.effective!, 'effective');
  if (requested === null && effective !== null) {
    fail('INVALID_EVENT', 'A recovered unknown engine attempt cannot report an effective identity.');
  }
  return Object.freeze({
    nodeId: text(payload.nodeId, 'nodeId'),
    position: text(payload.position, 'position'),
    sequence: payload.sequence as number,
    requested,
    effective,
  });
}

function targetKey(target: ExecutionTarget): string {
  return canonicalJson(target as unknown as JsonValue);
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

function validateAttemptIdentity(
  value: unknown,
  label: string,
  runId: string,
  namespace: string,
): AttemptIdentity {
  const identityRecord = record(value, label);
  const identity = createAttemptIdentity({
    namespace: text(identityRecord.namespace, `${label}.namespace`),
    streamId: text(identityRecord.streamId, `${label}.streamId`),
    nodeId: text(identityRecord.nodeId, `${label}.nodeId`),
    position: text(identityRecord.position, `${label}.position`),
  });
  if (
    canonicalJson(identity) !== canonicalJson(identityRecord)
    || identity.namespace !== namespace
    || identity.streamId !== runId
  ) {
    fail('INVALID_EVENT', `${label} must belong to this stored run.`);
  }
  return identity;
}

function validateFact(
  envelope: DomainEventEnvelope,
  runId: string,
  namespace: string,
  targetsForNode: (nodeId: string) => readonly ExecutionTarget[],
): ModelUnavailableFact {
  if (envelope.version !== 1) {
    fail('INVALID_EVENT', 'A model-unavailable event must use version 1.');
  }
  const payload = record(envelope.payload, 'A model-unavailable payload');
  const hasTarget = Object.hasOwn(payload, 'target');
  exactFields(payload, [
    'schemaVersion', 'identity', 'selection', 'effective', 'failure',
    ...(hasTarget ? ['target'] : []),
  ], 'A model-unavailable payload');
  if (payload.schemaVersion !== 1) {
    fail('INVALID_EVENT', 'A model-unavailable payload must use schemaVersion 1.');
  }
  const identity = validateAttemptIdentity(
    payload.identity,
    'A model-unavailable identity',
    runId,
    namespace,
  );
  const targets = targetsForNode(identity.nodeId);
  let selected: EngineSelectionRecord;
  let effective: EngineSelectionRecord;
  try {
    selected = engineSelection(payload.selection as unknown as EngineSelectionRecord);
    effective = engineSelection(payload.effective as unknown as EngineSelectionRecord);
  } catch (error) {
    fail('INVALID_EVENT', 'A model-unavailable engine identity is invalid.', error);
  }
  const compatible = targets.filter((target) => matchesEngineTarget(target, selected));
  if (compatible.length === 0) {
    if (!hasTarget && selected.provider === null && payload.failure === 'auth') {
      fail(
        'ENGINE_IDENTITY_UNRESOLVED',
        `Model availability for node "${identity.nodeId}" cannot resolve its legacy auth provider.`,
      );
    }
    fail('INVALID_EVENT', 'A model-unavailable selection is outside its recorded node lane.');
  }
  let target: ExecutionTarget | undefined;
  if (hasTarget) {
    target = compatible.find((candidate) => targetKey(candidate) === canonicalJson(payload.target!));
    if (target === undefined) {
      fail('INVALID_EVENT', 'A model-unavailable target must exactly match its selected route in the recorded node lane.');
    }
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
    ...(target === undefined ? {} : { target }),
  });
}

export function validateStandardEvent(
  envelope: DomainEventEnvelope,
  type: string,
  nodeIds: ReadonlySet<string>,
): GraphEvent {
  if (envelope.version !== 1) {
    fail('INVALID_EVENT', `${envelope.type} must use version 1.`);
  }
  const payload = record(envelope.payload, `${envelope.type} payload`);
  if (type === 'node-dispatched' || type === 'node-resumed') {
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

function validateAttemptStarted(
  envelope: DomainEventEnvelope,
  runId: string,
  namespace: string,
  nodeIds: ReadonlySet<string>,
): Readonly<{ readonly identity: AttemptIdentity; readonly retrySafe: boolean }> {
  if (envelope.version !== 1) {
    fail('INVALID_EVENT', 'graph:node-attempt-started must use version 1.');
  }
  const payload = record(envelope.payload, 'graph:node-attempt-started payload');
  exactFields(
    payload,
    ['identity', 'retrySafe'],
    'graph:node-attempt-started payload',
  );
  const identity = validateAttemptIdentity(
    payload.identity,
    'A node-attempt-started identity',
    runId,
    namespace,
  );
  if (!nodeIds.has(identity.nodeId)) {
    fail('INVALID_EVENT', 'A node-attempt-started identity refers to an unknown node.');
  }
  if (typeof payload.retrySafe !== 'boolean') {
    fail('INVALID_EVENT', 'graph:node-attempt-started.retrySafe must be a boolean.');
  }
  return Object.freeze({ identity, retrySafe: payload.retrySafe });
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

type StaticObservation =
  | { readonly kind: 'admitted'; readonly selection: EngineSelectionRecord }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'failed'; readonly failure: EngineFailureKind; readonly effective: EngineSelectionRecord | null; readonly detail: string };

function preflightEvent(runId: string, type: string, payload: unknown, causationId: string | null = null): NewDomainEvent {
  return validateNewDomainEvent({
    eventId: randomUUID(), type, version: 1, timestamp: new Date().toISOString(),
    correlationId: runId, causationId, payload: cloneFrozenJson(payload as JsonValue),
  });
}
function probeContextKey(laneId: string, target: ExecutionTarget, contextNodeId: string | null): string {
  return canonicalJson([laneId, target, contextNodeId] as unknown as JsonValue);
}
async function preflightScratch(value: unknown): Promise<string> {
  try {
    if (typeof value !== 'string') throw new TypeError('Scratch must be an absolute path.');
    return await validateScratchDirectory(value);
  } catch (error) {
    fail('INVALID_PREFLIGHT_CONFIG', 'Preflight requires an absolute, real, normalized scratch directory.', error);
  }
}
function probeAttempt(namespace: string, runId: string, eventId: string): AttemptMetadata {
  return {
    runId, attemptId: digestJson({ namespace, runId, preflightEventId: eventId }),
    leafId: eventId, path: ['preflight', eventId], label: 'preflight', iteration: 0, leaf: true,
  };
}
function unknownStatic(): StaticObservation {
  return { kind: 'failed', failure: 'unknown', effective: null, detail: 'Static admission returned an invalid or incompatible engine identity.' };
}
async function observeStatic(
  engine: Engine,
  request: Omit<AgentRequest, 'prompt'>,
  expected: EngineSelectionRecord | null,
  target: ExecutionTarget,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<StaticObservation> {
  if (typeof engine.admit !== 'function') return { kind: 'unsupported' };
  const deadline = performance.now() + timeoutMs;
  const controller = new AbortController();
  let reason: 'timeout' | 'aborted' | undefined;
  let resolveStop!: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStop = resolve; });
  const stop = (kind: 'timeout' | 'aborted') => {
    if (reason !== undefined) return;
    reason = kind;
    resolveStop();
    controller.abort();
  };
  const onAbort = () => stop('aborted');
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  signal.addEventListener('abort', onAbort, { once: true });
  const interruption = (): StaticObservation | undefined => {
    if (reason === undefined && performance.now() >= deadline) stop('timeout');
    return reason === undefined ? undefined : {
      kind: 'failed', failure: reason, effective: null,
      detail: reason === 'timeout' ? 'Static admission exceeded its time limit.' : 'Static admission was aborted.',
    };
  };
  try {
    if (signal.aborted) stop('aborted');
    const alreadyStopped = interruption();
    if (alreadyStopped) return alreadyStopped;
    let pending: Promise<EngineSelectionRecord>;
    try { pending = Promise.resolve(engine.admit(request, controller.signal, expected ?? undefined)); }
    catch (error) { pending = Promise.reject(error); }
    const operation = pending.then(
      (value) => ({ kind: 'value' as const, value }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    );
    const outcome = await Promise.race([operation, stopped.then(() => ({ kind: 'stopped' as const }))]);
    const interrupted = interruption();
    if (interrupted) return interrupted;
    if (outcome.kind === 'stopped') return unknownStatic();
    if (outcome.kind === 'error') {
      let effective: EngineSelectionRecord | null = null;
      try {
        if (outcome.error instanceof EngineError && outcome.error.effective !== undefined) effective = engineSelection(outcome.error.effective);
      } catch { return unknownStatic(); }
      return {
        kind: 'failed', failure: classifyEngineFailure(outcome.error), effective,
        detail: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      };
    }
    // Do not classify a return-value validation error as an adapter failure.
    try {
      const selection = engineSelection(outcome.value);
      if (!isDeepStrictEqual(selection, outcome.value) || !matchesEngineTarget(target, selection)
        || (expected !== null && !isDeepStrictEqual(selection, expected))) return unknownStatic();
      return interruption() ?? { kind: 'admitted', selection };
    } catch { return unknownStatic(); }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/** Build one executor from the stored definition and frozen execution plan. */
export async function createGraphExecutor(
  options: GraphExecutorOptions,
): Promise<Readonly<GraphExecutor>> {
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
  const targetsForNode = (nodeId: string): readonly ExecutionTarget[] => {
    const node = nodesById.get(nodeId);
    const lane = node?.laneId == null ? undefined : lanesById.get(node.laneId);
    if (lane === undefined) {
      fail('INVALID_EVENT', `Model availability for node "${nodeId}" needs its recorded engine lane.`);
    }
    return [lane.effective, ...lane.fallbacks];
  };
  const plannedTargets = new Set<string>();
  for (const lane of loaded.resolvedPlan.plan.executionLanes) {
    for (const target of [lane.effective, ...lane.fallbacks]) {
      plannedTargets.add(targetKey(target));
    }
  }

  const enginesByTarget = new Map<string, GraphEngineBinding>();
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
  }
  for (const target of plannedTargets) {
    if (!enginesByTarget.has(target)) {
      fail('MISSING_ENGINE_BINDING', 'Every target in the stored route needs an exact engine binding.');
    }
  }

  const plan = loaded.resolvedPlan.plan;
  const preflightPolicy = plan.preflight;
  const scratch = preflightPolicy === undefined ? undefined : await preflightScratch(options.preflightScratchDirectory);
  const restoredContexts = new Set<string>();
  const blockedRoutes = new Set<string>();

  const stream = {
    namespace: options.storage.record.namespace,
    streamId: options.runId,
  };
  let appendRevision = loaded.record.revision;
  let appendTail: Promise<void> = Promise.resolve();
  let running = false;

  const readFolded = async (): Promise<FoldedRun> => {
    let preflight: LoadedRunPreflight;
    try { preflight = await loadRunPreflight(options.storage, options.runId); }
    catch (error) {
      if (error instanceof EngineIdentityUnresolvedError) {
        fail('ENGINE_IDENTITY_UNRESOLVED', error.message, error);
      }
      throw error;
    }
    let state = options.graph.initialState();
    let revision = 0;
    const attempts = new Map<string, FoldedAttempt>();
    const pendingDispatches = new Map<
      string,
      Extract<GraphCommand, { readonly kind: 'dispatch' }>
    >();
    const unavailable = new Set<EngineExclusionKey>();
    for (const envelope of preflight.events) {
      revision = envelope.revision;
      if (!envelope.type.startsWith(GRAPH_PREFIX)) continue;
      const type = envelope.type.slice(GRAPH_PREFIX.length);
      if (type === 'run-started') continue;
      if (type === 'model-unavailable') {
        pendingDispatches.clear();
        const probeFailure = preflight.probeFailures.get(envelope.eventId);
        if (probeFailure !== undefined) {
          for (const key of probeFailure.exclusionKeys) unavailable.add(key);
          continue;
        }
        const fact = validateFact(
          envelope,
          options.runId,
          stream.namespace,
          targetsForNode,
        );
        try {
          for (const key of engineFailureExclusionKeys(fact, targetsForNode(fact.identity.nodeId))) {
            unavailable.add(key);
          }
        } catch (error) {
          if (error instanceof EngineIdentityUnresolvedError) {
            fail('ENGINE_IDENTITY_UNRESOLVED',
              `Model availability for node "${fact.identity.nodeId}" cannot be resolved: ${error.message}`, error);
          }
          throw error;
        }
        continue;
      }
      if (type === 'node-attempt-started') {
        pendingDispatches.clear();
        const started = validateAttemptStarted(
          envelope,
          options.runId,
          stream.namespace,
          nodeIds,
        );
        const attempt = attempts.get(started.identity.position);
        if (
          !attempt
          || attempt.command.nodeId !== started.identity.nodeId
          || attempt.status !== 'in-flight'
          || attempt.started !== null
        ) {
          fail(
            'INVALID_EVENT',
            `The start for position "${started.identity.position}" has no single unfinished dispatch.`,
          );
        }
        attempts.set(started.identity.position, Object.freeze({
          ...attempt,
          started,
        }));
        continue;
      }
      let graphEvent: GraphEvent;
      if (type === 'engine-attempt-recorded') {
        pendingDispatches.clear();
        const payload = validateEngineAttemptRecorded(envelope);
        const attempt = attempts.get(payload.position);
        const node = nodesById.get(payload.nodeId);
        const lane = node?.laneId === null || node?.laneId === undefined
          ? undefined
          : lanesById.get(node.laneId);
        if (
          !attempt
          || attempt.command.nodeId !== payload.nodeId
          || attempt.status !== 'in-flight'
          || attempt.started === null
          || payload.sequence !== attempt.engineSequence + 1
          || lane === undefined
        ) {
          fail('INVALID_EVENT', 'An engine receipt must follow its started engine position in sequence.');
        }
        const requested = payload.requested;
        if (requested !== null && ![lane.effective, ...lane.fallbacks].some((target) => (
          target.adapter === requested.adapter
          && target.model === requested.model
          && (requested.provider === null || target.provider === requested.provider)
          && (requested.modelFamily === null || target.modelFamily === requested.modelFamily)
        ))) {
          fail('INVALID_EVENT', 'An engine receipt requested a target outside its stored route.');
        }
        attempts.set(payload.position, Object.freeze({ ...attempt, engineSequence: payload.sequence }));
        graphEvent = Object.freeze({ type, version: 1, payload });
      } else if (
        type === 'node-dispatched'
        || type === 'node-completed'
        || type === 'node-failed'
        || type === 'node-paused'
        || type === 'node-resumed'
      ) {
        graphEvent = validateStandardEvent(envelope, type, nodeIds);
        const position = (graphEvent.payload as JsonObject).position as string;
        if (type === 'node-dispatched') {
          if (attempts.has(position)) {
            fail('INVALID_EVENT', `Dispatch position "${position}" is recorded more than once.`);
          }
          if (pendingDispatches.size === 0) {
            const decision = options.graph.decide(state);
            if (decision.some((command) => command.kind !== 'dispatch')) {
              fail('INVALID_EVENT', 'A recorded dispatch does not match the graph decision at its event prefix.');
            }
            for (const command of decision as readonly Extract<
              GraphCommand,
              { readonly kind: 'dispatch' }
            >[]) {
              pendingDispatches.set(command.position, command);
            }
          }
          const command = pendingDispatches.get(position);
          if (
            !command
            || command.nodeId !== (graphEvent.payload as JsonObject).nodeId
          ) {
            fail('INVALID_EVENT', `Dispatch position "${position}" does not match the graph decision at its event prefix.`);
          }
          pendingDispatches.delete(position);
          attempts.set(position, Object.freeze({
            command,
            started: null,
            status: 'in-flight',
            engineSequence: 0,
          }));
        } else if (type === 'node-resumed') {
          pendingDispatches.clear();
          const attempt = attempts.get(position);
          if (
            !attempt
            || attempt.command.nodeId !== (graphEvent.payload as JsonObject).nodeId
            || attempt.status === 'settled'
            || (attempt.status === 'in-flight' && attempt.started === null)
          ) {
            fail('INVALID_EVENT', `Resume position "${position}" has no matching unfinished attempt.`);
          }
          attempts.set(position, Object.freeze({
            ...attempt,
            status: 'in-flight',
          }));
        } else {
          pendingDispatches.clear();
          const attempt = attempts.get(position);
          if (
            !attempt
            || attempt.command.nodeId !== (graphEvent.payload as JsonObject).nodeId
            || attempt.status !== 'in-flight'
          ) {
            fail('INVALID_EVENT', `The result for position "${position}" has no single recorded dispatch.`);
          }
          attempts.set(position, Object.freeze({
            ...attempt,
            status: type === 'node-paused' ? 'paused' : 'settled',
          }));
        }
      } else {
        pendingDispatches.clear();
        graphEvent = Object.freeze({
          type,
          version: envelope.version,
          payload: cloneFrozenJson(envelope.payload),
        });
      }
      state = options.graph.reduce(state, graphEvent);
    }
    const dispatched = new Set(attempts.keys());
    const inFlight = [...attempts]
      .filter(([, attempt]) => attempt.status === 'in-flight')
      .map(([position]) => position);
    appendRevision = revision;
    return Object.freeze({
      revision,
      preflight,
      state,
      dispatched,
      inFlight: Object.freeze(inFlight),
      unavailable,
      attempts,
    });
  };

  const appendBatch = async (
    expectedRevision: number,
    events: readonly NewDomainEvent[],
  ): Promise<void> => {
    const batch = validateDomainEventBatch(events) as DomainEventBatch;
    appendRevision = await options.storage.eventStore.append(stream, expectedRevision, batch);
  };

  const enqueueBatch = (events: readonly NewDomainEvent[]): Promise<void> => {
    const current = appendTail.catch(() => undefined)
      .then(async () => appendBatch(appendRevision, events));
    appendTail = current.then(() => undefined, () => undefined);
    return current;
  };
  const enqueueAppend = (event: NewDomainEvent): Promise<void> => enqueueBatch([event]);

  const laneTargets = (lane: ResolvedExecutionLane): readonly ExecutionTarget[] => [lane.effective, ...lane.fallbacks];
  const lanePolicy = (lane: ResolvedExecutionLane) => preflightPolicy!.lanes.find((value) => value.laneId === lane.id)!;
  const routeId = (lane: ResolvedExecutionLane, target: ExecutionTarget) => canonicalJson([lane.id, target] as unknown as JsonValue);
  const contexts = (lane: ResolvedExecutionLane): readonly (string | null)[] => {
    const ids = plan.nodes.filter((node) => node.laneId === lane.id).map((node) => node.id);
    return ids.length === 0 ? [null] : ids;
  };
  const forTarget = (probe: CompletedProbe, lane: ResolvedExecutionLane, target: ExecutionTarget) =>
    probe.start.payload.laneId === lane.id && targetKey(probe.start.payload.target) === targetKey(target);
  const latestStatic = (folded: FoldedRun, lane: ResolvedExecutionLane, target: ExecutionTarget, contextNodeId: string | null) =>
    [...folded.preflight.probes].reverse().find((probe) => forTarget(probe, lane, target)
      && probe.start.payload.stage === 'static' && probe.start.payload.contextNodeId === contextNodeId);
  const savedSelection = (folded: FoldedRun, lane: ResolvedExecutionLane, target: ExecutionTarget): EngineSelectionRecord | null => {
    for (const probe of [...folded.preflight.probes].reverse()) {
      if (forTarget(probe, lane, target) && probe.payload.outcome.kind === 'admitted') return probe.payload.outcome.selection;
    }
    return null;
  };
  const staticBlocked = (folded: FoldedRun, lane: ResolvedExecutionLane, target: ExecutionTarget) =>
    lanePolicy(lane).unsupportedStatic === 'block' && contexts(lane).some((id) => latestStatic(folded, lane, target, id)?.payload.outcome.kind === 'unsupported');
  const excluded = (keys: ReadonlySet<EngineExclusionKey>, lane: ResolvedExecutionLane, target: ExecutionTarget) =>
    isEngineExcluded(keys, enginesByTarget.get(targetKey(target))!.selection, target, laneTargets(lane));
  const eligible = (folded: FoldedRun, lane: ResolvedExecutionLane, target: ExecutionTarget) =>
    !excluded(folded.unavailable, lane, target) && contexts(lane).every((id) => {
      const outcome = latestStatic(folded, lane, target, id)?.payload.outcome;
      return outcome?.kind === 'admitted' || (outcome?.kind === 'unsupported' && lanePolicy(lane).unsupportedStatic === 'allow');
    });
  const answered = (folded: FoldedRun, lane: ResolvedExecutionLane, target: ExecutionTarget) =>
    folded.preflight.probes.some((probe) => forTarget(probe, lane, target)
      && probe.payload.stage === 'live' && probe.payload.outcome.kind === 'succeeded');
  const updateBlockedRoutes = (folded: FoldedRun) => {
    blockedRoutes.clear();
    if (preflightPolicy === undefined) return;
    for (const lane of plan.executionLanes) for (const target of laneTargets(lane)) {
      if (staticBlocked(folded, lane, target)) blockedRoutes.add(routeId(lane, target));
    }
  };
  const staticRequestFor = async (
    target: ExecutionTarget, contextNodeId: string | null,
  ): Promise<Omit<AgentRequest, 'prompt' | 'attempt'>> => {
    if (contextNodeId === null) return {
      model: target.model, tools: [...target.tools], cwd: scratch!,
      timeoutMs: preflightPolicy!.timeoutMs, leaf: true,
    };
    const binding = options.nodes[contextNodeId];
    if (binding === undefined) fail('MISSING_NODE_BINDING', `No node behaviour is bound for "${contextNodeId}".`);
    const policy = validateAttemptBudgetPolicy(binding.policy);
    const workspace = validateWorkspacePolicy(binding.workspace);
    const nodeScratch = await preflightScratch(binding.scratchDirectory);
    if (!Array.isArray(binding.permissions) || binding.permissions.some((permission) =>
      typeof permission !== 'string' || permission.length === 0 || permission !== permission.trim()
      || /[\u0000-\u001f\u007f]/u.test(permission)) || new Set(binding.permissions).size !== binding.permissions.length) {
      throw new TypeError('Static admission permissions must be unique trimmed strings without control characters.');
    }
    const permissions = cloneFrozenJson([...binding.permissions]);
    return {
      model: target.model, tools: [...target.tools], allowedTools: [...permissions],
      ...(binding.resultContract === null ? {} : { jsonSchema: cloneFrozenJson(binding.resultContract.schema) }),
      ...(policy.callTokens === null ? {} : { maxTokens: policy.callTokens.tokens }),
      cwd: workspace.directory === null ? nodeScratch : await realpath(workspace.directory),
      workspaceMode: workspace.mode, timeoutMs: policy.timeoutMs, timeoutGraceMs: policy.teardownGraceMs,
      maxOutputBytes: policy.outputBytes, maxMemoryBytes: policy.memoryBytes, leaf: true,
    };
  };
  const writeDocument = async <Purpose extends string>(purpose: Purpose, document: unknown): Promise<ArtifactReference<Purpose>> =>
    await options.storage.artifactStore.write({ namespace: stream.namespace, runId: options.runId }, {
      bytes: Buffer.from(JSON.stringify(document)), mediaType: 'application/json', purpose, contentMode: 'state',
    }) as ArtifactReference<Purpose>;

  const appendProbeOutcome = async (
    start: NewDomainEvent,
    payload: ProbeStartPayload,
    observation: { readonly stage: 'static'; readonly value: StaticObservation }
      | { readonly stage: 'live'; readonly value: PreflightResult },
  ): Promise<StaticOutcome | LiveOutcome> => {
    let outcome: StaticOutcome | LiveOutcome;
    const diagnostic = (detail: string) => writeDocument('preflight-diagnostic', {
      schemaVersion: 1, runId: options.runId, probeEventId: start.eventId, detail,
    });
    try {
      if (observation.stage === 'static') {
        const value = observation.value;
        outcome = value.kind === 'failed' ? {
          kind: 'failed', failure: value.failure, effective: value.effective,
          diagnostic: await diagnostic(value.detail),
        } : value;
      } else {
        const value = observation.value;
        const evidence = value.evidence === undefined ? null : await writeDocument('preflight-evidence', {
          schemaVersion: 1, runId: options.runId, probeEventId: start.eventId, evidence: value.evidence,
        });
        const common = { usage: value.usage ?? { kind: 'unknown' as const }, effective: value.effective ?? null,
          evidence, diagnostic: await diagnostic(value.detail) };
        if (value.ok) {
          if (evidence === null) throw new TypeError('Successful preflight must retain complete evidence.');
          outcome = { ...common, kind: 'succeeded', evidence };
        } else outcome = { ...common, kind: 'failed', failure: value.failure ?? 'unknown' };
      }
    } catch (error) {
      if (!(error instanceof StorageError)) throw error;
      outcome = observation.stage === 'static' ? { kind: 'recording-failed', storageCode: error.code } : {
        kind: 'recording-failed', storageCode: error.code,
        usage: observation.value.usage ?? { kind: 'unknown' }, effective: observation.value.effective ?? null,
        evidence: null, diagnostic: null,
      };
    }
    const finishPayload = { probeEventId: start.eventId, stage: observation.stage, outcome } as ProbeFinishPayload;
    const finish = preflightEvent(options.runId, 'preflight:probe-finished', finishPayload, start.eventId);
    const batch: NewDomainEvent[] = [finish];
    if (outcome.kind === 'failed' && LANE_DEAD_FAILURES.has(outcome.failure)) {
      batch.push(preflightEvent(options.runId, 'graph:model-unavailable', {
        schemaVersion: 1, source: { kind: 'preflight', probeEventId: start.eventId, laneId: payload.laneId },
        target: payload.target, selection: payload.selection, effective: outcome.effective ?? payload.selection,
        failure: outcome.failure,
      }, finish.eventId));
    } else if (outcome.kind === 'failed' || outcome.kind === 'recording-failed') {
      batch.push(preflightEvent(options.runId, 'preflight:paused', {
        finishedProbeEventId: finish.eventId,
        reason: outcome.kind === 'recording-failed' ? 'recording-failure' : 'engine-failure',
      }, finish.eventId));
    }
    await enqueueBatch(batch);
    return outcome;
  };

  const admitBeforeWork = async (signal: AbortSignal): Promise<
    { readonly folded: FoldedRun } | { readonly result: PreflightPauseResult | PreflightFailureResult }
  > => {
    for (;;) {
      const folded = await readFolded();
      updateBlockedRoutes(folded);
      const snapshot = folded.preflight;
      if (snapshot.state.pause !== null) return { result: snapshot.state.pause };
      if (snapshot.state.phase === 'failed') return { result: {
        kind: 'fail', code: 'PREFLIGHT_FAILED', message: 'A declared lane has no admissible engine target.',
      } };
      if (snapshot.openProbe !== null) fail('PROTOCOL', `Preflight probe "${snapshot.openProbe.envelope.eventId}" is unfinished; verify worker cleanup and call interruptRunPreflight before resuming.`);
      if (signal.aborted) fail('ABORTED', 'The graph run was aborted.');
      if (preflightPolicy === undefined) return { folded };
      const probeExcluded = new Set<EngineExclusionKey>();
      for (const failure of snapshot.probeFailures.values()) for (const key of failure.exclusionKeys) probeExcluded.add(key);
      const dead = plan.executionLanes.find((lane) => laneTargets(lane).every((target) =>
        excluded(probeExcluded, lane, target) || staticBlocked(folded, lane, target)));
      if (dead !== undefined) {
        await enqueueAppend(preflightEvent(options.runId, 'preflight:failed', {
          laneId: dead.id, code: 'PREFLIGHT_FAILED', reason: 'no-admissible-target',
        }));
        continue;
      }
      const completed = snapshot.admissionCompletedAtRevision !== null;
      let check: { lane: ResolvedExecutionLane; target: ExecutionTarget; contextNodeId: string | null } | undefined;
      for (const lane of plan.executionLanes) {
        for (const target of laneTargets(lane)) {
          const unavailable = excluded(folded.unavailable, lane, target) || staticBlocked(folded, lane, target);
          for (const contextNodeId of contexts(lane)) {
            const previous = latestStatic(folded, lane, target, contextNodeId);
            const contextKey = probeContextKey(lane.id, target, contextNodeId);
            // Initial unvisited contexts are still checked after a different context excluded the target.
            if (completed && unavailable) continue;
            if (previous !== undefined && unavailable) continue;
            if (restoredContexts.has(contextKey)) continue;
            check = { lane, target, contextNodeId };
            break;
          }
          if (check) break;
        }
        if (check) break;
      }
      const resumed = [...snapshot.events].reverse().find((event) => event.type === 'preflight:resumed');
      const cause = resumed?.eventId ?? null;
      if (check !== undefined) {
        const { lane, target, contextNodeId } = check;
        const binding = enginesByTarget.get(targetKey(target))!;
        const expectedSelection = savedSelection(folded, lane, target);
        const payload: ProbeStartPayload = { stage: 'static', laneId: lane.id, target,
          selection: binding.selection, contextNodeId, expectedSelection };
        const start = preflightEvent(options.runId, 'preflight:probe-started', payload, cause);
        // Validate caller configuration before recording a call that has not begun.
        const configuration = await staticRequestFor(target, contextNodeId);
        if (signal.aborted) fail('ABORTED', 'The graph run was aborted.');
        await enqueueAppend(start);
        const request = { ...configuration, attempt: probeAttempt(stream.namespace, options.runId, start.eventId) };
        const observation = await observeStatic(binding.engine, request, expectedSelection, target, preflightPolicy.timeoutMs, signal);
        const outcome = await appendProbeOutcome(start, payload, { stage: 'static', value: observation });
        const contextKey = probeContextKey(lane.id, target, contextNodeId);
        if (outcome.kind === 'admitted') {
          enginesByTarget.set(targetKey(target), Object.freeze({ ...binding, selection: outcome.selection }));
          restoredContexts.add(contextKey);
        } else if (outcome.kind === 'unsupported') restoredContexts.add(contextKey);
        else restoredContexts.delete(contextKey);
        continue;
      }
      if (completed) return { folded };
      let live: { lane: ResolvedExecutionLane; target: ExecutionTarget } | undefined;
      for (const lane of plan.executionLanes) {
        if (lanePolicy(lane).live === 'skip'
          || laneTargets(lane).some((target) => eligible(folded, lane, target) && answered(folded, lane, target))) continue;
        const target = laneTargets(lane).find((target) => eligible(folded, lane, target) && !answered(folded, lane, target));
        if (target !== undefined) { live = { lane, target }; break; }
      }
      if (live === undefined) fail('PROTOCOL', 'Preflight has no permitted unfinished check and is not admitted.');
      const binding = enginesByTarget.get(targetKey(live.target))!;
      const admitted = savedSelection(folded, live.lane, live.target);
      const normal = admitted ?? binding.selection;
      const payload: ProbeStartPayload = { stage: 'live', laneId: live.lane.id, target: live.target, selection: normal };
      const start = preflightEvent(options.runId, 'preflight:probe-started', payload, cause);
      await enqueueAppend(start);
      let observation = await preflightEngine(binding.engine, {
        model: live.target.model, timeoutMs: preflightPolicy.timeoutMs, cwd: scratch,
        attempt: probeAttempt(stream.namespace, options.runId, start.eventId), signal,
      });
      const requested = observation.evidence?.kind === 'complete' ? observation.evidence.result.requested : null;
      const compatible = requested !== null && requested.capabilities.length === 0 && (admitted !== null
        ? isDeepStrictEqual(requested, engineSelection({ ...admitted, capabilities: [] }))
        : requested.adapter === normal.adapter && requested.provider === normal.provider
          && requested.modelFamily === normal.modelFamily && requested.model === normal.model);
      if (observation.ok && !compatible) {
        observation = { ...observation, ok: false, failure: 'unknown', detail: 'Live preflight requested identity does not match its selected target.' };
      }
      await appendProbeOutcome(start, payload, { stage: 'live', value: observation });
    }
  };

  const routeFor = (
    lane: ResolvedExecutionLane,
    unavailable: ReadonlySet<EngineExclusionKey>,
  ): readonly [PreparedEngineLane] | readonly [PreparedEngineLane, PreparedEngineLane] | null => {
    const live: PreparedEngineLane[] = [];
    const declaredTargets = [lane.effective, ...lane.fallbacks];
    for (const target of declaredTargets) {
      const binding = enginesByTarget.get(targetKey(target))!;
      if (blockedRoutes.has(routeId(lane, target))) continue;
      if (isEngineExcluded(unavailable, binding.selection, target, declaredTargets)) continue;
      live.push({
        engine: binding.engine,
        selection: binding.selection,
        hardTokenLimitEnforceable: binding.hardTokenLimitEnforceable,
        target,
      });
      if (live.length === 2) break;
    }
    if (live.length === 0) return null;
    if (live.length === 1) return [live[0]!];
    return [live[0]!, live[1]!];
  };

  const prepareDispatch = (
    command: Extract<GraphCommand, { readonly kind: 'dispatch' }>,
    unavailable: ReadonlySet<EngineExclusionKey>,
  ): PreparedDispatch => {
    const node = nodesById.get(command.nodeId);
    const binding = options.nodes[command.nodeId];
    if (!node || !binding) {
      fail('MISSING_NODE_BINDING', `No node behaviour is bound for "${command.nodeId}".`);
    }
    if (binding.retrySafe !== undefined && typeof binding.retrySafe !== 'boolean') {
      fail('MISSING_NODE_BINDING', `Node "${command.nodeId}" has an invalid retrySafe policy.`);
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
    alreadyStarted = false,
    engineSequence = 0,
  ): Promise<void> => {
    const { command, binding, prompt, route } = prepared;
    const identity: AttemptIdentity = createAttemptIdentity({
      namespace: stream.namespace,
      streamId: stream.streamId,
      nodeId: command.nodeId,
      position: command.position,
    });
    if (!alreadyStarted) {
      await enqueueAppend(newEvent(options.runId, 'node-attempt-started', {
        identity,
        retrySafe: binding.retrySafe ?? false,
      }));
    }
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
      declaredTargets: route === null ? [] : targetsForNode(command.nodeId),
      recordModelUnavailable: async (fact) => {
        await enqueueAppend(newEvent(
          options.runId,
          'model-unavailable',
          fact as unknown as JsonObject,
        ));
      },
      recordEngineAttempt: async (fact) => {
        await enqueueAppend(newEvent(options.runId, 'engine-attempt-recorded', {
          nodeId: command.nodeId,
          position: command.position,
          sequence: engineSequence + 1,
          ...fact,
        }));
        engineSequence += 1;
      },
      decideAction: binding.decideAction,
    }, signal);
    if (result.status === 'completed') {
      const issue = options.graph.validateNodeResult?.(command.nodeId, result.result) ?? null;
      if (issue !== null) {
        await appendResult(newEvent(options.runId, 'node-failed', {
          nodeId: command.nodeId,
          position: command.position,
          code: 'RESULT_INVALID',
        }));
        return;
      }
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

  const drive = async (signal: AbortSignal): Promise<GraphExecutorResult> => {
    for (;;) {
      if (signal.aborted) fail('ABORTED', 'The graph run was aborted.');
      const admission = await admitBeforeWork(signal);
      if ('result' in admission) return admission.result;
      const { folded } = admission;
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
  };

  const resumePosition = async (
    position: string,
    signal: AbortSignal,
  ): Promise<GraphExecutorResult> => {
    if (signal.aborted) fail('ABORTED', 'The graph run was aborted.');
    const admission = await admitBeforeWork(signal);
    if ('result' in admission) return admission.result;
    const { folded } = admission;
    const attempt = folded.attempts.get(position);
    if (!attempt || attempt.status === 'settled') {
      fail('PROTOCOL', `Position "${position}" is not an unfinished attempt.`);
    }
    const recovery: NewDomainEvent[] = [];
    if (
      attempt.status === 'in-flight'
      && attempt.started !== null
      && nodesById.get(attempt.command.nodeId)!.laneId !== null
    ) {
      recovery.push(newEvent(options.runId, 'engine-attempt-recorded', {
        nodeId: attempt.command.nodeId,
        position,
        sequence: attempt.engineSequence + 1,
        requested: null,
        effective: null,
      }));
    }
    if (
      attempt.status === 'in-flight'
      && attempt.started !== null
      && !attempt.started.retrySafe
    ) {
      await appendBatch(folded.revision, [...recovery, newEvent(options.runId, 'node-paused', {
        nodeId: attempt.command.nodeId,
        position,
        reason: 'The previous process stopped after node code started, so its outcome is uncertain.',
        request: {
          kind: 'reconcile-attempt',
          attemptId: attempt.started.identity.attemptId,
        },
      })]);
      return drive(signal);
    }

    const prepared = prepareDispatch(attempt.command, folded.unavailable);
    if (attempt.status === 'paused' || attempt.started !== null) {
      await appendBatch(folded.revision, [...recovery, newEvent(options.runId, 'node-resumed', {
        nodeId: attempt.command.nodeId,
        position,
      })]);
    }
    await appendOutcome(prepared, signal, attempt.started !== null, attempt.engineSequence + recovery.length);
    return drive(signal);
  };

  const resumePreflight = async (target: { readonly preflightEventId: string }, signal: AbortSignal): Promise<GraphExecutorResult> => {
    const value: unknown = target;
    const item = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : undefined;
    if (item === undefined || Object.getOwnPropertyNames(item).length !== 1 || Object.getOwnPropertySymbols(item).length !== 0 || !Object.hasOwn(item, 'preflightEventId') || 'position' in item) {
      fail('RESUME_EVENT_MISMATCH', 'Preflight resume requires exactly one valid preflightEventId.');
    }
    let requested: string;
    try { requested = validateDomainEventId(item.preflightEventId, '/preflightEventId'); }
    catch (cause) { fail('RESUME_EVENT_MISMATCH', 'Preflight resume requires exactly one valid preflightEventId.', cause); }
    if (signal.aborted) fail('ABORTED', 'The graph run was aborted.');
    const folded = await readFolded();
    const current = folded.preflight.state.pause?.preflightEventId ?? null;
    if (current !== requested) {
      fail('RESUME_EVENT_MISMATCH', `Resume expected preflight event "${requested}" but found "${current ?? '(none)'}".`);
    }
    await enqueueAppend(preflightEvent(options.runId, 'preflight:resumed', { preflightEventId: requested }, requested));
    return drive(signal);
  };

  const exclusively = async (
    operation: () => Promise<GraphExecutorResult>,
  ): Promise<GraphExecutorResult> => {
    if (running) fail('PROTOCOL', 'This graph executor is already running.');
    running = true;
    try {
      return await operation();
    } finally {
      running = false;
    }
  };

  return Object.freeze({
    run: (signal: AbortSignal) => exclusively(() => drive(signal)),
    resume: (target: string | { readonly preflightEventId: string }, signal: AbortSignal) => exclusively(
      () => typeof target === 'string' ? resumePosition(target, signal) : resumePreflight(target, signal),
    ),
  });
}
