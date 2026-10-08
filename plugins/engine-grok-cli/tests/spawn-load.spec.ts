import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EngineError } from '@obversa/api';
import { OwnedCommandError } from '@obversa/core/command';

const commandMock = vi.hoisted(() => ({
  refused: false,
  runOwnedCommand: vi.fn(),
  resolveCommandExecutable: vi.fn(),
}));

vi.mock('@obversa/core/command', async () => {
  const actual = await vi.importActual<typeof import('@obversa/core/command')>('@obversa/core/command');
  return {
    ...actual,
    runOwnedCommand: commandMock.runOwnedCommand,
    resolveCommandExecutable: commandMock.resolveCommandExecutable,
  };
});

import { GrokCliEngine } from '../src/index.ts';

// Once the system refuses a start, looking up the executable fails too.
function refuseStart(code: string, process: 'version' | 'model'): void {
  commandMock.refused = false;
  commandMock.resolveCommandExecutable.mockImplementation((executable: string) => {
    if (commandMock.refused) throw new Error('executable lookup failed');
    return executable;
  });
  commandMock.runOwnedCommand.mockImplementation(async (request: { args: readonly string[] }) => {
    if (process === 'model' && request.args.includes('--version')) {
      return {
        exitCode: 0,
        signal: null,
        stdout: new TextEncoder().encode('grok 1.0.44\n'),
        stderr: new Uint8Array(),
        timedOut: false,
        aborted: false,
      };
    }
    commandMock.refused = true;
    throw new OwnedCommandError('SPAWN_FAILED', `spawn grok ${code}`, [], code);
  });
}

async function failure(): Promise<unknown> {
  return await new GrokCliEngine({
    executable: '/usr/local/bin/grok',
    version: '1.0.44',
    identity: { provider: 'xai', modelFamily: 'grok-4' },
    permissionMode: 'dontAsk',
  }).run(
    { prompt: 'build', model: 'grok-4', cwd: globalThis.process.cwd() },
    () => {},
    new AbortController().signal,
  ).catch((error: unknown) => error);
}

describe('Grok spawn failure under load', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['EAGAIN', 'version'],
    ['EMFILE', 'version'],
    ['ENOMEM', 'version'],
    ['EAGAIN', 'model'],
    ['EMFILE', 'model'],
    ['ENOMEM', 'model'],
  ] as const)('reports %s at the %s process as retryable, not as a missing CLI', async (code, process) => {
    refuseStart(code, process);

    const error = await failure();

    expect(error).toBeInstanceOf(EngineError);
    expect(error).toMatchObject({
      kind: 'transient',
      message: `the system refused to start the Grok process (${code})`,
    });
    expect(commandMock.runOwnedCommand).toHaveBeenCalledTimes(process === 'model' ? 2 : 1);
  });

  it.each(['version', 'model'] as const)('still reports a missing CLI at the %s process when the executable is gone', async (process) => {
    refuseStart('ENOENT', process);

    expect(await failure()).toMatchObject({ kind: 'missing-cli' });
  });
});
