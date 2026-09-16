import { describe, expect, it } from 'vitest';

import { AnthropicApiEngine } from '../src/index.ts';

describe('Anthropic API workspace access', () => {
  it.each(['read', 'write'] as const)('refuses unsupported %s before a provider call', async (workspaceMode) => {
    let calls = 0;
    const engine = new AnthropicApiEngine({ apiKey: 'test-key' });
    (engine as unknown as { clientPromise: Promise<unknown> }).clientPromise = Promise.resolve({
      messages: {
        stream() {
          calls += 1;
          return {
            on() {},
            async finalMessage() {
              return {
                content: [{ type: 'text', text: 'A blind answer must not be accepted.' }],
                usage: { input_tokens: 1, output_tokens: 1 },
                stop_reason: 'end_turn',
              };
            },
          };
        },
      },
    });

    await expect(engine.run({
      prompt: 'Inspect the workspace.',
      tools: ['Read'],
      workspaceMode,
    }, () => {}, new AbortController().signal)).rejects.toMatchObject({
      name: 'EngineError', kind: 'invalid-config',
    });
    expect(calls).toBe(0);
  });
});
