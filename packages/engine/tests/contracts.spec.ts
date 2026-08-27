import { describe, expect, test } from 'vitest';
import {
  EngineError,
  attemptEnvironment,
  validateAgentResult,
  type AgentRequest,
} from '../src/index.js';

describe('@obversa/engine', () => {
  test('carries attempt metadata without a runtime type', () => {
    const request: AgentRequest = {
      prompt: 'work',
      attempt: {
        leaf: true,
        runId: 'run-1',
        attemptId: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
        leafId: 'node/0',
        path: [],
        label: 'node',
        iteration: 0,
      },
    };
    expect(attemptEnvironment(request)).toMatchObject({
      OBVERSA_LEAF: '1',
      OBVERSA_RUN_ID: 'run-1',
    });
  });

  test('owns typed provider failures', () => {
    const error = new EngineError({
      kind: 'rate-limit',
      message: 'slow down',
      retryAfterMs: 250,
    });
    expect(error.kind).toBe('rate-limit');
    expect(error.retryAfterMs).toBe(250);
  });

  test('rejects a result without exactly one final part', () => {
    expect(() => validateAgentResult({
      parts: [],
      usage: { kind: 'unknown' },
      requested: {
        adapter: 'fixture', adapterVersion: null, provider: null,
        modelFamily: null, model: null, capabilities: [],
      },
      effective: {
        adapter: 'fixture', adapterVersion: null, provider: null,
        modelFamily: null, model: null, capabilities: [],
      },
    })).toThrow('exactly one final part');
  });
});
