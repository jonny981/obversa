import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const parentFixture = join(
  import.meta.dirname,
  'fixtures/process-tree/parent.mjs',
);

export const directDetachedFixture = join(
  import.meta.dirname,
  'fixtures/process-tree/direct-detached.mjs',
);

export interface FixtureRecord {
  readonly pid: number;
  readonly parentPid: number;
  readonly childPid?: number;
  readonly grandchildPid?: number;
  readonly attemptId: string | null;
  readonly runId: string | null;
  readonly headless: string | null;
}

export function fixtureDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'lines-process-tree-'));
}

export async function waitForFixtureRecord(
  directory: string,
  name: 'parent' | 'child' | 'grandchild',
): Promise<FixtureRecord> {
  const path = join(directory, `${name}.json`);
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${name} process barrier.`);
    }
    await delay(5);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureRecord;
}

export function fixturePids(directory: string): readonly number[] {
  const pids = new Set<number>();
  for (const name of ['parent', 'child', 'grandchild'] as const) {
    const path = join(directory, `${name}.json`);
    if (!existsSync(path)) continue;
    const record = JSON.parse(readFileSync(path, 'utf8')) as FixtureRecord;
    pids.add(record.pid);
    if (record.childPid !== undefined) pids.add(record.childPid);
    if (record.grandchildPid !== undefined) pids.add(record.grandchildPid);
  }
  const directPath = join(directory, 'direct.json');
  if (existsSync(directPath)) {
    pids.add((JSON.parse(readFileSync(directPath, 'utf8')) as { pid: number }).pid);
  }
  return [...pids];
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function cleanupFixture(directory: string): void {
  for (const pid of fixturePids(directory)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  rmSync(directory, { recursive: true, force: true });
}
