import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createAttemptIdentity } from '../src/runtime/attempt.ts';
import {
  capturePipeOwnerProbe,
  inspectOwnedProcessTree,
  inspectPipeHoldingProcesses,
  parseWindowsProcessRows,
  readAttemptMarkerProcessIds,
  stopOwnedProcessTree,
} from '../src/runtime/process-tree.ts';
import {
  cleanupFixture,
  fixtureDirectory,
  fixturePids,
  isProcessAlive,
  parentFixture,
  waitForFixtureRecord,
} from './process-fixture.ts';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) cleanupFixture(directory);
});

describe('attempt process markers', () => {
  it('matches one exact NUL-delimited attempt marker', async () => {
    const directory = fixtureDirectory();
    directories.push(directory);
    const attemptId = createAttemptIdentity({
      namespace: 'tenant-a',
      streamId: 'run-1',
      nodeId: 'review',
      position: 'items/marker',
    }).attemptId;
    for (const pid of ['101', '102', 'not-a-pid']) {
      mkdirSync(join(directory, pid));
    }
    writeFileSync(
      join(directory, '101', 'environ'),
      Buffer.from(`OTHER=value\0LINES_ATTEMPT_ID=${attemptId}\0`, 'utf8'),
    );
    writeFileSync(
      join(directory, '102', 'environ'),
      Buffer.from(`OTHER=prefix-${attemptId}\0`, 'utf8'),
    );
    writeFileSync(
      join(directory, 'not-a-pid', 'environ'),
      Buffer.from(`LINES_ATTEMPT_ID=${attemptId}\0`, 'utf8'),
    );

    await expect(
      readAttemptMarkerProcessIds(attemptId, directory),
    ).resolves.toEqual([101]);
  });

  it('parses stable Windows process identities and memory', () => {
    expect(
      parseWindowsProcessRows(
        '101\t10\t4096\t638917824000000000\r\ninvalid\r\n',
      ),
    ).toEqual([
      {
        identity: {
          pid: 101,
          parentPid: 10,
          processGroupId: 0,
          startedAt: '638917824000000000',
        },
        residentBytes: 4_096,
      },
    ]);
  });
});

describe.runIf(process.platform !== 'win32')('owned process trees', () => {
  it('finds a detached grandchild through the direct process group', async () => {
    const directory = fixtureDirectory();
    directories.push(directory);
    const attemptId = createAttemptIdentity({
      namespace: 'tenant-a',
      streamId: 'run-1',
      nodeId: 'review',
      position: 'items/first',
    }).attemptId;
    const root = spawn(
      process.execPath,
      [parentFixture, 'ignore', directory],
      {
        detached: true,
        env: {
          ...process.env,
          LINES_ATTEMPT_ID: attemptId,
          LINES_RUN_ID: 'run-1',
          LINES_HEADLESS: '1',
        },
        stdio: 'ignore',
      },
    );

    await waitForFixtureRecord(directory, 'parent');
    const expected = fixturePids(directory);
    const observed = await inspectOwnedProcessTree({
      attemptId,
      rootPid: root.pid!,
      rootProcessGroupId: root.pid!,
    });

    expect(observed.map((process) => process.pid).sort()).toEqual(
      [...expected].sort(),
    );
    expect(
      new Set(
        observed.map((process) => `${process.pid}:${process.startedAt}`),
      ).size,
    ).toBe(observed.length);
    expect(observed.every((process) => process.startedAt.length > 0)).toBe(true);

    const remaining = await stopOwnedProcessTree({
      attemptId,
      rootPid: root.pid!,
      rootProcessGroupId: root.pid!,
      observed,
      graceMs: 100,
    });
    expect(remaining).toEqual([]);
    expect(expected.some(isProcessAlive)).toBe(false);
  });

  it('does not stop an unrelated process', async () => {
    const directory = fixtureDirectory();
    const unrelatedDirectory = fixtureDirectory();
    directories.push(directory, unrelatedDirectory);
    const attemptId = createAttemptIdentity({
      namespace: 'tenant-a',
      streamId: 'run-1',
      nodeId: 'review',
      position: 'items/second',
    }).attemptId;
    const owned = spawn(process.execPath, [parentFixture, 'ignore', directory], {
      detached: true,
      env: { ...process.env, LINES_ATTEMPT_ID: attemptId },
      stdio: 'ignore',
    });
    const unrelated = spawn(
      process.execPath,
      [parentFixture, 'ignore', unrelatedDirectory],
      { detached: true, stdio: 'ignore' },
    );
    await Promise.all([
      waitForFixtureRecord(directory, 'parent'),
      waitForFixtureRecord(unrelatedDirectory, 'parent'),
    ]);

    const observed = await inspectOwnedProcessTree({
      attemptId,
      rootPid: owned.pid!,
      rootProcessGroupId: owned.pid!,
    });
    await stopOwnedProcessTree({
      attemptId,
      rootPid: owned.pid!,
      rootProcessGroupId: owned.pid!,
      observed,
      graceMs: 100,
    });

    expect(isProcessAlive(unrelated.pid!)).toBe(true);
  });
});

describe.runIf(process.platform === 'darwin')('owned pipe identity', () => {
  it('does not follow a file descriptor reused by an unrelated child', async () => {
    const first = spawn('/usr/bin/true', [], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const oldDescriptors = [
      (first.stdout as unknown as { _handle: { fd: number } })._handle.fd,
      (first.stderr as unknown as { _handle: { fd: number } })._handle.fd,
    ];
    const probe = capturePipeOwnerProbe(oldDescriptors);
    await new Promise<void>((resolve) => first.once('close', () => resolve()));

    const unrelated = spawn('/bin/sleep', ['30'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const newDescriptors = [
      (unrelated.stdout as unknown as { _handle: { fd: number } })._handle.fd,
      (unrelated.stderr as unknown as { _handle: { fd: number } })._handle.fd,
    ];

    try {
      expect(newDescriptors.some((fd) => oldDescriptors.includes(fd))).toBe(true);
      const holders = await inspectPipeHoldingProcesses(probe.fileDescriptors);
      expect(holders.map((process) => process.pid)).not.toContain(unrelated.pid);
    } finally {
      probe.close();
      unrelated.kill('SIGKILL');
    }
  });
});

describe.runIf(process.platform === 'win32')('Windows owned process trees', () => {
  it('stops a direct child and its descendants with the platform tree operation', async () => {
    const directory = fixtureDirectory();
    directories.push(directory);
    const attemptId = createAttemptIdentity({
      namespace: 'tenant-a',
      streamId: 'run-1',
      nodeId: 'review',
      position: 'items/windows',
    }).attemptId;
    const root = spawn(process.execPath, [parentFixture, 'ignore', directory], {
      env: { ...process.env, LINES_ATTEMPT_ID: attemptId },
      stdio: 'ignore',
    });
    await waitForFixtureRecord(directory, 'parent');
    const expected = fixturePids(directory);

    const remaining = await stopOwnedProcessTree({
      attemptId,
      rootPid: root.pid!,
      rootProcessGroupId: root.pid!,
      graceMs: 100,
    });

    expect(remaining).toEqual([]);
    expect(expected.some(isProcessAlive)).toBe(false);
  });
});
