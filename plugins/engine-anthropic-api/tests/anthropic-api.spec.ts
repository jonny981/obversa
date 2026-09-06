import { createServer } from 'node:http';

import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import { AnthropicApiEngine } from '../src/index.ts';

describe('AnthropicApiEngine', () => {
  it('uses the request model before the plugin default', async () => {
    let body: unknown;
    const engine = new AnthropicApiEngine({
      apiKey: 'test-key',
      defaultModel: 'default-model',
    });
    (
      engine as unknown as {
        clientPromise: Promise<{
          messages: {
            stream: (request: unknown) => {
              on: () => void;
              finalMessage: () => Promise<unknown>;
            };
          };
        }>;
      }
    ).clientPromise = Promise.resolve({
      messages: {
        stream: (request) => {
          body = request;
          return {
            on: () => {},
            finalMessage: async () => ({
              content: [{ type: 'text', text: 'ok' }],
              usage: { input_tokens: 1, output_tokens: 2 },
              stop_reason: 'end_turn',
            }),
          };
        },
      },
    });

    await engine.run(
      { prompt: 'judge', model: 'request-model' },
      () => {},
      new AbortController().signal,
    );

    expect(body).toMatchObject({ model: 'request-model' });
  });

  it('preserves provider-limit errors when timeoutMs is configured', async () => {
    const error = Object.assign(new Error('too many requests'), {
      status: 429,
      headers: { get: (name: string) => (name === 'retry-after' ? '7' : null) },
    });
    const engine = new AnthropicApiEngine({ apiKey: 'test-key' });
    (
      engine as unknown as {
        clientPromise: Promise<{
          messages: { stream: () => { on: () => void; finalMessage: () => Promise<never> } };
        }>;
      }
    ).clientPromise = Promise.resolve({
      messages: {
        stream: () => ({
          on: () => {},
          finalMessage: async () => {
            throw error;
          },
        }),
      },
    });

    await expect(
      engine.run(
        { prompt: 'judge', timeoutMs: 10_000 },
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: 'rate-limit', retryAfterMs: 7_000 });
  });

  it('marks successful responses after the soft timeout as late', async () => {
    const engine = new AnthropicApiEngine({ apiKey: 'test-key' });
    (
      engine as unknown as {
        clientPromise: Promise<{
          messages: { stream: () => { on: () => void; finalMessage: () => Promise<unknown> } };
        }>;
      }
    ).clientPromise = Promise.resolve({
      messages: {
        stream: () => ({
          on: () => {},
          finalMessage: async () => {
            await new Promise((r) => setTimeout(r, 20));
            return {
              content: [{ type: 'text', text: 'ok' }],
              usage: { input_tokens: 1, output_tokens: 2 },
              stop_reason: 'end_turn',
            };
          },
        }),
      },
    });

    const result = await engine.run(
      { prompt: 'judge', timeoutMs: 1, timeoutGraceMs: 100 },
      () => {},
      new AbortController().signal,
    );

    expect(result.transportFailure).toMatchObject({ kind: 'timeout' });
  });

  it.each([
    ['ambiguous quota', new Error('quota allowance reached'), 'rate-limit'],
    ['ambiguous usage', new Error('usage limit reached'), 'rate-limit'],
    ['monthly usage', new Error('monthly usage limit reached'), 'quota'],
    ['historical billing tag', Object.assign(new Error('payment required'), {
      type: 'billing_error',
    }), 'quota'],
  ] as const)('classifies scripted API %s without an ordinary retry', async (_label, error, kind) => {
    let attempts = 0;
    const engine = new AnthropicApiEngine({ apiKey: 'test-key' });
    (engine as unknown as {
      clientPromise: Promise<{
        messages: {
          stream: () => { on: () => void; finalMessage: () => Promise<never> };
        };
      }>;
    }).clientPromise = Promise.resolve({
      messages: {
        stream: () => {
          attempts += 1;
          return { on: () => {}, finalMessage: async () => { throw error; } };
        },
      },
    });
    await expect(engine.run(
      { prompt: 'scripted API limit', timeoutMs: 10_000 },
      () => {},
      new AbortController().signal,
    )).rejects.toMatchObject({ kind });
    expect(attempts).toBe(1);
  });

  it.each([
    ['preflight', 1],
    [undefined, 9],
  ] as const)('uses the declared retry behavior for purpose %s', async (purpose, expectedRequests) => {
    let requests = 0;
    const paths: string[] = [];
    const server = createServer((request, response) => {
      requests += 1;
      paths.push(request.url ?? '');
      request.resume();
      response.writeHead(503, {
        'content-type': 'application/json',
        'retry-after-ms': '1',
        connection: 'close',
      });
      response.end(JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: 'Scripted provider unavailable.' },
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('The local provider did not acquire a TCP port.');
      }
      const engine = new AnthropicApiEngine({ apiKey: 'test-key' });
      (engine as unknown as { clientPromise: Promise<unknown> }).clientPromise = Promise.resolve(
        new Anthropic({
          apiKey: 'test-key',
          baseURL: `http://127.0.0.1:${address.port}`,
          timeout: 1_000,
        }),
      );
      await expect(engine.run({
        prompt: 'Scripted local retry check.',
        model: 'scripted-model',
        timeoutMs: 8_000,
        ...(purpose === undefined ? {} : { purpose }),
      }, () => {}, new AbortController().signal)).rejects.toMatchObject({
        name: 'EngineError', kind: 'transient',
      });
      expect(requests).toBe(expectedRequests);
      expect(paths).toEqual(Array.from({ length: expectedRequests }, () => '/v1/messages'));
    } finally {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
      server.closeAllConnections();
      await closed;
    }
  }, 15_000);
});
