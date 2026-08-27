import { describe, expect, it } from 'vitest';

import {
  ClaudeCliEngine,
  type ClaudeCliEngineOptions,
} from '../src/index.ts';

describe('@obversa/engine-claude-cli', () => {
  it('constructs the public engine with package-owned options', () => {
    const options: ClaudeCliEngineOptions = {
      defaultModel: 'claude-test',
      cliBinary: '/usr/bin/false',
      cliArgs: ['--debug'],
      permissionMode: 'auto',
    };

    const engine = new ClaudeCliEngine(options);

    expect(engine.name).toBe('claude-cli');
  });
});
