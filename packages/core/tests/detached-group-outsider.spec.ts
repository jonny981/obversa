import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import { exactPid } from './process-fixture.ts';

// A detached child's group should hold only the child and what it started.
// The process table the stop reads is changed so that a process this test
// started before the child, outside the child's tree, is shown in the child's
// group. It must get no signal.
const table = vi.hoisted(() => ({ childPid: 0, strangerPid: 0, rewritten: 0 }));
const EARLIER_START = 'Mon Jan  1 00:00:00 2001';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFileSync = ((file: string, args: readonly string[], options: object) => {
    const stdout = String(actual.execFileSync(file, args, options));
    if (file !== '/bin/ps' || args[0] !== '-axo' || table.childPid === 0) return stdout;
    return stdout.split('\n').map((line) => {
      if (Number(/^\s*(\d+)/u.exec(line)?.[1]) !== table.strangerPid) return line;
      table.rewritten += 1;
      const [pid, parentPid, , rss] = line.trim().split(/\s+/u);
      return `${pid} ${parentPid} ${table.childPid} ${rss} ${EARLIER_START}`;
    }).join('\n');
  }) as typeof actual.execFileSync;
  return { ...actual, execFileSync };
});

const { runChild } = await import('../src/index.ts');

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')('a detached child stop', () => {
  it('leaves a process that started before the child running, even when it shows the child\'s group id', async () => {
    const stranger = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    const controller = new AbortController();
    const realKill = process.kill.bind(process);
    // A signal to the stranger or to a group is recorded and never sent.
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) =>
      pid < 1 || pid === table.strangerPid || realKill(pid, signal));
    try {
      table.strangerPid = exactPid(stranger.pid);
      const result = await runChild({
        executable: process.execPath,
        args: ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 30_000)'],
        timeoutMs: 10_000,
        killGraceMs: 300,
        maxOutputBytes: 1_024,
        detached: true,
        signal: controller.signal,
        hooks: {
          onSpawn(child) {
            table.childPid = exactPid(child.pid);
          },
          onStdout() {
            controller.abort();
          },
        },
      });

      expect(result.aborted).toBe(true);
      expect(table.rewritten).toBeGreaterThan(0);
      expect(kill.mock.calls.filter(([pid]) => pid < 1 || pid === table.strangerPid)).toEqual([]);
    } finally {
      kill.mockRestore();
      table.childPid = 0;
      stranger.kill('SIGKILL');
    }
  });
});
