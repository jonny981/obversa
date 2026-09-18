import { describe, expect, it } from 'vitest';

import { buildCodexArgs } from '../src/index.ts';

describe('Codex workspace access', () => {
  it.each([
    { mode: 'read', sandbox: 'workspace-write' },
    { mode: 'read', sandbox: 'danger-full-access' },
    { mode: 'write', sandbox: 'read-only' },
  ] as const)('refuses $sandbox when the request requires $mode', ({ mode, sandbox }) => {
    expect(() => buildCodexArgs({
      prompt: 'Run the declared attempt.',
      tools: ['Read', 'Edit', 'Bash'],
      workspaceMode: mode,
    }, { sandbox }, '/tmp/obversa-mode-result')).toThrow(
      expect.objectContaining({ name: 'EngineError', kind: 'invalid-config' }),
    );
  });

  it('does not let permission bypass override a read-only request', () => {
    expect(() => buildCodexArgs({
      prompt: 'Review the work.', tools: ['Read'], workspaceMode: 'read',
    }, { permissionMode: 'bypassPermissions' }, '/tmp/obversa-mode-result')).toThrow(
      expect.objectContaining({ name: 'EngineError', kind: 'invalid-config' }),
    );
  });

  it('refuses none instead of substituting a readable workspace', () => {
    expect(() => buildCodexArgs({
      prompt: 'Answer without opening any file.',
      tools: ['Read'],
      workspaceMode: 'none',
    }, {}, '/tmp/obversa-mode-result')).toThrow(
      expect.objectContaining({ name: 'EngineError', kind: 'invalid-config' }),
    );
  });
});
