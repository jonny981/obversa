import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupFixture, fixtureDirectory } from './process-fixture.js';

// A process can exit between the /proc listing and the read of its environ;
// Linux then answers ESRCH. That process is gone, so the scan skips it.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(async (path: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
      if (String(path).endsWith(join('103', 'environ'))) {
        throw Object.assign(new Error('ESRCH: no such process'), { code: 'ESRCH' });
      }
      return (actual.readFile as (...args: unknown[]) => unknown)(path, ...rest);
    }),
  };
});

const { readAttemptMarkerProcessIds } = await import('../src/command/process-tree.js');
const ATTEMPT_ID = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) cleanupFixture(directory);
});

describe('a process that exits during the /proc scan', () => {
  it('is skipped, and the scan still finds the marked process', async () => {
    const directory = fixtureDirectory();
    directories.push(directory);
    for (const pid of ['101', '103']) mkdirSync(join(directory, pid));
    writeFileSync(join(directory, '101', 'environ'), Buffer.from(`OBVERSA_ATTEMPT_ID=${ATTEMPT_ID}\0`, 'utf8'));
    writeFileSync(join(directory, '103', 'environ'), Buffer.from('OTHER=value\0', 'utf8'));

    await expect(readAttemptMarkerProcessIds(ATTEMPT_ID, directory)).resolves.toEqual([101]);
  });
});
