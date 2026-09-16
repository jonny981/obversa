import { describe, expect, it } from 'vitest';

import {
  CodexEngine,
  buildCodexArgs,
  codex,
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

  it('creates a write-capable declarative seat with the package identity', () => {
    const seat = codex('gpt-5.6-luna');

    expect(seat.engine).toBeInstanceOf(CodexEngine);
    expect(seat.identity).toEqual({
      adapter: 'codex',
      provider: 'openai',
      modelFamily: 'gpt',
      model: 'gpt-5.6-luna',
      tools: ['Read', 'Edit', 'Bash'],
    });
    expect((seat.engine as unknown as { opts: CodexEngineOptions }).opts).toMatchObject({
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
    });
  });

  it('passes a caller sandbox choice without enabling the dangerous bypass', () => {
    const seat = codex('gpt-5.6-luna', { sandbox: 'read-only' });

    expect((seat.engine as unknown as { opts: CodexEngineOptions }).opts).toMatchObject({
      sandbox: 'read-only',
      approvalPolicy: 'never',
    });
  });
});
