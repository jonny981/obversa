import { describe, expect, it } from 'vitest';

import { EngineError } from '../src/error.ts';
import type {
  AgentRequest,
  AgentResult,
  Engine,
  EngineEventSink,
} from '../src/index.ts';
import {
  assertEngineConformance,
  runEngineConformance,
  type EngineConformanceFixture,
  type EngineConformanceScenario,
} from '../src/conformance.ts';
import {
  assistantResult,
  engineSelection,
  reportedUsage,
  validateAgentResult,
} from '../src/result.ts';

const requested = engineSelection({
  adapter: 'fixture',
  adapterVersion: '1.0.0',
  provider: 'fixture-provider',
  modelFamily: 'fixture-family',
  model: 'fixture-requested',
  capabilities: ['read'],
});
const effective = engineSelection({
  ...requested,
  model: 'fixture-effective',
});

function result(input: Partial<AgentResult> = {}): AgentResult {
  return validateAgentResult({
    parts: [{ kind: 'assistant', text: 'answer', final: true }],
    usage: { kind: 'unknown' },
    requested,
    effective,
    ...input,
  });
}

function errorFor(scenario: EngineConformanceScenario): Error | undefined {
  switch (scenario) {
    case 'missing-cli':
      return new Error('grok command not found');
    case 'auth':
      return new Error('401 unauthorized');
    case 'billing':
      return new Error('402 payment required: exhausted credit balance');
    case 'model-unavailable':
      return new Error('unknown model fixture-requested');
    case 'rate-limit':
      return new Error('429 rate limit reached');
    case 'quota':
      return new Error('quota allowance reached');
    case 'transient':
      return new Error('503 service unavailable');
    case 'timeout':
      return new EngineError({
        kind: 'timeout',
        message: 'fixture timed out',
      });
    case 'invalid-config':
      return new Error('invalid configuration');
    default:
      return undefined;
  }
}

function scriptedEngine(scenario: EngineConformanceScenario): Engine {
  return {
    name: 'fixture',
    async run(
      _request: AgentRequest,
      onEvent: EngineEventSink,
      signal: AbortSignal,
    ): Promise<AgentResult> {
      const failure = errorFor(scenario);
      if (failure) throw failure;
      if (scenario === 'cancellation') {
        return await new Promise<AgentResult>((_resolve, reject) => {
          const abort = () => reject(new EngineError({
            kind: 'aborted',
            message: 'fixture aborted',
          }));
          signal.addEventListener('abort', abort, { once: true });
          onEvent({ type: 'thinking', delta: 'fixture-ready' });
          if (signal.aborted) abort();
        });
      }
      if (scenario === 'ordered-parts') {
        onEvent({ type: 'text', delta: 'draft' });
        onEvent({ type: 'text', delta: 'answer' });
        onEvent({ type: 'usage', usage: { kind: 'unknown' }, model: 'fixture-effective' });
        return result({
          parts: [
            { kind: 'assistant', text: 'draft', final: false },
            { kind: 'assistant', text: 'answer', final: true },
          ],
        });
      }
      if (scenario === 'structured-result') {
        onEvent({ type: 'usage', usage: { kind: 'unknown' }, model: 'fixture-effective' });
        return result({
          parts: [{ kind: 'structured', value: { answer: 42 }, final: true }],
        });
      }
      if (scenario === 'reported-usage') {
        const usage = reportedUsage({ inputTokens: 5, outputTokens: 3 });
        onEvent({ type: 'usage', usage, model: 'fixture-effective' });
        return result({ usage });
      }
      if (scenario === 'tool-events') {
        onEvent({ type: 'tool', name: 'read', phase: 'use' });
        onEvent({ type: 'tool', name: 'read', phase: 'result' });
        onEvent({ type: 'usage', usage: { kind: 'unknown' }, model: 'fixture-effective' });
        return result();
      }
      if (scenario === 'late-final') {
        onEvent({ type: 'usage', usage: { kind: 'unknown' }, model: 'fixture-effective' });
        return result({
          transportFailure: {
            kind: 'unknown',
            message: 'transport failed after final result',
            exitCode: 7,
          },
        });
      }
      onEvent({ type: 'usage', usage: { kind: 'unknown' }, model: 'fixture-effective' });
      return result();
    },
  };
}

function fixture(
  open: EngineConformanceFixture['open'] = async (scenario) =>
    scriptedEngine(scenario),
): EngineConformanceFixture {
  return {
    request: {
      prompt: 'Run the engine conformance case.',
      model: 'fixture-requested',
      tools: ['read'],
      cwd: '/tmp',
      leaf: true,
    },
    requested,
    effective,
    open,
  };
}

describe('public engine conformance kit', () => {
  it('passes a conforming engine across results, usage, tools, stops, and failures', async () => {
    const report = await runEngineConformance(fixture());

    expect(report).toEqual({ ok: true, cases: 16, failures: [] });
    await expect(assertEngineConformance(fixture())).resolves.toBeUndefined();
  });

  it('accepts a job-owned parser when an engine returns structured text', async () => {
    const report = await runEngineConformance({
      ...fixture(async (scenario) => {
        if (scenario !== 'structured-result') return scriptedEngine(scenario);
        return {
          name: 'text-structured-fixture',
          async run(_request, onEvent) {
            onEvent({ type: 'usage', usage: { kind: 'unknown' }, model: 'fixture-effective' });
            return result({
              parts: [{
                kind: 'assistant',
                text: 'OBVERSA_STRUCTURED_RESULT_V1\n{"answer":42}',
                final: true,
              }],
            });
          },
        };
      }),
      parseStructuredResult(part) {
        if (
          part.kind !== 'assistant'
          || !part.text.startsWith('OBVERSA_STRUCTURED_RESULT_V1\n')
        ) {
          throw new TypeError('missing structured result marker');
        }
        return JSON.parse(
          part.text.slice('OBVERSA_STRUCTURED_RESULT_V1\n'.length),
        ) as { answer: number };
      },
    });

    expect(report).toEqual({ ok: true, cases: 16, failures: [] });
  });

  it('reports a named failure from a deliberately dishonest usage adapter', async () => {
    const report = await runEngineConformance(fixture(async (scenario) => {
      if (scenario !== 'unknown-usage') return scriptedEngine(scenario);
      return {
        name: 'broken-fixture',
        async run(_request, onEvent) {
          const usage = reportedUsage({ inputTokens: 0, outputTokens: 0 });
          onEvent({ type: 'usage', usage, model: 'fixture-effective' });
          return assistantResult({
            text: 'answer',
            usage,
            requested,
            effective,
          });
        },
      };
    }));

    expect(report.ok).toBe(false);
    expect(report.failures).toEqual([
      expect.objectContaining({ case: 'unknown usage remains unknown' }),
    ]);
  });
});
