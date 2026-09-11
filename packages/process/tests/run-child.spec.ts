import { describe, expect, it } from 'vitest';

import { RunChildError, runChild } from '../src/index.ts';

const node = process.execPath;

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
