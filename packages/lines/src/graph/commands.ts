import type { GraphKernel, NodeId } from './kernel.js';
import {
  cloneFrozenJson,
  GraphValidationError,
  JsonValueError,
  type GraphValidationIssue,
  type JsonValue,
} from './value.js';

export interface DispatchGraphCommand<Input extends JsonValue = JsonValue> {
  readonly kind: 'dispatch';
  readonly nodeId: NodeId;
  readonly input: Input;
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

function issue(path: string, message: string): GraphValidationIssue {
  return { code: 'INVALID_GRAPH_COMMAND', path, message };
}

function invalid(path: string, message: string): GraphValidationError {
  return new GraphValidationError(`Invalid graph command: ${message}`, [
    issue(path, message),
  ]);
}

function text(value: unknown, path: string, label: string): string {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw invalid(path, `${label} must be a non-empty string without control characters.`);
  }
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw invalid(path, `Expected fields ${wanted.join(', ')}; received ${actual.join(', ')}.`);
  }
}

/** Validate one pure graph decision before the runtime can act on it. */
export function validateGraphCommands(
  commands: readonly GraphCommand[],
  kernel: GraphKernel,
): readonly GraphCommand[] {
  if (!Array.isArray(commands)) {
    throw invalid('', 'A graph decision must be an array.');
  }
  if (commands.length === 0) {
    throw invalid('', 'A graph decision must contain at least one command.');
  }

  let frozen: readonly GraphCommand[];
  try {
    frozen = cloneFrozenJson(
      commands as readonly JsonValue[],
    ) as unknown as readonly GraphCommand[];
  } catch (error) {
    if (!(error instanceof JsonValueError)) throw error;
    throw invalid(error.path, error.message);
  }
  for (let index = 0; index < frozen.length; index += 1) {
    const path = `/${index}`;
    const command = frozen[index];
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      throw invalid(path, 'Each command must be an object.');
    }
  }

  const terminal = frozen.filter((command) => command.kind !== 'dispatch');
  if (terminal.length > 0 && frozen.length !== 1) {
    throw invalid('', 'A terminal command must be the only command in a decision.');
  }

  const dispatched = new Set<NodeId>();
  for (let index = 0; index < frozen.length; index += 1) {
    const command = frozen[index] as GraphCommand;
    const path = `/${index}`;

    switch (command.kind) {
      case 'dispatch': {
        exactKeys(command as unknown as Record<string, unknown>, [
          'kind', 'nodeId', 'input', 'position',
        ], path);
        const nodeId = text(command.nodeId, `${path}/nodeId`, 'nodeId');
        text(command.position, `${path}/position`, 'position');
        if (!kernel.node(nodeId)) {
          throw invalid(`${path}/nodeId`, `Dispatch refers to unknown node "${nodeId}".`);
        }
        if (dispatched.has(nodeId)) {
          throw invalid(
            `${path}/nodeId`,
            `Decision contains duplicate dispatch node "${nodeId}".`,
          );
        }
        dispatched.add(nodeId);
        break;
      }
      case 'pause':
        exactKeys(command as unknown as Record<string, unknown>, ['kind', 'reason'], path);
        text(command.reason, `${path}/reason`, 'reason');
        break;
      case 'complete':
        exactKeys(command as unknown as Record<string, unknown>, ['kind', 'output'], path);
        break;
      case 'fail':
        exactKeys(command as unknown as Record<string, unknown>, [
          'kind', 'code', 'message',
        ], path);
        text(command.code, `${path}/code`, 'code');
        text(command.message, `${path}/message`, 'message');
        break;
      default:
        throw invalid(
          `${path}/kind`,
          `Unknown command kind "${String((command as { kind?: unknown }).kind)}".`,
        );
    }
  }

  return frozen;
}
