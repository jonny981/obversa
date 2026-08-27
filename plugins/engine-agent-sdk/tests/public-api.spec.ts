import { describe, expect, it, vi } from 'vitest';

import type { AgentRequest } from '@obversa/engine';
import type { Memory } from '@obversa/memory';
import {
  AgentSdkEngine,
  type AgentSdkEngineOptions,
} from '../src/index.ts';

const sdk = vi.hoisted(() => ({
  createSdkMcpServer: vi.fn((options: unknown) => options),
  tool: vi.fn((...args: unknown[]) => ({ args })),
  query: vi.fn(() =>
    (async function* () {
      yield {
        type: 'result',
        result: 'done',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })(),
  ),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => sdk);

describe('@obversa/engine-agent-sdk', () => {
  it('injects constructor memory into a provider-neutral request', async () => {
    const memory: Memory = {
      scope: 'test',
      async execute(command) {
        return {
          ok: false,
          command: command.command,
          error: { code: 'NOT_FOUND', message: 'missing' },
        };
      },
    };
    const options: AgentSdkEngineOptions = {
      defaultModel: 'claude-test',
      permissionMode: 'auto',
      memory,
    };
    const request = {
      prompt: 'test',
      model: 'claude-request-model',
    } satisfies AgentRequest;
    const requestHasMemory: 'memory' extends keyof AgentRequest ? true : false =
      false;

    const engine = new AgentSdkEngine(options);
    await engine.run(request, () => {}, new AbortController().signal);

    expect(engine.name).toBe('agent-sdk');
    expect(requestHasMemory).toBe(false);
    expect(sdk.tool).toHaveBeenCalledOnce();
    expect(sdk.createSdkMcpServer).toHaveBeenCalledOnce();
    expect(sdk.query).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          model: 'claude-request-model',
          mcpServers: expect.objectContaining({
            'lines-memory': expect.anything(),
          }),
        }),
      }),
    );
  });
});
