import { describe, expect, it } from 'vitest';
import { Agent } from '@mastra/core/agent';
import { EngineError, classifyEngineFailure, type AgentRequest, type EngineStreamEvent } from '@obversa/api';
import { mastra, type MastraAgent } from '../src/index.ts';

type GenerateOptions = Parameters<MastraAgent['generate']>[1];
type Output = Awaited<ReturnType<MastraAgent['generate']>>;

/** A stand-in agent: the model it is built with, and a scripted generate. */
function standIn(
  reply: (prompt: string, options: GenerateOptions) => Promise<Partial<Output>>,
  model: MastraAgent['model'] = 'openai/gpt-5',
): MastraAgent & { calls: Array<{ prompt: string; options: GenerateOptions }> } {
  const calls: Array<{ prompt: string; options: GenerateOptions }> = [];
  return {
    model,
    calls,
    async generate(prompt, options) {
      calls.push({ prompt, options });
      const partial = await reply(prompt, options);
      return {
        text: '',
        totalUsage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
        finishReason: 'stop',
        error: undefined,
        ...partial,
      };
    },
  };
}

const request: AgentRequest = { prompt: 'Write the page.' };

async function run(agent: MastraAgent, req: AgentRequest = request, signal = new AbortController().signal) {
  const events: EngineStreamEvent[] = [];
  const result = await mastra(agent).engine.run(req, (event) => events.push(event), signal);
  return { result, events };
}

async function failure(promise: Promise<unknown>): Promise<EngineError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(EngineError);
  return error as EngineError;
}

describe('mastra seat identity', () => {
  it('reads a provider/model string', () => {
    expect(mastra(standIn(async () => ({}), 'anthropic/claude-sonnet-4-5')).identity).toEqual({
      adapter: 'mastra',
      provider: 'anthropic',
      modelFamily: 'claude',
      model: 'claude-sonnet-4-5',
      tools: [],
    });
  });

  it('reads a router string whose model names its own provider', () => {
    const { identity } = mastra(standIn(async () => ({}), 'openrouter/anthropic/claude-sonnet-4-5'));
    expect(identity).toMatchObject({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4-5', modelFamily: 'claude' });
  });

  it('reads a language model object', () => {
    const model = { specificationVersion: 'v2', provider: 'openai.responses', modelId: 'gpt-5', supportedUrls: {} } as unknown as MastraAgent['model'];
    expect(mastra(standIn(async () => ({}), model)).identity).toMatchObject({ provider: 'openai.responses', model: 'gpt-5', modelFamily: 'gpt' });
  });

  it('reads the first enabled entry of a fallback list', () => {
    const model = [
      { model: 'openai/gpt-5', enabled: false },
      { model: 'anthropic/claude-haiku-4-5' },
    ] as MastraAgent['model'];
    expect(mastra(standIn(async () => ({}), model)).identity).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-4-5' });
  });

  it('reads an OpenAI-compatible config', () => {
    expect(mastra(standIn(async () => ({}), { id: 'groq/llama-3.3-70b' })).identity).toMatchObject({ provider: 'groq', model: 'llama-3.3-70b', modelFamily: 'llama' });
    expect(mastra(standIn(async () => ({}), { providerId: 'local', modelId: 'qwen-3' })).identity).toMatchObject({ provider: 'local', model: 'qwen-3', modelFamily: 'qwen' });
  });

  it('needs the model named when the agent chooses it at run time', () => {
    const dynamic = standIn(async () => ({}), () => 'openai/gpt-5');
    expect(() => mastra(dynamic)).toThrow(/pass \{ model: "provider\/model" \}/);
    expect(mastra(dynamic, { model: 'openai/gpt-5' }).identity).toMatchObject({ provider: 'openai', model: 'gpt-5', modelFamily: 'gpt' });
  });

  it('refuses a named model that is not provider/model', () => {
    expect(() => mastra(standIn(async () => ({})), { model: 'gpt-5' })).toThrow('mastra(): model "gpt-5" must be "provider/model"');
  });

  it('records the configured identity on every result', async () => {
    const { result } = await run(standIn(async () => ({ text: 'done' }), 'anthropic/claude-sonnet-4-5'));
    const selection = {
      adapter: 'mastra',
      adapterVersion: null,
      provider: 'anthropic',
      modelFamily: 'claude',
      model: 'claude-sonnet-4-5',
      executable: null,
      capabilities: [],
    };
    expect(result.requested).toEqual(selection);
    expect(result.effective).toEqual(selection);
  });
});

describe('mastra engine run', () => {
  it('sends the prompt and returns the final text as the assistant part', async () => {
    const agent = standIn(async () => ({ text: 'the page', finishReason: 'stop' }));
    const { result } = await run(agent);
    expect(agent.calls.map((call) => call.prompt)).toEqual(['Write the page.']);
    expect(result.parts).toEqual([{ kind: 'assistant', text: 'the page', final: true }]);
    expect(result.stopReason).toBe('stop');
  });

  it('appends system text, or replaces the instructions when asked', async () => {
    const agent = standIn(async () => ({ text: 'ok' }));
    await run(agent, { ...request, system: 'Be brief.' });
    await run(agent, { ...request, system: 'Only this.', systemMode: 'replace' });
    await run(agent);
    expect(agent.calls.map(({ options }) => ({ system: options.system, instructions: options.instructions }))).toEqual([
      { system: 'Be brief.', instructions: undefined },
      { system: undefined, instructions: 'Only this.' },
      { system: undefined, instructions: undefined },
    ]);
  });

  it('passes no tools, workspace or model to the agent', async () => {
    const agent = standIn(async () => ({ text: 'ok' }));
    await run(agent, { ...request, model: 'other', tools: ['Read'], allowedTools: ['Read'], workspaceMode: 'read', cwd: '/tmp' });
    expect(Object.keys(agent.calls[0]!.options)).toEqual(['abortSignal']);
  });

  it('refuses effort on the seat and on a step, naming why', async () => {
    const why = 'mastra cannot take effort: the Mastra agent you pass decides how its model runs; set it on the agent';
    const agent = standIn(async () => ({ text: 'ok' }));
    expect(() => mastra(agent, { effort: 'high' })).toThrow(why);
    const error = await failure(run(agent, { ...request, effort: 'high' }));
    expect(error).toMatchObject({ kind: 'invalid-config', message: why });
    expect(agent.calls).toEqual([]);
  });

  it('reports the usage Mastra reports', async () => {
    const { result, events } = await run(standIn(async () => ({
      text: 'ok',
      totalUsage: { inputTokens: 30, outputTokens: 7, totalTokens: 37, cachedInputTokens: 10 },
    })));
    const usage = { kind: 'reported', inputTokens: 30, outputTokens: 7, cacheReadInputTokens: 10 };
    expect(result.usage).toEqual(usage);
    expect(result.billing).toBe('api');
    expect(events).toEqual([{ type: 'usage', usage, model: 'gpt-5', billing: 'api' }]);
  });

  it('reports unknown usage when Mastra reports none', async () => {
    const { result, events } = await run(standIn(async () => ({ text: 'ok' })));
    expect(result.usage).toEqual({ kind: 'unknown' });
    expect(events).toEqual([{ type: 'usage', usage: { kind: 'unknown' }, model: 'gpt-5', billing: 'api' }]);
  });

  it('aborts the agent call when the request signal aborts', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    // Mastra resolves an aborted call with empty text rather than throwing.
    const agent = standIn(async (_prompt, options) => {
      seen = options.abortSignal;
      setTimeout(() => controller.abort(), 0);
      await new Promise((resolve) => options.abortSignal.addEventListener('abort', resolve, { once: true }));
      return { text: '', finishReason: 'aborted' };
    });
    const error = await failure(run(agent, request, controller.signal));
    expect(error.kind).toBe('aborted');
    expect(seen?.aborted).toBe(true);
  });

  it('never calls the agent when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const agent = standIn(async () => ({ text: 'ok' }));
    expect((await failure(run(agent, request, controller.signal))).kind).toBe('aborted');
    expect(agent.calls).toHaveLength(0);
  });

  it('stops the agent at the request timeout', async () => {
    const agent = standIn(async (_prompt, options) => {
      await new Promise((resolve) => options.abortSignal.addEventListener('abort', resolve, { once: true }));
      return { finishReason: 'aborted' };
    });
    expect((await failure(run(agent, { ...request, timeoutMs: 10 }))).kind).toBe('timeout');
  });

  it('maps a thrown 429 to a rate limit with the provider reset', async () => {
    const thrown = Object.assign(new Error('the provider refused the request'), {
      statusCode: 429,
      responseHeaders: { 'retry-after': '30' },
    });
    const error = await failure(run(standIn(async () => { throw thrown; })));
    expect(error.kind).toBe('rate-limit');
    expect(error.retryAfterMs).toBe(30_000);
    expect(error.cause).toBe(thrown);
  });

  it('counts a failed call under the agent\'s model and API billing', async () => {
    const thrown = Object.assign(new Error('the provider refused the request'), { statusCode: 429 });
    const events: EngineStreamEvent[] = [];
    const agent = standIn(async () => { throw thrown; }, 'anthropic/claude-sonnet-4-5');
    const error = await failure(mastra(agent).engine.run(request, (event) => events.push(event), new AbortController().signal));
    expect(error.kind).toBe('rate-limit');
    expect(events).toEqual([
      { type: 'usage', usage: { kind: 'unknown' }, model: 'claude-sonnet-4-5', billing: 'api' },
    ]);
  });

  it('maps quota and other provider errors through the shared classification', async () => {
    const quota = await failure(run(standIn(async () => { throw new Error('monthly usage limit reached'); })));
    expect(quota.kind).toBe('quota');
    const auth = await failure(run(standIn(async () => { throw Object.assign(new Error('401 unauthorized'), { statusCode: 401 }); })));
    expect(auth.kind).toBe('auth');
    const unknown = await failure(run(standIn(async () => { throw new Error('the tool crashed'); })));
    expect(unknown.kind).toBe('unknown');
    expect(unknown.message).toBe('mastra agent failed: the tool crashed');
  });

  it('fails when Mastra resolves with an error', async () => {
    const error = await failure(run(standIn(async () => ({ text: '', error: new Error('503 service unavailable') }))));
    expect(error.kind).toBe('transient');
  });

  it('counts the tokens of a call that resolves with an error', async () => {
    const events: EngineStreamEvent[] = [];
    const agent = standIn(async () => ({
      text: '',
      totalUsage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
      error: new Error('503 service unavailable'),
    }));
    await failure(mastra(agent).engine.run(request, (event) => events.push(event), new AbortController().signal));
    expect(events).toEqual([
      { type: 'usage', usage: { kind: 'reported', inputTokens: 1000, outputTokens: 200 }, model: 'gpt-5', billing: 'api' },
    ]);
  });

  it('refuses a read workspace with no declared tool, as the contract requires', async () => {
    const agent = standIn(async () => ({ text: 'ok' }));
    const error = await failure(run(agent, { ...request, workspaceMode: 'read', tools: [] }));
    expect(classifyEngineFailure(error)).toBe('invalid-config');
    expect(agent.calls).toHaveLength(0);
  });
});

describe('a real Mastra agent', () => {
  it('runs through the engine with its own model, instructions and usage', async () => {
    const prompts: unknown[] = [];
    const model = {
      specificationVersion: 'v2',
      provider: 'scripted',
      modelId: 'scripted-writer',
      supportedUrls: {},
      async doGenerate(options: { prompt: unknown }) {
        prompts.push(options.prompt);
        return {
          content: [{ type: 'text', text: 'from the agent' }],
          finishReason: 'stop',
          usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
          warnings: [],
        };
      },
      async doStream(): Promise<never> {
        throw new Error('the engine calls generate');
      },
    };
    const agent = new Agent({ id: 'writer', name: 'Writer', instructions: 'You write pages.', model: model as never });
    const seat = mastra(agent);
    expect(seat.identity).toMatchObject({ provider: 'scripted', model: 'scripted-writer', modelFamily: 'scripted' });
    const result = await seat.engine.run({ prompt: 'Write it.', system: 'Be brief.' }, () => {}, new AbortController().signal);
    expect(result.parts).toEqual([{ kind: 'assistant', text: 'from the agent', final: true }]);
    expect(result.usage).toEqual({ kind: 'reported', inputTokens: 5, outputTokens: 3 });
    expect(JSON.stringify(prompts[0])).toContain('You write pages.');
    expect(JSON.stringify(prompts[0])).toContain('Be brief.');
  });
});
