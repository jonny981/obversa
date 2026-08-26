import { describe, expect, it } from 'vitest';

import {
  resolveGraphPlan,
  validateGraphDescription,
  type GraphDescription,
  type PlanResolution,
} from '../src/graph/plan.ts';

const definitionDigest = `sha256:${'1'.repeat(64)}` as const;
const packageDigest = `sha256:${'2'.repeat(64)}` as const;

function deeplyNestedJson(depth = 10_000): unknown {
  return JSON.parse(`${'['.repeat(depth)}null${']'.repeat(depth)}`);
}

const description: GraphDescription = {
  schemaVersion: 1,
  graph: {
    id: 'review',
    definitionVersion: 1,
    kind: 'two-role',
    typeVersion: 1,
    definitionDigest,
  },
  inputContract: { type: 'object' },
  outputContract: { type: 'object' },
  phases: [{ id: 'work', name: 'Work', nodeIds: ['author'] }],
  nodes: [{
    id: 'author',
    phaseId: 'work',
    inputContract: {},
    outputContract: {},
    laneId: 'author-lane',
  }],
  edges: [],
  policies: {
    retry: { max: 2 },
    stop: { on: 'complete' },
    concurrency: { max: 1 },
    write: { paths: ['src/**'] },
    budget: { tokens: 1000 },
    action: { default: 'deny' },
  },
  executionLanes: [{
    id: 'author-lane',
    requested: {
      adapter: 'agent-sdk',
      provider: 'provider-a',
      modelFamily: 'family-a',
      model: 'model-a',
      tools: ['Read'],
    },
    knownSubstitutions: [{
      adapter: 'api',
      provider: 'provider-a',
      modelFamily: 'family-a',
      model: 'model-b',
      tools: ['Read'],
    }],
  }],
  requestedPermissions: [{ name: 'workspace.read', scope: { paths: ['src/**'] } }],
  bounds: {
    dispatches: {
      min: { kind: 'known', value: 1 },
      max: { kind: 'known', value: 3 },
    },
    maxConcurrency: { kind: 'known', value: 1 },
    maxFanOut: { kind: 'unknown', reason: 'chosen from input' },
  },
  requirements: { memory: 'unused' },
};

function resolution(): PlanResolution {
  const identity = {
    source: 'npm:@example/two-role',
    version: '1.0.0',
    digest: packageDigest,
  } as const;
  return {
    package: identity,
    admission: {
      package: identity,
      permissions: [
        { name: 'workspace.read', scope: { paths: ['src/**'] } },
        { name: 'workspace.write', scope: { paths: ['tmp/**'] } },
      ],
    },
    executionLanes: [{
      id: 'author-lane',
      effective: description.executionLanes[0]!.requested,
    }],
  };
}

const descriptionWithEdge: GraphDescription = {
  ...description,
  edges: [{ id: 'author-loop', source: 'author', target: 'author' }],
};

const invalidIdentifierCases: readonly [string, GraphDescription][] = [
  ['/graph/id', {
    ...description,
    graph: { ...description.graph, id: ' review' },
  }],
  ['/phases/0/id', {
    ...description,
    phases: [{ ...description.phases[0]!, id: 'work ' }],
    nodes: [{ ...description.nodes[0]!, phaseId: 'work ' }],
  }],
  ['/phases/0/nodeIds/0', {
    ...description,
    phases: [{ ...description.phases[0]!, nodeIds: [' author'] }],
  }],
  ['/nodes/0/id', {
    ...description,
    phases: [{ ...description.phases[0]!, nodeIds: ['author '] }],
    nodes: [{ ...description.nodes[0]!, id: 'author ' }],
  }],
  ['/nodes/0/phaseId', {
    ...description,
    nodes: [{ ...description.nodes[0]!, phaseId: ' work' }],
  }],
  ['/nodes/0/laneId', {
    ...description,
    nodes: [{ ...description.nodes[0]!, laneId: 'author-lane ' }],
  }],
  ['/edges/0/id', {
    ...descriptionWithEdge,
    edges: [{ ...descriptionWithEdge.edges[0]!, id: ' author-loop' }],
  }],
  ['/edges/0/source', {
    ...descriptionWithEdge,
    edges: [{ ...descriptionWithEdge.edges[0]!, source: 'author ' }],
  }],
  ['/edges/0/target', {
    ...descriptionWithEdge,
    edges: [{ ...descriptionWithEdge.edges[0]!, target: ' author' }],
  }],
  ['/executionLanes/0/id', {
    ...description,
    nodes: [{ ...description.nodes[0]!, laneId: ' author-lane' }],
    executionLanes: [{ ...description.executionLanes[0]!, id: ' author-lane' }],
  }],
];

describe('resolveGraphPlan', () => {
  it('returns structured validation errors for malformed public data', () => {
    expect(() => validateGraphDescription({} as never)).toThrow(/required field/i);
    expect(() => resolveGraphPlan(description, {} as never)).toThrow(/required field/i);
    expect(() => validateGraphDescription({ bad: undefined } as never)).toThrow(
      /invalid json/i,
    );
  });

  it('returns GraphValidationError for excessive JSON depth at public boundaries', () => {
    const deepDescription = {
      ...description,
      inputContract: deeplyNestedJson(),
    } as GraphDescription;

    for (const operation of [
      () => validateGraphDescription(deepDescription),
      () => resolveGraphPlan(deepDescription, resolution()),
    ]) {
      expect(operation).toThrowError(
        expect.objectContaining({
          name: 'GraphValidationError',
          issues: [expect.objectContaining({ code: 'INVALID_JSON_VALUE' })],
        }),
      );
    }
  });

  it('requires a node phaseId to match the phase that contains it', () => {
    const mismatched: GraphDescription = {
      ...description,
      phases: [
        { id: 'listed', name: 'Listed', nodeIds: ['author'] },
        { id: 'claimed', name: 'Claimed', nodeIds: [] },
      ],
      nodes: [{ ...description.nodes[0]!, phaseId: 'claimed' }],
    };

    expect(() => validateGraphDescription(mismatched)).toThrowError(
      expect.objectContaining({
        issues: [expect.objectContaining({
          code: 'INVALID_PHASE_ASSIGNMENT',
          path: '/nodes/0/phaseId',
        })],
      }),
    );
  });

  it.each(invalidIdentifierCases)(
    'rejects whitespace in saved identifiers and references at %s',
    (path, invalid) => {
      expect(() => validateGraphDescription(invalid)).toThrowError(
        expect.objectContaining({
          issues: [expect.objectContaining({ code: 'INVALID_ID', path })],
        }),
      );
    },
  );

  it('returns stable plan bytes and a stable digest', () => {
    const first = resolveGraphPlan(description, resolution());
    const second = resolveGraphPlan(description, resolution());

    expect(first).toEqual(second);
    expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.plan.bounds.dispatches).toEqual({
      min: { kind: 'known', value: 1 },
      max: { kind: 'known', value: 3 },
    });
    expect(first.plan.bounds.maxFanOut).toEqual({
      kind: 'unknown',
      reason: 'chosen from input',
    });
    expect(first.plan.permissions.requested).toHaveLength(1);
    expect(first.plan.permissions.admitted).toHaveLength(2);
  });

  it.each([
    ['adapter', 'other-adapter'],
    ['provider', 'other-provider'],
    ['modelFamily', 'other-family'],
    ['model', 'other-model'],
  ] as const)('changes the digest when %s changes', (field, value) => {
    const base = resolveGraphPlan(description, resolution());
    const requested = {
      ...description.executionLanes[0]!.requested,
      [field]: value,
    };
    const changedDescription: GraphDescription = {
      ...description,
      executionLanes: [{
        ...description.executionLanes[0]!,
        requested,
      }],
    };
    const changed: PlanResolution = {
      ...resolution(),
      executionLanes: [{
      id: 'author-lane',
        effective: requested,
      }],
    };

    expect(resolveGraphPlan(changedDescription, changed).digest).not.toBe(base.digest);
  });

  it('changes the digest when tools or a declared substitution changes', () => {
    const base = resolveGraphPlan(description, resolution());
    const requested = {
      ...description.executionLanes[0]!.requested,
      tools: ['Read', 'Search'],
    };
    const changedTools: GraphDescription = {
      ...description,
      executionLanes: [{ ...description.executionLanes[0]!, requested }],
    };
    const changedResolution: PlanResolution = {
      ...resolution(),
      executionLanes: [{ id: 'author-lane', effective: requested }],
    };
    expect(resolveGraphPlan(changedTools, changedResolution).digest).not.toBe(base.digest);

    const substitution = {
      ...description.executionLanes[0]!.knownSubstitutions[0]!,
      model: 'model-c',
    };
    const changedSubstitution: GraphDescription = {
      ...description,
      executionLanes: [{
        ...description.executionLanes[0]!,
        knownSubstitutions: [substitution],
      }],
    };
    expect(resolveGraphPlan(changedSubstitution, resolution()).digest).not.toBe(base.digest);
  });

  it.each(['source', 'version', 'digest'] as const)(
    'rejects a package %s that the host did not admit',
    (field) => {
      const base = resolution();
      const changed: PlanResolution = {
        ...base,
        admission: {
          ...base.admission,
          package: {
            ...base.admission.package,
          [field]: field === 'digest' ? `sha256:${'3'.repeat(64)}` : 'different',
          },
        },
      };
      expect(() => resolveGraphPlan(description, changed)).toThrow(/package/i);
    },
  );

  it('rejects a permission outside admission and does not promote extras', () => {
    const base = resolution();
    const missing: PlanResolution = {
      ...base,
      admission: { package: base.package, permissions: [] },
    };
    expect(() => resolveGraphPlan(description, missing)).toThrow(/permission/i);

    const accepted = resolveGraphPlan(description, resolution());
    expect(accepted.plan.permissions.requested).toEqual(
      description.requestedPermissions,
    );
    expect(accepted.plan.permissions.requested).not.toContainEqual(
      { name: 'workspace.write', scope: { paths: ['tmp/**'] } },
    );
  });

  it('rejects an undeclared execution target', () => {
    const changed: PlanResolution = {
      ...resolution(),
      executionLanes: [{
        id: 'author-lane',
        effective: {
          adapter: 'other',
          provider: 'other',
          modelFamily: 'other',
          model: 'other',
          tools: [],
        },
      }],
    };
    expect(() => resolveGraphPlan(description, changed)).toThrow(/substitution/i);
  });
});
