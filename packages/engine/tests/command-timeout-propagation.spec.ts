import { describe, expect, it, vi } from 'vitest';

const processMock = vi.hoisted(() => ({
  runChild: vi.fn(),
}));

vi.mock('@obversa/process', async () => {
  const actual = await vi.importActual<typeof import('@obversa/process')>('@obversa/process');
  return { ...actual, runChild: processMock.runChild };
});

import { runOwnedCommand, type OwnedCommandRequest } from '../src/command/run.ts';

const ATTEMPT_ID =
  'sha256:1111111111111111111111111111111111111111111111111111111111111111' as const;

const command: OwnedCommandRequest = {
  executable: process.execPath,
  args: [],
  cwd: import.meta.dirname,
  env: {},
  stdin: '',
  attemptId: ATTEMPT_ID,
  runId: 'run-1',
  timeoutMs: 100,
  teardownGraceMs: 100,
  maxOutputBytes: 1_024,
  maxMemoryBytes: 512 * 1_024 * 1_024,
};

describe('owned command timeout propagation', () => {
  it('keeps a timeout recorded by the child runner when the child closes first', async () => {
    processMock.runChild.mockResolvedValue({
      exitCode: null,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      timedOut: true,
      aborted: false,
    });

    await expect(runOwnedCommand(command, new AbortController().signal)).resolves.toMatchObject({
      exitCode: null,
      timedOut: true,
      aborted: false,
    });
  });
});
