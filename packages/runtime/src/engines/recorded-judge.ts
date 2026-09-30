import { readFile } from 'node:fs/promises';

import {
  assistantResult,
  engineSelection,
  type Engine,
  type TeamSeat,
} from '@obversa/api';

/**
 * A seat that stands in for the Jev seat in a proof or an offline run. The
 * file at `path` is a JSON array of answer objects. Each call returns the
 * next one as assistant text, and the last one repeats. The file is read at
 * the first call, not when the seat is built.
 */
export function recordedJudge(path: string): TeamSeat {
  const identity = {
    adapter: 'recorded',
    provider: 'typesafe',
    modelFamily: 'jev',
    model: 'jev-latest',
    tools: [],
  };
  const selection = engineSelection(identity);
  let answers: Promise<readonly unknown[]> | undefined;
  let calls = 0;
  const engine: Engine = {
    name: 'recorded',
    async run() {
      answers ??= readFile(path, 'utf8').then((text) => {
        const parsed: unknown = JSON.parse(text);
        if (!Array.isArray(parsed) || parsed.length === 0) {
          throw new TypeError(`${path} must hold a non-empty JSON array of answer objects`);
        }
        return parsed;
      });
      const list = await answers;
      const answer = list[Math.min(calls++, list.length - 1)];
      return assistantResult({ text: JSON.stringify(answer), usage: { kind: 'unknown' }, requested: selection });
    },
  };
  return { engine, identity };
}
