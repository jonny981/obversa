import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const [mode, barrierDir] = process.argv.slice(2);
const grandchildFile = join(barrierDir, 'grandchild.json');

mkdirSync(barrierDir, { recursive: true });
const grandchild = spawn(
  process.execPath,
  [join(import.meta.dirname, 'detached-grandchild.mjs'), mode, barrierDir],
  {
    detached: true,
    env: process.env,
    stdio: 'inherit',
  },
);
grandchild.unref();

while (!existsSync(grandchildFile)) {
  await delay(5);
}

const barrier = join(barrierDir, 'child.json');
writeFileSync(`${barrier}.tmp`, JSON.stringify({
  pid: process.pid,
  parentPid: process.ppid,
  grandchildPid: grandchild.pid,
  attemptId: process.env.LINES_ATTEMPT_ID ?? null,
  runId: process.env.LINES_RUN_ID ?? null,
  headless: process.env.LINES_HEADLESS ?? null,
}));
renameSync(`${barrier}.tmp`, barrier);

if (mode === 'ignore') {
  process.on('SIGTERM', () => {});
}

setInterval(() => {}, 1_000);
