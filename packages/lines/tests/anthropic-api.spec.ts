import { describe, expect, it } from 'vitest';

import { AnthropicApiEngine } from '../src/engines/anthropic-api.ts';

describe('AnthropicApiEngine', () => {
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
    ).rejects.toMatchObject({ code: 'RATE_LIMIT', retryAfterMs: 7_000 });
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

    expect(result.late).toBe(true);
  });
});
