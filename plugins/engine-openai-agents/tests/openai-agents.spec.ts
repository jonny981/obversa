import { describe, expect, it } from 'vitest';
import {
  Agent,
  MemorySession,
  RunContext,
  RunToolApprovalItem,
  Runner,
  Usage,
  getDefaultModel,
  run as sdkRun,
  setTracingDisabled,
  type AgentInputItem,
  type Model,
  type ModelRequest,
  type NonStreamRunOptions,
  type UsageInput,
} from '@openai/agents';
import { EngineError, classifyEngineFailure, type AgentRequest, type EngineStreamEvent } from '@obversa/api';
import { openaiAgent, type OpenAIAgentsRunner } from '../src/index.ts';

type RunArgs = Parameters<OpenAIAgentsRunner['run']>;
type Output = Awaited<ReturnType<OpenAIAgentsRunner['run']>>;

/** A run result with the final output, the approvals it waits for and the usage the SDK reports. */
function result(finalOutput: unknown, usage?: UsageInput, interruptions: Output['interruptions'] = []): Output {
  const runContext = new RunContext();
  runContext.usage = new Usage(usage);
  return { finalOutput, interruptions, runContext };
}

/** A stand-in runner: it records each call and answers from a script. */
function standIn(
  reply: (...args: RunArgs) => Promise<Output>,
): OpenAIAgentsRunner & { calls: Array<{ agent: RunArgs[0]; input: RunArgs[1]; options: RunArgs[2] }> } {
  const calls: Array<{ agent: RunArgs[0]; input: RunArgs[1]; options: RunArgs[2] }> = [];
  return {
    calls,
    async run(agent, input, options) {
      calls.push({ agent, input, options });
      return reply(agent, input, options);
    },
  };
}

const agent = new Agent({ name: 'Writer', instructions: 'You write pages.', model: 'gpt-5' });
const request: AgentRequest = { prompt: 'Write the page.' };

async function run(runner: OpenAIAgentsRunner, req: AgentRequest = request, signal = new AbortController().signal) {
  const events: EngineStreamEvent[] = [];
  const outcome = await openaiAgent(agent, { runner }).engine.run(req, (event) => events.push(event), signal);
  return { result: outcome, events };
}

async function failure(promise: Promise<unknown>): Promise<EngineError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(EngineError);
  return error as EngineError;
}

/** An error shaped like the ones the OpenAI client throws for an HTTP status. */
function apiError(status: number, message: string, extra: { code?: string; headers?: Record<string, string> } = {}) {
  return Object.assign(new Error(`${status} ${message}`), {
    status,
    code: extra.code,
    headers: new Headers(extra.headers),
  });
}

describe('openai agent seat identity', () => {
  it('reads the model name the agent is built with, from the OpenAI provider', () => {
    expect(openaiAgent(agent).identity).toEqual({
      adapter: 'openai-agents',
      provider: 'openai',
      modelFamily: 'gpt',
      model: 'gpt-5',
      tools: [],
    });
  });

  it('reads the SDK default model when the agent names none', () => {
    const { identity } = openaiAgent(new Agent({ name: 'Default' }));
    expect(identity).toMatchObject({ provider: 'openai', model: getDefaultModel() });
  });

  it('needs the model named when the agent holds a model object', () => {
    const model: Model = {
      async getResponse(): Promise<never> { throw new Error('not called'); },
      getStreamedResponse(): never { throw new Error('not called'); },
    };
    const built = new Agent({ name: 'Object', model });
    expect(() => openaiAgent(built)).toThrow(/pass \{ model: "provider\/model" \}/);
    expect(openaiAgent(built, { model: 'anthropic/claude-sonnet-4-5' }).identity)
      .toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4-5', modelFamily: 'claude' });
  });

  it('refuses a named model that is not provider/model', () => {
    expect(() => openaiAgent(agent, { model: 'gpt-5' })).toThrow('openaiAgent(): model "gpt-5" must be "provider/model"');
  });

  it('takes the SDK Runner as its runner', () => {
    expect(openaiAgent(agent, { runner: new Runner() }).identity.model).toBe('gpt-5');
  });

  it('records the configured identity on every result', async () => {
    const { result: outcome } = await run(standIn(async () => result('done')));
    const selection = {
      adapter: 'openai-agents',
      adapterVersion: null,
      provider: 'openai',
      modelFamily: 'gpt',
      model: 'gpt-5',
      executable: null,
      capabilities: [],
    };
    expect(outcome.requested).toEqual(selection);
    expect(outcome.effective).toEqual(selection);
  });
});

describe('openai agent engine run', () => {
  it('hands the prompt and the agent to the runner and returns the final output as text', async () => {
    const runner = standIn(async () => result('the page'));
    const { result: outcome } = await run(runner);
    expect(runner.calls.map((call) => [call.agent, call.input])).toEqual([[agent, 'Write the page.']]);
    expect(outcome.parts).toEqual([{ kind: 'assistant', text: 'the page', final: true }]);
  });

  it('returns structured final output as JSON text', async () => {
    const { result: outcome } = await run(standIn(async () => result({ answer: 42 })));
    expect(outcome.parts).toEqual([{ kind: 'assistant', text: '{"answer":42}', final: true }]);
  });

  it('appends system text as a system message, or replaces the instructions when asked', async () => {
    const runner = standIn(async () => result('ok'));
    await run(runner, { ...request, system: 'Be brief.' });
    await run(runner, { ...request, system: 'Only this.', systemMode: 'replace' });
    expect(runner.calls[0]!.agent).toBe(agent);
    expect(runner.calls[0]!.input).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Write the page.' },
    ]);
    const copy = runner.calls[1]!.agent;
    expect(copy).not.toBe(agent);
    expect(copy.instructions).toBe('Only this.');
    expect(copy.model).toBe('gpt-5');
    expect(agent.instructions).toBe('You write pages.');
    expect(runner.calls[1]!.input).toBe('Write the page.');
  });

  it('passes no tools, workspace or model to the runner', async () => {
    const runner = standIn(async () => result('ok'));
    await run(runner, { ...request, model: 'other', tools: ['Read'], allowedTools: ['Read'], workspaceMode: 'read', cwd: '/tmp' });
    expect(runner.calls[0]!.agent).toBe(agent);
    expect(Object.keys(runner.calls[0]!.options)).toEqual(['signal']);
  });

  it('lets a runner add a session to the options the engine gives', async () => {
    const session = new MemorySession();
    // The shape of the SDK's own run, so the session option is checked against its types.
    const seen: NonStreamRunOptions[] = [];
    const sdkShaped = async (_agent: Agent<any, any>, _input: string | AgentInputItem[], options: NonStreamRunOptions) => {
      seen.push(options);
      return result('ok');
    };
    const { result: outcome } = await run({ run: (a, input, options) => sdkShaped(a, input, { ...options, session }) });
    expect(outcome.parts).toEqual([{ kind: 'assistant', text: 'ok', final: true }]);
    expect(Object.keys(seen[0]!)).toEqual(['signal', 'session']);
    expect(seen[0]!.session).toBe(session);
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);

    // The runner the docs show, over the SDK's own run, fits the option's type.
    const withSession: OpenAIAgentsRunner = { run: (a, input, options) => sdkRun(a, input, { ...options, session }) };
    expect(typeof withSession.run).toBe('function');
  });

  it('reports the usage the SDK reports, with cached input tokens', async () => {
    const { result: outcome, events } = await run(standIn(async () => result('ok', {
      requests: 2,
      inputTokens: 30,
      outputTokens: 7,
      totalTokens: 37,
      inputTokensDetails: [{ cached_tokens: 6 }, { cached_tokens: 4 }],
    })));
    const usage = { kind: 'reported', inputTokens: 30, outputTokens: 7, cacheReadInputTokens: 10 };
    expect(outcome.usage).toEqual(usage);
    expect(events).toEqual([{ type: 'usage', usage, model: 'gpt-5' }]);
  });

  it('reports unknown usage when the SDK counted no request', async () => {
    const { result: outcome, events } = await run(standIn(async () => result('ok')));
    expect(outcome.usage).toEqual({ kind: 'unknown' });
    expect(events).toEqual([{ type: 'usage', usage: { kind: 'unknown' }, model: 'gpt-5' }]);
  });

  it('aborts the run when the request signal aborts', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const runner = standIn(async (_agent, _input, options) => {
      seen = options.signal;
      setTimeout(() => controller.abort(), 0);
      await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
      throw new DOMException('This operation was aborted', 'AbortError');
    });
    const error = await failure(run(runner, request, controller.signal));
    expect(error.kind).toBe('aborted');
    expect(seen?.aborted).toBe(true);
  });

  it('never calls the runner when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = standIn(async () => result('ok'));
    expect((await failure(run(runner, request, controller.signal))).kind).toBe('aborted');
    expect(runner.calls).toHaveLength(0);
  });

  it('stops the run at the request timeout', async () => {
    const runner = standIn(async (_agent, _input, options) => {
      await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
      throw new DOMException('This operation was aborted', 'AbortError');
    });
    expect((await failure(run(runner, { ...request, timeoutMs: 10 }))).kind).toBe('timeout');
  });

  it('maps a 429 to a rate limit with the provider reset', async () => {
    const thrown = apiError(429, 'Rate limit reached', { headers: { 'retry-after': '30' } });
    const error = await failure(run(standIn(async () => { throw thrown; })));
    expect(error.kind).toBe('rate-limit');
    expect(error.retryAfterMs).toBe(30_000);
    expect(error.cause).toBe(thrown);
  });

  it('maps a 429 with the insufficient_quota code to a quota', async () => {
    const thrown = apiError(429, 'You exceeded your current quota, please check your plan and billing details.', { code: 'insufficient_quota' });
    const error = await failure(run(standIn(async () => { throw thrown; })));
    expect(error.kind).toBe('quota');
    expect(error.retryAfterMs).toBeUndefined();
  });

  it('maps other provider and SDK errors through the shared classification', async () => {
    const auth = await failure(run(standIn(async () => { throw apiError(401, 'Incorrect API key provided'); })));
    expect(auth.kind).toBe('auth');
    const quota = await failure(run(standIn(async () => { throw new Error('monthly usage limit reached'); })));
    expect(quota.kind).toBe('quota');
    const unknown = await failure(run(standIn(async () => { throw new Error('the tool crashed'); })));
    expect(unknown.kind).toBe('unknown');
    expect(unknown.message).toBe('openai agent failed: the tool crashed');
  });

  it('fails when the run stops to wait for a tool approval', async () => {
    const approval = new RunToolApprovalItem({ type: 'function_call', callId: 'call-1', name: 'deploy', arguments: '{}' }, agent);
    const error = await failure(run(standIn(async () => result(undefined, undefined, [approval]))));
    expect(error.kind).toBe('invalid-config');
    expect(error.message).toMatch(/tool approval/);
  });

  it('fails when the run ends with no final output', async () => {
    expect((await failure(run(standIn(async () => result(undefined))))).kind).toBe('unknown');
  });

  it('refuses a read workspace with no declared tool, as the contract requires', async () => {
    const runner = standIn(async () => result('ok'));
    const error = await failure(run(runner, { ...request, workspaceMode: 'read', tools: [] }));
    expect(classifyEngineFailure(error)).toBe('invalid-config');
    expect(runner.calls).toHaveLength(0);
  });
});

describe('a real OpenAI Agents SDK agent', () => {
  it('runs through the SDK runner with its own model, instructions and usage', async () => {
    setTracingDisabled(true);
    const requests: ModelRequest[] = [];
    const model: Model = {
      async getResponse(modelRequest) {
        requests.push(modelRequest);
        return {
          usage: new Usage({ requests: 1, inputTokens: 5, outputTokens: 3, totalTokens: 8 }),
          output: [{
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'from the agent' }],
          }],
        };
      },
      getStreamedResponse(): never {
        throw new Error('the engine runs without streaming');
      },
    };
    const built = new Agent({ name: 'Writer', instructions: 'You write pages.', model });
    const seat = openaiAgent(built, { model: 'scripted/scripted-writer' });
    expect(seat.identity).toMatchObject({ provider: 'scripted', model: 'scripted-writer', modelFamily: 'scripted' });
    const outcome = await seat.engine.run({ prompt: 'Write it.', system: 'Be brief.' }, () => {}, new AbortController().signal);
    expect(outcome.parts).toEqual([{ kind: 'assistant', text: 'from the agent', final: true }]);
    expect(outcome.usage).toEqual({ kind: 'reported', inputTokens: 5, outputTokens: 3 });
    expect(requests[0]!.systemInstructions).toBe('You write pages.');
    expect(requests[0]!.input).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Write it.' },
    ]);
    expect(requests[0]!.signal?.aborted).toBe(false);
  });
});
