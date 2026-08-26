import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [mode, barrierDir] = process.argv.slice(2);

mkdirSync(barrierDir, { recursive: true });
const barrier = join(barrierDir, 'grandchild.json');
writeFileSync(`${barrier}.tmp`, JSON.stringify({
  pid: process.pid,
  parentPid: process.ppid,
  attemptId: process.env.LINES_ATTEMPT_ID ?? null,
  runId: process.env.LINES_RUN_ID ?? null,
  headless: process.env.LINES_HEADLESS ?? null,
}));
renameSync(`${barrier}.tmp`, barrier);

if (mode === 'ignore') {
  process.on('SIGTERM', () => {});
}

setInterval(() => {}, 1_000);
