import { describe, it, expect } from 'vitest';

import { mapMessage, newAccumulator } from '../src/engines/message-map.ts';
import type { EngineStreamEvent } from '../src/engines/engine.ts';

function collect(messages: unknown[]) {
  const acc = newAccumulator('test-model');
  const events: EngineStreamEvent[] = [];
  for (const m of messages) mapMessage(m, acc, (e) => events.push(e));
  return { acc, events };
}

describe('message-map', () => {
  it('extracts text + usage from a non-partial assistant + result', () => {
    const { acc, events } = collect([
      {
        type: 'assistant',
        message: {
          model: 'm1',
          content: [{ type: 'text', text: 'Hello' }],
          usage: { input_tokens: 7, output_tokens: 3 },
        },
      },
      {
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 7, output_tokens: 3 },
      },
    ]);
    expect(acc.text).toBe('Hello');
    expect(acc.model).toBe('m1');
    expect(acc.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect(events.some((e) => e.type === 'text' && e.delta === 'Hello')).toBe(
      true,
    );
  });

  it('counts cached Claude input once when terminal usage replaces message totals', () => {
    const assistant = {
      type: 'assistant',
      message: {
        content: [],
        usage: {
          input_tokens: 7,
          cache_creation_input_tokens: 11,
          cache_read_input_tokens: 13,
          output_tokens: 3,
        },
      },
    };
    expect(collect([assistant]).acc.usage).toEqual({
      inputTokens: 31,
      outputTokens: 3,
      cacheCreationInputTokens: 11,
      cacheReadInputTokens: 13,
    });
    expect(
      collect([
        assistant,
        {
          type: 'result',
          subtype: 'success',
          usage: {
            input_tokens: 7,
            cache_creation_input_tokens: 11,
            cache_read_input_tokens: 13,
            output_tokens: 3,
          },
        },
      ]).acc.usage,
    ).toEqual({
      inputTokens: 31,
      outputTokens: 3,
      cacheCreationInputTokens: 11,
      cacheReadInputTokens: 13,
    });
  });

  it('streams deltas without double-counting the final block', () => {
    const { acc, events } = collect([
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Po' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'ng' },
        },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Pong' }] },
      },
    ]);
    const textDeltas = events
      .filter((e) => e.type === 'text')
      .map((e) => (e as { delta: string }).delta);
    expect(textDeltas).toEqual(['Po', 'ng']); // deltas only, block not re-emitted
    expect(acc.text).toBe('Pong'); // accumulated from the authoritative block
  });

  it('emits tool-use events and falls back to result text', () => {
    const { acc, events } = collect([
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash' }] },
      },
      { type: 'result', subtype: 'success', result: 'final answer' },
    ]);
    expect(
      events.some(
        (e) => e.type === 'tool' && e.name === 'Bash' && e.phase === 'use',
      ),
    ).toBe(true);
    expect(acc.text).toBe('final answer');
  });

  it('is defensive against malformed messages', () => {
    expect(() =>
      collect([
        null,
        undefined,
        {},
        { type: 'assistant' },
        { type: 'stream_event' },
      ]),
    ).not.toThrow();
  });
});
