import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [mode, barrierDir] = process.argv.slice(2);

mkdirSync(barrierDir, { recursive: true });
const barrier = join(barrierDir, 'grandchild.json');
writeFileSync(`${barrier}.tmp`, JSON.stringify({
  pid: process.pid,
  parentPid: process.ppid,
  attemptId: process.env.OBVERSA_ATTEMPT_ID ?? null,
  runId: process.env.OBVERSA_RUN_ID ?? null,
  headless: process.env.OBVERSA_HEADLESS ?? null,
}));
renameSync(`${barrier}.tmp`, barrier);

if (mode === 'ignore' || mode === 'flood-ignore') {
  process.on('SIGTERM', () => {});
}

setInterval(() => {}, 1_000);
