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

import { DevinCliEngine } from '../src/index.ts';

// Once the system refuses a start, looking up the executable fails too.
function refuseStart(code: string, stage: 'version' | 'model'): void {
  commandMock.refused = false;
  commandMock.resolveCommandExecutable.mockImplementation(() => {
    if (commandMock.refused) throw new Error('executable lookup failed');
    return process.execPath;
  });
  commandMock.runOwnedCommand.mockImplementation(async (request: { args: readonly string[] }) => {
    if (stage === 'model' && request.args.includes('--version')) {
      return {
        exitCode: 0,
        signal: null,
        stdout: new TextEncoder().encode('devin 1.0.0 (abc123)\n'),
        stderr: new Uint8Array(),
        timedOut: false,
        aborted: false,
      };
    }
    commandMock.refused = true;
    throw new OwnedCommandError('SPAWN_FAILED', `spawn ${process.execPath} ${code}`, [], code);
  });
}

async function failure(): Promise<unknown> {
  return await new DevinCliEngine({ cliBinary: process.execPath }).run(
    { prompt: 'build', cwd: process.cwd() },
    () => {},
    new AbortController().signal,
  ).catch((error: unknown) => error);
}

describe('Devin spawn failure under load', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['EAGAIN', 'version'],
    ['EMFILE', 'version'],
    ['ENOMEM', 'version'],
    ['EAGAIN', 'model'],
    ['EMFILE', 'model'],
    ['ENOMEM', 'model'],
  ] as const)('reports %s at the %s process as retryable, not as a missing CLI', async (code, stage) => {
    refuseStart(code, stage);

    const error = await failure();

    expect(error).toBeInstanceOf(EngineError);
    expect(error).toMatchObject({
      kind: 'transient',
      message: `the system refused to start the Devin process (${code})`,
    });
    expect(commandMock.runOwnedCommand).toHaveBeenCalledTimes(stage === 'model' ? 2 : 1);
  });

  it.each(['version', 'model'] as const)('still reports a missing CLI at the %s process when the executable is gone', async (stage) => {
    refuseStart('ENOENT', stage);

    expect(await failure()).toMatchObject({ kind: 'missing-cli' });
  });
});
