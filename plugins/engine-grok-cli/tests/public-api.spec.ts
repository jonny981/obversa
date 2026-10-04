import { describe, expect, it } from 'vitest';

import {
  GrokCliEngine,
  buildGrokArgs,
  grok,
  type GrokCliEngineOptions,
  type GrokCliIdentity,
  type GrokSeat,
} from '../src/index.ts';

describe('@obversa/engine-grok-cli', () => {
  it('exports the package-owned engine, seat, identity, options, and builder', () => {
    const identity: GrokCliIdentity = {
      provider: 'xai',
      modelFamily: 'grok-4',
    };
    const options: GrokCliEngineOptions = {
      executable: '/usr/bin/false',
      version: '1.0.44',
      identity,
      permissionMode: 'dontAsk',
    };

    const engine = new GrokCliEngine(options);

    expect(engine.name).toBe('grok-cli');
    expect(typeof buildGrokArgs).toBe('function');
    const seat: GrokSeat = grok('grok-4', { executable: '/usr/bin/false' });
    expect(seat.engine).toBeInstanceOf(GrokCliEngine);
  });
});
