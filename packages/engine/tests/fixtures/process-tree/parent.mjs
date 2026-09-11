import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const [mode, barrierDir] = process.argv.slice(2);
const childFile = join(barrierDir, 'child.json');

mkdirSync(barrierDir, { recursive: true });
const child = spawn(
  process.execPath,
  [join(import.meta.dirname, 'child.mjs'), mode, barrierDir],
  {
    env: process.env,
    stdio: 'inherit',
  },
);

while (!existsSync(childFile)) {
  await delay(5);
}

const barrier = join(barrierDir, 'parent.json');
writeFileSync(`${barrier}.tmp`, JSON.stringify({
  pid: process.pid,
  parentPid: process.ppid,
  childPid: child.pid,
  attemptId: process.env.OBVERSA_ATTEMPT_ID ?? null,
  runId: process.env.OBVERSA_RUN_ID ?? null,
  headless: process.env.OBVERSA_HEADLESS ?? null,
}));
renameSync(`${barrier}.tmp`, barrier);

if (mode === 'complete') {
  process.stdout.write('PONG');
  process.stderr.write('WARN');
  process.exit(0);
}

if (mode === 'flood' || mode === 'flood-ignore') {
  const chunk = Buffer.alloc(16 * 1_024, 0x78);
  while (true) {
    if (!process.stdout.write(chunk)) {
      await new Promise((resolve) => process.stdout.once('drain', resolve));
    }
  }
}

if (mode === 'memory') {
  const allocations = [];
  setInterval(() => {
    allocations.push(Buffer.alloc(8 * 1_024 * 1_024, 0x78));
  }, 10);
}

if (mode === 'ignore') {
  process.on('SIGTERM', () => {});
}

setInterval(() => {}, 1_000);
