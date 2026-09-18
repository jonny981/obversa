import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { briefFromFile, person, run, stage, workflow } from '../src/api.js';

describe('the public workflow builder', () => {
  it('runs a declared command and pauses for a person through the runtime entry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'f66-workflow-'));
    const briefPath = join(directory, 'brief.md');
    await writeFile(briefPath, '---\nfiles: ["result.txt"]\n---\nWrite the result.\n');

    try {
      const job = workflow('one-result', {
        brief: briefFromFile(briefPath),
        roles: { approve: person('Approve the result?') },
        stages: [
          stage('write', {
            run: ['node', '-e', "require('node:fs').writeFileSync('result.txt', 'ready\\n')"],
            writes: 'result.txt',
          }),
          stage('approve', { input: 'approve' }),
        ],
      });
      const result = await run(job, { cwd: directory });
      expect(result.outcome.status).toBe('paused');
      expect(await readFile(join(directory, 'result.txt'), 'utf8')).toBe('ready\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
