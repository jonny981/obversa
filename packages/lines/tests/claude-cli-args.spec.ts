import { describe, it, expect } from 'vitest';

import { buildClaudeArgs } from '../src/engines/claude-cli.ts';

describe('buildClaudeArgs', () => {
  it('always uses headless stream-json and keeps the prompt out of argv', () => {
    const args = buildClaudeArgs({ prompt: 'do the thing' }, {});
    expect(args.slice(0, 4)).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
    expect(args).not.toContain('do the thing');
    expect(args).not.toContain('--permission-mode');
  });

  it('passes --permission-mode when set', () => {
    const args = buildClaudeArgs(
      { prompt: 'go' },
      { permissionMode: 'bypassPermissions' },
    );
    const i = args.indexOf('--permission-mode');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('bypassPermissions');
  });

  it('wires model, system prompt, and tool allowlist', () => {
    const args = buildClaudeArgs(
      {
        prompt: 'go',
        model: 'claude-haiku-4-5-20251001',
        system: 'be terse',
        allowedTools: ['Read', 'Bash'],
      },
      { defaultModel: 'ignored-when-req-has-model' },
    );
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-haiku-4-5-20251001');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('be terse');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,Bash');
  });

  it('can replace the default system prompt for a prompt-only turn', () => {
    const args = buildClaudeArgs(
      { prompt: 'select', system: 'selector only', systemMode: 'replace' },
      {},
    );
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('selector only');
    expect(args).not.toContain('--append-system-prompt');
  });

  it('can disable all available tools for a prompt-only turn', () => {
    const args = buildClaudeArgs({ prompt: 'select', tools: [] }, {});
    expect(args[args.indexOf('--tools') + 1]).toBe('');
  });

  it('strips Claude Code long-context suffixes before passing --model', () => {
    const args = buildClaudeArgs(
      { prompt: 'go', model: 'claude-fable-5 [1m]' },
      {},
    );
    expect(args[args.indexOf('--model') + 1]).toBe('claude-fable-5');
  });

  it('appends caller cliArgs', () => {
    const args = buildClaudeArgs(
      { prompt: 'go' },
      { cliArgs: ['--add-dir', '/tmp'] },
    );
    expect(args).toContain('--add-dir');
  });

  it('disallows the sub-agent tools for a leaf agent', () => {
    const args = buildClaudeArgs({ prompt: 'go', leaf: true }, {});
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Task,Agent');
    // a non-leaf turn never restricts spawning
    expect(buildClaudeArgs({ prompt: 'go' }, {})).not.toContain('--disallowedTools');
  });
});
