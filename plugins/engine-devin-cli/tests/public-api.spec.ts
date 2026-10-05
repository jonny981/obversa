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
      promptFile: '/tmp/prompt', exportFile: '/tmp/export', configFile: '/tmp/config.json',
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

  it('creates a seat that leaves the model to Devin', () => {
    const seat = devin();

    expect(seat.identity).toMatchObject({ adapter: 'devin-cli', provider: 'cognition', model: 'default' });
    expect(buildDevinArgs({ prompt: 'review', model: seat.identity.model, tools: ['read'] }, {}, {
      promptFile: '/tmp/prompt', exportFile: '/tmp/export', configFile: '/tmp/config.json',
    })).not.toContain('--model');
  });

  it('passes clean mode to the engine, and leaves the default to the engine', () => {
    const opts = (seat: ReturnType<typeof devin>) =>
      (seat.engine as unknown as { opts: { clean?: boolean } }).opts;

    expect(opts(devin('swe-2-max', { clean: true })).clean).toBe(true);
    expect(opts(devin(undefined, { clean: true })).clean).toBe(true);
    expect(opts(devin('swe-2-max')).clean).toBeUndefined();
  });

  it('passes the permission mode to the engine, and leaves the default to the engine', () => {
    const opts = (seat: ReturnType<typeof devin>) =>
      (seat.engine as unknown as { opts: DevinCliEngineOptions }).opts;

    expect(opts(devin('swe-2-max', { permissionMode: 'dangerous' })).permissionMode).toBe('dangerous');
    expect(opts(devin(undefined, { permissionMode: 'smart' })).permissionMode).toBe('smart');
    expect(opts(devin('swe-2-max')).permissionMode).toBeUndefined();
  });

  it('refuses an empty model name', () => {
    expect(() => devin(' ')).toThrow(TypeError);
  });
});
