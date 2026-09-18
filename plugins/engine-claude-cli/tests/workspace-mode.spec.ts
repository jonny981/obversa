import { describe, expect, it } from 'vitest';

import { EngineError } from '@obversa/api';
import { buildClaudeArgs } from '../src/index.ts';

describe('Claude workspace access', () => {
  it.each([
    { mode: 'none', tools: '', approvals: undefined },
    { mode: 'read', tools: 'Read', approvals: 'Read(src/**)' },
    { mode: 'write', tools: 'Read,Edit,Bash', approvals: 'Read(src/**),Edit(src/**),Bash(node:*)' },
  ] as const)('bounds $mode access even when approvals are bypassed', ({ mode, tools, approvals }) => {
    for (const permissionMode of ['default', 'bypassPermissions'] as const) {
      const args = buildClaudeArgs({
        prompt: 'Inspect the supplied work.',
        tools: ['Read', 'Edit', 'Bash'],
        allowedTools: ['Read(src/**)', 'Edit(src/**)', 'Bash(node:*)'],
        workspaceMode: mode,
      }, { permissionMode });

      expect(args).toContain('--tools');
      expect(args[args.indexOf('--tools') + 1]).toBe(tools);
      if (approvals === undefined) {
        expect(args).not.toContain('--allowedTools');
      } else {
        expect(args[args.indexOf('--allowedTools') + 1]).toBe(approvals);
      }
    }
  });

  it('refuses a read request when its only declared tools can write', () => {
    expect(() => buildClaudeArgs({
      prompt: 'Review the work.',
      tools: ['Edit', 'Bash'],
      workspaceMode: 'read',
    }, {})).toThrow(EngineError);
  });

  it('returns a typed configuration failure for a blind read request', () => {
    expect(() => buildClaudeArgs({
      prompt: 'Review the work.', tools: [], workspaceMode: 'read',
    }, {})).toThrow(expect.objectContaining({ name: 'EngineError', kind: 'invalid-config' }));
  });

  it.each(['none', 'read'] as const)('refuses extra CLI arguments and custom tools in %s mode', (workspaceMode) => {
    expect(() => buildClaudeArgs({ prompt: 'fixture', tools: ['Read'], workspaceMode }, {
      cliArgs: ['--tools', 'Bash'],
    })).toThrow(EngineError);
    expect(() => buildClaudeArgs({ prompt: 'fixture', tools: ['Read', 'mcp__custom__write'], workspaceMode }, {}))
      .toThrow(EngineError);
  });

  it('does not expose an undeclared tool through a write-mode approval', () => {
    const args = buildClaudeArgs({
      prompt: 'fixture', tools: ['Read'], allowedTools: ['Read(src/**)', 'Grep', 'Bash'], workspaceMode: 'write',
    }, {});
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read(src/**)');
  });
});
