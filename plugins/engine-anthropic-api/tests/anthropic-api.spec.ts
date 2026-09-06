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
});
