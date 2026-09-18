import { describe, expect, it } from 'vitest';

import {
  ClaudeCliEngine,
  claude,
  type ClaudeCliEngineOptions,
} from '../src/index.ts';

describe('@obversa/engine-claude-cli', () => {
  it('constructs the public engine with package-owned options', () => {
    const options: ClaudeCliEngineOptions = {
      defaultModel: 'claude-test',
      cliBinary: '/usr/bin/false',
      cliArgs: ['--debug'],
      permissionMode: 'auto',
    };

    const engine = new ClaudeCliEngine(options);

    expect(engine.name).toBe('claude-cli');
  });

  it('creates a write-capable declarative seat with the package identity', () => {
    const seat = claude('claude-sonnet-4-5');

    expect(seat.engine).toBeInstanceOf(ClaudeCliEngine);
    expect(seat.identity).toEqual({
      adapter: 'claude-cli',
      provider: 'anthropic',
      modelFamily: 'claude',
      model: 'claude-sonnet-4-5',
      tools: ['Read', 'Edit', 'Bash'],
    });
    expect((seat.engine as unknown as { opts: ClaudeCliEngineOptions }).opts.permissionMode)
      .toBe('bypassPermissions');
  });

  it('passes a caller permission mode to the engine', () => {
    const seat = claude('claude-sonnet-4-5', { permissionMode: 'plan' });

    expect((seat.engine as unknown as { opts: ClaudeCliEngineOptions }).opts.permissionMode)
      .toBe('plan');
  });
});
