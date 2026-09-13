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
      modelFamily: 'big-pickle',
      model: 'opencode/big-pickle',
    });
  });
});
