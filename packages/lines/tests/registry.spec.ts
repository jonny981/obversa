import { describe, it, expect } from 'vitest';

import { EngineRegistry } from '../src/engines/registry.ts';
import { LoopError } from '../src/api.ts';
import { isEngine } from '../src/engines/engine.ts';
import { MockEngine } from '../src/testing.ts';

describe('EngineRegistry', () => {
  it('resolves built-in names to engines', () => {
    const reg = new EngineRegistry();
    for (const name of ['agent-sdk', 'claude-cli', 'codex', 'anthropic-api']) {
      expect(reg.has(name)).toBe(true);
      expect(reg.create(name, 'agent-sdk').name).toBe(name);
    }
  });

  it('caches the instance per name', () => {
    const reg = new EngineRegistry();
    expect(reg.create('claude-cli', 'claude-cli')).toBe(
      reg.create('claude-cli', 'claude-cli'),
    );
  });

  it('throws a CONFIG error for an unknown engine', () => {
    const reg = new EngineRegistry();
    try {
      reg.create('nope', 'nope');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(LoopError);
      expect((e as LoopError).code).toBe('CONFIG');
    }
  });

  it('accepts a custom drop-in engine by name', () => {
    const reg = new EngineRegistry();
    const mine = new MockEngine(() => 'hi');
    reg.register('mine', () => mine);
    expect(reg.create('mine', 'agent-sdk')).toBe(mine);
  });

  it('passes through a ready-made Engine instance (EngineRef)', () => {
    const reg = new EngineRegistry();
    const mine = new MockEngine(() => 'hi');
    expect(isEngine(mine)).toBe(true);
    expect(reg.create(mine, 'agent-sdk')).toBe(mine);
  });
});
