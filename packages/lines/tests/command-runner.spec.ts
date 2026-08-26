import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createAttemptIdentity } from '../src/runtime/attempt.ts';
import {
  OwnedCommandError,
  resolveCommandExecutable,
  runOwnedCommand,
  type OwnedCommandRequest,
} from '../src/engines/command-runner.ts';
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

afterEach(() => {
  for (const directory of directories.splice(0)) cleanupFixture(directory);
});

function request(
  mode: string,
  directory: string,
  overrides: Partial<OwnedCommandRequest> = {},
): OwnedCommandRequest {
  const attemptId = createAttemptIdentity({
    namespace: 'tenant-a',
    streamId: 'run-1',
    nodeId: 'review',
    position: `attempts/${mode}`,
  }).attemptId;
  return {
    executable: process.execPath,
    args: [parentFixture, mode, directory],
    cwd: import.meta.dirname,
    env: {},
    stdin: 'INPUT',
    attemptId,
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

describe('command resolution', () => {
  it('resolves one executable from an explicit search path', () => {
    const directory = fixtureDirectory();
    directories.push(directory);
    const executable = join(directory, 'engine-stub');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);

    const resolved = realpathSync(executable);
    expect(resolveCommandExecutable('engine-stub', directory)).toBe(resolved);
    expect(resolveCommandExecutable(executable, '')).toBe(resolved);
    expect(() => resolveCommandExecutable('missing-stub', directory)).toThrow(
      expect.objectContaining({ code: 'INVALID_EXECUTABLE' }),
    );
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
});
