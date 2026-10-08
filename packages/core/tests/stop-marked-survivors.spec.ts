import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  readAttemptMarkerProcessIds,
  readProcessIdentity,
  stopOwnedProcessTree,
} from '../src/command/process-tree.ts';
import { cleanupFixture, exactPid, fixtureDirectory } from './process-fixture.ts';

// Real work: these tests start real processes, so this file declares its own
// time limit; the suite default is a hang guard, not a speed bar.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const attemptId = `sha256:${'f'.repeat(64)}` as const;
const otherAttemptId = `sha256:${'e'.repeat(64)}` as const;
const started: ChildProcess[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const child of started.splice(0)) {
    try { process.kill(exactPid(child.pid), 'SIGKILL'); } catch {}
    await exited(child, 5_000);
  }
  for (const directory of directories.splice(0)) cleanupFixture(directory);
});

/** Start a process that sleeps until killed and carries `marker` as its attempt id. */
function sleeper(marker: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, OBVERSA_ATTEMPT_ID: marker },
  });
  started.push(child);
  return child;
}

async function exited(child: ChildProcess, withinMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await Promise.race([
    new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
    delay(withinMs).then(() => false),
  ]);
}

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(5);
  }
}

const carriesMarker = async (child: ChildProcess, marker: typeof attemptId): Promise<boolean> =>
  (await readAttemptMarkerProcessIds(marker)).includes(exactPid(child.pid));

describe.runIf(process.platform === 'linux')('the stop and the attempt marker', () => {
  it('stops a process carrying the attempt marker that no parent, group or sample leads to', async () => {
    const root = sleeper(attemptId);
    const helper = sleeper(attemptId);
    const unrelated = sleeper(otherAttemptId);
    await until(() => carriesMarker(root, attemptId), 'the root to carry the marker');
    await until(() => carriesMarker(helper, attemptId), 'the helper to carry the marker');
    await until(() => carriesMarker(unrelated, otherAttemptId), 'the unrelated process to carry its marker');
    const rootIdentity = readProcessIdentity(exactPid(root.pid))!;

    const remaining = await stopOwnedProcessTree({
      attemptId,
      rootPid: rootIdentity.pid,
      rootProcessGroupId: rootIdentity.pid,
      rootStartedAt: rootIdentity.startedAt,
      observed: [rootIdentity],
      graceMs: 100,
    });

    expect(remaining).toEqual([]);
    expect(await exited(root, 3_000)).toBe(true);
    expect(await exited(helper, 3_000)).toBe(true);
    expect(await exited(unrelated, 200)).toBe(false);
  });

  it('stops a marked process that appears during teardown, after the first look', async () => {
    const directory = fixtureDirectory();
    directories.push(directory);
    // The root asks for a helper when it is told to stop, and exits only once
    // that helper carries the marker. The helper is never the root's child,
    // so only a look for the marker made during teardown can find it.
    const root = spawn(process.execPath, ['-e', `
      const { existsSync, writeFileSync } = require('node:fs');
      const directory = process.argv[1];
      process.on('SIGTERM', () => {
        writeFileSync(directory + '/go', '');
        setInterval(() => { if (existsSync(directory + '/helper-ready')) process.exit(0); }, 5);
      });
      writeFileSync(directory + '/root-ready', '');
      setInterval(() => {}, 1000);
    `, directory], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, OBVERSA_ATTEMPT_ID: attemptId },
    });
    started.push(root);
    await until(() => existsSync(join(directory, 'root-ready')), 'the root to start');
    const rootIdentity = readProcessIdentity(exactPid(root.pid))!;

    let helper: ChildProcess | undefined;
    const helperStarted = (async () => {
      await until(() => existsSync(join(directory, 'go')), 'the root to be told to stop');
      helper = sleeper(attemptId);
      await until(() => carriesMarker(helper!, attemptId), 'the helper to carry the marker');
      writeFileSync(join(directory, 'helper-ready'), '');
    })();

    const remaining = await stopOwnedProcessTree({
      attemptId,
      rootPid: rootIdentity.pid,
      rootProcessGroupId: rootIdentity.pid,
      rootStartedAt: rootIdentity.startedAt,
      observed: [rootIdentity],
      graceMs: 2_000,
    });
    await helperStarted;

    expect(remaining).toEqual([]);
    expect(await exited(helper!, 3_000)).toBe(true);
  });
});
