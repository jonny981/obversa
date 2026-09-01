import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { finalResultText } from '@obversa/engine';
import { ClaudeCliEngine } from '../src/index.ts';

const ORPHAN_PID_PATH = '__ORPHAN_PID_PATH__';
const ORPHAN_HELPER_PATH = '__ORPHAN_HELPER_PATH__';
const fixtures: Array<{
  readonly directory: string;
  readonly orphanPidPath: string;
}> = [];

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function stub(source: string): {
  readonly bin: string;
  readonly orphanPidPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'claude-cli-exit-settle-'));
  const bin = join(dir, 'engine-stub.mjs');
  const orphanHelper = join(dir, 'orphan-helper.mjs');
  const orphanPidPath = join(dir, 'orphan.pid');
  fixtures.push({ directory: dir, orphanPidPath });
  writeFileSync(orphanHelper, `
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], String(process.pid));
process.send?.('ready');
process.disconnect?.();
setInterval(() => {}, 1000);
`);
  writeFileSync(
    bin,
    source
      .replaceAll(ORPHAN_PID_PATH, JSON.stringify(orphanPidPath))
      .replaceAll(ORPHAN_HELPER_PATH, JSON.stringify(orphanHelper)),
  );
  chmodSync(bin, 0o755);
  return { bin, orphanPidPath };
}

const SPAWN_ORPHAN = `
import { spawn } from 'node:child_process';
const orphan = spawn(process.execPath, [${ORPHAN_HELPER_PATH}, ${ORPHAN_PID_PATH}], {
  stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  detached: true
});
await new Promise((resolve, reject) => {
  orphan.once('message', resolve);
  orphan.once('error', reject);
});
orphan.unref();
`;

afterEach(() => {
  for (const { directory, orphanPidPath } of fixtures.splice(0)) {
    if (existsSync(orphanPidPath)) {
      const pid = Number(readFileSync(orphanPidPath, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0 && isProcessAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The process can exit between the liveness check and the signal.
        }
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

async function expectOrphanStopped(path: string): Promise<void> {
  const pid = Number(readFileSync(path, 'utf8'));
  const deadline = Date.now() + 2_000;
  while (isProcessAlive(pid) && Date.now() < deadline) await delay(10);
  expect(isProcessAlive(pid)).toBe(false);
}

async function waitForOrphan(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path) && Date.now() < deadline) await delay(10);
  expect(existsSync(path)).toBe(true);
}

describe.runIf(process.platform !== 'win32')('Claude CLI process cleanup', () => {
  it('resolves a completed stream-json turn at exit', async () => {
    const assistant = JSON.stringify({
      type: 'assistant',
      message: {
        model: 'stub-model',
        content: [{ type: 'text', text: 'PONG' }],
      },
    });
    const terminal = JSON.stringify({
      type: 'result',
      result: 'PONG',
      usage: { input_tokens: 3, output_tokens: 1 },
    });
    const { bin, orphanPidPath } = stub(`#!/usr/bin/env node
import { readFileSync } from 'node:fs';
${SPAWN_ORPHAN}
readFileSync(0, 'utf8');
process.stdout.write(${JSON.stringify(`${assistant}\n${terminal}\n`)});
process.exit(0);
`);

    const startedAt = Date.now();
    const result = await new ClaudeCliEngine({ cliBinary: bin }).run(
      { prompt: 'ping' },
      () => {},
      new AbortController().signal,
    );

    expect(finalResultText(result)).toBe('PONG');
    expect(result.usage).toEqual({
      kind: 'reported',
      inputTokens: 3,
      outputTokens: 1,
    });
    expect(result.requested.executable).toBe(bin);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    await expectOrphanStopped(orphanPidPath);
  });

  it('starts cleanup at the work deadline and keeps a completed result', async () => {
    const assistant = JSON.stringify({
      type: 'assistant',
      message: {
        model: 'stub-model',
        content: [{ type: 'text', text: 'PONG' }],
      },
    });
    const terminal = JSON.stringify({
      type: 'result',
      result: 'PONG',
      usage: { input_tokens: 3, output_tokens: 1 },
    });
    const { bin } = stub(`#!/usr/bin/env node
import { readFileSync } from 'node:fs';
readFileSync(0, 'utf8');
process.stdout.write(${JSON.stringify(`${assistant}\n${terminal}\n`)});
await new Promise((resolve) => setTimeout(resolve, 1500));
`);

    const result = await new ClaudeCliEngine({ cliBinary: bin }).run(
      { prompt: 'ping', timeoutMs: 1_000, timeoutGraceMs: 1_000 },
      () => {},
      new AbortController().signal,
    );

    expect(finalResultText(result)).toBe('PONG');
    expect(result.transportFailure).toMatchObject({
      kind: 'timeout',
      message: expect.stringContaining('during teardown'),
      exitCode: null,
    });
  });

  it('settles an abort instead of waiting for the orphan', async () => {
    const { bin, orphanPidPath } = stub(`#!/usr/bin/env node
${SPAWN_ORPHAN}
setInterval(() => {}, 1000);
`);

    const controller = new AbortController();
    const startedAt = Date.now();
    const running = new ClaudeCliEngine({ cliBinary: bin }).run(
      { prompt: 'ping' },
      () => {},
      controller.signal,
    );
    const rejected = expect(running).rejects.toMatchObject({ kind: 'aborted' });
    await waitForOrphan(orphanPidPath);
    controller.abort();
    await rejected;
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    await expectOrphanStopped(orphanPidPath);
  });
});
