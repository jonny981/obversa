import type { CompiledGraphType, GraphEvent } from './graph/type.js';
import type { GraphCommand } from './graph/commands.js';
import type { JsonValue } from './graph/value.js';
import { executeNodeAttempt, type NodeAttemptRecord, type PreparedNodeAttempt } from './runtime/node-lifecycle.js';
import type { EngineSelectionRecord } from './engines/engine.js';

export interface ModelUnavailableEvent extends GraphEvent<'model-unavailable', JsonValue> {}

/** Rebuild dead execution targets from durable model-unavailable events. */
export function unavailableTargets(events: readonly ModelUnavailableEvent[]): readonly EngineSelectionRecord[] {
  const seen = new Set<string>();
  const result: EngineSelectionRecord[] = [];
  for (const event of events) {
    const effective = (event.payload as unknown as { readonly effective: EngineSelectionRecord }).effective;
    const key = JSON.stringify(effective);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(effective);
  }
  return Object.freeze(result);
}

export function selectAvailableTargets(
  targets: readonly EngineSelectionRecord[],
  unavailable: readonly EngineSelectionRecord[],
): readonly EngineSelectionRecord[] {
  const dead = new Set(unavailable.map((value) => JSON.stringify(value)));
  return Object.freeze(targets.filter((value) => !dead.has(JSON.stringify(value))));
}

export async function runWithFallback<T>(
  targets: readonly EngineSelectionRecord[],
  unavailable: readonly EngineSelectionRecord[],
  run: (target: EngineSelectionRecord) => Promise<{ readonly value?: T; readonly unavailable: boolean }>,
): Promise<{ readonly target: EngineSelectionRecord; readonly value: T } | { readonly status: 'failed'; readonly code: 'ENGINE_UNAVAILABLE' }> {
  for (const target of selectAvailableTargets(targets, unavailable)) {
    const result = await run(target);
    if (!result.unavailable && result.value !== undefined) return { target, value: result.value };
  }
  return { status: 'failed', code: 'ENGINE_UNAVAILABLE' };
}

/** Run declared node attempts in order, skipping targets recorded unavailable. */
export async function executeWithFallback(
  targets: readonly EngineSelectionRecord[],
  unavailable: readonly EngineSelectionRecord[],
  prepare: (target: EngineSelectionRecord) => PreparedNodeAttempt,
  signal: AbortSignal,
): Promise<{ readonly target: EngineSelectionRecord; readonly record: NodeAttemptRecord } | { readonly status: 'failed'; readonly code: 'ENGINE_UNAVAILABLE' }> {
  for (const target of selectAvailableTargets(targets, unavailable)) {
    const record = await executeNodeAttempt(prepare(target), signal);
    if (record.status === 'completed') return { target, record };
  }
  return { status: 'failed', code: 'ENGINE_UNAVAILABLE' };
}

export interface GraphExecutorSnapshot<State extends JsonValue = JsonValue> {
  readonly state: State;
  readonly events: readonly GraphEvent[];
  readonly positions: readonly string[];
}

/** Fold durable graph events and produce the next validated pure decision. */
export function graphDecision<
  State extends JsonValue,
  Event extends GraphEvent,
>(graph: CompiledGraphType, events: readonly Event[]): GraphExecutorSnapshot<State> & {
  readonly commands: readonly GraphCommand[];
} {
  let state = graph.initialState() as State;
  const positions = new Set<string>();
  for (const event of events) {
    state = graph.reduce(state, event) as State;
    if (event.type === 'node-dispatched') {
      const position = (event.payload as { position?: unknown }).position;
      if (typeof position === 'string') positions.add(position);
    }
  }
  const commands = graph.decide(state);
  for (const command of commands) {
    if (command.kind === 'dispatch' && positions.has(command.position)) {
      throw new Error(`Dispatch position already exists: ${command.position}`);
    }
  }
  return Object.freeze({ state, events: [...events], positions: [...positions], commands });
}

export interface ExecutorBinding {
  readonly prepare: (command: Extract<GraphCommand, { kind: 'dispatch' }>) => PreparedNodeAttempt;
}

/** Execute one dispatch through the D4 node-attempt lifecycle. */
export async function executeGraphDispatch(
  command: Extract<GraphCommand, { kind: 'dispatch' }>,
  bindings: Readonly<Record<string, ExecutorBinding>>,
  signal: AbortSignal,
): Promise<NodeAttemptRecord> {
  const binding = bindings[command.nodeId];
  if (!binding) throw new Error(`No executor binding for node: ${command.nodeId}`);
  return executeNodeAttempt(binding.prepare(command), signal);
}
