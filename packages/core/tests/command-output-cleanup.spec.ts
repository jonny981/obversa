import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/command/process-tree.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/command/process-tree.ts')>('../src/command/process-tree.ts');
  return { ...actual, stopOwnedProcessTree: vi.fn() };
});

import { stopOwnedProcessTree } from '../src/command/process-tree.ts';
import { runOwnedCommand, type OwnedCommandRequest } from '../src/command/run.ts';
import { parentFixture, fixtureDirectory, fixturePids, isProcessAlive, waitForFixtureRecord } from './process-fixture.ts';

const ATTEMPT_ID = `sha256:${'3'.repeat(64)}` as const;
const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    for (const pid of fixturePids(directory)) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }
});

function request(directory: string): OwnedCommandRequest {
  return {
    executable: process.execPath,
    args: [parentFixture, 'flood-ignore', directory],
    cwd: import.meta.dirname,
    env: {},
    stdin: '',
    attemptId: ATTEMPT_ID,
    runId: 'output-cleanup',
    timeoutMs: 5_000,
    teardownGraceMs: 500,
    maxOutputBytes: 64,
    maxMemoryBytes: 512 * 1_024 * 1_024,
  };
}

describe.runIf(process.platform !== 'win32')('owned command output cleanup', () => {
  it('retains surviving detached descendants when output reaches its cap', async () => {
    const directory = fixtureDirectory();
    directories.push(directory);
    const cleanup = vi.mocked(stopOwnedProcessTree);
    cleanup.mockImplementation(async () => {
      const survivor = await waitForFixtureRecord(directory, 'grandchild');
      return [{
        pid: survivor.pid,
        parentPid: survivor.parentPid,
        processGroupId: survivor.pid,
        startedAt: 'fixture-survivor',
      }];
    });

    const running = runOwnedCommand(request(directory), new AbortController().signal);
    const survivor = await waitForFixtureRecord(directory, 'grandchild');
    await expect(running).rejects.toMatchObject({
      code: 'TEARDOWN_INCOMPLETE',
      remainingProcesses: expect.arrayContaining([
        expect.objectContaining({ pid: survivor.pid }),
      ]),
    });
    expect(isProcessAlive(survivor.pid)).toBe(true);

    try { process.kill(survivor.pid, 'SIGKILL'); } catch {}
    await expect.poll(() => isProcessAlive(survivor.pid), { timeout: 5_000 }).toBe(false);
  });
});
