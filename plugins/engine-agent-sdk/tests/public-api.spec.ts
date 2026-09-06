import { describe, expect, it, vi } from 'vitest';

import {
  EngineError,
  EngineIncompleteResultError,
  engineSelection,
  type AgentRequest,
} from '@obversa/engine';
import type { Memory } from '@obversa/memory';
import {
  AgentSdkEngine,
  type AgentSdkEngineOptions,
} from '../src/index.ts';

const sdk = vi.hoisted(() => ({
  createSdkMcpServer: vi.fn((options: unknown) => options),
  tool: vi.fn((...args: unknown[]) => ({ args })),
  query: vi.fn(() =>
    (async function* () {
      yield {
        type: 'result',
        result: 'done',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })(),
  ),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => sdk);

describe('@obversa/engine-agent-sdk', () => {
  it('injects constructor memory into a provider-neutral request', async () => {
    const memory: Memory = {
      scope: 'test',
      async execute(command) {
        return {
          ok: false,
          command: command.command,
          error: { code: 'NOT_FOUND', message: 'missing' },
        };
      },
    };
    const options: AgentSdkEngineOptions = {
      defaultModel: 'claude-test',
      permissionMode: 'auto',
      memory,
    };
    const request = {
      prompt: 'test',
      model: 'claude-request-model',
    } satisfies AgentRequest;
    const requestHasMemory: 'memory' extends keyof AgentRequest ? true : false =
      false;

    const engine = new AgentSdkEngine(options);
    await engine.run(request, () => {}, new AbortController().signal);

    expect(engine.name).toBe('agent-sdk');
    expect(requestHasMemory).toBe(false);
    expect(sdk.tool).toHaveBeenCalledOnce();
    expect(sdk.createSdkMcpServer).toHaveBeenCalledOnce();
    expect(sdk.query).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          model: 'claude-request-model',
          mcpServers: expect.objectContaining({
            'obversa-memory': expect.anything(),
          }),
        }),
      }),
    );
  });

  it('keeps an observed model substitution on a model-unavailable error', async () => {
    sdk.query.mockImplementationOnce(() =>
      (async function* () {
        yield {
          type: 'assistant',
          message: {
            model: 'runtime-substitution',
            content: [],
          },
        };
        throw new Error('unknown model runtime-substitution');
      })() as never);

    await expect(new AgentSdkEngine().run(
      { prompt: 'test', model: 'declared-model' },
      () => {},
      new AbortController().signal,
    )).rejects.toMatchObject({
      kind: 'model-unavailable',
      effective: {
        adapter: 'agent-sdk',
        model: 'runtime-substitution',
      },
    });
  });

  it.each([
    ['ambiguous quota', new Error('quota allowance reached'), { kind: 'rate-limit' }],
    ['ambiguous usage', new Error('usage limit reached'), { kind: 'rate-limit' }],
    ['ambiguous session', new Error('session limit reached'), { kind: 'rate-limit' }],
    ['monthly usage', new Error('monthly usage limit reached'), { kind: 'quota' }],
    ['typed quota code', Object.assign(new Error('usage limit'), { code: 'QUOTA' }), { kind: 'quota' }],
    ['unrelated credit', new Error('credit report unavailable'), { kind: 'unknown' }],
    ['billing tag', Object.assign(new Error('provider limit'), { error: 'billing_error' }), { kind: 'quota' }],
    ['credits tag', Object.assign(new Error('provider limit'), {
      rate_limit_info: { errorCode: 'credits_required' },
    }), { kind: 'quota' }],
    ['rate tag and reset', Object.assign(new Error('provider limit'), {
      error: 'rate_limit', rate_limit_info: { resetsAt: 1_700_000_000_000 },
    }), { kind: 'rate-limit', resetAt: 1_700_000_000_000 }],
    ['overloaded and overage reset', Object.assign(new Error('provider limit'), {
      error: 'overloaded', rate_limit_info: { overageResetsAt: 1_700_000_001_000 },
    }), { kind: 'rate-limit', resetAt: 1_700_000_001_000 }],
  ] as const)('classifies scripted SDK %s', async (_label, error, expected) => {
    const before = sdk.query.mock.calls.length;
    sdk.query.mockImplementationOnce(() => (async function* () { throw error; })() as never);
    await expect(new AgentSdkEngine().run(
      { prompt: 'scripted limit check', model: 'declared-model' },
      () => {},
      new AbortController().signal,
    )).rejects.toMatchObject(expected);
    expect(sdk.query.mock.calls.length).toBe(before + 1);
  });

  it('preserves a typed quota object and all supplied hints', async () => {
    const effective = engineSelection({ adapter: 'agent-sdk', model: 'observed-model' });
    const error = new EngineError({
      kind: 'quota',
      message: 'usage limit',
      retryAfterMs: 7_000,
      resetAt: 1_700_000_000_000,
      effective,
    });
    sdk.query.mockImplementationOnce(() => (async function* () { throw error; })() as never);
    await expect(new AgentSdkEngine().run(
      { prompt: 'scripted typed check', model: 'declared-model' },
      () => {},
      new AbortController().signal,
    )).rejects.toBe(error);
  });

  it('keeps typed incomplete evidence instead of reclassifying its message', async () => {
    const selected = engineSelection({ adapter: 'agent-sdk', model: 'declared-model' });
    const error = new EngineIncompleteResultError('usage limit', {
      parts: [{ kind: 'assistant', text: 'partial answer', final: false }],
      usage: { kind: 'reported', inputTokens: 2, outputTokens: 1 },
      requested: selected,
      effective: engineSelection({ ...selected, model: 'observed-model' }),
      transportFailure: { kind: 'transient', message: 'transport stopped', exitCode: null },
    });
    sdk.query.mockImplementationOnce(() => (async function* () { throw error; })() as never);
    await expect(new AgentSdkEngine().run(
      { prompt: 'scripted evidence check', model: 'declared-model' },
      () => {},
      new AbortController().signal,
    )).rejects.toBe(error);
  });

  it('retains the typed model-unavailable branch that adds observed identity', async () => {
    sdk.query.mockImplementationOnce(() => (async function* () {
      yield { type: 'assistant', message: { model: 'observed-model', content: [] } };
      throw new EngineError({ kind: 'model-unavailable', message: 'usage limit' });
    })() as never);
    await expect(new AgentSdkEngine().run(
      { prompt: 'scripted identity check', model: 'declared-model' },
      () => {},
      new AbortController().signal,
    )).rejects.toMatchObject({
      kind: 'model-unavailable',
      effective: { adapter: 'agent-sdk', model: 'observed-model' },
    });
  });

  it('keeps a final result and its usage when later transport text is ambiguous', async () => {
    sdk.query.mockImplementationOnce(() => (async function* () {
      yield { type: 'assistant', message: { model: 'observed-model', content: [] } };
      yield { type: 'result', result: 'completed answer', usage: { input_tokens: 2, output_tokens: 1 } };
      throw new Error('quota allowance reached');
    })() as never);
    const result = await new AgentSdkEngine().run(
      { prompt: 'scripted late failure', model: 'declared-model' },
      () => {},
      new AbortController().signal,
    );
    expect(result.parts).toEqual([{ kind: 'assistant', text: 'completed answer', final: true }]);
    expect(result.usage).toEqual({ kind: 'reported', inputTokens: 2, outputTokens: 1 });
    expect(result.requested.model).toBe('declared-model');
    expect(result.effective.model).toBe('observed-model');
    expect(result.transportFailure).toMatchObject({ kind: 'rate-limit', exitCode: null });
  });
});
