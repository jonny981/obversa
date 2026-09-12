import { spawn } from 'node:child_process';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runOwnedCommand } from '../../../src/command/run.ts';

const [mode, directory, ownerId, loader, workerPid, requestedAttemptId] = process.argv.slice(2);
const attemptId = requestedAttemptId ?? `sha256:${(mode === 'watchdog' ? '1' : '2').repeat(64)}`;
const record = (name, value) => {
  const path = join(directory, `${name}.json`);
  writeFileSync(`${path}.tmp`, JSON.stringify(value));
  renameSync(`${path}.tmp`, path);
};
const command = (childMode, extra = {}) => ({
  executable: process.execPath,
  args: ['--import', loader, import.meta.filename, childMode, directory, ownerId, loader, String(process.pid), attemptId],
  cwd: directory, env: {}, stdin: '',
  attemptId,
  runId: mode, timeoutMs: 15_000, teardownGraceMs: 100,
  maxOutputBytes: 1024, maxMemoryBytes: 512 * 1024 * 1024,
  ...extra,
});

if (mode === 'watchdog' || mode === 'term-watchdog') {
  const diagnostic = { exitCode: null, signal: null, timedOut: null, stdout: '', stderr: '' };
  const observer = {
    onStdout: (chunk) => { diagnostic.stdout += Buffer.from(chunk).toString('utf8'); },
    onStderr: (chunk) => { diagnostic.stderr += Buffer.from(chunk).toString('utf8'); },
    onExit: (exitCode, signal) => {
      diagnostic.exitCode = exitCode;
      diagnostic.signal = signal;
    },
  };
  try {
    const result = await runOwnedCommand(
      command(mode === 'watchdog' ? 'worker' : 'term-root', { ownerId }),
      new AbortController().signal,
      observer,
    );
    diagnostic.timedOut = result.timedOut;
    record('run-diagnostic', { ...diagnostic, result: { exitCode: result.exitCode, timedOut: result.timedOut, aborted: result.aborted } });
    record('result', { exitCode: result.exitCode, remaining: result.remainingProcesses });
  } catch (error) {
    record('run-diagnostic', {
      ...diagnostic,
      error: {
        name: error?.name,
        message: error?.message,
        code: error?.code,
      },
    });
    throw error;
  }
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
