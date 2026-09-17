import { describe, expect, it, vi } from 'vitest';
import type { Memory } from '@obversa/memory';

import { AgentSdkEngine, agentSdkToolOptions } from '../src/index.ts';

const sdk = vi.hoisted(() => ({
  query: vi.fn((_input: unknown) => (async function* () {
    yield {
      type: 'result',
      result: 'done',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  })()),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => sdk);

describe('Agent SDK workspace access', () => {
  it.each([
    { mode: 'none', tools: [], approvals: [] },
    { mode: 'read', tools: ['Read'], approvals: ['Read(src/**)'] },
    { mode: 'write', tools: ['Read', 'Edit', 'Bash'], approvals: ['Read(src/**)', 'Edit(src/**)', 'Bash(node:*)'] },
  ] as const)('bounds $mode access independently of permission mode', async ({ mode, tools, approvals }) => {
    for (const permissionMode of ['default', 'bypassPermissions'] as const) {
      sdk.query.mockClear();
      await new AgentSdkEngine({ permissionMode }).run({
        prompt: 'Inspect the supplied work.',
        tools: ['Read', 'Edit', 'Bash'],
        allowedTools: ['Read(src/**)', 'Edit(src/**)', 'Bash(node:*)'],
        workspaceMode: mode,
      }, () => {}, new AbortController().signal);

      expect(sdk.query).toHaveBeenCalledOnce();
      expect(sdk.query.mock.calls[0]?.[0]).toMatchObject({
        options: { tools, allowedTools: approvals },
      });
    }
  });

  it('refuses a read request with no declared reading tool', () => {
    expect(() => agentSdkToolOptions({
      tools: ['Edit', 'Bash'],
      workspaceMode: 'read',
    })).toThrow();
  });

  it.each(['none', 'read'] as const)('refuses a writable memory extension before query in %s mode', async (workspaceMode) => {
    sdk.query.mockClear();
    const memory: Memory = {
      scope: 'fixture',
      async execute(command) {
        return { ok: false, command: command.command, error: { code: 'NOT_FOUND', message: 'fixture' } };
      },
    };
    await expect(new AgentSdkEngine({ memory }).run({
      prompt: 'fixture', tools: ['Read'], workspaceMode,
    }, () => {}, new AbortController().signal)).rejects.toMatchObject({ kind: 'invalid-config' });
    expect(sdk.query).not.toHaveBeenCalled();
  });

  it('does not expose an undeclared tool through a write-mode approval', () => {
    expect(agentSdkToolOptions({
      tools: ['Read'], allowedTools: ['Read(src/**)', 'Grep', 'Bash'], workspaceMode: 'write',
    }).allowedTools).toEqual(['Read(src/**)']);
  });
});
