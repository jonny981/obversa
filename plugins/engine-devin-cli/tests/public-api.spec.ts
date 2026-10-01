import { describe, expect, it } from 'vitest';

import {
  DevinCliEngine,
  buildDevinArgs,
  devin,
  type DevinCliEngineOptions,
} from '../src/index.ts';

describe('@obversa/engine-devin-cli', () => {
  it('exports the engine, its options and the argument builder', () => {
    const options: DevinCliEngineOptions = { defaultModel: 'swe-2-max', cliBinary: '/usr/bin/false' };

    expect(new DevinCliEngine(options).name).toBe('devin-cli');
    expect(buildDevinArgs({ prompt: 'review', tools: ['read'] }, options, {
      promptFile: '/tmp/prompt', exportFile: '/tmp/export',
    })).toContain('swe-2-max');
  });

  it('creates a seat keyed by the named model', () => {
    const seat = devin('claude-opus-5-5-max');

    expect(seat.engine).toBeInstanceOf(DevinCliEngine);
    expect(seat.identity).toEqual({
      adapter: 'devin-cli',
      provider: 'cognition',
      modelFamily: 'claude',
      model: 'claude-opus-5-5-max',
      tools: ['read', 'edit', 'exec'],
    });
  });

  it('creates a seat that leaves the model to the person\'s Devin settings', () => {
    const seat = devin();

    expect(seat.identity).toMatchObject({ adapter: 'devin-cli', provider: 'cognition', model: 'default' });
    expect(buildDevinArgs({ prompt: 'review', model: seat.identity.model, tools: ['read'] }, {}, {
      promptFile: '/tmp/prompt', exportFile: '/tmp/export',
    })).not.toContain('--model');
  });

  it('refuses an empty model name', () => {
    expect(() => devin(' ')).toThrow(TypeError);
  });
});
