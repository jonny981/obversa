import { describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';

import { finalResultText } from '@obversa/engine';
import type {
  OwnedCommandRequest,
  OwnedCommandResult,
} from '@obversa/engine/command';

const commandMock = vi.hoisted(() => ({
  runOwnedCommand: vi.fn(),
}));

vi.mock('@obversa/engine/command', async () => {
  const actual = await vi.importActual<typeof import('@obversa/engine/command')>('@obversa/engine/command');
  return { ...actual, runOwnedCommand: commandMock.runOwnedCommand };
});

import { CodexEngine } from '../src/index.ts';

describe('Codex timeout propagation', () => {
  it('turns a timed-out null exit with a saved result into a timeout transport failure', async () => {
    commandMock.runOwnedCommand.mockImplementation(async (request: OwnedCommandRequest): Promise<OwnedCommandResult> => {
      if (request.args.length === 1 && request.args[0] === '--version') {
        return {
          exitCode: 0,
          stdout: new TextEncoder().encode('codex-cli 1.0.0\n'),
          stderr: new Uint8Array(),
          timedOut: false,
          aborted: false,
          peakMemoryBytes: 0,
          remainingProcesses: [],
        };
      }
      const outputIndex = request.args.indexOf('-o');
      const outputPath = outputIndex >= 0 ? request.args[outputIndex + 1] : undefined;
      if (outputPath === undefined) throw new Error('output path is required');
      writeFileSync(outputPath, 'PONG');
      return {
        exitCode: null,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        timedOut: true,
        aborted: false,
        peakMemoryBytes: 0,
        remainingProcesses: [],
      };
    });

    const result = await new CodexEngine({ cliBinary: process.execPath }).run(
      { prompt: 'ping', timeoutMs: 300, timeoutGraceMs: 100 },
      () => {},
      new AbortController().signal,
    );

    expect(commandMock.runOwnedCommand).toHaveBeenCalledTimes(2);
    const [versionRequest, modelRequest] = commandMock.runOwnedCommand.mock.calls.map(([request]) => request);
    expect(versionRequest?.args).toEqual(['--version']);
    expect(modelRequest?.args[0]).toBe('exec');
    expect(modelRequest?.args).toContain('-o');
    expect(finalResultText(result)).toBe('PONG');
    expect(result.transportFailure).toMatchObject({
      kind: 'timeout',
      exitCode: null,
    });
  });
});
