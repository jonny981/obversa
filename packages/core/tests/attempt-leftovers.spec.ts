import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  OwnedCommandError,
  runOwnedCommand,
  type OwnedCommandRequest,
} from '../src/command/run.ts';
import {
  exactPid,
  isProcessAlive,
  parentFixture,
  waitForFixtureRecord,
} from './process-fixture.ts';

// Real work: these tests start real processes, so this file declares its own
// time limit; the suite default is a hang guard, not a speed bar.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const ATTEMPT_1 = `sha256:${'1'.repeat(64)}` as const;
const fixture = join(import.meta.dirname, 'fixtures/process-tree/leave-on-signal.mjs');
const heavyHelperFixture = join(import.meta.dirname, 'fixtures/process-tree/leave-heavy-helper.mjs');

const directories: string[] = [];

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'obversa-attempt-leftovers-'));
  directories.push(directory);
  return directory;
}

// Every pid a fixture or inline script recorded in the directory, so a
// teardown that throws still leaves the 160 MB helper stopped. `parentPid`
// is the fixture's own parent, never a process the test started.
function recordedPids(directory: string): number[] {
  const pids = new Set<number>();
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith('.json')) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(readFileSync(join(directory, entry), 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const field of ['pid', 'helperPid', 'childPid', 'grandchildPid'] as const) {
      const value = record[field];
      if (Number.isSafeInteger(value) && (value as number) > 0) {
        pids.add(value as number);
      }
    }
  }
  return [...pids];
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    // Two passes: a keeper killed while it was starting a helper writes the
    // helper's record in the same tick, and a root still starting when the
    // test failed lands the keeper's record during the pause, so a second
    // read after the first round of stops reaps what the first could not
    // have named.
    for (let pass = 0; pass < 2; pass += 1) {
      for (const pid of recordedPids(directory)) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
      if (pass === 0) await delay(100);
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

function request(
  directory: string,
  attemptId: string,
  overrides: Partial<OwnedCommandRequest> = {},
): OwnedCommandRequest {
  return {
    executable: process.execPath,
    args: [fixture, directory],
    cwd: directory,
    env: {},
    stdin: '',
    attemptId: attemptId as OwnedCommandRequest['attemptId'],
    runId: 'run-1',
    timeoutMs: 1_000,
    teardownGraceMs: 2_000,
    maxOutputBytes: 1_024,
    maxMemoryBytes: 512 * 1_024 * 1_024,
    ...overrides,
  };
}

async function waitForRecord(directory: string, name: string): Promise<Record<string, unknown>> {
  const path = join(directory, `${name}.json`);
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${name} barrier.`);
    await delay(5);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

async function untilStopped(pid: number): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(10);
  }
  return true;
}

describe.runIf(process.platform !== 'win32')('an attempt that ends with a helper behind', () => {
  it('stops a helper that starts while teardown runs, graceful signal first', async () => {
    const directory = makeDirectory();
    // The fixture's root records the keeper's process id and exits at once.
    // The keeper holds the command's pipes and ignores SIGTERM; 1.2 seconds
    // in it starts a detached helper on the same pipes, inside the teardown
    // window, and exits. The helper is a shell script whose TERM trap is set
    // in its first milliseconds, so the graceful signal lands on a live trap
    // and the helper records it.
    const result = await runOwnedCommand(
      request(directory, ATTEMPT_1),
      new AbortController().signal,
    );
    const { pid } = (await waitForRecord(directory, 'leftover')) as { pid: number };
    const leftoverPid = exactPid(pid);

    const marker = join(directory, 'helper-sigterm.json');
    expect(existsSync(marker)).toBe(true);
    const graceful = JSON.parse(readFileSync(marker, 'utf8')) as { pid: number };
    expect(graceful.pid).toBe(leftoverPid);
    expect(await untilStopped(leftoverPid)).toBe(true);
    expect(
      result.stoppedProcesses.some((process) => process.pid === leftoverPid),
    ).toBe(true);
  });

  it('records a process that exits at once on the first signal of a timeout', async () => {
    const directory = makeDirectory();
    // The root starts a helper inside its own process group, records both
    // process ids, and waits. Neither traps SIGTERM, so both exit on the
    // first signal, before teardown's own process discovery can see them.
    const result = await runOwnedCommand(
      request(directory, ATTEMPT_1, {
        args: [
          '-e',
          `const fs = require('node:fs');
           const { spawn } = require('node:child_process');
           const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
           fs.writeFileSync(${JSON.stringify(join(directory, 'root.json'))},
             JSON.stringify({ pid: process.pid, helperPid: helper.pid }));
           setInterval(() => {}, 1000);`,
        ],
      }),
      new AbortController().signal,
    );
    const record = JSON.parse(readFileSync(join(directory, 'root.json'), 'utf8')) as {
      pid: number; helperPid: number;
    };

    expect(result.timedOut).toBe(true);
    expect(result.stoppedProcesses.some((process) => process.pid === record.pid)).toBe(true);
    expect(result.stoppedProcesses.some((process) => process.pid === record.helperPid)).toBe(true);
  });

  it('stops a detached helper that outlives its root and holds no command pipes', async () => {
    const directory = makeDirectory();
    // The fixture's root starts a detached helper holding 160 MB that does
    // not keep the command's pipes, stays 400 ms so the monitor samples the
    // helper while it is still a descendant of the root, then exits. No
    // group, live parent or pipe leads to the helper at teardown; on macOS
    // only the attempt's observed list does, while on Linux the helper's
    // inherited attempt marker also names it.
    const result = await runOwnedCommand(
      request(directory, ATTEMPT_1, {
        args: [heavyHelperFixture, directory],
        timeoutMs: 10_000,
      }),
      new AbortController().signal,
    );
    const { pid } = (await waitForRecord(directory, 'leftover')) as { pid: number };
    const leftoverPid = exactPid(pid);

    expect(
      result.stoppedProcesses.some((process) => process.pid === leftoverPid),
    ).toBe(true);
    expect(await untilStopped(leftoverPid)).toBe(true);
  });

  it('records the processes a failed attempt stopped and every process it counted', async () => {
    const directory = makeDirectory();
    // In 'memory' mode the fixture's parent grows until the attempt's memory
    // cap stops the command; its detached grandchild keeps the pipes. The cap
    // is well above the fixture's own footprint, so the monitor sees the
    // grandchild in samples before the one that trips.
    const failure = await runOwnedCommand(
      request(directory, ATTEMPT_1, {
        args: [parentFixture, 'memory', directory],
        timeoutMs: 30_000,
        maxMemoryBytes: 512 * 1_024 * 1_024,
      }),
      new AbortController().signal,
    ).then(
      () => { throw new Error('expected the attempt to fail'); },
      (error: unknown) => error,
    );
    const parent = await waitForFixtureRecord(directory, 'parent');
    const child = await waitForFixtureRecord(directory, 'child');
    const grandchild = await waitForFixtureRecord(directory, 'grandchild');

    expect(failure).toBeInstanceOf(OwnedCommandError);
    const error = failure as OwnedCommandError;
    expect(error.code).toBe('MEMORY_LIMIT');
    expect(
      error.stoppedProcesses.some((process) => process.pid === grandchild.pid),
    ).toBe(true);
    expect(await untilStopped(exactPid(grandchild.pid))).toBe(true);

    // The memory stop names every process it counted, its resident memory,
    // its command line cut at 200 characters, and why it counted.
    const counted = error.countedProcesses;
    for (const entry of counted) {
      expect(entry.pid).toBeGreaterThan(0);
      expect(entry.parentPid).toBeGreaterThanOrEqual(0);
      expect(entry.command.length).toBeLessThanOrEqual(200);
      expect(entry.residentBytes).toBeGreaterThan(0);
    }
    const countedRoot = counted.find((entry) => entry.pid === parent.pid);
    expect(countedRoot?.root).toBe(true);
    expect(countedRoot?.command).toContain('parent.mjs');
    expect(countedRoot?.earlierObserved).toBe(false);
    const countedChild = counted.find((entry) => entry.pid === child.pid);
    expect(countedChild?.descendant).toBe(true);
    expect(countedChild?.groupMember).toBe(true);
    expect(countedChild?.earlierObserved).toBe(true);
    const countedGrandchild = counted.find((entry) => entry.pid === grandchild.pid);
    expect(countedGrandchild?.descendant).toBe(true);
    expect(countedGrandchild?.groupMember).toBe(false);
    expect(countedGrandchild?.earlierObserved).toBe(true);
  });

  it('scrubs a secret-shaped argument from a counted command line', async () => {
    const directory = makeDirectory();
    // The secret rides the root's own command line, inside the 200-character
    // cap the record applies after scrubbing.
    const failure = await runOwnedCommand(
      request(directory, ATTEMPT_1, {
        args: ['-e', 'setInterval(() => {}, 1000)', 'sk-ant-testvalue12345'],
        maxMemoryBytes: 1,
      }),
      new AbortController().signal,
    ).then(
      () => { throw new Error('expected the attempt to fail'); },
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(OwnedCommandError);
    const error = failure as OwnedCommandError;
    expect(error.code).toBe('MEMORY_LIMIT');
    const countedRoot = error.countedProcesses.find((entry) => entry.root);
    expect(countedRoot?.command).toContain('[redacted]');
    expect(JSON.stringify(error.countedProcesses)).not.toContain('sk-ant-testvalue12345');
  });
});

// Nothing runs this spec today: no CI job targets Windows and no developer
// machine does either, so both tests below have never executed anywhere.
describe.runIf(process.platform === 'win32')('a Windows attempt that ends on a signal', () => {
  it('records the root when the first signal already stops it', async () => {
    const directory = makeDirectory();
    // The root records its own process id and waits. On a timeout the first
    // signal stops it at once, before teardown's own process discovery can
    // see it, so only the identity read while it started can name it.
    const result = await runOwnedCommand(
      request(directory, ATTEMPT_1, {
        args: [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(join(directory, 'root.json'))},
            JSON.stringify({ pid: process.pid }));
           setInterval(() => {}, 1000);`,
        ],
      }),
      new AbortController().signal,
    );
    const { pid } = (await waitForRecord(directory, 'root')) as { pid: number };

    expect(result.timedOut).toBe(true);
    expect(result.stoppedProcesses.some((process) => process.pid === pid)).toBe(true);
  });

  it('completes teardown and records an observed child whose root already exited', async () => {
    const directory = makeDirectory();
    // The root starts a windowless child, records both process ids, and
    // exits at once, so teardown's first look already finds the root gone.
    // A plain taskkill leaves a child with no window running, so the child
    // stands until teardown's forced taskkill /F; the record names it from
    // the first signal pass either way.
    const result = await runOwnedCommand(
      request(directory, ATTEMPT_1, {
        args: [
          '-e',
          `const fs = require('node:fs');
           const { spawn } = require('node:child_process');
           const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
             { detached: true, stdio: 'ignore' });
           child.unref();
           fs.writeFileSync(${JSON.stringify(join(directory, 'root.json'))},
             JSON.stringify({ pid: process.pid, childPid: child.pid }));
           process.exit(0);`,
        ],
        timeoutMs: 10_000,
      }),
      new AbortController().signal,
    );
    const { childPid } = (await waitForRecord(directory, 'root')) as { childPid: number };

    expect(
      result.stoppedProcesses.some((process) => process.pid === childPid),
    ).toBe(true);
  });
});
