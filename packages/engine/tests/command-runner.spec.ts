import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { chmodSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  commandCleanupCapability,
  OwnedCommandError,
  resolveCommandExecutable,
  runOwnedCommand,
  type OwnedCommandRequest,
} from '../src/command/run.ts';
import {
  cleanupFixture,
  directDetachedFixture,
  fixtureDirectory,
  fixturePids,
  isProcessAlive,
  parentFixture,
  waitForFixtureRecord,
} from './process-fixture.ts';

const directories: string[] = [];
const decoder = new TextDecoder();
const ATTEMPT_ID =
  'sha256:1111111111111111111111111111111111111111111111111111111111111111' as const;

afterEach(() => {
  for (const directory of directories.splice(0)) cleanupFixture(directory);
});

function request(
  mode: string,
  directory: string,
  overrides: Partial<OwnedCommandRequest> = {},
): OwnedCommandRequest {
  return {
    executable: process.execPath,
    args: [parentFixture, mode, directory],
    cwd: import.meta.dirname,
    env: {},
    stdin: 'INPUT',
    attemptId: ATTEMPT_ID,
    runId: 'run-1',
    timeoutMs: 5_000,
    teardownGraceMs: 100,
    maxOutputBytes: 1_024,
    maxMemoryBytes: 512 * 1_024 * 1_024,
    ...overrides,
  };
}

function expectFixtureStopped(directory: string): void {
  expect(fixturePids(directory).some(isProcessAlive)).toBe(false);
}

describe('command cleanup capability', () => {
  it('reports the capability of the actual host', () => {
    expect(commandCleanupCapability()).toBe(
      process.platform === 'linux' ? 'inherited-owner' : 'observed-processes',
    );
  });

  it('reports inherited owner discovery under a Linux platform fixture', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
      expect(commandCleanupCapability()).toBe('inherited-owner');
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});

describe('command resolution', () => {
  it('resolves one executable from an explicit search path', () => {
    const directory = fixtureDirectory();
    directories.push(directory);
    const executable = join(directory, 'engine-stub');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);

    expect(resolveCommandExecutable('engine-stub', directory)).toBe(executable);
    expect(resolveCommandExecutable(executable, '')).toBe(executable);
    expect(() => resolveCommandExecutable('missing-stub', directory)).toThrow(
      expect.objectContaining({ code: 'INVALID_EXECUTABLE' }),
    );
  });

  it('keeps an explicitly selected wrapper path instead of its real target', () => {
    const directory = fixtureDirectory();
    directories.push(directory);
    const target = join(directory, 'engine-target');
    const wrapper = join(directory, 'engine-wrapper');
    writeFileSync(target, '#!/bin/sh\nexit 0\n');
    chmodSync(target, 0o755);
    symlinkSync(target, wrapper);

    expect(resolveCommandExecutable(wrapper, '')).toBe(wrapper);
  });
});

describe.runIf(process.platform !== 'win32')('owned command runner', () => {
  it('keeps bounded output and cleans descendants after normal exit', async () => {
    const directory = fixtureDirectory();
    directories.push(directory);
    const command = request('complete', directory);

    const result = await runOwnedCommand(command, new AbortController().signal);
    const parent = await waitForFixtureRecord(directory, 'parent');
    const child = await waitForFixtureRecord(directory, 'child');
    const grandchild = await waitForFixtureRecord(directory, 'grandchild');

    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
      aborted: false,
      remainingProcesses: [],
    });
    expect(decoder.decode(result.stdout)).toBe('PONG');
    expect(decoder.decode(result.stderr)).toBe('WARN');
    for (const record of [parent, child, grandchild]) {
      expect(record).toMatchObject({
        attemptId: command.attemptId,
        runId: command.runId,
        headless: '1',
      });
    }
    expectFixtureStopped(directory);
  });

  it('cleans a helper that detaches immediately and keeps stdout open', async () => {
    const directory = fixtureDirectory();
    directories.push(directory);
    const command = request('complete', directory, {
      args: [directDetachedFixture, directory],
    });

    const result = await runOwnedCommand(command, new AbortController().signal);

    expect(decoder.decode(result.stdout)).toBe('PONG');
    expectFixtureStopped(directory);
  });

  it('returns an aborted result only after the whole tree stops', async () => {
    const directory = fixtureDirectory();
    directories.push(directory);
    const controller = new AbortController();
    const running = runOwnedCommand(
      request('hang', directory, { timeoutMs: 10_000 }),
      controller.signal,
    );
    await waitForFixtureRecord(directory, 'parent');
    controller.abort();

    await expect(running).resolves.toMatchObject({
      aborted: true,
      timedOut: false,
      remainingProcesses: [],
    });
    expectFixtureStopped(directory);
  });

  it('force-stops a SIGTERM-ignoring tree at one timeout deadline', async () => {
    const directory = fixtureDirectory();
    directories.push(directory);
    const startedAt = Date.now();

    await expect(runOwnedCommand(
      request('ignore', directory, {
        timeoutMs: 1_000,
        teardownGraceMs: 100,
      }),
      new AbortController().signal,
    )).resolves.toMatchObject({
      timedOut: true,
      aborted: false,
      remainingProcesses: [],
    });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expectFixtureStopped(directory);
  });

  it('still cleans the process tree when the first cleanup attempt fails', async () => {
    const directory = fixtureDirectory();
    directories.push(directory);
    const controller = new AbortController();
    const failure = Object.assign(new Error('forced process-tree cleanup failure'), {
      code: 'EACCES',
    });
    const nativeKill = process.kill.bind(process);
    let forced = false;
    const kill = vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (!forced && signal === 'SIGTERM') {
        forced = true;
        throw failure;
      }
      return nativeKill(pid, signal);
    }) as typeof process.kill);

    let caught: unknown;
    try {
      await runOwnedCommand(
        request('complete', directory, { timeoutMs: 54_321 }),
        controller.signal,
      );
    } catch (error) {
      caught = error;
    } finally {
      kill.mockRestore();
    }

    expect(forced).toBe(true);
    expect(caught).toBe(failure);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
    expectFixtureStopped(directory);
  });

  it('fails typed before retaining output beyond its cap', async () => {
    const directory = fixtureDirectory();
    directories.push(directory);

    await expect(runOwnedCommand(
      request('flood', directory, { maxOutputBytes: 64 }),
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'OUTPUT_LIMIT',
    } satisfies Partial<OwnedCommandError>);
    expectFixtureStopped(directory);
  });

  it('fails typed and cleans the tree when its memory cap is crossed', async () => {
    const directory = fixtureDirectory();
    directories.push(directory);

    await expect(runOwnedCommand(
      request('memory', directory, {
        maxMemoryBytes: 96 * 1_024 * 1_024,
      }),
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'MEMORY_LIMIT',
    } satisfies Partial<OwnedCommandError>);
    expectFixtureStopped(directory);
  });

  it('rejects a relative executable before spawning', async () => {
    const directory = fixtureDirectory();
    directories.push(directory);

    await expect(runOwnedCommand(
      request('complete', directory, { executable: 'node' }),
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'INVALID_EXECUTABLE',
    } satisfies Partial<OwnedCommandError>);
    expect(fixturePids(directory)).toEqual([]);
  });

  it('rejects time policies that Node timers would shorten', async () => {
    const directory = fixtureDirectory();
    directories.push(directory);
    const maximumTimerMs = 2_147_483_647;

    await expect(runOwnedCommand(
      request('complete', directory, { timeoutMs: maximumTimerMs + 1 }),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'INVALID_COMMAND' });
    await expect(runOwnedCommand(
      request('complete', directory, {
        timeoutMs: maximumTimerMs,
        teardownGraceMs: 1,
      }),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'INVALID_COMMAND' });
    expect(fixturePids(directory)).toEqual([]);
  });
});
