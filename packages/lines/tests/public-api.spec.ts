import { describe, expect, it } from 'vitest';

import * as api from '../src/api.ts';
import * as commandEnvironmentApi from '../src/env/command.ts';
import * as testingApi from '../src/testing.ts';

describe('public runtime API', () => {
  it('exports only the reviewed programmatic surface', () => {
    expect(Object.keys(api).sort()).toEqual([
      'EXIT_PAUSED',
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
      'reviewContext',
      'reviewPanel',
      'revisionRequest',
      'run',
      'sampled',
      'sequence',
      'toCondition',
      'tournament',
      'withEnv',
      'writeScope',
    ]);
  });

  it('keeps test and environment helpers on explicit subpaths', () => {
    expect(Object.keys(testingApi).sort()).toEqual([
      'MockEngine',
      'MockEnvironment',
      'mockVerdict',
    ]);
    expect(Object.keys(commandEnvironmentApi).sort()).toEqual([
      'commandEnvironment',
    ]);
  });
});
