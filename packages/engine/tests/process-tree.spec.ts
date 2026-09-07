import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  capturePipeOwnerProbe,
  inspectOwnedProcessTree,
  inspectPipeHoldingProcesses,
  parseWindowsProcessRows,
  readAttemptMarkerProcessIds,
  stopOwnedProcessTree,
} from '../src/command/process-tree.ts';
import {
  cleanupFixture,
  fixtureDirectory,
  fixturePids,
  isProcessAlive,
  parentFixture,
  waitForFixtureRecord,
} from './process-fixture.ts';

const directories: string[] = [];
const ATTEMPT_ID =
  'sha256:2222222222222222222222222222222222222222222222222222222222222222' as const;

afterEach(() => {
  for (const directory of directories.splice(0)) cleanupFixture(directory);
});

describe('attempt process markers', () => {
  it('matches one exact NUL-delimited attempt marker', async () => {
    const directory = fixtureDirectory();
    directories.push(directory);
    const attemptId = ATTEMPT_ID;
    for (const pid of ['101', '102', 'not-a-pid']) {
      mkdirSync(join(directory, pid));
    }
    writeFileSync(
      join(directory, '101', 'environ'),
      Buffer.from(`OTHER=value\0OBVERSA_ATTEMPT_ID=${attemptId}\0`, 'utf8'),
    );
    writeFileSync(
      join(directory, '102', 'environ'),
      Buffer.from(`OTHER=prefix-${attemptId}\0`, 'utf8'),
    );
    writeFileSync(
      join(directory, 'not-a-pid', 'environ'),
      Buffer.from(`OBVERSA_ATTEMPT_ID=${attemptId}\0`, 'utf8'),
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
  it('reads one startedAt for the same process under a different locale and timezone', async () => {
    const commandUrl = new URL('../dist/command.js', import.meta.url).href;
    const reader = (targetPid: number, env: Record<string, string>) => {
      const script = [
        `const { inspectOwnedProcessTree } = await import(${JSON.stringify(commandUrl)});`,
        `const tree = await inspectOwnedProcessTree({ rootPid: ${targetPid}, rootProcessGroupId: ${targetPid}, attemptId: ${JSON.stringify(ATTEMPT_ID)} });`,
        `const me = tree.find((item) => item.pid === ${targetPid});`,
        "if (me === undefined) throw new Error('target missing from owned tree');",
        'process.stdout.write(`${JSON.stringify(me)}\\n`);',
        'setInterval(() => {}, 1000);',
      ].join('\n');
      return spawn(process.execPath, ['--input-type=module', '-e', script], {
        env,
        stdio: ['pipe', 'pipe', 'inherit'],
      });
    };
    const readLine = (child: ReturnType<typeof spawn>): Promise<string> =>
      new Promise((resolve, reject) => {
        let out = '';
        child.stdout!.on('data', (chunk) => {
          out += chunk;
          if (out.includes('\n')) resolve(out);
        });
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`reader child exited ${code}`)));
      });
    // The recording side runs under a restricted environment like the
    // runner's worker: no LANG, LC_ALL, LC_TIME or TZ, so it reads ps under
    // the C locale and the host timezone.
    const recorder = reader(process.pid, { PATH: process.env.PATH ?? '' });
    // The reading side runs under a different locale AND timezone, so the
    // two sides spell one start time two ways unless the ps call pins both.
    const host = reader(process.pid, {
      PATH: process.env.PATH ?? '',
      LC_ALL: 'en_GB.UTF-8',
      TZ: 'Asia/Tokyo',
    });
    try {
      const recorded = JSON.parse(await readLine(recorder)) as { pid: number; startedAt: string };
      const readBack = JSON.parse(await readLine(host)) as { pid: number; startedAt: string };
      expect(recorded.pid).toBe(process.pid);
      expect(readBack.pid).toBe(process.pid);
      // One process, one spelling: the runner compares and keys recorded
      // identities on this exact string.
      expect(readBack.startedAt).toBe(recorded.startedAt);
    } finally {
      recorder.kill('SIGKILL');
      host.kill('SIGKILL');
    }
  });

  it('finds a detached grandchild through the direct process group', async () => {
    const directory = fixtureDirectory();
    directories.push(directory);
    const attemptId = ATTEMPT_ID;
    const root = spawn(
      process.execPath,
      [parentFixture, 'ignore', directory],
      {
        detached: true,
        env: {
          ...process.env,
          OBVERSA_ATTEMPT_ID: attemptId,
          OBVERSA_RUN_ID: 'run-1',
          OBVERSA_HEADLESS: '1',
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
    const attemptId = ATTEMPT_ID;
    const owned = spawn(process.execPath, [parentFixture, 'ignore', directory], {
      detached: true,
      env: { ...process.env, OBVERSA_ATTEMPT_ID: attemptId },
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
    const attemptId = ATTEMPT_ID;
    const root = spawn(process.execPath, [parentFixture, 'ignore', directory], {
      env: { ...process.env, OBVERSA_ATTEMPT_ID: attemptId },
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
