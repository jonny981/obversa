/**
 * Engine subprocess resolution is bounded by process EXIT, not stream close.
 *
 * A real engine CLI (codex, claude) spawns helpers — MCP transport workers,
 * hook processes — that inherit its stdio. An orphan that outlives the engine
 * holds the pipe write ends open, and execa settles only when every stream
 * ends: the completed turn would never resolve back to the loop, and neither
 * execa's `timeout` nor `cancelSignal` can settle it in that state. These
 * fixtures reproduce the orphan deterministically (a detached `sleep` given
 * the inherited stdio) and prove each adapter resolves at exit anyway.
 */
import { afterEach, describe, it, expect } from 'vitest';
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
import { CodexEngine } from '../src/index.ts';

/** Seconds the orphan holds the pipes — far beyond any test bound below, so a
 *  regression to stream-close waiting fails loudly rather than just slowly. */
const HOLD_SECS = 120;
const ORPHAN_PID_PATH = '__ORPHAN_PID_PATH__';
const FINAL_MARKER_PATH = '__FINAL_MARKER_PATH__';
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
  readonly finalMarkerPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'lines-exit-settle-'));
  directories.push(dir);
  const bin = join(dir, 'engine-stub.mjs');
  const orphanPidPath = join(dir, 'orphan.pid');
  const finalMarkerPath = join(dir, 'final-written');
  writeFileSync(
    bin,
    source
      .replaceAll(ORPHAN_PID_PATH, JSON.stringify(orphanPidPath))
      .replaceAll(FINAL_MARKER_PATH, JSON.stringify(finalMarkerPath)),
  );
  chmodSync(bin, 0o755);
  return { bin, orphanPidPath, finalMarkerPath };
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

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path) && Date.now() < deadline) await delay(10);
  expect(existsSync(path)).toBe(true);
}

describe.runIf(process.platform !== 'win32')('engine-owned process cleanup', () => {
  it('codex resolves a completed turn at exit', async () => {
    const { bin, orphanPidPath } = stub(`#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
${SPAWN_ORPHAN}
const args = process.argv.slice(2);
readFileSync(0, 'utf8');
writeFileSync(args[args.indexOf('-o') + 1], 'PONG');
process.exit(0);
`);

    const startedAt = Date.now();
    const result = await new CodexEngine({ cliBinary: bin }).run(
      { prompt: 'ping' },
      () => {},
      new AbortController().signal,
    );

    expect(finalResultText(result)).toBe('PONG');
    expect(result.transportFailure).toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    await expectOrphanStopped(orphanPidPath);
  });

  it('starts cleanup at the work deadline and keeps a completed result', async () => {
    const { bin, finalMarkerPath } = stub(`#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
readFileSync(0, 'utf8');
process.on('SIGTERM', () => {});
writeFileSync(args[args.indexOf('-o') + 1], 'PONG');
writeFileSync(${FINAL_MARKER_PATH}, 'written');
setInterval(() => {}, 1_000);
await new Promise(() => {});
`);

    const controller = new AbortController();
    let abortFired = false;
    const running = new CodexEngine({ cliBinary: bin }).run(
      { prompt: 'ping', timeoutMs: 5_000, timeoutGraceMs: 500 },
      () => {},
      controller.signal,
    );
    await waitForFile(finalMarkerPath);
    abortFired = true;
    controller.abort();
    const result = await running;

    expect(abortFired).toBe(true);
    expect(finalResultText(result)).toBe('PONG');
    expect(result.usage).toBeDefined();
    expect(result.transportFailure).toMatchObject({
      kind: 'aborted',
      message: expect.stringContaining('during teardown'),
      exitCode: null,
    });
  });

  it('classifies a null exit after the deadline as a timeout', async () => {
    const { bin } = stub(`#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
readFileSync(0, 'utf8');
process.on('SIGTERM', () => {});
writeFileSync(args[args.indexOf('-o') + 1], 'PONG');
setTimeout(() => process.kill(process.pid, 'SIGKILL'), 325);
setInterval(() => {}, 1_000);
`);

    const result = await new CodexEngine({ cliBinary: bin }).run(
      { prompt: 'ping', timeoutMs: 300, timeoutGraceMs: 100 },
      () => {},
      new AbortController().signal,
    );

    expect(finalResultText(result)).toBe('PONG');
    expect(result.transportFailure).toMatchObject({
      kind: 'timeout',
      exitCode: null,
    });
  });

  it('the hard timeout still fires when the engine never exits', async () => {
    const { bin, orphanPidPath } = stub(`#!/usr/bin/env node
${SPAWN_ORPHAN}
setInterval(() => {}, 1000);
`);

    const startedAt = Date.now();
    const running = new CodexEngine({ cliBinary: bin }).run(
      { prompt: 'ping', timeoutMs: 5_000 },
      () => {},
      new AbortController().signal,
    );
    // Keep an early timeout handled while the fixture reports readiness.
    void running.catch(() => {});
    await waitForFile(orphanPidPath);
    await expect(running).rejects.toMatchObject({ kind: 'timeout' });
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    await expectOrphanStopped(orphanPidPath);
  }, 15_000);
});
