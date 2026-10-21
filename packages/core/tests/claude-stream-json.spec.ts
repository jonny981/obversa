import { describe, it, expect } from 'vitest';

import { mapMessage, newAccumulator } from '../src/claude-stream-json.ts';
import type { EngineStreamEvent } from '@obversa/api';

function collect(messages: unknown[]) {
  const acc = newAccumulator('test-model');
  const events: EngineStreamEvent[] = [];
  for (const m of messages) mapMessage(m, acc, (e) => events.push(e));
  return { acc, events };
}

describe('message-map', () => {
  it('extracts ordered parts + reported usage from an assistant + result', () => {
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
    expect(acc.parts).toEqual([
      { kind: 'assistant', text: 'Hello', final: true },
    ]);
    expect(acc.model).toBe('m1');
    expect(acc.usage).toEqual({
      kind: 'reported',
      inputTokens: 7,
      outputTokens: 3,
    });
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
      kind: 'reported',
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
      kind: 'reported',
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
    expect(acc.parts).toEqual([
      { kind: 'assistant', text: 'Pong', final: false },
    ]); // the terminal result is what marks one part final
  });

  it('keeps assistant continuations separate and marks only the last final', () => {
    const { acc } = collect([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'First' }] },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Second' }] },
      },
      { type: 'result', subtype: 'success' },
    ]);

    expect(acc.parts).toEqual([
      { kind: 'assistant', text: 'First', final: false },
      { kind: 'assistant', text: 'Second', final: true },
    ]);
    expect(acc.usage).toEqual({ kind: 'unknown' });
  });

  it('keeps partial usage unknown instead of filling missing fields with zero', () => {
    const { acc } = collect([
      {
        type: 'result',
        result: 'done',
        usage: { input_tokens: 4 },
      },
    ]);

    expect(acc.usage).toEqual({ kind: 'unknown' });
  });

  it('emits tool-use events and falls back to one final result part', () => {
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
    expect(acc.parts).toEqual([
      { kind: 'assistant', text: 'final answer', final: true },
    ]);
  });

  it('maps a tool-use block\'s input to a target, and reports none for a tool with no such argument', () => {
    const { events } = collect([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: 'src/a.ts' } },
            { type: 'tool_use', name: 'AskUser', input: { question: 'proceed?' } },
          ],
        },
      },
    ]);
    const tools = events.filter((e) => e.type === 'tool');
    expect(tools).toEqual([
      { type: 'tool', name: 'Read', phase: 'use', target: 'src/a.ts' },
      { type: 'tool', name: 'AskUser', phase: 'use' },
    ]);
  });

  it('reports no target on a tool-result block, which carries no input', () => {
    const { events } = collect([
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', name: 'Read' }] },
      },
    ]);
    expect(events).toEqual([{ type: 'tool', name: 'Read', phase: 'result' }]);
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

describe('a session that spans two turns', () => {
  // A command started in the background ends the first turn; when it
  // finishes, the CLI starts a second turn by itself. Each turn ends with
  // its own result message.
  const firstTurn = [
    { type: 'system', subtype: 'init', session_id: 's1', model: 'm1' },
    {
      type: 'assistant',
      message: {
        model: 'm1',
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'pnpm test', run_in_background: true } },
        ],
        usage: { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 20 },
      },
    },
    { type: 'user', message: { content: [{ type: 'tool_result', name: 'Bash' }] } },
    {
      type: 'assistant',
      message: {
        model: 'm1',
        content: [{ type: 'text', text: 'The tests are running in the background.' }],
        usage: { input_tokens: 5, cache_read_input_tokens: 120, output_tokens: 30 },
      },
    },
    {
      type: 'result',
      subtype: 'success',
      result: 'The tests are running in the background.',
      total_cost_usd: 0.5,
      usage: {
        input_tokens: 15,
        cache_creation_input_tokens: 40,
        cache_read_input_tokens: 220,
        output_tokens: 50,
      },
    },
  ];
  const secondTurn = [
    { type: 'system', subtype: 'task_notification', status: 'completed' },
    {
      type: 'assistant',
      message: {
        model: 'm1',
        content: [{ type: 'text', text: 'The tests passed.' }],
        usage: { input_tokens: 3, cache_read_input_tokens: 300, output_tokens: 70 },
      },
    },
    {
      type: 'result',
      subtype: 'success',
      result: 'The tests passed.',
      total_cost_usd: 0.8,
      usage: {
        input_tokens: 3,
        cache_read_input_tokens: 300,
        output_tokens: 70,
      },
    },
  ];

  it('keeps exactly one final part, holding the second turn\'s text', () => {
    const { acc } = collect([...firstTurn, ...secondTurn]);

    expect(acc.parts.filter((part) => part.final)).toEqual([
      { kind: 'assistant', text: 'The tests passed.', final: true },
    ]);
    expect(acc.parts).toEqual([
      { kind: 'assistant', text: 'The tests are running in the background.', final: false },
      { kind: 'assistant', text: 'The tests passed.', final: true },
    ]);
  });

  it('sums the tokens of both turns and keeps the last result\'s cost', () => {
    const { acc } = collect([...firstTurn, ...secondTurn]);

    expect(acc.usage).toEqual({
      kind: 'reported',
      inputTokens: 15 + 40 + 220 + 3 + 300,
      outputTokens: 50 + 70,
      cacheCreationInputTokens: 40,
      cacheReadInputTokens: 220 + 300,
    });
    expect(acc.costUsd).toBe(0.8);
  });

  it('reads a one-turn stream as before', () => {
    const { acc } = collect(firstTurn);

    expect(acc.parts).toEqual([
      { kind: 'assistant', text: 'The tests are running in the background.', final: true },
    ]);
    expect(acc.usage).toEqual({
      kind: 'reported',
      inputTokens: 15 + 40 + 220,
      outputTokens: 50,
      cacheCreationInputTokens: 40,
      cacheReadInputTokens: 220,
    });
    expect(acc.costUsd).toBe(0.5);
  });
});
