import { GraphValidationError, type GraphValidationIssue, type GraphDefinition, type CompiledGraphDefinition } from './graph-contract.js';
import { JsonValueError, canonicalJson, cloneFrozenJson, digestJson, type JsonObject, type JsonValue } from './json.js';

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function isRecord(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isId(value: JsonValue | undefined): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    !CONTROL_CHARACTER.test(value)
  );
}

function issue(
  code: string,
  path: string,
  message: string,
): GraphValidationIssue {
  return { code, path, message };
}

function validateDefinition(value: JsonValue): asserts value is GraphDefinition {
  const issues: GraphValidationIssue[] = [];
  if (!isRecord(value)) {
    throw new GraphValidationError('Graph definition is invalid.', [
      issue('INVALID_DEFINITION', '', 'The graph definition must be an object.'),
    ]);
  }

  if (!isId(value.id)) {
    issues.push(
      issue(
        'INVALID_ID',
        '/id',
        'The graph id must be a non-empty trimmed string without control characters.',
      ),
    );
  }

  if (
    typeof value.definitionVersion !== 'number' ||
    !Number.isSafeInteger(value.definitionVersion) ||
    value.definitionVersion < 1
  ) {
    issues.push(
      issue(
        'INVALID_VERSION',
        '/definitionVersion',
        'The definition version must be a positive safe integer.',
      ),
    );
  }

  if (!Object.hasOwn(value, 'data')) {
    issues.push(
      issue('INVALID_DEFINITION', '/data', 'The graph data field is required.'),
    );
  }

  const nodeIds = new Set<string>();
  if (!Array.isArray(value.nodes)) {
    issues.push(
      issue('INVALID_DEFINITION', '/nodes', 'Graph nodes must be an array.'),
    );
  } else {
    for (const [index, node] of value.nodes.entries()) {
      const path = `/nodes/${index}`;
      if (!isRecord(node)) {
        issues.push(
          issue('INVALID_DEFINITION', path, 'Each graph node must be an object.'),
        );
        continue;
      }

      if (!isId(node.id)) {
        issues.push(
          issue(
            'INVALID_ID',
            `${path}/id`,
            'A node id must be a non-empty trimmed string without control characters.',
          ),
        );
      } else if (nodeIds.has(node.id)) {
        issues.push(
          issue(
            'DUPLICATE_NODE_ID',
            `${path}/id`,
            `Node id "${node.id}" is already declared.`,
          ),
        );
      } else {
        nodeIds.add(node.id);
      }

      if (!Object.hasOwn(node, 'data')) {
        issues.push(
          issue('INVALID_DEFINITION', `${path}/data`, 'Node data is required.'),
        );
      }
    }
  }

  const edgeIds = new Set<string>();
  if (!Array.isArray(value.edges)) {
    issues.push(
      issue('INVALID_DEFINITION', '/edges', 'Graph edges must be an array.'),
    );
  } else {
    for (const [index, edge] of value.edges.entries()) {
      const path = `/edges/${index}`;
      if (!isRecord(edge)) {
        issues.push(
          issue('INVALID_DEFINITION', path, 'Each graph edge must be an object.'),
        );
        continue;
      }

      if (!isId(edge.id)) {
        issues.push(
          issue(
            'INVALID_ID',
            `${path}/id`,
            'An edge id must be a non-empty trimmed string without control characters.',
          ),
        );
      } else if (edgeIds.has(edge.id)) {
        issues.push(
          issue(
            'DUPLICATE_EDGE_ID',
            `${path}/id`,
            `Edge id "${edge.id}" is already declared.`,
          ),
        );
      } else {
        edgeIds.add(edge.id);
      }

      if (!isId(edge.source)) {
        issues.push(
          issue(
            'INVALID_ID',
            `${path}/source`,
            'An edge source must be a valid node id.',
          ),
        );
      } else if (!nodeIds.has(edge.source)) {
        issues.push(
          issue(
            'UNKNOWN_SOURCE_NODE',
            `${path}/source`,
            `Source node "${edge.source}" is not declared.`,
          ),
        );
      }

      if (!isId(edge.target)) {
        issues.push(
          issue(
            'INVALID_ID',
            `${path}/target`,
            'An edge target must be a valid node id.',
          ),
        );
      } else if (!nodeIds.has(edge.target)) {
        issues.push(
          issue(
            'UNKNOWN_TARGET_NODE',
            `${path}/target`,
            `Target node "${edge.target}" is not declared.`,
          ),
        );
      }

      if (!Object.hasOwn(edge, 'data')) {
        issues.push(
          issue('INVALID_DEFINITION', `${path}/data`, 'Edge data is required.'),
        );
      }
    }
  }

  if (issues.length > 0) {
    throw new GraphValidationError('Graph definition is invalid.', issues);
  }
}

export function compileGraphDefinition<Definition extends GraphDefinition>(
  definition: Definition,
): CompiledGraphDefinition<Definition> {
  let frozen: JsonValue;
  try {
    frozen = cloneFrozenJson(definition);
  } catch (error) {
    if (!(error instanceof JsonValueError)) throw error;
    throw new GraphValidationError('Graph definition is invalid.', [
      issue('INVALID_JSON_VALUE', error.path, error.message),
    ]);
  }

  validateDefinition(frozen);
  const value = frozen as Definition;
  return Object.freeze({
    value,
    canonicalJson: canonicalJson(value),
    digest: digestJson(value),
  });
}
