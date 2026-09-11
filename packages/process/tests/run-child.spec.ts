import { createRequire } from 'node:module';
import { spawn as spawnProcess, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { RunChildError, runChild } from '../src/index.ts';

const node = process.execPath;
const require = createRequire(import.meta.url);

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForText(stream: NodeJS.ReadableStream, expected: string): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    let text = '';
    const onData = (chunk: string | Uint8Array): void => {
      text += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      if (text.includes(expected)) {
        stream.off('data', onData);
        resolve();
      }
    };
    stream.on('data', onData);
    stream.once('error', reject);
    stream.once('end', () => reject(new Error(`stream ended before ${expected}`)));
  });
}

describe('runChild', () => {
  it('ends input and drains both output streams before returning', async () => {
    const result = await runChild({
      executable: node,
      args: ['-e', [
        'let input = "";',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.on("data", (chunk) => { input += chunk; });',
        'process.stdin.on("end", () => { process.stdout.write(input); process.stderr.write("WARN"); });',
      ].join('')],
      stdin: 'hello',
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
      aborted: false,
    });
    expect(new TextDecoder().decode(result.stdout)).toBe('hello');
    expect(new TextDecoder().decode(result.stderr)).toBe('WARN');
  });

  it('does not count teardown after an in-deadline exit as a timeout', async () => {
    const result = await runChild({
      executable: node,
      args: ['-e', 'process.exit(0)'],
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      hooks: {
        async onExit() {
          await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
        },
      },
    });

    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
      aborted: false,
    });
  });

  it.runIf(process.platform !== 'win32')('returns after exit when a survivor holds the output pipe', async () => {
    let survivorPid: number | undefined;
    try {
      const startedAt = performance.now();
      const result = await runChild({
        executable: node,
        args: ['--input-type=module', '-e', [
          'import { spawn } from "node:child_process";',
          'const survivor = spawn(process.execPath, ["-e", "setInterval(() => {}, 30_000)"], { detached: true, stdio: "inherit" });',
          'process.stdout.write(`${survivor.pid}\\ndone\\n`);',
          'setTimeout(() => process.exit(0), 20);',
        ].join('')],
        timeoutMs: 200,
        killGraceMs: 50,
        maxOutputBytes: 1_024,
      });
      const elapsedMs = performance.now() - startedAt;
      const output = new TextDecoder().decode(result.stdout);
      survivorPid = Number(output.match(/^\d+/u)?.[0]);

      expect(result).toMatchObject({ exitCode: 0, timedOut: false, aborted: false });
      expect(output).toContain('done');
      expect(elapsedMs).toBeLessThan(1_500);
    } finally {
      if (survivorPid !== undefined && Number.isSafeInteger(survivorPid)) {
        try {
          process.kill(survivorPid, 'SIGKILL');
        } catch {
          // The fixture may have ended during cleanup.
        }
        const deadline = Date.now() + 1_000;
        while (isProcessAlive(survivorPid) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(isProcessAlive(survivorPid)).toBe(false);
      }
    }
  });

  it.runIf(process.platform !== 'win32')('stops a live child when the parent process exits', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'obversa-process-parent-'));
    const pidPath = join(directory, 'child.pid');
    const fixture = join(import.meta.dirname, 'fixtures/parent-cleanup.ts');
    const parent = spawnProcess(node, ['--import', require.resolve('tsx'), fixture, pidPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let childPid: number | undefined;
    try {
      await waitForText(parent.stdout!, 'READY');
      childPid = Number(readFileSync(pidPath, 'utf8'));
      expect(isProcessAlive(childPid)).toBe(true);
      parent.kill('SIGTERM');
      await new Promise<void>((resolve) => parent.once('exit', () => resolve()));

      const deadline = Date.now() + 1_000;
      while (isProcessAlive(childPid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(isProcessAlive(childPid)).toBe(false);
    } finally {
      if (parent.exitCode === null) parent.kill('SIGKILL');
      if (childPid !== undefined && isProcessAlive(childPid)) parent.kill('SIGKILL');
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')('keeps children in the foreground group unless detached is requested', async () => {
    const parentGroup = spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout.trim();
    const groupFor = async (detached: boolean): Promise<string> => {
      const controller = new AbortController();
      let pid: number | undefined;
      const result = runChild({
        executable: node,
        args: ['-e', 'setInterval(() => {}, 1_000)'],
        detached,
        signal: controller.signal,
        timeoutMs: 2_000,
        maxOutputBytes: 1_024,
        hooks: {
          onSpawn(child) {
            pid = child.pid;
          },
        },
      });
      expect(pid).toBeDefined();
      const group = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
      controller.abort();
      await result;
      return group;
    };

    expect(await groupFor(false)).toBe(parentGroup);
    expect(await groupFor(true)).not.toBe(parentGroup);
  });

  it('reports a child that never exits as timed out and stops it', async () => {
    const result = await runChild({
      executable: node,
      args: ['-e', 'setInterval(() => {}, 1_000)'],
      timeoutMs: 40,
      killGraceMs: 100,
      maxOutputBytes: 1_024,
    });

    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
  });

  it('keeps timeout classification when the stopped child closes with no exit code', async () => {
    const result = await runChild({
      executable: node,
      args: ['-e', [
        'process.on("SIGTERM", () => {});',
        'setTimeout(() => process.kill(process.pid, "SIGKILL"), 100);',
        'setInterval(() => {}, 1_000);',
      ].join('')],
      timeoutMs: 40,
      killGraceMs: 200,
      maxOutputBytes: 1_024,
    });

    expect(result).toMatchObject({
      exitCode: null,
      timedOut: true,
      aborted: false,
    });
  });

  it('keeps timeout classification when setup delays the timeout callback', async () => {
    const result = await runChild({
      executable: node,
      args: ['-e', 'setInterval(() => {}, 1_000)'],
      timeoutMs: 20,
      killGraceMs: 100,
      maxOutputBytes: 1_024,
      hooks: {
        onSpawn(child) {
          const end = Date.now() + 100;
          while (Date.now() < end) {}
          expect(child.kill('SIGKILL')).toBe(true);
        },
      },
    });

    expect(result).toMatchObject({
      exitCode: null,
      timedOut: true,
      aborted: false,
    });
  });

  it('fails with an output limit while draining a full pipe', async () => {
    await expect(runChild({
      executable: node,
      args: ['-e', [
        'process.stdin.resume();',
        'process.stdin.on("end", () => { process.stdout.write("x".repeat(131072)); process.stderr.write("y".repeat(131072)); });',
      ].join('')],
      stdin: 'input',
      timeoutMs: 1_000,
      killGraceMs: 100,
      maxOutputBytes: 1_024,
    })).rejects.toMatchObject({
      name: 'RunChildError',
      code: 'OUTPUT_LIMIT',
    } satisfies Partial<RunChildError>);
  });
});
