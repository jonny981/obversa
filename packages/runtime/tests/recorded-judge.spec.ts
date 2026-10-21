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

async function ask(seat: ReturnType<typeof recordedJudge>, questions?: readonly string[], round?: number): Promise<unknown> {
  const state = round === undefined ? {} : { when: { round } };
  const prompt = questions === undefined ? '{}' : JSON.stringify({ state, questions: Object.fromEntries(questions.map((key) => [key, {}])) });
  const result = await seat.engine.run({ prompt }, () => {}, new AbortController().signal);
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

  it('serves one round from one entry when the judge asks the findings and the round in two calls', async () => {
    const path = await answersFile();
    const seat = recordedJudge(path);
    await writeFile(path, JSON.stringify([
      { 'finding-1': { score: 2 }, stop_reason: { choice: 'continue' } },
      { 'finding-1': { score: 1 }, stop_reason: { choice: 'holds' } },
    ]));
    // Round 1: the finding scores, then the round questions, from the first entry.
    expect(await ask(seat, ['finding-1'])).toEqual({ 'finding-1': { score: 2 } });
    expect(await ask(seat, ['stop_reason'])).toEqual({ stop_reason: { choice: 'continue' } });
    // Round 2 asks finding-1 again, so it reads the next entry.
    expect(await ask(seat, ['finding-1'])).toEqual({ 'finding-1': { score: 1 } });
    expect(await ask(seat, ['stop_reason'])).toEqual({ stop_reason: { choice: 'holds' } });
  });

  it('reads the next entry when the round changes, even when the new round asks no question the last one did', async () => {
    const path = await answersFile();
    const seat = recordedJudge(path);
    await writeFile(path, JSON.stringify([
      { product_decision: { noul: 0.1 }, stop_reason: { choice: 'continue' } },
      { 'finding-1': { score: 3 }, 'finding-2': { score: 0 }, product_decision: { noul: 0.1 }, stop_reason: { choice: 'holds' } },
    ]));
    // Round 1 has no findings, so it is one call over the round questions.
    expect(await ask(seat, ['product_decision', 'stop_reason'], 1)).toEqual({
      product_decision: { noul: 0.1 }, stop_reason: { choice: 'continue' },
    });
    // Round 2 asks its finding scores first: no key overlaps round 1, but the round number moved on.
    expect(await ask(seat, ['finding-1', 'finding-2'], 2)).toEqual({ 'finding-1': { score: 3 }, 'finding-2': { score: 0 } });
    expect(await ask(seat, ['product_decision', 'stop_reason'], 2)).toEqual({
      product_decision: { noul: 0.1 }, stop_reason: { choice: 'holds' },
    });
  });

  it('refuses a file that is not a non-empty array', async () => {
    const path = await answersFile();
    await writeFile(path, JSON.stringify({ judge: [] }));
    await expect(ask(recordedJudge(path))).rejects.toThrow(/non-empty JSON array/);
  });
});
