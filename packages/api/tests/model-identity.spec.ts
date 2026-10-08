import { describe, expect, it } from 'vitest';

import { EngineError, modelIdentity } from '../src/index.ts';

describe('modelIdentity', () => {
  it('reads the provider and the family from a provider/model string', () => {
    expect(modelIdentity('anthropic/claude-sonnet-4-5')).toEqual({
      provider: 'anthropic',
      modelFamily: 'claude',
    });
  });

  it.each([
    ['openrouter/anthropic/claude-sonnet-4-5', 'claude'],
    ['openrouter/anthropic/claude-sonnet-4.5', 'claude'],
    ['  OpenRouter/OpenAI/GPT-5.6-luna ', 'gpt'],
  ])('reads the gateway provider and underlying family from %j', (model, family) => {
    expect(modelIdentity(model)).toEqual({ provider: 'openrouter', modelFamily: family });
  });

  it('refuses an OpenRouter router because it chooses the model family', () => {
    expect(() => modelIdentity('openrouter/openrouter/auto'))
      .toThrow(/OpenRouter chooses.*family/);
  });

  it('reads the family alone from a bare model string', () => {
    expect(modelIdentity('gpt-5.6-luna')).toEqual({ modelFamily: 'gpt' });
    expect(modelIdentity('grok-4')).toEqual({ modelFamily: 'grok' });
  });

  it('lowercases both parts and ignores surrounding whitespace', () => {
    expect(modelIdentity('  OpenAI/GPT-5.6-luna ')).toEqual({ provider: 'openai', modelFamily: 'gpt' });
  });

  it('returns frozen values', () => {
    expect(Object.isFrozen(modelIdentity('grok-4'))).toBe(true);
  });

  it.each([
    ['', 'an empty string'],
    ['   ', 'whitespace'],
    ['unknown', 'the unknown placeholder'],
    ['Unknown-2', 'the unknown placeholder with a suffix'],
    ['-sonnet', 'a leading separator'],
    ['anthropic/', 'a provider with no model'],
    ['/claude-sonnet-4-5', 'a model with an empty provider'],
    ['anthropic/claude sonnet', 'a model name with a space'],
    ['anth ropic/claude-sonnet-4-5', 'a provider with a space'],
    ['anthropic/claude\tsonnet', 'a tab inside the model name'],
    ['anthropic//', 'a second separator with nothing after it'],
    ['anthropic//unknown', 'the unknown placeholder behind a second separator'],
    ['anthropic/claude/extra', 'two separators'],
    ['openrouter//claude-sonnet-4.5', 'an empty vendor'],
    ['openrouter/anthropic/', 'an empty gateway model'],
    ['openrouter/anthropic/claude/extra', 'three separators'],
    ['openrouter/anth ropic/claude-sonnet-4.5', 'a vendor with whitespace'],
    ['openrouter/anthropic/unknown-2', 'an unknown gateway family'],
    ['openrouter/anthropic/-sonnet', 'an empty gateway family'],
    ['openrouter/openrouter/auto', 'automatic model selection'],
    ['OPENROUTER/OpenRouter/free', 'automatic selection with mixed case'],
  ])('refuses %j (%s) with an invalid-config engine error', (model) => {
    let caught: unknown;
    try {
      modelIdentity(model);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EngineError);
    expect((caught as EngineError).kind).toBe('invalid-config');
    expect((caught as EngineError).message).toContain(JSON.stringify(model));
  });

  it('refuses a non-string the same way, never returning undefined', () => {
    expect(() => modelIdentity(undefined as unknown as string)).toThrow(EngineError);
    expect(() => modelIdentity(42 as unknown as string)).toThrow(EngineError);
  });
});
