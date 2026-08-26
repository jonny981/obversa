import { isDeepStrictEqual } from 'node:util';

import type { Memory } from '@obversa/memory';

import { validateGraphCommands, type GraphCommand } from './commands.js';
import {
  createGraphKernel,
  type CompiledGraphDefinition,
  type GraphDefinition,
  type GraphKernel,
} from './kernel.js';
import {
  validateGraphDescription,
  type GraphDescription,
  type GraphDescriptionInput,
  type GraphRequirements,
} from './plan.js';
import {
  cloneFrozenJson,
  GraphValidationError,
  JsonValueError,
  type GraphValidationIssue,
  type JsonValue,
} from './value.js';

export interface GraphEvent<
  Type extends string = string,
  Payload extends JsonValue = JsonValue,
> {
  readonly type: Type;
  readonly version: number;
  readonly payload: Payload;
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

function issue(path: string, message: string): GraphValidationIssue {
  return { code: 'INVALID_GRAPH_TYPE', path, message };
}

function fail(path: string, message: string): never {
  throw new GraphValidationError('Invalid graph type.', [issue(path, message)]);
}

function name(value: unknown, path: string, label: string): string {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(path, `${label} must be a non-empty string without control characters.`);
  }
  return value;
}

function version(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(path, 'Graph type version must be a positive safe integer.');
  }
  return value as number;
}

function json<Value>(value: Value, path: string): Value {
  try {
    return cloneFrozenJson(value as unknown as JsonValue) as unknown as Value;
  } catch (error) {
    if (!(error instanceof JsonValueError)) throw error;
    fail(`${path}${error.path}`, error.message);
  }
}

function validateEvent<Event extends GraphEvent>(value: Event): Event {
  const event = json(value, '/event') as unknown;
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    fail('/event', 'Event must be an object.');
  }
  const fields = Object.keys(event).sort();
  const expected = ['payload', 'type', 'version'];
  if (!isSameStringList(fields, expected)) {
    fail(
      '/event',
      `Event must contain exactly type, version, and payload; received ${fields.join(', ') || 'no fields'}.`,
    );
  }
  const safeEvent = event as Event;
  name(safeEvent.type, '/event/type', 'Event type');
  if (!Number.isSafeInteger(safeEvent.version) || safeEvent.version < 1) {
    fail('/event/version', 'Event version must be a positive safe integer.');
  }
  return safeEvent;
}

function isSameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function descriptionMismatch(path: string, message: string): never {
  throw new GraphValidationError(`Invalid graph plan: ${message}`, [{
    code: 'DESCRIPTION_MISMATCH',
    path,
    message,
  }]);
}

function assertCompiledDescription(
  description: GraphDescription,
  expected: {
    readonly kernel: GraphKernel;
    readonly kind: string;
    readonly typeVersion: number;
    readonly requirements: GraphRequirements;
  },
): void {
  const { definition } = expected.kernel;
  if (
    description.graph.id !== definition.value.id
    || description.graph.definitionVersion !== definition.value.definitionVersion
    || description.graph.definitionDigest !== definition.digest
    || description.graph.kind !== expected.kind
    || description.graph.typeVersion !== expected.typeVersion
    || !isDeepStrictEqual(description.requirements, expected.requirements)
  ) {
    descriptionMismatch('/graph', 'Description metadata does not match the compiled graph.');
  }
  if (!isDeepStrictEqual(
    description.nodes.map((node) => node.id),
    definition.value.nodes.map((node) => node.id),
  )) {
    descriptionMismatch('/nodes', 'Description node order does not match the definition.');
  }
  if (!isDeepStrictEqual(description.edges, definition.value.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
  })))) {
    descriptionMismatch('/edges', 'Description edges do not match the definition.');
  }
}

/** Validate a definition, then compile its trusted graph-type implementation. */
export function compileGraph<
  Definition extends GraphDefinition,
  State extends JsonValue,
  Event extends GraphEvent,
  Requirements extends GraphRequirements,
>(
  graphType: GraphType<Definition, State, Event, Requirements>,
  definition: Definition,
): CompiledGraphType<Definition, State, Event, Requirements> {
  const kind = name(graphType.kind, '/kind', 'Graph kind');
  const typeVersion = version(graphType.version, '/version');
  const kernel = createGraphKernel(definition);
  const implementation = graphType.compile(kernel.definition.value, kernel);
  if (!implementation || typeof implementation !== 'object') {
    fail('/compile', 'compile() must return a compiled graph object.');
  }
  const requirements = json(implementation.requirements, '/compile/requirements');
  if (requirements.memory !== 'required' && requirements.memory !== 'unused') {
    fail('/compile/requirements/memory', 'Memory must be required or unused.');
  }
  for (const method of ['initialState', 'reduce', 'decide', 'describe'] as const) {
    if (typeof implementation[method] !== 'function') {
      fail(`/compile/${method}`, `${method} must be a function.`);
    }
  }

  const initialState = json(implementation.initialState(), '/initialState');
  const descriptionInput = json(
    implementation.describe(),
    '/description',
  ) as GraphDescriptionInput;
  const description = validateGraphDescription({
    ...descriptionInput,
    schemaVersion: 1,
    graph: {
      id: kernel.definition.value.id,
      definitionVersion: kernel.definition.value.definitionVersion,
      kind,
      typeVersion,
      definitionDigest: kernel.definition.digest,
    },
    edges: kernel.definition.value.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
    })),
    requirements,
  });
  assertCompiledDescription(description, {
    kernel,
    kind,
    typeVersion,
    requirements,
  });

  return Object.freeze({
    definition: kernel.definition,
    requirements,
    initialState: () => initialState,
    reduce(state: State, event: Event): State {
      const safeState = json(state, '/state');
      const safeEvent = validateEvent(event);
      return json(implementation.reduce(safeState, safeEvent), '/reducedState');
    },
    decide(state: State): readonly GraphCommand[] {
      const safeState = json(state, '/state');
      return validateGraphCommands(implementation.decide(safeState), kernel);
    },
    describe: () => description,
  });
}
