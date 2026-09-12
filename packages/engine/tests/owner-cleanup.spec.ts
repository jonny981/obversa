import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { cleanupFixture, fixtureDirectory, isProcessAlive } from './process-fixture.ts';
import { inspectOwnerMarkedProcesses } from '../src/command/run.ts';

// Real work: these tests build real process fixtures in temporary
// directories on disk and write files to them, so this file declares its
// own time limit; the suite default is a hang guard, not a speed bar.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const loader = createRequire(import.meta.url).resolve('tsx');
const fixture = join(import.meta.dirname, 'fixtures/process-tree/owner.mjs');
const owner = `sha256:${'a'.repeat(64)}` as const;

async function record(directory: string, name: string): Promise<Record<string, unknown>> {
  const path = join(directory, `${name}.json`);
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Missing ${name}`);
    await delay(10);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function reportDiagnostic(directory: string): Promise<void> {
  const path = join(directory, 'run-diagnostic.json');
  const deadline = Date.now() + 1_000;
  while (!existsSync(path) && Date.now() < deadline) await delay(10);
  if (existsSync(path)) {
    console.error(`[owner-cleanup diagnostic] ${readFileSync(path, 'utf8')}`);
  } else {
    console.error(`[owner-cleanup diagnostic] no run-diagnostic.json; files=${JSON.stringify(readdirSync(directory))}`);
  }
}

function stop(pid: number): void {
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')('command owner cleanup', () => {
  it(process.platform === 'linux'
    ? 'ignores owner text in arguments and other environment values'
    : 'does not infer unsupported macOS ownership from argument or environment text', async () => {
    const children = [
      spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '', 'argument with spaces', `OBVERSA_RUN_OWNER=${owner}`], { stdio: 'ignore' }),
      spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore', env: { ...process.env, OTHER_ENV: `prefix OBVERSA_RUN_OWNER=${owner} suffix` },
      }),
    ];
    try {
      const found = await inspectOwnerMarkedProcesses(owner);
      expect(found.filter((entry) => children.some((child) => child.pid === entry.pid))).toEqual([]);
    } finally {
      for (const child of children) stop(child.pid!);
    }
  });

  it.runIf(process.platform === 'linux')('cleans a helper created by an owned child during SIGTERM', async () => {
    const directory = fixtureDirectory();
    const watchdog = spawn(process.execPath, ['--import', loader, fixture, 'term-watchdog', directory, owner, loader], {
      stdio: 'inherit',
    });
    try {
      const helper = await record(directory, 'term-helper');
      await delay(100);
      process.kill(watchdog.pid!, 'SIGCONT');
      await record(directory, 'result');
      expect(isProcessAlive(helper.pid as number)).toBe(false);
    } finally {
      try { process.kill(watchdog.pid!, 'SIGCONT'); } catch {}
      stop(watchdog.pid!);
      for (const name of ['term-parent', 'term-helper']) {
        if (existsSync(join(directory, `${name}.json`))) stop((await record(directory, name)).pid as number);
      }
      cleanupFixture(directory);
    }
  });

  it(process.platform === 'linux'
    ? 'cleans a detached nested command missed while its watchdog is stopped'
    : 'leaves an unobserved detached helper outside macOS cleanup capability', async () => {
    const directory = fixtureDirectory();
    const unrelated = [`sha256:${'b'.repeat(64)}`, `${owner}0`].map((marker) => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true, stdio: 'ignore',
      env: { ...process.env, OBVERSA_RUN_OWNER: marker },
    }));
    const watchdog = spawn(process.execPath, ['--import', loader, fixture, 'watchdog', directory, owner, loader], {
      stdio: 'inherit',
    });
    try {
      let worker: Record<string, unknown>;
      try {
        worker = await record(directory, 'worker');
      } catch (error) {
        try { process.kill(watchdog.pid!, 'SIGCONT'); } catch {}
        await reportDiagnostic(directory);
        throw error;
      }
      process.kill(watchdog.pid!, 'SIGSTOP');
      await delay(50);
      writeFileSync(join(directory, 'go'), '');
      const helper = await record(directory, 'helper');
      const workerExitDeadline = Date.now() + 5_000;
      while (isProcessAlive(worker.pid as number)) {
        const state = execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(worker.pid)], { encoding: 'utf8' });
        if (state.trimStart().startsWith('Z')) break;
        if (Date.now() >= workerExitDeadline) throw new Error('Worker did not exit before watchdog resume');
        await delay(10);
      }
      process.kill(watchdog.pid!, 'SIGCONT');
      const result = await record(directory, 'result');
      expect(result.remaining).toEqual([]);
      if (process.platform === 'linux') {
        expect(isProcessAlive(helper.pid as number)).toBe(false);
      } else {
        expect(isProcessAlive(helper.pid as number)).toBe(true);
      }
      expect(unrelated.every((child) => isProcessAlive(child.pid!))).toBe(true);
    } finally {
      try { process.kill(watchdog.pid!, 'SIGCONT'); } catch {}
      stop(watchdog.pid!);
      for (const child of unrelated) stop(child.pid!);
      for (const name of ['worker', 'helper']) {
        if (existsSync(join(directory, `${name}.json`))) stop((await record(directory, name)).pid as number);
      }
      cleanupFixture(directory);
    }
  });

  it('preserves inherited ownership without sweeping the worker or its sibling', async () => {
    const directory = fixtureDirectory();
    const worker = spawn(process.execPath, ['--import', loader, fixture, 'nested', directory, owner, loader], {
      stdio: 'inherit', env: { ...process.env, OBVERSA_RUN_OWNER: owner },
    });
    try {
      expect(await record(directory, 'result')).toEqual({ exitCode: 0, owner });
      expect(await record(directory, 'short')).toEqual({ owner });
    } finally {
      stop(worker.pid!);
      if (existsSync(join(directory, 'sibling.json'))) stop((await record(directory, 'sibling')).pid as number);
      cleanupFixture(directory);
    }
  });
});
