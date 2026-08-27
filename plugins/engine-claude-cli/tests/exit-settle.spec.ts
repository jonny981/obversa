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

const HOLD_SECS = 120;
const ORPHAN_PID_PATH = '__ORPHAN_PID_PATH__';
const directories: string[] = [];

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
  directories.push(dir);
  const bin = join(dir, 'engine-stub.mjs');
  const orphanPidPath = join(dir, 'orphan.pid');
  writeFileSync(
    bin,
    source.replaceAll(ORPHAN_PID_PATH, JSON.stringify(orphanPidPath)),
  );
  chmodSync(bin, 0o755);
  return { bin, orphanPidPath };
}

const SPAWN_ORPHAN = `
import { spawn } from 'node:child_process';
import { writeFileSync as writeOrphanPid } from 'node:fs';
const orphan = spawn('sleep', ['${HOLD_SECS}'], { stdio: 'inherit', detached: true });
writeOrphanPid(${ORPHAN_PID_PATH}, String(orphan.pid));
orphan.unref();
`;

afterEach(() => {
  for (const directory of directories.splice(0)) {
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
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    await expectOrphanStopped(orphanPidPath);
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
