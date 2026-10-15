import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// The root starts a keeper that keeps the command's output pipes in a new
// session and ignores SIGTERM, records the keeper's process id at once so a
// failed run still names it for cleanup, waits until the keeper's SIGTERM
// handler is installed, then exits. The keeper pauses,
// then starts a detached helper on the same pipes, so the helper begins
// after the command's own process is already gone.
const [barrierDir] = process.argv.slice(2);
mkdirSync(barrierDir, { recursive: true });

const keeper = spawn(
  process.execPath,
  [join(import.meta.dirname, 'leave-on-signal-keeper.mjs'), barrierDir],
  { detached: true, stdio: 'inherit' },
);
const record = join(barrierDir, 'keeper.json');
writeFileSync(`${record}.tmp`, JSON.stringify({ pid: keeper.pid }));
renameSync(`${record}.tmp`, record);
// Exit only once the keeper reports its SIGTERM handler installed: teardown
// starts on this process's exit, and a keeper still booting would die from
// the first signal instead of starting the helper.
const ready = join(barrierDir, 'keeper-ready');
const waitUntil = Date.now() + 10_000;
while (!existsSync(ready)) {
  if (Date.now() > waitUntil) throw new Error('keeper never reported ready');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
keeper.unref();
