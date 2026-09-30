import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { finalResultText } from '../src/api.ts';
import { recordedJudge } from '../src/testing.ts';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function answersFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'recorded-judge-'));
  dirs.push(dir);
  return join(dir, 'judge.json');
}

async function ask(seat: ReturnType<typeof recordedJudge>): Promise<unknown> {
  const result = await seat.engine.run({ prompt: '{}' }, () => {}, new AbortController().signal);
  return JSON.parse(finalResultText(result) ?? 'null');
}

describe('recordedJudge()', () => {
  it('carries the same provider, family and model as the jev seat', () => {
    expect(recordedJudge('judge.json').identity).toEqual({
      adapter: 'recorded',
      provider: 'typesafe',
      modelFamily: 'jev',
      model: 'jev-latest',
      tools: [],
    });
  });

  it('replays one answer per call in order, then repeats the last', async () => {
    const path = await answersFile();
    // Built before the file exists: the file is read at the first call.
    const seat = recordedJudge(path);
    await writeFile(path, JSON.stringify([
      { stop_reason: { choice: 'continue' } },
      { stop_reason: { choice: 'holds' } },
    ]));
    expect(await ask(seat)).toEqual({ stop_reason: { choice: 'continue' } });
    expect(await ask(seat)).toEqual({ stop_reason: { choice: 'holds' } });
    expect(await ask(seat)).toEqual({ stop_reason: { choice: 'holds' } });
  });

  it('refuses a file that is not a non-empty array', async () => {
    const path = await answersFile();
    await writeFile(path, JSON.stringify({ judge: [] }));
    await expect(ask(recordedJudge(path))).rejects.toThrow(/non-empty JSON array/);
  });
});
