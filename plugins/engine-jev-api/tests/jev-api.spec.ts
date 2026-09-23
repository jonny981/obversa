/**
 * Jev adapter behaviour against a local HTTP stub. No live API is ever
 * contacted: every test either counts the requests a stub server received or
 * injects a fetch that cannot reach the network. The synthetic response
 * bodies below are adapter fixtures shaped like the provider's documented
 * response — they are labelled synthetic until a saved provider response
 * confirms them.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

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

import { JevApiEngine, parseJevDocument } from '../src/jev-api.js';

const API_KEY = 'test-key-not-a-credential';
const QUESTIONS = {
  send_back: {
    type: 'noul',
    instructions: 'Should this work be sent back?',
    criteria: { true: 'A finding is user-visible', false: 'Advisories only' },
  },
  which_stage: {
    type: 'choice',
    instructions: 'Which stage should it return to?',
    criteria: { implement: 'code defect', test: 'tests missing', none: 'nothing' },
  },
} as const;

function prompt(questions: unknown = QUESTIONS, state: unknown = { verdict: 'accept' }): string {
  return JSON.stringify({ state, questions });
}

function request(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return { prompt: prompt(), model: 'jev-fixture', workspaceMode: 'none', ...overrides };
}

interface CapturedCall {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly body: unknown;
}

interface Stub {
  readonly url: string;
  readonly calls: CapturedCall[];
  respond(status: number, body: unknown): void;
  delay(milliseconds: number): void;
  trickle(milliseconds: number): void;
}

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function stub(): Promise<Stub> {
  let status = 200;
  let body: unknown = {
    model: 'jev-fixture-effective',
    usage: { input_tokens: 5, output_tokens: 3 },
    answers: { send_back: { type: 'noul', noul: 0.1 } },
  };
  let delayMs = 0;
  let trickleMs = 0;
  const calls: CapturedCall[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      calls.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'),
      });
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      if (trickleMs > 0) {
        res.writeHead(status, { 'content-type': 'application/json' });
        const first = payload.slice(0, Math.ceil(payload.length / 2));
        res.write(first);
        setTimeout(() => res.end(payload.slice(first.length)), trickleMs);
        return;
      }
      setTimeout(() => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(payload);
      }, delayMs);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/systemone`,
    calls,
    respond(nextStatus, nextBody) {
      status = nextStatus;
      body = nextBody;
    },
    delay(milliseconds) {
      delayMs = milliseconds;
    },
    trickle(milliseconds) {
      trickleMs = milliseconds;
    },
  };
}

function engine(url: string, options: Partial<ConstructorParameters<typeof JevApiEngine>[0]> = {}): JevApiEngine {
  return new JevApiEngine({
    endpoint: url,
    apiKey: API_KEY,
    adapterVersion: '0.1.0',
    ...options,
  });
}

async function failureOf(run: () => Promise<unknown>): Promise<EngineError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(EngineError);
    return error as EngineError;
  }
  throw new Error('expected the call to fail');
}

describe('admission', () => {
  it('selects the jev-api identity without a call', async () => {
    const stubServer = await stub();
    const selected = await engine(stubServer.url, {
      fetch: () => Promise.reject(new Error('admit must not call fetch')),
    }).admit(
      { model: 'jev-fixture', workspaceMode: 'none' },
      new AbortController().signal,
    );
    expect(selected).toEqual({
      adapter: 'jev-api',
      adapterVersion: '0.1.0',
      provider: 'typesafe',
      modelFamily: 'jev',
      model: 'jev-fixture',
      executable: null,
      capabilities: [],
    });
    expect(stubServer.calls).toHaveLength(0);
  });

  it('restores a matching saved selection and refuses a changed one', async () => {
    const stubServer = await stub();
    const instance = engine(stubServer.url);
    const signal = new AbortController().signal;
    const selected = await instance.admit({ model: 'jev-fixture' }, signal);
    await expect(instance.admit({ model: 'jev-fixture' }, signal, selected)).resolves.toEqual(selected);
    for (const changed of [
      { adapter: 'other' },
      { provider: 'other' },
      { modelFamily: 'other' },
      { model: 'jev-other' },
      { adapterVersion: '9.9.9' },
      { capabilities: ['x'] },
    ]) {
      await expect(
        instance.admit({ model: 'jev-fixture' }, signal, engineSelection({ ...selected, ...changed })),
      ).rejects.toMatchObject({ name: 'EngineError', kind: 'invalid-config' });
    }
  });

  it('requires endpoint and key at construction', () => {
    expect(() => new JevApiEngine({ endpoint: '', apiKey: API_KEY }))
      .toThrowError(expect.objectContaining({ kind: 'invalid-config' }));
    expect(() => new JevApiEngine({ endpoint: 'http://x', apiKey: '' }))
      .toThrowError(expect.objectContaining({ kind: 'invalid-config' }));
  });
});

describe('request shape validation', () => {
  it.each([
    ['system prompt', { system: 'you are helpful' }],
    ['system mode', { systemMode: 'append' as const }],
    ['env', { env: { TYPESAFE_API_KEY: 'leaked' } }],
    ['maxTokens', { maxTokens: 100 }],
    ['read workspace', { workspaceMode: 'read' as const }],
    ['write workspace', { workspaceMode: 'write' as const }],
    ['declared tools', { tools: ['read_file'] }],
  ])('rejects %s as invalid-config before any request', async (_label, fields) => {
    const stubServer = await stub();
    const error = await failureOf(() => engine(stubServer.url).run(
      request(fields),
      () => {},
      new AbortController().signal,
    ));
    expect(error.kind).toBe('invalid-config');
    expect(stubServer.calls).toHaveLength(0);
  });
});

describe('prompt document', () => {
  it.each([
    ['not JSON', 'this is not json'],
    ['a bare string', '"hello"'],
    ['an array', '[1,2]'],
    ['no questions', JSON.stringify({ state: {} })],
    ['empty questions', JSON.stringify({ questions: {} })],
    ['questions not an object', JSON.stringify({ questions: ['a'] })],
    ['question not an object', JSON.stringify({ questions: { q: 4 } })],
    ['question missing type', JSON.stringify({ questions: { q: { instructions: 'x' } } })],
    ['unknown question type', JSON.stringify({ questions: { q: { type: 'essay' } } })],
  ])('rejects %s as invalid-config before any request', async (_label, bad) => {
    const stubServer = await stub();
    const error = await failureOf(() => engine(stubServer.url).run(
      request({ prompt: bad }),
      () => {},
      new AbortController().signal,
    ));
    expect(error.kind).toBe('invalid-config');
    expect(stubServer.calls).toHaveLength(0);
  });

  it('parses the document and defaults state to an empty object', () => {
    const document = parseJevDocument(JSON.stringify({ questions: QUESTIONS }));
    expect(document.state).toEqual({});
    expect(document.questions).toEqual(QUESTIONS);
  });
});

describe('the wire call', () => {
  it('posts model, state and questions with the configured bearer key', async () => {
    const stubServer = await stub();
    const state = { stage: 'review', findings: ['one'] };
    await engine(stubServer.url).run(
      request({ prompt: prompt(QUESTIONS, state) }),
      () => {},
      new AbortController().signal,
    );
    expect(stubServer.calls).toHaveLength(1);
    const call = stubServer.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/v1/systemone');
    expect(call.authorization).toBe(`Bearer ${API_KEY}`);
    expect(call.contentType).toBe('application/json');
    expect(call.body).toEqual({ model: 'jev-fixture', state, questions: QUESTIONS });
  });

  it('returns the answers as the structured final part', async () => {
    const stubServer = await stub();
    const answers = {
      send_back: { type: 'noul', noul: 0.1 },
      which_stage: { type: 'choice', choice: 'none', confidence: 0.8 },
    };
    stubServer.respond(200, { model: 'jev-fixture-effective', usage: { input_tokens: 5, output_tokens: 3 }, answers });
    const events: EngineStreamEvent[] = [];
    const result = await engine(stubServer.url).run(
      request(),
      (event) => events.push(event),
      new AbortController().signal,
    );
    expect(result.parts).toEqual([{ kind: 'structured', value: answers, final: true }]);
    expect(result.usage).toEqual({ kind: 'reported', inputTokens: 5, outputTokens: 3 });
    expect(events.filter((event) => event.type === 'usage')).toEqual([
      { type: 'usage', usage: result.usage, model: 'jev-fixture' },
    ]);
    expect(result.effective.model).toBe('jev-fixture-effective');
    expect(result.effective.modelFamily).toBe('jev');
    expect(result.requested.adapter).toBe('jev-api');
    expect(result.raw).toMatchObject({ answers });
  });

  it('reports a null effective identity when the response echoes no model', async () => {
    const stubServer = await stub();
    stubServer.respond(200, { usage: { input_tokens: 1, output_tokens: 1 }, answers: { ok: { type: 'score', score: 3 } } });
    const result = await engine(stubServer.url).run(request(), () => {}, new AbortController().signal);
    expect(result.effective.model).toBeNull();
    expect(result.effective.modelFamily).toBeNull();
    expect(result.effective.provider).toBe('typesafe');
  });

  it.each([
    ['an unreadable word', 'unknown'],
    ['whitespace', 'not a model'],
    ['empty', ''],
    ['non-string', 42],
  ])('reports a null effective identity when the echo is %s', async (_label, echo) => {
    const stubServer = await stub();
    const answers = { ok: { type: 'score', score: 3 } };
    stubServer.respond(200, { model: echo, usage: { input_tokens: 1, output_tokens: 1 }, answers });
    const result = await engine(stubServer.url).run(request(), () => {}, new AbortController().signal);
    expect(result.effective.model).toBeNull();
    expect(result.effective.modelFamily).toBeNull();
    expect(result.effective.provider).toBe('typesafe');
    expect(result.parts[0]).toEqual({ kind: 'structured', value: answers, final: true });
  });

  it('still rejects an unreadable requested model as invalid-config before any request', async () => {
    const stubServer = await stub();
    const error = await failureOf(() => engine(stubServer.url).run(
      request({ model: 'not a model' }),
      () => {},
      new AbortController().signal,
    ));
    expect(error.kind).toBe('invalid-config');
    expect(stubServer.calls).toHaveLength(0);
  });

  it('completes with a low-confidence answer and records it', async () => {
    const stubServer = await stub();
    // noul carries a bare probability and no confidence field — the
    // genuinely unconfident answer here is the choice, at confidence 0.05.
    const answers = {
      send_back: { type: 'noul', noul: 0.51 },
      which_stage: { type: 'choice', choice: 'test', confidence: 0.05 },
    };
    stubServer.respond(200, { answers });
    const result = await engine(stubServer.url).run(request(), () => {}, new AbortController().signal);
    expect(result.parts[0]).toEqual({ kind: 'structured', value: answers, final: true });
    expect(result.usage.kind).toBe('unknown');
  });

  it('never puts the key into results or error messages', async () => {
    const stubServer = await stub();
    stubServer.respond(401, { error: 'bad credential' });
    const error = await failureOf(() => engine(stubServer.url).run(
      request(), () => {}, new AbortController().signal,
    ));
    expect(JSON.stringify(error.message)).not.toContain(API_KEY);
    expect(error.message).not.toContain(API_KEY);
  });
});

describe('usage receipts', () => {
  it('emits exactly one unknown usage observation when the body lacks both token fields', async () => {
    const stubServer = await stub();
    stubServer.respond(200, { model: 'jev-fixture-effective', usage: { input_tokens: 5 }, answers: { a: { type: 'score', score: 1 } } });
    const events: EngineStreamEvent[] = [];
    const result = await engine(stubServer.url).run(request(), (event) => events.push(event), new AbortController().signal);
    expect(result.usage).toEqual({ kind: 'unknown' });
    expect(events.filter((event) => event.type === 'usage')).toEqual([
      { type: 'usage', usage: { kind: 'unknown' }, model: 'jev-fixture' },
    ]);
  });

  it.each([
    ['a negative count', { input_tokens: -1, output_tokens: 3 }],
    ['an unsafe integer', { input_tokens: 2 ** 53, output_tokens: 3 }],
    ['a non-integer', { input_tokens: 1.5, output_tokens: 3 }],
  ])('emits one unknown usage observation when the body carries %s', async (_label, usage) => {
    const stubServer = await stub();
    const answers = { a: { type: 'score', score: 1 } };
    stubServer.respond(200, { model: 'jev-fixture-effective', usage, answers });
    const events: EngineStreamEvent[] = [];
    const result = await engine(stubServer.url).run(request(), (event) => events.push(event), new AbortController().signal);
    expect(result.usage).toEqual({ kind: 'unknown' });
    expect(result.parts[0]).toEqual({ kind: 'structured', value: answers, final: true });
    expect(events.filter((event) => event.type === 'usage')).toEqual([
      { type: 'usage', usage: { kind: 'unknown' }, model: 'jev-fixture' },
    ]);
  });
});

describe('failure mapping', () => {
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [402, 'billing'],
    [429, 'rate-limit'],
    [500, 'transient'],
    [503, 'transient'],
    [404, 'unknown'],
    [418, 'unknown'],
  ] as const)('maps HTTP %i to %s', async (status, kind) => {
    const stubServer = await stub();
    stubServer.respond(status, { error: 'synthetic failure body' });
    const error = await failureOf(() => engine(stubServer.url).run(request(), () => {}, new AbortController().signal));
    expect(error.kind).toBe(kind);
    expect(stubServer.calls).toHaveLength(1);
  });

  it('carries retry-after on a rate limit', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(429, { 'retry-after': '2', 'content-type': 'application/json' });
      res.end('{}');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const error = await failureOf(() => engine(`http://127.0.0.1:${port}/v1/systemone`).run(
      request(), () => {}, new AbortController().signal,
    ));
    expect(error.kind).toBe('rate-limit');
    expect(error.retryAfterMs).toBe(2000);
  });

  it('fails the attempt as transient when the endpoint is unreachable', async () => {
    // A bound-then-closed port: connection refused, zero model calls.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const error = await failureOf(() => engine(`http://127.0.0.1:${port}/v1/systemone`).run(
      request(), () => {}, new AbortController().signal,
    ));
    expect(error.kind).toBe('transient');
  });

  it('fails as unknown when the body is not JSON', async () => {
    const stubServer = await stub();
    stubServer.respond(200, 'this is not json');
    const error = await failureOf(() => engine(stubServer.url).run(request(), () => {}, new AbortController().signal));
    expect(error.kind).toBe('unknown');
  });

  it('fails as unknown when the body carries no answers object', async () => {
    const stubServer = await stub();
    stubServer.respond(200, { model: 'x', usage: { input_tokens: 1, output_tokens: 1 } });
    const error = await failureOf(() => engine(stubServer.url).run(request(), () => {}, new AbortController().signal));
    expect(error.kind).toBe('unknown');
  });

  it('fails as unknown naming the cap when the body exceeds maxOutputBytes', async () => {
    const stubServer = await stub();
    const error = await failureOf(() => engine(stubServer.url).run(
      request({ maxOutputBytes: 16 }), () => {}, new AbortController().signal,
    ));
    expect(error.kind).toBe('unknown');
    expect(error.message).toContain('16');
  });
});

describe('cancellation and deadlines', () => {
  it('fails as aborted when the caller aborts mid-flight', async () => {
    const stubServer = await stub();
    stubServer.delay(2_000);
    const controller = new AbortController();
    const running = engine(stubServer.url).run(request(), () => {}, controller.signal);
    setTimeout(() => controller.abort(), 25);
    const error = await failureOf(() => running);
    expect(error.kind).toBe('aborted');
  });

  it('fails as aborted when the signal is already aborted', async () => {
    const stubServer = await stub();
    const controller = new AbortController();
    controller.abort();
    const error = await failureOf(() => engine(stubServer.url).run(request(), () => {}, controller.signal));
    expect(error.kind).toBe('aborted');
    expect(stubServer.calls).toHaveLength(0);
  });

  it('fails as timeout when the response exceeds timeoutMs plus grace', async () => {
    const stubServer = await stub();
    stubServer.delay(2_000);
    const error = await failureOf(() => engine(stubServer.url).run(
      request({ timeoutMs: 100, timeoutGraceMs: 50 }), () => {}, new AbortController().signal,
    ));
    expect(error.kind).toBe('timeout');
  });

  it('fails as timeout when the body still streams after the deadline', async () => {
    const stubServer = await stub();
    stubServer.trickle(2_000);
    const error = await failureOf(() => engine(stubServer.url).run(
      request({ timeoutMs: 100, timeoutGraceMs: 50 }), () => {}, new AbortController().signal,
    ));
    expect(error.kind).toBe('timeout');
  });
});

describe('sanitized review cases', () => {
  // The three case payloads mirror the sanitized review questions the adapter
  // was built for; the stub answers are synthetic fixtures, not provider
  // observations the stub must reproduce.
  const cases: ReadonlyArray<readonly [string, JsonObject]> = [
    ['rejected', {
      stage: 'review',
      brief: 'Add a webhook notifier that posts one message per interesting run event.',
      diff: '27 files changed, +1456/-11. New package with 351 lines of source and 478 of tests.',
      findings: [
        'A loop iteration is mistaken for the run ending: a five-iteration loop posts "Run finished." after the first pass and the real failure is suppressed.',
        'The new package has no dependency-direction rule, so its claim to import nothing from the repository is enforced by nobody.',
      ],
      testsPassing: true,
      mutationsRed: '16 of 16',
    }],
    ['accepted', {
      stage: 'review',
      brief: 'Repair the notifier so the container owning a run decides what the run is.',
      diff: '2 files changed, +55/-21. One predicate replaces three separate depth conditions.',
      findings: [],
      notes: 'Both review seats accepted with zero blocking findings. 41 tests. 11 of 11 mutations fail the suite.',
      testsPassing: true,
      mutationsRed: '11 of 11',
    }],
    ['advisories-only', {
      stage: 'review',
      brief: 'Emit run-level start and end events so a consumer stops inferring the run from containers.',
      diff: '9 files changed. Two new event kinds, one pin, one page row, one changelog line.',
      findings: [
        'Advisory: the compile-time compatibility claim is broader than what the check actually proves.',
        'Advisory: one test never reaches the guard it is named for.',
        'Advisory: a documentation page repeats prose that appears elsewhere.',
      ],
      notes: 'No blocking findings from either seat. Every advisory is about wording or test reach, not behaviour.',
      testsPassing: true,
      mutationsRed: '10 of 10',
    }],
  ];

  it.each(cases)('carries the %s case through one call', async (_label, state) => {
    const stubServer = await stub();
    const answers = {
      send_back: { type: 'noul', noul: 0.5 },
      which_stage: { type: 'choice', choice: 'none', confidence: 0.8 },
    };
    stubServer.respond(200, { answers });
    const result = await engine(stubServer.url).run(
      request({ prompt: prompt(QUESTIONS, state) }),
      () => {},
      new AbortController().signal,
    );
    expect(stubServer.calls).toHaveLength(1);
    expect(stubServer.calls[0]!.body).toMatchObject({ state, questions: QUESTIONS });
    expect(result.parts[0]).toEqual({ kind: 'structured', value: answers, final: true });
  });
});

describe('engine conformance kit', () => {
  it('passes the public kit against the stub server', async () => {
    const stubServer = await stub();
    let snapshot = 0;
    const serverCalls = stubServer.calls;
    const respond = stubServer.respond;

    const requested = engineSelection({
      adapter: 'jev-api',
      adapterVersion: '0.1.0',
      provider: 'typesafe',
      modelFamily: 'jev',
      model: 'jev-fixture',
      executable: null,
      capabilities: [],
    });
    const effective = engineSelection({
      adapter: 'jev-api',
      adapterVersion: '0.1.0',
      provider: 'typesafe',
      modelFamily: 'jev',
      model: 'jev-fixture-effective',
      executable: null,
      capabilities: [],
    });
    const ok = (answers: JsonObject = { answer: 42 }) => ({
      model: 'jev-fixture-effective',
      usage: { input_tokens: 5, output_tokens: 3 },
      answers,
    });

    const fixture: EngineConformanceFixture = {
      request: request({ timeoutMs: 400 }),
      requested,
      effective,
      unsupported: {
        'ordered-parts': 'the wire returns one structured answer; no assistant stream exists to order',
        'tool-events': 'the adapter declares no tools and the wire carries no tool use',
        'late-final': 'a single request/response has no stream that could carry a late final',
        'cancellation': 'no engine event exists before the response arrives; abort coverage lives in the unit suite',
        'missing-cli': 'the adapter is an HTTP client with no executable to lose',
        'model-unavailable': 'unclassified until an observed provider error body exists',
        'quota': 'unclassified until an observed provider error body exists',
      },
      workspace: {
        modes: {
          none: { request: request(), outcome: 'supported' },
          read: { request: request(), outcome: 'refused' },
          write: { request: request(), outcome: 'refused' },
        },
        observe: async () => {
          const modelCalls = serverCalls.length - snapshot;
          return { modelCalls, canRead: false, canWrite: false };
        },
      },
      open: async (scenario) => {
        snapshot = serverCalls.length;
        switch (scenario) {
          case 'structured-result':
            respond(200, ok({ answer: 42 }));
            break;
          case 'unknown-usage':
            respond(200, { model: 'jev-fixture-effective', answers: { answer: 42 } });
            break;
          case 'reported-usage':
            respond(200, ok());
            break;
          case 'auth':
            respond(401, { error: 'synthetic' });
            break;
          case 'billing':
            respond(402, { error: 'synthetic' });
            break;
          case 'rate-limit':
            respond(429, { error: 'synthetic' });
            break;
          case 'transient':
            respond(500, { error: 'synthetic' });
            break;
          case 'timeout':
            stubServer.delay(2_000);
            respond(200, ok());
            break;
          case 'invalid-config':
            return new JevApiEngine({ endpoint: '', apiKey: '' });
          default:
            stubServer.delay(0);
            respond(200, ok());
        }
        if (scenario !== 'timeout') stubServer.delay(0);
        return engine(stubServer.url);
      },
    };

    const report = await runEngineConformance(fixture);
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  });
});
