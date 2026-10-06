import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import { exactPid, isProcessAlive } from './process-fixture.ts';

// When a command's process and its whole group have exited, the system can
// give its pid to a new process, which can then lead a process group with that
// same id. The kernel cannot be made to hand a chosen pid out again, so the
// process table the cleanup reads changes once the command has exited: a new
// process holds the command's pid, and a process this test started, outside
// the command's tree, is shown in that new process's group. No signal ever
// reaches the made-up process that holds the pid.
const table = vi.hoisted(() => ({ commandPid: 0, strangerPid: 0, rewritten: 0 }));
const LATER_START = 'Fri Jan  1 00:00:00 2100';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const real = promisify(actual.execFile);
  const answer = async (file: string, args: readonly string[], options: object) => {
    const result = await real(file, args, options);
    if (file !== '/bin/ps' || args[0] !== '-axo' || table.commandPid === 0) return result;
    const lines = String(result.stdout).split('\n');
    const pidOf = (line: string): number => Number(/^\s*(\d+)/u.exec(line)?.[1]);
    if (lines.some((line) => pidOf(line) === table.commandPid)) return result;
    const stdout = [`${table.commandPid} 1 ${table.commandPid} 1024 ${LATER_START}`, ...lines.map((line) => {
      if (pidOf(line) !== table.strangerPid) return line;
      table.rewritten += 1;
      return line.replace(/^(\s*\d+\s+\d+\s+)\d+/u, `$1${table.commandPid}`);
    })].join('\n');
    return { stdout, stderr: result.stderr };
  };
  const execFile = (...args: Parameters<typeof actual.execFile>) => actual.execFile(...args);
  return { ...actual, execFile: Object.assign(execFile, { [promisify.custom]: answer }) };
});

const { runOwnedCommand } = await import('../src/command/run.ts');
const { readProcessIdentity, stopOwnedProcessTree } = await import('../src/command/process-tree.ts');

/** Refuse and record every signal to the made-up pid holder or to a group. */
function refuseSignalsToHolder() {
  const realKill = process.kill.bind(process);
  return vi.spyOn(process, 'kill').mockImplementation((pid, signal) =>
    pid < 1 || pid === table.commandPid || realKill(pid, signal));
}

function refused(kill: ReturnType<typeof refuseSignalsToHolder>): unknown[] {
  return kill.mock.calls.filter(([pid]) => pid < 1 || pid === table.commandPid);
}

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')('a group id that matches a finished command', () => {
  it('leaves a process outside the command running', async () => {
    const stranger = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    const kill = refuseSignalsToHolder();
    try {
      table.strangerPid = exactPid(stranger.pid);
      const result = await runOwnedCommand({
        executable: '/bin/sh',
        // The command prints its own pid, then lives long enough to be seen.
        args: ['-c', 'echo $$; sleep 0.3'],
        cwd: import.meta.dirname,
        env: {},
        stdin: '',
        attemptId: 'sha256:5555555555555555555555555555555555555555555555555555555555555555',
        runId: 'run-1',
        timeoutMs: 10_000,
        teardownGraceMs: 100,
        maxOutputBytes: 1_024,
        maxMemoryBytes: 512 * 1_024 * 1_024,
      }, new AbortController().signal, {
        onStdout: (chunk) => {
          table.commandPid = exactPid(Number(Buffer.from(chunk).toString('utf8').trim()));
        },
      });

      expect(result.exitCode).toBe(0);
      expect(table.rewritten).toBeGreaterThan(0);
      expect(refused(kill)).toEqual([]);
      expect(stranger.signalCode).toBeNull();
      expect(isProcessAlive(table.strangerPid)).toBe(true);
    } finally {
      kill.mockRestore();
      stranger.kill('SIGKILL');
    }
  });

  it.each([
    ['without a recorded start time', false],
    ['with the start time recorded while it lived', true],
  ])('leaves a process outside a stopped command running %s', async (_name, recorded) => {
    table.commandPid = 0;
    const stranger = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    const command = spawn('/bin/sleep', ['0.2'], { stdio: 'ignore' });
    const kill = refuseSignalsToHolder();
    try {
      table.strangerPid = exactPid(stranger.pid);
      table.rewritten = 0;
      const commandPid = exactPid(command.pid);
      const rootStartedAt = readProcessIdentity(commandPid)!.startedAt;
      await new Promise((resolve) => command.once('exit', resolve));
      table.commandPid = commandPid;

      await stopOwnedProcessTree({
        attemptId: 'sha256:5555555555555555555555555555555555555555555555555555555555555555',
        rootPid: commandPid,
        rootProcessGroupId: commandPid,
        ...(recorded ? { rootStartedAt } : {}),
        graceMs: 100,
      });

      expect(table.rewritten).toBeGreaterThan(0);
      expect(refused(kill)).toEqual([]);
      expect(stranger.signalCode).toBeNull();
      expect(isProcessAlive(table.strangerPid)).toBe(true);
    } finally {
      kill.mockRestore();
      table.commandPid = 0;
      stranger.kill('SIGKILL');
      command.kill('SIGKILL');
    }
  });
});
