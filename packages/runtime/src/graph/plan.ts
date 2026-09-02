import { isDeepStrictEqual } from 'node:util';

import type { EdgeId, GraphId, NodeId } from './kernel.js';
import {
  canonicalJson,
  cloneFrozenJson,
  digestJson,
  GraphValidationError,
  JsonValueError,
  type GraphValidationIssue,
  type JsonObject,
  type JsonValue,
  type Sha256Digest,
} from './value.js';

export interface PermissionDescriptor {
  readonly name: string;
  readonly scope: JsonValue;
}

export interface ExecutionTarget extends JsonObject {
  readonly adapter: string;
  readonly provider: string;
  readonly modelFamily: string;
  readonly model: string;
  readonly tools: readonly string[];
}

export interface ExecutionLaneDescription extends JsonObject {
  readonly id: string;
  readonly requested: ExecutionTarget;
  readonly knownSubstitutions: readonly ExecutionTarget[];
}

export interface GraphPhaseDescription {
  readonly id: string;
  readonly name: string;
  readonly nodeIds: readonly NodeId[];
}

export interface GraphNodeDescription {
  readonly id: NodeId;
  readonly phaseId: string;
  readonly inputContract: JsonValue;
  readonly outputContract: JsonValue;
  readonly laneId: string | null;
}

export interface GraphEdgeDescription {
  readonly id: EdgeId;
  readonly source: NodeId;
  readonly target: NodeId;
}

export type PlanBound =
  | { readonly kind: 'known'; readonly value: number }
  | { readonly kind: 'unknown'; readonly reason: string };

export interface GraphBounds {
  readonly dispatches: {
    readonly min: PlanBound;
    readonly max: PlanBound;
  };
  readonly maxConcurrency: PlanBound;
  readonly maxFanOut: PlanBound;
}

export interface GraphPolicyDescription {
  readonly retry: JsonValue;
  readonly stop: JsonValue;
  readonly concurrency: JsonValue;
  readonly write: JsonValue;
  readonly budget: JsonValue;
  readonly action: JsonValue;
}

export interface GraphRequirements {
  readonly memory: 'required' | 'unused';
}

export interface GraphDescriptionInput {
  readonly inputContract: JsonValue;
  readonly outputContract: JsonValue;
  readonly phases: readonly GraphPhaseDescription[];
  readonly nodes: readonly GraphNodeDescription[];
  readonly policies: GraphPolicyDescription;
  readonly executionLanes: readonly ExecutionLaneDescription[];
  readonly requestedPermissions: readonly PermissionDescriptor[];
  readonly bounds: GraphBounds;
}

export interface GraphDescription extends GraphDescriptionInput {
  readonly schemaVersion: 1;
  readonly graph: {
    readonly id: GraphId;
    readonly definitionVersion: number;
    readonly kind: string;
    readonly typeVersion: number;
    readonly definitionDigest: Sha256Digest;
  };
  readonly edges: readonly GraphEdgeDescription[];
  readonly requirements: GraphRequirements;
}

export interface GraphPackageIdentity {
  readonly source: string;
  readonly version: string;
  readonly digest: Sha256Digest;
}

export interface GraphPackageAdmission {
  readonly package: GraphPackageIdentity;
  readonly permissions: readonly PermissionDescriptor[];
}

export interface ExecutionLaneResolution {
  readonly id: string;
  readonly effective: ExecutionTarget;
  readonly fallbacks?: readonly ExecutionTarget[];
}

export interface PlanResolution {
  readonly package: GraphPackageIdentity;
  readonly admission: GraphPackageAdmission;
  readonly executionLanes: readonly ExecutionLaneResolution[];
}

export interface ResolvedExecutionLane extends ExecutionLaneDescription {
  readonly effective: ExecutionTarget;
  readonly fallbacks: readonly ExecutionTarget[];
}

export interface ResolvedPlan {
  readonly schemaVersion: 1;
  readonly graph: GraphDescription['graph'];
  readonly package: GraphPackageIdentity;
  readonly inputContract: JsonValue;
  readonly outputContract: JsonValue;
  readonly phases: readonly GraphPhaseDescription[];
  readonly nodes: readonly GraphNodeDescription[];
  readonly edges: readonly GraphEdgeDescription[];
  readonly policies: GraphPolicyDescription;
  readonly executionLanes: readonly ResolvedExecutionLane[];
  readonly permissions: {
    readonly requested: readonly PermissionDescriptor[];
    readonly admitted: readonly PermissionDescriptor[];
  };
  readonly bounds: GraphBounds;
  readonly requirements: GraphRequirements;
}

export interface ResolvedPlanSnapshot {
  readonly plan: ResolvedPlan;
  readonly canonicalJson: string;
  readonly digest: Sha256Digest;
}

function issue(code: string, path: string, message: string): GraphValidationIssue {
  return { code, path, message };
}

function fail(code: string, path: string, message: string): never {
  throw new GraphValidationError(`Invalid graph plan: ${message}`, [
    issue(code, path, message),
  ]);
}

function record(
  value: unknown,
  path: string,
  label: string,
): Readonly<Record<string, JsonValue>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_SHAPE', path, `${label} must be an object.`);
  }
  return value as Readonly<Record<string, JsonValue>>;
}

function list(value: unknown, path: string, label: string): readonly JsonValue[] {
  if (!Array.isArray(value)) {
    fail('INVALID_SHAPE', path, `${label} must be an array.`);
  }
  return value;
}

function requireFields(
  value: Readonly<Record<string, JsonValue>>,
  fields: readonly string[],
  path: string,
): void {
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) {
      fail(
        'MISSING_FIELD',
        `${path}/${field}`,
        `Required field "${field}" is missing.`,
      );
    }
  }
}

function exactFields(
  value: Readonly<Record<string, JsonValue>>,
  fields: readonly string[],
  path: string,
): void {
  requireFields(value, fields, path);
  const expected = new Set(fields);
  for (const field of Object.keys(value)) {
    if (!expected.has(field)) {
      fail(
        'UNKNOWN_FIELD',
        `${path}/${field}`,
        `Unknown field "${field}" is not allowed.`,
      );
    }
  }
}

function json(value: unknown, path: string): JsonValue {
  try {
    return cloneFrozenJson(value as JsonValue);
  } catch (error) {
    if (!(error instanceof JsonValueError)) throw error;
    fail('INVALID_JSON_VALUE', `${path}${error.path}`, error.message);
  }
}

function text(value: unknown, path: string, label: string): string {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail('INVALID_TEXT', path, `${label} must be a non-empty string without control characters.`);
  }
  return value;
}

function identifier(value: unknown, path: string, label: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(
      'INVALID_ID',
      path,
      `${label} must be a non-empty trimmed string without control characters.`,
    );
  }
  return value;
}

function positiveVersion(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail('INVALID_VERSION', path, 'Version must be a positive safe integer.');
  }
  return value as number;
}

function digest(value: unknown, path: string): Sha256Digest {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    fail('INVALID_DIGEST', path, 'Digest must be lowercase sha256 followed by 64 hex characters.');
  }
  return value as Sha256Digest;
}

function unique(values: readonly string[], path: string, label: string): void {
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = text(values[index], `${path}/${index}`, label);
    if (seen.has(value)) fail('DUPLICATE_ID', `${path}/${index}`, `Duplicate ${label} "${value}".`);
    seen.add(value);
  }
}

function target(value: ExecutionTarget, path: string): void {
  const item = record(value, path, 'Execution target');
  requireFields(item, ['adapter', 'provider', 'modelFamily', 'model', 'tools'], path);
  text(value.adapter, `${path}/adapter`, 'adapter');
  text(value.provider, `${path}/provider`, 'provider');
  text(value.modelFamily, `${path}/modelFamily`, 'modelFamily');
  text(value.model, `${path}/model`, 'model');
  unique(list(value.tools, `${path}/tools`, 'tools') as readonly string[], `${path}/tools`, 'tool');
}

function bound(value: PlanBound, path: string): void {
  const item = record(value, path, 'Plan bound');
  requireFields(item, ['kind'], path);
  if (value.kind === 'known') {
    requireFields(item, ['value'], path);
    if (!Number.isSafeInteger(value.value) || value.value < 0) {
      fail('INVALID_BOUND', `${path}/value`, 'A known bound must be a non-negative safe integer.');
    }
    return;
  }
  if (value.kind === 'unknown') {
    requireFields(item, ['reason'], path);
    text(value.reason, `${path}/reason`, 'unknown-bound reason');
    return;
  }
  fail('INVALID_BOUND', `${path}/kind`, 'Bound kind must be known or unknown.');
}

function permission(value: PermissionDescriptor, path: string): void {
  const item = record(value, path, 'Permission');
  requireFields(item, ['name', 'scope'], path);
  text(value.name, `${path}/name`, 'permission name');
  json(value.scope, `${path}/scope`);
}

function packageIdentity(value: GraphPackageIdentity, path: string): void {
  const item = record(value, path, 'Package identity');
  requireFields(item, ['source', 'version', 'digest'], path);
  text(value.source, `${path}/source`, 'package source');
  text(value.version, `${path}/version`, 'package version');
  digest(value.digest, `${path}/digest`);
}

function strictTarget(value: unknown, path: string): void {
  const item = record(value, path, 'Execution target');
  exactFields(item, ['adapter', 'provider', 'modelFamily', 'model', 'tools'], path);
  target(item as unknown as ExecutionTarget, path);
}

function strictPermission(value: unknown, path: string): void {
  const item = record(value, path, 'Permission');
  exactFields(item, ['name', 'scope'], path);
  permission(item as unknown as PermissionDescriptor, path);
}

function strictBound(value: unknown, path: string): void {
  const item = record(value, path, 'Plan bound');
  bound(item as unknown as PlanBound, path);
  exactFields(
    item,
    item.kind === 'known' ? ['kind', 'value'] : ['kind', 'reason'],
    path,
  );
}

/** Validate and freeze a resolved plan read from storage. */
export function validateResolvedPlan(value: unknown): ResolvedPlan {
  const raw = json(value, '');
  const root = record(raw, '', 'Resolved plan');
  exactFields(root, [
    'schemaVersion',
    'graph',
    'package',
    'inputContract',
    'outputContract',
    'phases',
    'nodes',
    'edges',
    'policies',
    'executionLanes',
    'permissions',
    'bounds',
    'requirements',
  ], '');

  const graph = record(root.graph, '/graph', 'Graph metadata');
  exactFields(graph, [
    'id', 'definitionVersion', 'kind', 'typeVersion', 'definitionDigest',
  ], '/graph');

  const packageValue = record(root.package, '/package', 'Package identity');
  exactFields(packageValue, ['source', 'version', 'digest'], '/package');

  const phases = list(root.phases, '/phases', 'Phases');
  phases.forEach((phase, index) => {
    const item = record(phase, `/phases/${index}`, 'Phase');
    exactFields(item, ['id', 'name', 'nodeIds'], `/phases/${index}`);
  });

  const nodes = list(root.nodes, '/nodes', 'Nodes');
  nodes.forEach((node, index) => {
    const item = record(node, `/nodes/${index}`, 'Node description');
    exactFields(item, [
      'id', 'phaseId', 'inputContract', 'outputContract', 'laneId',
    ], `/nodes/${index}`);
  });

  const edges = list(root.edges, '/edges', 'Edges');
  edges.forEach((edge, index) => {
    const item = record(edge, `/edges/${index}`, 'Edge description');
    exactFields(item, ['id', 'source', 'target'], `/edges/${index}`);
  });

  const policies = record(root.policies, '/policies', 'Policies');
  exactFields(policies, [
    'retry', 'stop', 'concurrency', 'write', 'budget', 'action',
  ], '/policies');

  const lanes = list(root.executionLanes, '/executionLanes', 'Execution lanes');
  lanes.forEach((lane, index) => {
    const path = `/executionLanes/${index}`;
    const item = record(lane, path, 'Resolved execution lane');
    exactFields(item, [
      'id', 'requested', 'knownSubstitutions', 'effective', 'fallbacks',
    ], path);
    strictTarget(item.requested, `${path}/requested`);
    list(
      item.knownSubstitutions,
      `${path}/knownSubstitutions`,
      'Known substitutions',
    ).forEach((targetValue, targetIndex) => {
      strictTarget(
        targetValue,
        `${path}/knownSubstitutions/${targetIndex}`,
      );
    });
    strictTarget(item.effective, `${path}/effective`);
    list(item.fallbacks, `${path}/fallbacks`, 'Fallbacks')
      .forEach((targetValue, targetIndex) => {
        strictTarget(targetValue, `${path}/fallbacks/${targetIndex}`);
      });
  });

  const permissions = record(root.permissions, '/permissions', 'Permissions');
  exactFields(permissions, ['requested', 'admitted'], '/permissions');
  list(permissions.requested, '/permissions/requested', 'Requested permissions')
    .forEach((item, index) => {
      strictPermission(item, `/permissions/requested/${index}`);
    });
  list(permissions.admitted, '/permissions/admitted', 'Admitted permissions')
    .forEach((item, index) => {
      strictPermission(item, `/permissions/admitted/${index}`);
    });

  const bounds = record(root.bounds, '/bounds', 'Bounds');
  exactFields(bounds, [
    'dispatches', 'maxConcurrency', 'maxFanOut',
  ], '/bounds');
  const dispatches = record(
    bounds.dispatches,
    '/bounds/dispatches',
    'Dispatch bounds',
  );
  exactFields(dispatches, ['min', 'max'], '/bounds/dispatches');
  strictBound(dispatches.min, '/bounds/dispatches/min');
  strictBound(dispatches.max, '/bounds/dispatches/max');
  strictBound(bounds.maxConcurrency, '/bounds/maxConcurrency');
  strictBound(bounds.maxFanOut, '/bounds/maxFanOut');

  const requirements = record(root.requirements, '/requirements', 'Requirements');
  exactFields(requirements, ['memory'], '/requirements');

  const plan = root as unknown as ResolvedPlan;
  const description = validateGraphDescription({
    schemaVersion: plan.schemaVersion,
    graph: plan.graph,
    inputContract: plan.inputContract,
    outputContract: plan.outputContract,
    phases: plan.phases,
    nodes: plan.nodes,
    edges: plan.edges,
    policies: plan.policies,
    executionLanes: plan.executionLanes.map((lane) => ({
      id: lane.id,
      requested: lane.requested,
      knownSubstitutions: lane.knownSubstitutions,
    })),
    requestedPermissions: plan.permissions.requested,
    bounds: plan.bounds,
    requirements: plan.requirements,
  });
  const rebuilt = resolveGraphPlan(description, {
    package: plan.package,
    admission: {
      package: plan.package,
      permissions: plan.permissions.admitted,
    },
    executionLanes: plan.executionLanes.map((lane) => ({
      id: lane.id,
      effective: lane.effective,
      fallbacks: lane.fallbacks,
    })),
  }).plan;
  if (!isDeepStrictEqual(plan, rebuilt)) {
    fail(
      'RESOLVED_PLAN_MISMATCH',
      '',
      'Resolved plan does not match its graph description and host resolution.',
    );
  }
  return rebuilt;
}

/** Validate and freeze the stable data returned by a graph type. */
export function validateGraphDescription(
  value: unknown,
): GraphDescription {
  const raw = json(value, '');
  const root = record(raw, '', 'Graph description');
  requireFields(root, [
    'schemaVersion',
    'graph',
    'inputContract',
    'outputContract',
    'phases',
    'nodes',
    'edges',
    'policies',
    'executionLanes',
    'requestedPermissions',
    'bounds',
    'requirements',
  ], '');
  const graph = record(root.graph, '/graph', 'Graph metadata');
  requireFields(graph, [
    'id', 'definitionVersion', 'kind', 'typeVersion', 'definitionDigest',
  ], '/graph');
  const phaseValues = list(root.phases, '/phases', 'Phases');
  const nodeValues = list(root.nodes, '/nodes', 'Nodes');
  const edgeValues = list(root.edges, '/edges', 'Edges');
  const laneValues = list(root.executionLanes, '/executionLanes', 'Execution lanes');
  const permissionValues = list(
    root.requestedPermissions,
    '/requestedPermissions',
    'Requested permissions',
  );
  const policies = record(root.policies, '/policies', 'Policies');
  requireFields(policies, [
    'retry', 'stop', 'concurrency', 'write', 'budget', 'action',
  ], '/policies');
  const bounds = record(root.bounds, '/bounds', 'Bounds');
  requireFields(bounds, [
    'dispatches', 'maxConcurrency', 'maxFanOut',
  ], '/bounds');
  const dispatchBounds = record(bounds.dispatches, '/bounds/dispatches', 'Dispatch bounds');
  requireFields(dispatchBounds, ['min', 'max'], '/bounds/dispatches');
  const requirements = record(root.requirements, '/requirements', 'Requirements');
  requireFields(requirements, ['memory'], '/requirements');
  phaseValues.forEach((phase, index) => {
    const item = record(phase, `/phases/${index}`, 'Phase');
    requireFields(item, ['id', 'name', 'nodeIds'], `/phases/${index}`);
    list(item.nodeIds, `/phases/${index}/nodeIds`, 'Phase nodeIds');
  });
  nodeValues.forEach((node, index) => {
    const item = record(node, `/nodes/${index}`, 'Node description');
    requireFields(item, [
      'id', 'phaseId', 'inputContract', 'outputContract', 'laneId',
    ], `/nodes/${index}`);
  });
  edgeValues.forEach((edge, index) => {
    const item = record(edge, `/edges/${index}`, 'Edge description');
    requireFields(item, ['id', 'source', 'target'], `/edges/${index}`);
  });
  laneValues.forEach((lane, index) => {
    const item = record(lane, `/executionLanes/${index}`, 'Execution lane');
    requireFields(item, [
      'id', 'requested', 'knownSubstitutions',
    ], `/executionLanes/${index}`);
    list(
      item.knownSubstitutions,
      `/executionLanes/${index}/knownSubstitutions`,
      'Known substitutions',
    );
  });
  permissionValues.forEach((item, index) => {
    record(item, `/requestedPermissions/${index}`, 'Permission');
  });
  const description = root as unknown as GraphDescription;
  if (description.schemaVersion !== 1) {
    fail('INVALID_SCHEMA_VERSION', '/schemaVersion', 'Graph description schemaVersion must be 1.');
  }
  identifier(description.graph.id, '/graph/id', 'graph id');
  positiveVersion(description.graph.definitionVersion, '/graph/definitionVersion');
  text(description.graph.kind, '/graph/kind', 'graph kind');
  positiveVersion(description.graph.typeVersion, '/graph/typeVersion');
  digest(description.graph.definitionDigest, '/graph/definitionDigest');

  description.phases.forEach((phase, index) => {
    identifier(phase.id, `/phases/${index}/id`, 'phase id');
  });
  description.nodes.forEach((node, index) => {
    identifier(node.id, `/nodes/${index}/id`, 'node id');
  });
  description.edges.forEach((edge, index) => {
    identifier(edge.id, `/edges/${index}/id`, 'edge id');
  });
  description.executionLanes.forEach((lane, index) => {
    identifier(lane.id, `/executionLanes/${index}/id`, 'lane id');
  });
  description.phases.forEach((phase, phaseIndex) => {
    phase.nodeIds.forEach((nodeId, nodeIndex) => {
      identifier(nodeId, `/phases/${phaseIndex}/nodeIds/${nodeIndex}`, 'node id');
    });
  });
  description.nodes.forEach((node, index) => {
    identifier(node.phaseId, `/nodes/${index}/phaseId`, 'phase id');
    if (node.laneId !== null) {
      identifier(node.laneId, `/nodes/${index}/laneId`, 'lane id');
    }
  });
  description.edges.forEach((edge, index) => {
    identifier(edge.source, `/edges/${index}/source`, 'node id');
    identifier(edge.target, `/edges/${index}/target`, 'node id');
  });

  unique(description.phases.map((phase) => phase.id), '/phases', 'phase id');
  unique(description.nodes.map((node) => node.id), '/nodes', 'node id');
  unique(description.edges.map((edge) => edge.id), '/edges', 'edge id');
  unique(description.executionLanes.map((lane) => lane.id), '/executionLanes', 'lane id');
  unique(description.requestedPermissions.map((item) => item.name), '/requestedPermissions', 'permission name');

  const phaseIds = new Set(description.phases.map((phase) => phase.id));
  const nodeIds = new Set(description.nodes.map((node) => node.id));
  const laneIds = new Set(description.executionLanes.map((lane) => lane.id));
  const assignedNodes: string[] = [];
  const assignedPhaseByNode = new Map<NodeId, string>();
  for (let index = 0; index < description.phases.length; index += 1) {
    const phase = description.phases[index]!;
    text(phase.name, `/phases/${index}/name`, 'phase name');
    unique(phase.nodeIds, `/phases/${index}/nodeIds`, 'node id');
    for (const nodeId of phase.nodeIds) {
      if (!nodeIds.has(nodeId)) {
        fail('UNKNOWN_NODE', `/phases/${index}/nodeIds`, `Phase refers to unknown node "${nodeId}".`);
      }
      assignedNodes.push(nodeId);
      assignedPhaseByNode.set(nodeId, phase.id);
    }
  }
  if (
    assignedNodes.length !== nodeIds.size
    || new Set(assignedNodes).size !== nodeIds.size
  ) {
    fail('INVALID_PHASE_ASSIGNMENT', '/phases', 'Every node must appear in exactly one phase.');
  }

  for (let index = 0; index < description.nodes.length; index += 1) {
    const node = description.nodes[index]!;
    if (!phaseIds.has(node.phaseId)) {
      fail('UNKNOWN_PHASE', `/nodes/${index}/phaseId`, `Node refers to unknown phase "${node.phaseId}".`);
    }
    if (assignedPhaseByNode.get(node.id) !== node.phaseId) {
      fail(
        'INVALID_PHASE_ASSIGNMENT',
        `/nodes/${index}/phaseId`,
        `Node "${node.id}" claims phase "${node.phaseId}" but is listed in phase "${assignedPhaseByNode.get(node.id)}".`,
      );
    }
    if (node.laneId !== null && !laneIds.has(node.laneId)) {
      fail('UNKNOWN_LANE', `/nodes/${index}/laneId`, `Node refers to unknown lane "${node.laneId}".`);
    }
  }

  for (let index = 0; index < description.edges.length; index += 1) {
    const edge = description.edges[index]!;
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      fail('UNKNOWN_NODE', `/edges/${index}`, 'Edge refers to an unknown node.');
    }
  }

  for (let index = 0; index < description.executionLanes.length; index += 1) {
    const lane = description.executionLanes[index]!;
    target(lane.requested, `/executionLanes/${index}/requested`);
    const substitutions = new Set<string>();
    for (let item = 0; item < lane.knownSubstitutions.length; item += 1) {
      const substitution = lane.knownSubstitutions[item]!;
      target(substitution, `/executionLanes/${index}/knownSubstitutions/${item}`);
      const key = canonicalJson(substitution as unknown as JsonValue);
      if (substitutions.has(key)) {
        fail('DUPLICATE_SUBSTITUTION', `/executionLanes/${index}/knownSubstitutions/${item}`, 'Execution substitution is duplicated.');
      }
      substitutions.add(key);
    }
  }

  for (let index = 0; index < description.requestedPermissions.length; index += 1) {
    permission(description.requestedPermissions[index]!, `/requestedPermissions/${index}`);
  }

  bound(description.bounds.dispatches.min, '/bounds/dispatches/min');
  bound(description.bounds.dispatches.max, '/bounds/dispatches/max');
  bound(description.bounds.maxConcurrency, '/bounds/maxConcurrency');
  bound(description.bounds.maxFanOut, '/bounds/maxFanOut');
  const min = description.bounds.dispatches.min;
  const max = description.bounds.dispatches.max;
  if (min.kind === 'known' && max.kind === 'known' && min.value > max.value) {
    fail('INVALID_BOUND', '/bounds/dispatches', 'Minimum dispatches cannot exceed maximum dispatches.');
  }
  if (description.requirements.memory !== 'required' && description.requirements.memory !== 'unused') {
    fail('INVALID_REQUIREMENT', '/requirements/memory', 'Memory must be required or unused.');
  }

  return description;
}

/** Bind a pure plan description to host admission and effective engines. */
export function resolveGraphPlan(
  value: GraphDescription,
  input: PlanResolution,
): ResolvedPlanSnapshot {
  const description = validateGraphDescription(value);
  const raw = json(input, '');
  const root = record(raw, '', 'Plan resolution');
  requireFields(root, ['package', 'admission', 'executionLanes'], '');
  const admission = record(root.admission, '/admission', 'Package admission');
  requireFields(admission, ['package', 'permissions'], '/admission');
  list(admission.permissions, '/admission/permissions', 'Admitted permissions')
    .forEach((item, index) => {
      record(item, `/admission/permissions/${index}`, 'Permission');
    });
  list(root.executionLanes, '/executionLanes', 'Lane resolutions')
    .forEach((item, index) => {
      const lane = record(item, `/executionLanes/${index}`, 'Lane resolution');
      requireFields(lane, ['id', 'effective'], `/executionLanes/${index}`);
      list(
        lane.fallbacks ?? [],
        `/executionLanes/${index}/fallbacks`,
        'Fallbacks',
      );
    });
  const resolution = root as unknown as PlanResolution;
  packageIdentity(resolution.package, '/package');
  packageIdentity(resolution.admission.package, '/admission/package');
  if (!isDeepStrictEqual(resolution.package, resolution.admission.package)) {
    fail('PACKAGE_NOT_ADMITTED', '/admission/package', 'Host admission does not match the requested package.');
  }

  unique(resolution.executionLanes.map((lane) => lane.id), '/executionLanes', 'lane resolution id');
  const resolutions = new Map(resolution.executionLanes.map((lane) => [lane.id, lane]));
  if (resolutions.size !== description.executionLanes.length) {
    fail('INVALID_LANE_RESOLUTION', '/executionLanes', 'Every described lane needs exactly one resolution.');
  }
  const resolvedLanes: ResolvedExecutionLane[] = [];
  for (let index = 0; index < description.executionLanes.length; index += 1) {
    const lane = description.executionLanes[index]!;
    const resolved = resolutions.get(lane.id);
    if (!resolved) {
      fail('INVALID_LANE_RESOLUTION', '/executionLanes', `Lane "${lane.id}" has no resolution.`);
    }
    target(resolved.effective, `/executionLanes/${index}/effective`);
    const allowed = [lane.requested, ...lane.knownSubstitutions];
    if (!allowed.some((candidate) => isDeepStrictEqual(candidate, resolved.effective))) {
      fail('UNKNOWN_SUBSTITUTION', `/executionLanes/${index}/effective`, `Lane "${lane.id}" uses an undeclared substitution.`);
    }
    const fallbacks = resolved.fallbacks ?? [];
    const fallbackKeys = new Set<string>();
    for (let fallbackIndex = 0; fallbackIndex < fallbacks.length; fallbackIndex += 1) {
      const fallback = fallbacks[fallbackIndex]!;
      const path = `/executionLanes/${index}/fallbacks/${fallbackIndex}`;
      target(fallback, path);
      if (!allowed.some((candidate) => isDeepStrictEqual(candidate, fallback))) {
        fail('UNKNOWN_SUBSTITUTION', path, `Lane "${lane.id}" uses an undeclared fallback.`);
      }
      if (isDeepStrictEqual(fallback, resolved.effective)) {
        fail('DUPLICATE_SUBSTITUTION', path, 'A fallback cannot repeat the effective target.');
      }
      const key = canonicalJson(fallback as unknown as JsonValue);
      if (fallbackKeys.has(key)) {
        fail('DUPLICATE_SUBSTITUTION', path, 'Execution fallback is duplicated.');
      }
      fallbackKeys.add(key);
    }
    resolvedLanes.push({
      ...lane,
      effective: resolved.effective,
      fallbacks,
    });
    resolutions.delete(lane.id);
  }
  if (resolutions.size > 0) {
    fail('INVALID_LANE_RESOLUTION', '/executionLanes', 'Resolution contains an unknown lane.');
  }

  const admittedByName = new Map<string, PermissionDescriptor>();
  for (let index = 0; index < resolution.admission.permissions.length; index += 1) {
    const item = resolution.admission.permissions[index]!;
    permission(item, `/admission/permissions/${index}`);
    if (admittedByName.has(item.name)) {
      fail('DUPLICATE_PERMISSION', `/admission/permissions/${index}`, `Permission "${item.name}" is duplicated.`);
    }
    admittedByName.set(item.name, item);
  }
  for (let index = 0; index < description.requestedPermissions.length; index += 1) {
    const requested = description.requestedPermissions[index]!;
    const admitted = admittedByName.get(requested.name);
    if (!admitted || canonicalJson(admitted.scope) !== canonicalJson(requested.scope)) {
      fail('PERMISSION_NOT_ADMITTED', `/requestedPermissions/${index}`, `Permission "${requested.name}" is outside host admission.`);
    }
  }

  const plan = cloneFrozenJson({
    schemaVersion: 1,
    graph: description.graph,
    package: resolution.package,
    inputContract: description.inputContract,
    outputContract: description.outputContract,
    phases: description.phases,
    nodes: description.nodes,
    edges: description.edges,
    policies: description.policies,
    executionLanes: resolvedLanes,
    permissions: {
      requested: description.requestedPermissions,
      admitted: resolution.admission.permissions,
    },
    bounds: description.bounds,
    requirements: description.requirements,
  } as unknown as JsonValue) as unknown as ResolvedPlan;
  const canonical = canonicalJson(plan as unknown as JsonValue);
  return Object.freeze({
    plan,
    canonicalJson: canonical,
    digest: digestJson(plan as unknown as JsonValue),
  });
}
