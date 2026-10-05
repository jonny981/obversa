import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EngineError, type EngineStreamEvent } from '@obversa/api';
import { AgentSdkEngine } from '../src/index.ts';

const sdk = vi.hoisted(() => ({ stall: false, throwOnAbort: false }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: { abortController: AbortController } }) => (async function* () {
    if (sdk.stall) {
      // A turn that reports its tokens, then a call that never finishes.
      yield { type: 'assistant', message: { model: 'claude-test', content: [{ type: 'text', text: 'working' }], usage: { input_tokens: 7, output_tokens: 2 } } };
      await new Promise((resolve) => options.abortController.signal.addEventListener('abort', resolve));
      // The SDK throws when its call is cancelled.
      if (sdk.throwOnAbort) throw new Error('aborted by user');
      return;
    }
    yield { type: 'assistant', message: { model: 'claude-test', content: [{ type: 'text', text: 'answer' }] } };
    yield { type: 'result', result: 'answer', usage: { input_tokens: 5, output_tokens: 3 }, total_cost_usd: 0.004 };
  })(),
}));

beforeEach(() => {
  // The person's own shell may set any of these; the test decides them.
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) {
    vi.stubEnv(name, '');
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  sdk.stall = false;
  sdk.throwOnAbort = false;
});

async function runOnce(env?: Record<string, string>) {
  const events: EngineStreamEvent[] = [];
  const result = await new AgentSdkEngine().run(
    { prompt: 'ping', model: 'claude-test', leaf: true, ...(env ? { env } : {}) },
    (event) => events.push(event),
    new AbortController().signal,
  );
  return { result, usage: events.find((event) => event.type === 'usage') };
}

it('records the dollar figure the SDK reports, billed to the person\'s plan', async () => {
  const { result, usage } = await runOnce();
  expect(result).toMatchObject({ cost: { kind: 'reported', usd: 0.004 }, billing: 'subscription' });
  expect(usage).toMatchObject({ cost: { kind: 'reported', usd: 0.004 }, billing: 'subscription' });
});

it('records api billing when the SDK process gets an API key', async () => {
  const { result } = await runOnce({ ANTHROPIC_API_KEY: 'test-key' });
  expect(result.billing).toBe('api');
});

it('records the tokens and billing of a call that timed out after reporting tokens', async () => {
  sdk.stall = true;
  const events: EngineStreamEvent[] = [];
  const failure = await new AgentSdkEngine().run(
    { prompt: 'ping', model: 'claude-test', leaf: true, timeoutMs: 200 },
    (event) => events.push(event),
    new AbortController().signal,
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(EngineError);
  expect((failure as EngineError).kind).toBe('timeout');
  expect(events.filter((event) => event.type === 'usage')).toEqual([
    { type: 'usage', usage: { kind: 'reported', inputTokens: 7, outputTokens: 2 }, model: 'claude-test', billing: 'subscription' },
  ]);
});

it('records the tokens and billing of a call cancelled after reporting tokens', async () => {
  sdk.stall = true;
  sdk.throwOnAbort = true;
  const events: EngineStreamEvent[] = [];
  const cancel = new AbortController();
  const failure = new AgentSdkEngine().run(
    { prompt: 'ping', model: 'claude-test', leaf: true },
    (event) => {
      events.push(event);
      // Cancel once the turn has reported its tokens and the call waits.
      if (event.type === 'text') setTimeout(() => cancel.abort(), 0);
    },
    cancel.signal,
  ).catch((error: unknown) => error);
  const error = await failure;
  expect(error).toBeInstanceOf(EngineError);
  expect((error as EngineError).kind).toBe('aborted');
  expect(events.filter((event) => event.type === 'usage')).toEqual([
    { type: 'usage', usage: { kind: 'reported', inputTokens: 7, outputTokens: 2 }, model: 'claude-test', billing: 'subscription' },
  ]);
});
