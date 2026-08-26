import { describe, expect, it } from 'vitest';

import {
  assertGraphTypeConformance,
  runGraphTypeConformance,
  type GraphTypeConformanceFixture,
} from '../src/graph/conformance.ts';
import type {
  GraphDescription,
  PlanResolution,
} from '../src/graph/plan.ts';
import type { GraphDefinition } from '../src/graph/kernel.ts';
import type { GraphEvent, GraphType } from '../src/graph/type.ts';

const definition: GraphDefinition = {
  id: 'counter',
  definitionVersion: 1,
  data: {},
  nodes: [{ id: 'step', data: {} }],
  edges: [],
};

type State = { readonly completed: boolean };
type Event = GraphEvent<'node-completed', { readonly nodeId: 'step' }>;

function graphDescription(): Omit<
  GraphDescription,
  'schemaVersion' | 'graph' | 'edges' | 'requirements'
> {
  return {
    inputContract: {},
    outputContract: {},
    phases: [{ id: 'work', name: 'Work', nodeIds: ['step'] }],
    nodes: [{
      id: 'step',
      phaseId: 'work',
      inputContract: {},
      outputContract: {},
      laneId: null,
    }],
    policies: {
      retry: null,
      stop: null,
      concurrency: null,
      write: null,
      budget: null,
      action: null,
    },
    executionLanes: [],
    requestedPermissions: [],
    bounds: {
      dispatches: {
        min: { kind: 'known', value: 1 },
        max: { kind: 'known', value: 1 },
      },
      maxConcurrency: { kind: 'known', value: 1 },
      maxFanOut: { kind: 'known', value: 1 },
    },
  };
}

function typeWith(
  overrides: Partial<{
    initialState: () => State;
    reduce: (state: State, event: Event) => State;
    decide: (state: State) => readonly ({
      readonly kind: 'dispatch';
      readonly nodeId: string;
      readonly input: {};
      readonly position: string;
    } | { readonly kind: 'complete'; readonly output: {} })[];
    describe: () => ReturnType<typeof graphDescription>;
  }> = {},
): GraphType<typeof definition, State, Event, { readonly memory: 'unused' }> {
  return {
    kind: 'counter',
    version: 1,
    compile(_value, _kernel) {
      return {
        requirements: { memory: 'unused' },
        initialState: overrides.initialState ?? (() => ({ completed: false })),
        reduce: overrides.reduce ?? (() => ({ completed: true })),
        decide: overrides.decide ?? ((state) => state.completed
          ? [{ kind: 'complete', output: {} }]
          : [{ kind: 'dispatch', nodeId: 'step', input: {}, position: 'work/step' }]),
        describe: overrides.describe ?? graphDescription,
      };
    },
  };
}

function planResolution(): PlanResolution {
  const identity = {
    source: 'file:test-fixture',
    version: '1.0.0',
    digest: `sha256:${'4'.repeat(64)}` as const,
  };
  return {
    package: identity,
    admission: { package: identity, permissions: [] },
    executionLanes: [],
  };
}

function fixture(
  graphType = typeWith(),
): GraphTypeConformanceFixture<
  typeof definition,
  State,
  Event,
  { readonly memory: 'unused' }
> {
  return {
    graphType,
    definition,
    events: [{
      type: 'node-completed',
      version: 1,
      payload: { nodeId: 'step' },
    }],
    invalidDefinitions: [{
      ...definition,
      nodes: [
        { id: 'step', data: {} },
        { id: 'step', data: {} },
      ],
    }],
    planResolution: planResolution(),
    expected: {
      states: [
        { completed: false },
        { completed: true },
      ],
      commands: [
        [{ kind: 'dispatch', nodeId: 'step', input: {}, position: 'work/step' }],
        [{ kind: 'complete', output: {} }],
      ],
      bounds: graphDescription().bounds,
    },
  };
}

describe('graph type conformance', () => {
  it('passes a small graph without Vitest-specific adapters', () => {
    const report = runGraphTypeConformance(fixture());
    expect(report.ok).toBe(true);
    expect(report.cases).toBeGreaterThanOrEqual(6);
    expect(report.failures).toEqual([]);
    expect(() => assertGraphTypeConformance(fixture())).not.toThrow();
  });

  it('reports a reducer that tries to mutate frozen state', () => {
    const report = runGraphTypeConformance(fixture(typeWith({
      reduce(state) {
        (state as { completed: boolean }).completed = true;
        return state;
      },
    })));
    expect(report.ok).toBe(false);
    expect(report.failures.some((failure) => /replay|reduc/i.test(failure.case))).toBe(true);
  });

  it('reports a decision that changes for the same state', () => {
    let calls = 0;
    const report = runGraphTypeConformance(fixture(typeWith({
      decide() {
        calls += 1;
        return calls % 2 === 0
          ? [{ kind: 'complete', output: {} }]
          : [{ kind: 'dispatch', nodeId: 'step', input: {}, position: 'work/step' }];
      },
    })));
    expect(report.ok).toBe(false);
    expect(report.failures.some((failure) => /decision/i.test(failure.case))).toBe(true);
    expect(() => assertGraphTypeConformance(fixture(typeWith({
      decide: () => [{
        kind: 'dispatch',
        nodeId: 'missing',
        input: {},
        position: 'work/missing',
      }],
    })))).toThrow(/conformance/i);
  });

  it('compares ordered decisions from separate compiled instances', () => {
    let compiles = 0;
    const drifting: GraphType<
      typeof definition,
      State,
      Event,
      { readonly memory: 'unused' }
    > = {
      ...typeWith(),
      compile(value, kernel) {
        const compiled = typeWith().compile(value, kernel);
        compiles += 1;
        const dispatches = compiles % 2 === 1;
        return {
          ...compiled,
          decide: (state) => state.completed
            ? [{ kind: 'complete', output: {} }]
            : dispatches
              ? [{ kind: 'dispatch', nodeId: 'step', input: {}, position: 'work/step' }]
              : [{ kind: 'complete', output: {} }],
        };
      },
    };

    const report = runGraphTypeConformance(fixture(drifting));

    expect(report.ok).toBe(false);
    expect(report.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ case: 'deterministic decision' }),
    ]));
  });

  it('checks the expected state and ordered decision at the initial prefix', () => {
    let initialDecisionCalls = 0;
    const wrong = typeWith({
      initialState: () => ({ completed: true }),
      decide(state) {
        if (state.completed) return [{ kind: 'complete', output: {} }];
        initialDecisionCalls += 1;
        return initialDecisionCalls % 2 === 1
          ? [{ kind: 'dispatch', nodeId: 'step', input: {}, position: 'work/step' }]
          : [{ kind: 'complete', output: {} }];
      },
    });

    const report = runGraphTypeConformance(fixture(wrong));

    expect(report.ok).toBe(false);
    expect(report.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ case: 'deterministic compile' }),
      expect.objectContaining({ case: 'deterministic decision' }),
    ]));
  });

  it('rejects plan bounds that do not match the fixture', () => {
    const report = runGraphTypeConformance(fixture(typeWith({
      describe: () => ({
        ...graphDescription(),
        bounds: {
          dispatches: {
            min: { kind: 'known', value: 999 },
            max: { kind: 'known', value: 999 },
          },
          maxConcurrency: { kind: 'known', value: 999 },
          maxFanOut: { kind: 'unknown', reason: 'not calculated' },
        },
      }),
    })));

    expect(report.ok).toBe(false);
    expect(report.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ case: 'deterministic plan resolution' }),
    ]));
  });
});
