import { describe, expect, it } from 'vitest';

import {
  CodexEngine,
  buildCodexArgs,
  type CodexEngineOptions,
} from '../src/index.ts';

describe('@obversa/engine-codex', () => {
  it('exports the package-owned engine, options, and argument builder', () => {
    const options: CodexEngineOptions = {
      defaultModel: 'gpt-test',
      cliBinary: '/usr/bin/false',
      cliArgs: ['--debug'],
      permissionMode: 'plan',
    };

    const engine = new CodexEngine(options);

    expect(engine.name).toBe('codex');
    expect(buildCodexArgs({ prompt: 'review' }, options, '/tmp/out')).toContain(
      'gpt-test',
    );
  });
});
