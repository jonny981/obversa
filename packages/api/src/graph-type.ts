import type { Memory } from './memory-types.js';
import type { GraphCommand } from './graph-commands.js';
import type { CompiledGraphDefinition, GraphDefinition, GraphKernel, NodeId, GraphValidationIssue } from './graph-contract.js';
import type { GraphRequirements, GraphDescriptionInput, GraphDescription } from './graph-plan.js';
import type { JsonObject, JsonValue } from './json.js';

export interface GraphEvent<
  Type extends string = string,
  Payload extends JsonValue = JsonValue,
> {
  readonly type: Type;
  readonly version: number;
  readonly payload: Payload;
}

export interface GraphEngineIdentity extends JsonObject {
  readonly adapter: string;
  readonly provider: string | null;
  readonly modelFamily: string | null;
  readonly model: string | null;
}

export interface EngineAttemptRecordedPayload extends JsonObject {
  readonly nodeId: NodeId;
  readonly position: string;
  readonly sequence: number;
  readonly requested: GraphEngineIdentity | null;
  readonly effective: GraphEngineIdentity | null;
}

export type GraphBindings<Requirements extends GraphRequirements> =
  'required' extends Requirements['memory']
    ? { readonly memory: Memory }
    : { readonly memory?: never };

export interface GraphTypeCompilation<
  State extends JsonValue = JsonValue,
  Event extends GraphEvent = GraphEvent,
  Requirements extends GraphRequirements = GraphRequirements,
> {
  readonly requirements: Requirements;
  initialState(): State;
  reduce(state: State, event: Event): State;
  decide(state: State): readonly GraphCommand[];
  describe(): GraphDescriptionInput;
  validateNodeResult?(nodeId: NodeId, result: JsonValue): GraphValidationIssue | null;
}

export interface CompiledGraphType<
  Definition extends GraphDefinition = GraphDefinition,
  State extends JsonValue = JsonValue,
  Event extends GraphEvent = GraphEvent,
  Requirements extends GraphRequirements = GraphRequirements,
> extends Omit<GraphTypeCompilation<State, Event, Requirements>, 'describe'> {
  readonly definition: CompiledGraphDefinition<Definition>;
  describe(): GraphDescription;
}

export interface GraphType<
  Definition extends GraphDefinition = GraphDefinition,
  State extends JsonValue = JsonValue,
  Event extends GraphEvent = GraphEvent,
  Requirements extends GraphRequirements = GraphRequirements,
> {
  readonly kind: string;
  readonly version: number;
  compile(
    definition: Definition,
    kernel: GraphKernel<Definition>,
  ): GraphTypeCompilation<State, Event, Requirements>;
}
