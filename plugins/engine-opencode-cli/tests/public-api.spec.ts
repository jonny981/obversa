import { describe, expect, it } from 'vitest';

import {
  OpenCodeCliEngine,
  opencode,
  buildOpenCodeInvocation,
  type OpenCodeCliEngineOptions,
  type OpenCodeCliIdentity,
} from '../src/index.ts';

describe('@obversa/engine-opencode-cli', () => {
  it('exports the package-owned engine, identity, options, and builder', () => {
    const identity: OpenCodeCliIdentity = {
      provider: 'fixture-provider',
      modelFamily: 'fixture-family',
    };
    const options: OpenCodeCliEngineOptions = {
      executable: '/usr/bin/false',
      version: '1.18.23',
      identity,
    };

    const engine = new OpenCodeCliEngine(options);

    expect(engine.name).toBe('opencode-cli');
    expect(typeof buildOpenCodeInvocation).toBe('function');
  });

  it('creates the declarative seat shape from a provider model and executable', () => {
    const seat = opencode('opencode/big-pickle', { executable: '/usr/bin/false' });

    expect(seat.engine.name).toBe('opencode-cli');
    expect(seat.identity).toEqual({
      adapter: 'opencode-cli',
      provider: 'opencode',
      modelFamily: 'big',
      model: 'opencode/big-pickle',
      tools: ['read', 'grep'],
    });
  });

  it('derives one lowercased family from each model identifier', () => {
    const sonnet = opencode('anthropic/claude-sonnet-4-5', { executable: '/usr/bin/false' });
    const opus = opencode('anthropic/claude-opus-4-1', { executable: '/usr/bin/false' });
    const gpt = opencode('openai/GPT-5.6-luna', { executable: '/usr/bin/false' });

    // The family is the first hyphen-delimited segment of the model identifier,
    // lowercased: claude-sonnet-4-5 -> claude, claude-opus-4-1 -> claude,
    // gpt-5.6-luna -> gpt.
    expect(sonnet.identity).toMatchObject({ provider: 'anthropic', modelFamily: 'claude' });
    expect(opus.identity).toMatchObject({ provider: 'anthropic', modelFamily: 'claude' });
    expect(gpt.identity).toMatchObject({ provider: 'openai', modelFamily: 'gpt' });
  });

  it('refuses a model with an empty first family segment', () => {
    expect(() => opencode('anthropic/-claude-sonnet-4-5', { executable: '/usr/bin/false' }))
      .toThrow('OpenCode model family must not be empty');
  });
});
