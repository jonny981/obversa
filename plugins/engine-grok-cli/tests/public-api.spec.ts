import { describe, expect, it } from 'vitest';

import {
  GrokCliEngine,
  buildGrokArgs,
  type GrokCliEngineOptions,
  type GrokCliIdentity,
} from '../src/index.ts';

describe('@obversa/engine-grok-cli', () => {
  it('exports the package-owned engine, identity, options, and builder', () => {
    const identity: GrokCliIdentity = {
      provider: 'xai',
      modelFamily: 'grok-4',
    };
    const options: GrokCliEngineOptions = {
      executable: '/usr/bin/false',
      version: '1.0.5',
      identity,
      permissionMode: 'dontAsk',
    };

    const engine = new GrokCliEngine(options);

    expect(engine.name).toBe('grok-cli');
    expect(typeof buildGrokArgs).toBe('function');
  });
});
