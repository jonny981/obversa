import { describe, expect, it, vi } from 'vitest';
import type { Memory } from '@obversa/api';

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

  it('passes the engine effort to the SDK, a request effort over it, and records it', async () => {
    sdk.query.mockClear();
    const engine = new AgentSdkEngine({ effort: 'low' });
    const result = await engine.run({ prompt: 'fixture', effort: 'max' }, () => {}, new AbortController().signal);
    expect(sdk.query.mock.calls[0]?.[0]).toMatchObject({ options: { effort: 'max' } });
    expect(result.requested.effort).toBe('max');
    expect(result.effective.effort).toBe('max');
    await engine.run({ prompt: 'fixture' }, () => {}, new AbortController().signal);
    expect(sdk.query.mock.calls[1]?.[0]).toMatchObject({ options: { effort: 'low' } });
  });

  it('passes no effort when none is set', async () => {
    sdk.query.mockClear();
    const result = await new AgentSdkEngine().run({ prompt: 'fixture' }, () => {}, new AbortController().signal);
    expect('effort' in (sdk.query.mock.calls[0]?.[0] as { options: object }).options).toBe(false);
    expect('effort' in result.requested).toBe(false);
  });

  it.each([
    { clean: true, settingSources: ['project'], strictMcpConfig: true },
    { clean: false, settingSources: ['user', 'project', 'local'], strictMcpConfig: undefined },
  ] as const)('loads the setup sources for clean: $clean', async ({ clean, settingSources, strictMcpConfig }) => {
    sdk.query.mockClear();
    await new AgentSdkEngine({ clean }).run({
      prompt: 'Inspect the supplied work.', tools: ['Read', 'Edit'], workspaceMode: 'write',
    }, () => {}, new AbortController().signal);

    const options = (sdk.query.mock.calls[0]?.[0] as { options: Record<string, unknown> }).options;
    expect(options.settingSources).toEqual(settingSources);
    expect(options.strictMcpConfig).toBe(strictMcpConfig);
  });

  it('runs clean by default', async () => {
    sdk.query.mockClear();
    await new AgentSdkEngine({}).run({
      prompt: 'Inspect the supplied work.', tools: ['Read', 'Edit'], workspaceMode: 'write',
    }, () => {}, new AbortController().signal);

    const options = (sdk.query.mock.calls[0]?.[0] as { options: Record<string, unknown> }).options;
    expect(options.settingSources).toEqual(['project']);
    expect(options.strictMcpConfig).toBe(true);
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
