import { describe, expect, it } from 'vitest';

import {
  OpenCodeCliEngine,
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
});
