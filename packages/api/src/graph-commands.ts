import type { NodeId } from './graph-contract.js';
import type { JsonValue } from './json.js';

export interface DispatchGraphCommand<Input extends JsonValue = JsonValue> {
  readonly kind: 'dispatch';
  readonly nodeId: NodeId;
  readonly input: Input;
  /** Stable logical identity and location of this requested node occurrence. */
  readonly position: string;
}

export interface PauseGraphCommand {
  readonly kind: 'pause';
  readonly reason: string;
}

export interface CompleteGraphCommand<Output extends JsonValue = JsonValue> {
  readonly kind: 'complete';
  readonly output: Output;
}

export interface FailGraphCommand {
  readonly kind: 'fail';
  readonly code: string;
  readonly message: string;
}

export type GraphCommand<
  Input extends JsonValue = JsonValue,
  Output extends JsonValue = JsonValue,
> =
  | DispatchGraphCommand<Input>
  | PauseGraphCommand
  | CompleteGraphCommand<Output>
  | FailGraphCommand;
