import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';

import { exactPid, isProcessAlive } from './process-fixture.ts';

// When the last holder of a command's output socket closes it, macOS can give
// the socket's kernel address to a new socket in any process. The command
// below leaves a helper holding its output, and the cleanup's real lsof calls
// see that helper's socket. While the cleanup scans every socket on the
// machine, the test stops the helper. The kernel cannot be made to hand the
// freed address to a chosen process, so the scan's answer gets one extra line:
// an unrelated process holding that address.
const scan = vi.hoisted(() => ({
  helperPid: 0,
  unrelatedPid: 0,
  peers: new Set<string>(),
  scans: 0,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const real = promisify(actual.execFile);
  const answer = async (file: string, args: readonly string[], options: object) => {
    const result = await (async () => {
      if (file !== '/usr/sbin/lsof' || !args.includes('-U')) return await real(file, args, options);
      scan.scans += 1;
      for (let waited = 0; scan.helperPid === 0 && waited < 5_000; waited += 20) await delay(20);
      // Without the helper's pid this fails before it sends any signal.
      process.kill(exactPid(scan.helperPid), 'SIGKILL');
      while (isProcessAlive(scan.helperPid)) await delay(20);
      const all = await real(file, args, options);
      const taken = [...scan.peers]
        .map((peer) => `sleep ${scan.unrelatedPid} user 1u unix ${peer} 0t0 ->0x142974edb68b4308\n`)
        .join('');
      return { stdout: `${String(all.stdout)}${taken}`, stderr: all.stderr };
    })();
    if (file === '/usr/sbin/lsof' && !args.includes('-U')) {
      for (const match of String(result.stdout).matchAll(/->(0x[0-9a-f]+)/giu)) scan.peers.add(match[1]!);
    }
    return result;
  };
  const execFile = (...args: Parameters<typeof actual.execFile>) => actual.execFile(...args);
  return { ...actual, execFile: Object.assign(execFile, { [promisify.custom]: answer }) };
});

const { runOwnedCommand } = await import('../src/command/run.ts');

describe.runIf(process.platform === 'darwin')('an output socket address taken by another process', () => {
  it('leaves the process that took the address running', async () => {
    const unrelated = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    scan.unrelatedPid = unrelated.pid!;
    try {
      const result = await runOwnedCommand({
        executable: '/bin/sh',
        // The helper keeps the command's output open after the command exits.
        args: ['-c', '/bin/sleep 30 & echo $!'],
        cwd: import.meta.dirname,
        env: {},
        stdin: '',
        attemptId: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
        runId: 'run-1',
        timeoutMs: 10_000,
        teardownGraceMs: 100,
        maxOutputBytes: 1_024,
        maxMemoryBytes: 512 * 1_024 * 1_024,
      }, new AbortController().signal, {
        onStdout: (chunk) => {
          scan.helperPid = Number(Buffer.from(chunk).toString('utf8').trim());
        },
      });

      expect(result.exitCode).toBe(0);
      expect(scan.scans).toBe(1);
      expect(scan.peers.size).toBeGreaterThan(0);
      expect(unrelated.signalCode).toBeNull();
      expect(isProcessAlive(unrelated.pid!)).toBe(true);
    } finally {
      unrelated.kill('SIGKILL');
      if (scan.helperPid > 0 && isProcessAlive(scan.helperPid)) process.kill(scan.helperPid, 'SIGKILL');
    }
  });
});
