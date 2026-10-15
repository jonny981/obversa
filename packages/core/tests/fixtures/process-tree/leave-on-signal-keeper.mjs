import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// The keeper holds the command's pipes, lives in its own session, and
// ignores SIGTERM. After 1.2 seconds it starts a detached helper on the same
// pipes, records the helper's process id, and exits, leaving the helper
// orphaned behind them. The helper is a shell script whose TERM trap is set
// in its first milliseconds, so the graceful signal always lands on a live
// trap.
const [barrierDir] = process.argv.slice(2);

process.on('SIGTERM', () => {});
// Tell the root the SIGTERM handler is installed; the root waits for this
// before it exits, so teardown's first signal can never beat the handler.
writeFileSync(join(barrierDir, 'keeper-ready'), '');

setTimeout(() => {
  const helper = spawn(
    '/bin/sh',
    [join(import.meta.dirname, 'leave-on-signal-helper.sh'), barrierDir],
    { detached: true, stdio: 'inherit' },
  );
  helper.unref();
  const barrier = join(barrierDir, 'leftover.json');
  writeFileSync(`${barrier}.tmp`, JSON.stringify({ pid: helper.pid }));
  renameSync(`${barrier}.tmp`, barrier);
  process.exit(0);
}, 1_200);

setInterval(() => {}, 1_000);
