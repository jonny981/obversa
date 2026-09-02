import { describe, expect, it } from 'vitest';

import * as api from '../src/api.ts';
import * as commandEnvironmentApi from '../src/env/command.ts';
import * as localStorageApi from '../src/storage/local.ts';
import * as testingApi from '../src/testing.ts';
import type { GraphDefinition, GraphEvent, GraphKernel } from '../src/api.ts';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Expect<Value extends true> = Value;
type PublicValidatorTakesOneArgument = Expect<Equal<
  Parameters<typeof api.validateGraphDescription>,
  [value: unknown]
>>;

const publicValidatorTakesOneArgument: PublicValidatorTakesOneArgument = true;
const publicGraphKernelType: GraphKernel | undefined = undefined;

describe('public runtime API', () => {
  it('exports only the reviewed programmatic surface', () => {
    expect(Object.keys(api).sort()).toEqual([
      'EXIT_PAUSED',
      'EngineError',
      'EngineIncompleteResultError',
      'GraphExecutionError',
      'GraphValidationError',
      'JsonValueError',
      'LANE_DEAD_FAILURES',
      'LoopError',
      'StorageError',
      'agentCheck',
      'agentJob',
      'all',
      'always',
      'any',
      'assertGraph',
      'bodyPassed',
      'classifyEngineFailure',
      'commandSucceeds',
      'compileGraph',
      'confidenceCondition',
      'confidenceFromText',
      'costReport',
      'createGraphExecutor',
      'dag',
      'defineAgent',
      'defineAgentFromMarkdown',
      'defineJob',
      'defineSkill',
      'describeConditions',
      'exitCodeFor',
      'fallbackEngine',
      'finalResultPart',
      'finalResultText',
      'fnJob',
      'formatCostReport',
      'formatPreflight',
      'fromFile',
      'gateJob',
      'isolated',
      'jobMeta',
      'kickback',
      'lastDecisionLine',
      'lastGateBrief',
      'loadRunDefinition',
      'loop',
      'minConfidence',
      'never',
      'not',
      'parallel',
      'persistRunDefinition',
      'pipeline',
      'predicate',
      'preflight',
      'preflightEngine',
      'prove',
      'quorum',
      'ratchet',
      'renderPlan',
      'resolveGraphPlan',
      'reviewContext',
      'reviewPanel',
      'revisionRequest',
      'run',
      'sampled',
      'sequence',
      'toCondition',
      'tournament',
      'validateAgentResult',
      'validateArtifactReference',
      'validateArtifactScope',
      'validateDomainEventBatch',
      'validateDomainEventEnvelope',
      'validateEventStreamRef',
      'validateGraphDescription',
      'validateNewArtifact',
      'validateNewDomainEvent',
      'validateRunDefinition',
      'validateRunStartRecord',
      'validateRunStoragePolicy',
      'validateRunStorageRecord',
      'withEnv',
      'writeScope',
    ]);
    expect(publicGraphKernelType).toBeUndefined();
  });

  it('exports the invalid JSON error returned for bad run parameters', async () => {
    let ran = false;

    await expect(api.run(
      api.fnJob('never', async () => {
        ran = true;
        return { status: 'pass' };
      }),
      { params: null as never },
    )).rejects.toBeInstanceOf(api.JsonValueError);
    expect(ran).toBe(false);
  });

  it('validates and freezes a parsed graph description without host resolution', () => {
    const parsed: unknown = JSON.parse(JSON.stringify({
      schemaVersion: 1,
      graph: {
        id: 'empty',
        definitionVersion: 1,
        kind: 'empty',
        typeVersion: 1,
        definitionDigest: `sha256:${'1'.repeat(64)}`,
      },
      inputContract: {},
      outputContract: {},
      phases: [{ id: 'work', name: 'Work', nodeIds: [] }],
      nodes: [],
      edges: [],
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
          min: { kind: 'known', value: 0 },
          max: { kind: 'known', value: 0 },
        },
        maxConcurrency: { kind: 'known', value: 0 },
        maxFanOut: { kind: 'known', value: 0 },
      },
      requirements: { memory: 'unused' },
    }));
    const validate = api.validateGraphDescription;

    const validated = validate(parsed);

    expect(validated).toEqual(parsed);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.graph)).toBe(true);
    expect(Object.isFrozen(validated.phases)).toBe(true);
    expect(() => validate({})).toThrowError(api.GraphValidationError);
    expect(publicValidatorTakesOneArgument).toBe(true);
  });

  it('keeps test and environment helpers on explicit subpaths', () => {
    expect(Object.keys(testingApi).sort()).toEqual([
      'MockEngine',
      'MockEnvironment',
      'assertArtifactStoreConformance',
      'assertEngineConformance',
      'assertEventStoreConformance',
      'assertGraphTypeConformance',
      'createGraphEventTrace',
      'defineGraphDefinition',
      'mockVerdict',
      'runArtifactStoreConformance',
      'runEngineConformance',
      'runEventStoreConformance',
      'runGraphTypeConformance',
    ]);
    expect(Object.keys(commandEnvironmentApi).sort()).toEqual([
      'commandEnvironment',
    ]);
    expect(Object.keys(localStorageApi).sort()).toEqual([
      'createLocalArtifactStore',
      'createLocalEventStore',
      'createLocalRunStorage',
    ]);
  });

  it('provides frozen graph definitions and ordered event traces for package authors', () => {
    const source = {
      id: 'testing-helper',
      definitionVersion: 1,
      data: { label: 'original' },
      nodes: [{ id: 'worker', data: {} }],
      edges: [],
    } satisfies GraphDefinition;
    const graph = testingApi.defineGraphDefinition(source);
    source.data.label = 'changed';
    expect(graph.data).toEqual({ label: 'original' });
    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.nodes)).toBe(true);
    expect(() => testingApi.defineGraphDefinition({
      ...source,
      nodes: [...source.nodes, { id: 'worker', data: {} }],
    })).toThrow(api.GraphValidationError);

    const eventPayload = { value: 1 };
    const first: GraphEvent<'first', { readonly value: number }> = {
      type: 'first',
      version: 1,
      payload: eventPayload,
    };
    const trace = testingApi.createGraphEventTrace<GraphEvent>([first]);
    eventPayload.value = 9;
    const second = trace.record({
      type: 'second',
      version: 1,
      payload: { value: 2 },
    });
    expect(trace.events).toEqual([{
      type: 'first',
      version: 1,
      payload: { value: 1 },
    }, second]);
    expect(Object.isFrozen(trace)).toBe(true);
    expect(Object.isFrozen(trace.events)).toBe(true);
    expect(Object.isFrozen(trace.events[0]?.payload)).toBe(true);
    expect(trace.events[0]?.payload).toEqual({ value: 1 });
    expect(() => testingApi.createGraphEventTrace([{
      type: '',
      version: 0,
      payload: {},
    }])).toThrow(api.GraphValidationError);
  });
});
