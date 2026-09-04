import { spawn } from 'node:child_process';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runOwnedCommand } from '../../../src/command/run.ts';

const [mode, directory, ownerId, loader, workerPid] = process.argv.slice(2);
const record = (name, value) => {
  const path = join(directory, `${name}.json`);
  writeFileSync(`${path}.tmp`, JSON.stringify(value));
  renameSync(`${path}.tmp`, path);
};
const command = (childMode, extra = {}) => ({
  executable: process.execPath,
  args: ['--import', loader, import.meta.filename, childMode, directory, ownerId, loader, String(process.pid)],
  cwd: directory, env: {}, stdin: '',
  attemptId: `sha256:${(mode === 'watchdog' ? '1' : '2').repeat(64)}`,
  runId: mode, timeoutMs: 15_000, teardownGraceMs: 100,
  maxOutputBytes: 1024, maxMemoryBytes: 512 * 1024 * 1024,
  ...extra,
});

if (mode === 'watchdog' || mode === 'term-watchdog') {
  const result = await runOwnedCommand(command(mode === 'watchdog' ? 'worker' : 'term-root', { ownerId }), new AbortController().signal);
  record('result', { exitCode: result.exitCode, remaining: result.remainingProcesses });
} else if (mode === 'term-root') {
  spawn(process.execPath, ['--import', loader, import.meta.filename, 'term-parent', directory, ownerId, loader, workerPid], {
    detached: true, stdio: 'ignore',
  }).unref();
  while (!existsSync(join(directory, 'term-parent.json'))) await delay(5);
} else if (mode === 'term-parent') {
  process.on('SIGTERM', async () => {
    process.kill(Number(workerPid), 'SIGSTOP');
    await delay(100);
    const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true, stdio: 'ignore',
    });
    record('term-helper', { pid: helper.pid });
    process.exit(0);
  });
  record('term-parent', { pid: process.pid });
  setInterval(() => {}, 1000);
} else if (mode === 'worker') {
  record('worker', { pid: process.pid });
  while (!existsSync(join(directory, 'go'))) await delay(5);
  await runOwnedCommand(command('helper', { inheritParentEnv: false }), new AbortController().signal);
} else if (mode === 'helper') {
  record('helper', { pid: process.pid, owner: process.env.OBVERSA_RUN_OWNER });
  process.kill(Number(workerPid), 'SIGKILL');
  setInterval(() => {}, 1000);
} else if (mode === 'nested') {
  const sibling = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true, stdio: 'ignore',
  });
  record('sibling', { pid: sibling.pid });
  try {
    const result = await runOwnedCommand(command('short', {
      inheritParentEnv: false,
      ownerId: `sha256:${'f'.repeat(64)}`,
      env: { OBVERSA_RUN_OWNER: `sha256:${'e'.repeat(64)}` },
    }), new AbortController().signal);
    process.kill(sibling.pid, 0);
    record('result', { exitCode: result.exitCode, owner: process.env.OBVERSA_RUN_OWNER });
  } finally {
    sibling.kill('SIGKILL');
  }
} else if (mode === 'short') {
  record('short', { owner: process.env.OBVERSA_RUN_OWNER });
}
