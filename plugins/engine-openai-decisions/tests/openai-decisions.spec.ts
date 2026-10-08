/**
 * OpenAI Decisions adapter behaviour against a local HTTP stub or an injected
 * fetch. No live API is ever contacted. The response bodies below are
 * synthetic fixtures shaped like the examples in OpenAI's Decisions guide
 * (https://developers.openai.com/api/docs/guides/decisions). A live call
 * through scripts/probe.mjs returned the same shapes: answers carrying
 * `type`, `name` and the typed fields, a top-level `model`, and `usage` with
 * `input_tokens`, `output_tokens` (0), their details and `total_tokens`.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EngineError,
  engineSelection,
  type AgentRequest,
  type EngineStreamEvent,
  type JsonObject,
} from '@obversa/api';
import {
  runEngineConformance,
  type EngineConformanceFixture,
} from '@obversa/api/testing';

import {
  OpenAIDecisionsEngine,
  answersByName,
  openaiDecisions,
  parseDecisionDocument,
  wireQuestion,
} from '../src/openai-decisions.js';

const API_KEY = 'test-key-not-a-credential';
const QUESTIONS = {
  holds: {
    type: 'noul',
    instructions: 'Does the draft hold as it stands?',
    criteria: { true: 'Only nits remain', false: 'A block remains' },
  },
  stop_reason: {
    type: 'choice',
    instructions: 'Why stop, if at all?',
    criteria: { holds: 'It holds', continue: 'Another round is worth it' },
  },
  readiness: {
    type: 'score',
    instructions: 'How ready is this to ship?',
    criteria: ['Unsafe to ship', 'Needs another round', 'Ships clean'],
  },
} as const;

const ANSWERS = [
  { type: 'predicate', name: 'holds', probability: 0.82 },
  {
    type: 'choice', name: 'stop_reason', choice: 'holds', confidence: 0.9,
    probabilities: [{ value: 'holds', probability: 0.91 }, { value: 'continue', probability: 0.09 }],
  },
  {
    type: 'score', name: 'readiness', score: 1.6, confidence: 0.55,
    probabilities: [
      { value: 0, label: 'Unsafe to ship', probability: 0.05 },
      { value: 1, label: 'Needs another round', probability: 0.3 },
      { value: 2, label: 'Ships clean', probability: 0.65 },
    ],
  },
];

function prompt(questions: unknown = QUESTIONS, state: unknown = { verdict: 'accept' }): string {
  return JSON.stringify({ state, questions });
}

function request(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return { prompt: prompt(), model: 'gpt-6-luna', workspaceMode: 'none', ...overrides };
}

const ok = (answers: unknown = ANSWERS, extra: JsonObject = {}) => ({
  model: 'gpt-6-luna',
  usage: { input_tokens: 120 },
  answers,
  ...extra,
});

interface FetchCall { readonly url: string; readonly init: RequestInit }

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: FetchCall[] = [];
  const call = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }) as typeof fetch;
  return { call, calls };
}

async function runWith(
  status: number,
  body: unknown,
  overrides: Partial<AgentRequest> = {},
  headers: Record<string, string> = {},
) {
  const fake = fakeFetch(status, body, headers);
  const engine = new OpenAIDecisionsEngine({ apiKey: API_KEY, fetch: fake.call });
  const events: EngineStreamEvent[] = [];
  const outcome = await engine
    .run(request(overrides), (event) => { events.push(event); }, new AbortController().signal)
    .then((result) => ({ result, error: undefined }), (error: unknown) => ({ result: undefined, error }));
  return { ...outcome, events, calls: fake.calls };
}

describe('the prompt document', () => {
  it('reads the Jev-shaped {state, questions} document and defaults a missing state', () => {
    expect(parseDecisionDocument(JSON.stringify({ questions: QUESTIONS }))).toEqual({ state: {}, questions: QUESTIONS });
  });

  it.each([
    ['not json', 'not JSON'],
    [JSON.stringify([1, 2]), 'an array'],
    [JSON.stringify({ state: {}, questions: {} }), 'no questions'],
    [JSON.stringify({ questions: { a: 'x' } }), 'a question that is not an object'],
    [JSON.stringify({ questions: { a: { type: 'predicate' } } }), 'a wire type name instead of a Jev one'],
  ])('refuses %j (%s) as invalid-config before any call', (text, _label) => {
    expect(() => parseDecisionDocument(text)).toThrowError(EngineError);
    try { parseDecisionDocument(text); } catch (error) { expect((error as EngineError).kind).toBe('invalid-config'); }
  });
});

describe('translating a question to the wire', () => {
  it('sends a noul as a predicate whose instructions carry the true and false criteria', () => {
    expect(wireQuestion('holds', QUESTIONS.holds)).toEqual({
      type: 'predicate',
      name: 'holds',
      instructions: 'Does the draft hold as it stands?\nTrue when: Only nits remain\nFalse when: A block remains',
    });
  });

  it('sends a choice with each criterion as a value and its description', () => {
    expect(wireQuestion('stop_reason', QUESTIONS.stop_reason)).toEqual({
      type: 'choice',
      name: 'stop_reason',
      instructions: 'Why stop, if at all?',
      choices: [
        { value: 'holds', description: 'It holds' },
        { value: 'continue', description: 'Another round is worth it' },
      ],
    });
  });

  it('sends a score with its labels as ordered levels, from plain labels or label objects', () => {
    expect(wireQuestion('readiness', QUESTIONS.readiness).levels).toEqual([
      { label: 'Unsafe to ship', description: 'Unsafe to ship' },
      { label: 'Needs another round', description: 'Needs another round' },
      { label: 'Ships clean', description: 'Ships clean' },
    ]);
    expect(wireQuestion('severity', {
      type: 'score',
      instructions: 'How severe?',
      criteria: [{ label: 'Cosmetic', description: 'Appearance only' }, 'Blocked'],
    }).levels).toEqual([
      { label: 'Cosmetic', description: 'Appearance only' },
      { label: 'Blocked', description: 'Blocked' },
    ]);
  });

  it.each([
    [{ type: 'noul', criteria: { true: 'x' } }, 'no instructions'],
    [{ type: 'choice', instructions: 'Which?', criteria: { only: 'one' } }, 'a single choice'],
    [{ type: 'choice', instructions: 'Which?', criteria: { a: 'x', b: '' } }, 'a choice with no description'],
    [{ type: 'score', instructions: 'How?', criteria: ['one'] }, 'a single level'],
    [{ type: 'score', instructions: 'How?', criteria: ['one', 2] }, 'a level that is not a label'],
  ])('refuses %j (%s)', (question, _label) => {
    expect(() => wireQuestion('q', question as JsonObject)).toThrowError(/openai-decisions question/);
  });
});

describe('the call', () => {
  it('posts the model, the state as indented JSON and the questions to the default endpoint', async () => {
    const { result, calls } = await runWith(200, ok());
    expect(result).toBeDefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/decisions');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.model).toBe('gpt-6-luna');
    expect(body.input).toBe(JSON.stringify({ verdict: 'accept' }, null, 2));
    expect(body.questions.map((question: { name: string; type: string }) => [question.name, question.type]))
      .toEqual([['holds', 'predicate'], ['stop_reason', 'choice'], ['readiness', 'score']]);
  });

  it('sends a string state as the evidence itself', async () => {
    const { calls } = await runWith(200, ok(), { prompt: prompt(QUESTIONS, 'The export fails in Safari.') });
    expect(JSON.parse(String(calls[0]!.init.body)).input).toBe('The export fails in Safari.');
  });

  it('uses a configured endpoint', async () => {
    const fake = fakeFetch(200, ok());
    const engine = new OpenAIDecisionsEngine({ apiKey: API_KEY, endpoint: 'https://eu.example.test/v1/decisions', fetch: fake.call });
    await engine.run(request(), () => {}, new AbortController().signal);
    expect(fake.calls[0]!.url).toBe('https://eu.example.test/v1/decisions');
  });

  it('returns the answers keyed by name, with a predicate probability also given as noul', async () => {
    const { result } = await runWith(200, ok());
    const final = result!.parts.find((part) => part.final);
    expect(final).toMatchObject({ kind: 'structured' });
    const value = (final as { value: Record<string, JsonObject> }).value;
    expect(value.holds).toEqual({ type: 'predicate', probability: 0.82, noul: 0.82 });
    expect(value.stop_reason).toMatchObject({ type: 'choice', choice: 'holds', confidence: 0.9 });
    expect(value.readiness).toMatchObject({ type: 'score', score: 1.6, confidence: 0.55 });
  });

  it('keeps a refusal as an answer of type refusal', () => {
    const answers = answersByName([
      { type: 'refusal', name: 'holds' },
      ANSWERS[1], ANSWERS[2],
    ], ['holds', 'stop_reason', 'readiness']);
    expect(answers.holds).toEqual({ type: 'refusal' });
  });

  it.each([
    [{ answers: { holds: 1 } }, 'answers that are not an array'],
    [ok([ANSWERS[0], ANSWERS[1]]), 'a question left unanswered'],
    [ok([...ANSWERS, { type: 'predicate', name: 'extra', probability: 0.5 }]), 'an answer to a question nobody asked'],
    [ok([{ type: 'predicate', probability: 0.5 }]), 'an answer with no name'],
    ['not json', 'a body that is not JSON'],
  ])('fails as unknown on %j (%s), and still counts the call once', async (body, _label) => {
    const { error, events } = await runWith(200, body);
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).kind).toBe('unknown');
    expect(events.filter((event) => event.type === 'usage')).toHaveLength(1);
  });

  it('reads input-only usage as zero output tokens, since the API bills input only', async () => {
    const { result, events } = await runWith(200, ok());
    expect(result!.usage).toMatchObject({ kind: 'reported', inputTokens: 120, outputTokens: 0 });
    expect(events).toContainEqual(expect.objectContaining({ type: 'usage', model: 'gpt-6-luna', billing: 'api' }));
  });

  it('reads both counts when the response gives them, and unknown usage when it gives no input count', async () => {
    expect((await runWith(200, ok(ANSWERS, { usage: { input_tokens: 40, output_tokens: 3 } }))).result!.usage)
      .toMatchObject({ kind: 'reported', inputTokens: 40, outputTokens: 3 });
    expect((await runWith(200, ok(ANSWERS, { usage: {} }))).result!.usage).toEqual({ kind: 'unknown' });
  });

  it.each([
    [400, 'invalid-config'],
    [401, 'auth'],
    [403, 'auth'],
    [402, 'billing'],
    [429, 'rate-limit'],
    [500, 'transient'],
    [418, 'unknown'],
  ])('maps HTTP %i to %s', async (status, kind) => {
    const { error } = await runWith(status, { error: { message: 'synthetic' } });
    expect((error as EngineError).kind).toBe(kind);
  });

  it('carries Retry-After on a rate limit', async () => {
    const { error } = await runWith(429, { error: { message: 'synthetic' } }, {}, { 'retry-after': '7' });
    expect((error as EngineError).retryAfterMs).toBe(7_000);
  });

  it.each([
    [{ system: 'be terse' }, 'a system prompt'],
    [{ env: { A: 'b' } }, 'env'],
    [{ maxTokens: 10 }, 'maxTokens'],
    [{ jsonSchema: { type: 'object', required: ['summary'] } }, 'a jsonSchema result'],
    [{ workspaceMode: 'read' as const }, 'a workspace'],
    [{ tools: ['read'] }, 'tools'],
    [{ effort: 'high' }, 'effort'],
  ])('refuses %j (%s) before any call', async (overrides, _label) => {
    const { error, calls } = await runWith(200, ok(), overrides as Partial<AgentRequest>);
    expect((error as EngineError).kind).toBe('invalid-config');
    expect(calls).toHaveLength(0);
  });

  it('refuses a jsonSchema result at admission', async () => {
    const fake = fakeFetch(200, ok());
    const engine = new OpenAIDecisionsEngine({ apiKey: API_KEY, fetch: fake.call });
    const { prompt: _prompt, ...rest } = request({ jsonSchema: { type: 'object', required: ['summary'] } });
    await expect(engine.admit(rest, new AbortController().signal)).rejects.toMatchObject({ kind: 'invalid-config' });
    expect(fake.calls).toHaveLength(0);
  });

  it('fails as aborted when the caller cancels a call in flight', async () => {
    const pending = (async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(init.signal!.reason); });
    })) as typeof fetch;
    const engine = new OpenAIDecisionsEngine({ apiKey: API_KEY, fetch: pending });
    const controller = new AbortController();
    const running = engine.run(request(), () => {}, controller.signal);
    controller.abort();
    await expect(running).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('refuses a missing key and an effort option at construction', () => {
    expect(() => new OpenAIDecisionsEngine({ apiKey: '' })).toThrowError(/apiKey/);
    expect(() => new OpenAIDecisionsEngine({ apiKey: API_KEY, effort: 'high' })).toThrowError(/effort/);
  });

  it('records the model the response echoes as the effective model', async () => {
    const { result } = await runWith(200, ok(ANSWERS, { model: 'gpt-6-luna-2026-09' }));
    expect(result!.effective).toMatchObject({ model: 'gpt-6-luna-2026-09', modelFamily: 'gpt', provider: 'openai' });
    const silent = await runWith(200, { answers: ANSWERS, usage: { input_tokens: 1 } });
    expect(silent.result!.effective).toMatchObject({ model: null, modelFamily: null });
  });
});

describe('the seat', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('reads OPENAI_API_KEY and reports provider openai and family gpt', () => {
    vi.stubEnv('OPENAI_API_KEY', API_KEY);
    expect(openaiDecisions().identity).toEqual({
      adapter: 'openai-decisions',
      provider: 'openai',
      modelFamily: 'gpt',
      model: 'gpt-6-luna',
      tools: [],
    });
  });

  it('refuses to start without a key', () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    expect(() => openaiDecisions()).toThrowError(/OPENAI_API_KEY/);
  });

  it('returns the answers as assistant text, as the judge reads a jev() seat', async () => {
    const fake = fakeFetch(200, ok());
    vi.stubGlobal('fetch', fake.call);
    try {
      const seat = openaiDecisions('gpt-6-luna', { apiKey: API_KEY });
      const result = await seat.engine.run(request(), () => {}, new AbortController().signal);
      const final = result.parts.find((part) => part.final);
      expect(final).toMatchObject({ kind: 'assistant' });
      const answers = JSON.parse((final as { text: string }).text);
      // The judge reads `noul ?? probability` and `choice`; both are here.
      expect(answers.holds.noul).toBe(0.82);
      expect(answers.stop_reason.choice).toBe('holds');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

interface Stub {
  readonly url: string;
  readonly calls: number[];
  respond(status: number, body: unknown): void;
  delay(milliseconds: number): void;
}

async function stub(): Promise<Stub> {
  let status = 200;
  let body: unknown = ok();
  let delayMs = 0;
  const calls: number[] = [];
  const server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      calls.push(Date.now());
      setTimeout(() => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      }, delayMs);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/decisions`,
    calls,
    respond(nextStatus, nextBody) { status = nextStatus; body = nextBody; },
    delay(milliseconds) { delayMs = milliseconds; },
  };
}

describe('engine conformance kit', () => {
  it('passes the public kit against the stub server', async () => {
    const stubServer = await stub();
    let snapshot = 0;
    const selection = (model: string) => engineSelection({
      adapter: 'openai-decisions',
      adapterVersion: '0.1.0',
      provider: 'openai',
      modelFamily: 'gpt',
      model,
      executable: null,
      capabilities: [],
    });
    const engine = (endpoint: string) => new OpenAIDecisionsEngine({ apiKey: API_KEY, endpoint, adapterVersion: '0.1.0' });

    const fixture: EngineConformanceFixture = {
      request: request({ timeoutMs: 400 }),
      requested: selection('gpt-6-luna'),
      effective: selection('gpt-6-luna'),
      unsupported: {
        'structured-result': 'the Decisions API answers typed questions only (predicate, choice, score) and cannot return a free JSON object for a schema; its answers are checked in this suite',
        'ordered-parts': 'the wire returns one structured answer; no assistant stream exists to order',
        'tool-events': 'the adapter declares no tools and the wire carries no tool use',
        'late-final': 'a single request and response has no stream that could carry a late final',
        'cancellation': 'no engine event exists before the response arrives; abort coverage lives in this suite',
        'missing-cli': 'the adapter is an HTTP client with no executable to lose',
        'model-unavailable': 'unclassified until an observed provider error body exists',
        'quota': 'unclassified until an observed provider error body exists',
        'clean-mode': 'the adapter is an HTTP client that loads none of the person\'s own setup, so it always runs clean',
      },
      workspace: {
        modes: {
          none: { request: request(), outcome: 'supported' },
          read: { request: request(), outcome: 'refused' },
          write: { request: request(), outcome: 'refused' },
        },
        observe: async () => ({ modelCalls: stubServer.calls.length - snapshot, canRead: false, canWrite: false }),
      },
      open: async (scenario) => {
        snapshot = stubServer.calls.length;
        stubServer.delay(0);
        switch (scenario) {
          case 'unknown-usage':
            stubServer.respond(200, { model: 'gpt-6-luna', answers: ANSWERS });
            break;
          case 'reported-usage':
            stubServer.respond(200, ok(ANSWERS, { usage: { input_tokens: 5, output_tokens: 3 } }));
            break;
          case 'auth':
            stubServer.respond(401, { error: { message: 'synthetic' } });
            break;
          case 'billing':
            stubServer.respond(402, { error: { message: 'synthetic' } });
            break;
          case 'rate-limit':
            stubServer.respond(429, { error: { message: 'synthetic' } });
            break;
          case 'transient':
            stubServer.respond(500, { error: { message: 'synthetic' } });
            break;
          case 'timeout':
            stubServer.delay(2_000);
            stubServer.respond(200, ok());
            break;
          case 'invalid-config':
            return new OpenAIDecisionsEngine({ apiKey: '' });
          default:
            stubServer.respond(200, ok());
        }
        return engine(stubServer.url);
      },
    };

    const report = await runEngineConformance(fixture);
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  });
});
