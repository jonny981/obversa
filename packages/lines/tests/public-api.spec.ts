import { describe, expect, it } from 'vitest';

import * as api from '../src/api.ts';
import * as commandEnvironmentApi from '../src/env/command.ts';
import * as testingApi from '../src/testing.ts';
import type { GraphKernel } from '../src/api.ts';

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
      'GraphValidationError',
      'JsonValueError',
      'LANE_DEAD_FAILURES',
      'LoopError',
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
      'dag',
      'defineAgent',
      'defineAgentFromMarkdown',
      'defineJob',
      'defineSkill',
      'describeConditions',
      'exitCodeFor',
      'fallbackEngine',
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
      'loop',
      'minConfidence',
      'never',
      'not',
      'parallel',
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
      'validateGraphDescription',
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
      'assertGraphTypeConformance',
      'mockVerdict',
      'runGraphTypeConformance',
    ]);
    expect(Object.keys(commandEnvironmentApi).sort()).toEqual([
      'commandEnvironment',
    ]);
  });
});
