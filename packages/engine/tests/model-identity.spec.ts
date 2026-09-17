import { describe, expect, it } from 'vitest';

import { EngineError, modelIdentity } from '../src/index.ts';

describe('modelIdentity', () => {
  it('reads the provider and the family from a provider/model string', () => {
    expect(modelIdentity('anthropic/claude-sonnet-4-5')).toEqual({
      provider: 'anthropic',
      modelFamily: 'claude',
    });
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
