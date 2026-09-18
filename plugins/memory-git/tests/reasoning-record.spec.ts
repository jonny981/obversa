import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { openReasoningRecord, type RecordedEvent } from '../src/index.ts';

/**
 * A run's real events carry more fields than the record reads. The record's
 * own type names only what it reads, so a real event assigned from a variable
 * fits it; these literals are cast because a literal is checked for excess
 * properties and these are standing in for the real thing.
 */
const otherTraffic = (event: RecordedEvent & Record<string, unknown>): RecordedEvent => event;

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'obversa-reasoning-record-'));
  roots.push(root);
  const run = (args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  run(['init', '--quiet']);
  run(['config', 'user.email', 'fixture@example.invalid']);
  run(['config', 'user.name', 'Fixture']);
  run(['config', 'commit.gpgsign', 'false']);
  await writeFile(join(root, 'seed.txt'), 'seed\n');
  run(['add', '-A']);
  run(['commit', '--quiet', '-m', 'seed']);
  return root;
}

function bodyOfHead(root: string): string {
  return execFileSync('git', ['-C', root, 'log', '-1', '--format=%B'], { encoding: 'utf8' });
}

function commitCount(root: string): number {
  return Number(execFileSync('git', ['-C', root, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim());
}

const turn = (delta: string, node = 'implement') => ({
  kind: 'engine:text' as const,
  path: ['delivery', node],
  delta,
});

describe('the reasoning record', () => {
  it('writes the composed reasoning as the body of the change it explains', async () => {
    const root = await repository();
    const record = await openReasoningRecord({
      repositoryPath: root,
      stage: 'implement',
      compose: (input) => [
        '## Why',
        '',
        input.captured.map((entry) => entry.text).join(' '),
      ].join('\n'),
    });

    record.observe(turn('the first attempt used a clock, '));
    record.observe(turn('which fails under load, so it waits for the condition'));
    await writeFile(join(root, 'changed.txt'), 'work\n');
    const result = await record.close({ status: 'pass', summary: 'the stage finished' });

    expect(result.composed).toBe(true);
    expect(commitCount(root)).toBe(2);
    const body = bodyOfHead(root);
    expect(body).toContain('## Why');
    expect(body).toContain('waits for the condition');
  });

  it('takes the deterministic floor when composition fails, and says so', async () => {
    const root = await repository();
    const record = await openReasoningRecord({
      repositoryPath: root,
      stage: 'implement',
      compose: () => { throw new Error('the composer was unreachable'); },
    });

    record.observe(turn('some reasoning that will not be composed'));
    const result = await record.close({ status: 'pass', summary: 'the stage finished anyway' });

    // Every iteration leaves a trace: a gap is worst exactly where the work
    // was routine, which is where a later reader is most lost.
    expect(result.composed).toBe(false);
    expect(result.floor).toBe(true);
    expect(commitCount(root)).toBe(2);
    expect(bodyOfHead(root)).toContain('the stage finished anyway');
  });

  it('captures a writer\'s turns and ignores the run\'s other traffic', async () => {
    const root = await repository();
    const seen: string[] = [];
    const record = await openReasoningRecord({
      repositoryPath: root,
      stage: 'implement',
      compose: (input) => { seen.push(...input.captured.map((entry) => entry.text)); return 'body'; },
    });

    record.observe(turn('kept'));
    record.observe({ kind: 'engine:thinking', path: ['delivery', 'implement'], delta: 'also kept' });
    record.observe(otherTraffic({ kind: 'engine:tool', path: ['delivery', 'implement'], name: 'read', phase: 'use' }));
    record.observe(otherTraffic({ kind: 'dag:node', path: ['delivery'], node: 'implement', phase: 'start' }));
    await record.close({ status: 'pass' });

    expect(seen).toEqual(['kept', 'also kept']);
  });

  it('refuses a workspace that is not a repository, naming the stage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obversa-reasoning-plain-'));
    roots.push(root);
    await mkdir(join(root, 'work'), { recursive: true });

    await expect(openReasoningRecord({ repositoryPath: join(root, 'work'), stage: 'implement' }))
      .rejects.toThrow(/implement/);
  });

  it('keeps the composed body about the reasoning, never the diff', async () => {
    const root = await repository();
    const record = await openReasoningRecord({
      repositoryPath: root,
      stage: 'implement',
      compose: (input) => `## Why\n\n${input.captured.length} turns\n`,
    });
    record.observe(turn('one'));
    await writeFile(join(root, 'changed.txt'), 'work\n');
    await record.close({ status: 'pass', summary: 'done' });

    const body = bodyOfHead(root);
    expect(body).not.toContain('changed.txt');
    expect(body).not.toContain('diff --git');
  });
});
