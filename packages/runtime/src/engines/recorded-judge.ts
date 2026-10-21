import { readFile } from 'node:fs/promises';

import {
  assistantResult,
  engineSelection,
  type Engine,
  type TeamSeat,
} from '@obversa/api';

/**
 * A seat that stands in for the Jev seat in a proof or an offline run. The
 * file at `path` is a JSON array of answer objects, one per round. Each call
 * answers the questions its prompt asks from the current entry, so a round
 * the judge asks in two calls (the finding scores, then the round questions)
 * reads one entry. A call whose packet names a different round
 * (`state.when.round`) than the call before it, or that asks a question the
 * current entry already answered, reads the next entry; the last entry
 * repeats. A prompt that names no questions gets the whole entry. The file
 * is read at the first call, not when the seat is built.
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
  let entry = 0;
  let lastRound: number | undefined;
  const served = new Set<string>();
  const engine: Engine = {
    name: 'recorded',
    async run(request) {
      answers ??= readFile(path, 'utf8').then((text) => {
        const parsed: unknown = JSON.parse(text);
        if (!Array.isArray(parsed) || parsed.length === 0) {
          throw new TypeError(`${path} must hold a non-empty JSON array of answer objects`);
        }
        return parsed;
      });
      const list = await answers;
      const current = (): unknown => list[Math.min(entry, list.length - 1)];
      const { questions: named, round } = readPrompt(request.prompt);
      const asked = named ?? Object.keys(current() ?? {});
      const newRound = round !== undefined && lastRound !== undefined && round !== lastRound;
      if (newRound || asked.some((key) => served.has(key))) {
        entry += 1;
        served.clear();
      }
      if (round !== undefined) lastRound = round;
      for (const key of asked) served.add(key);
      const whole = current();
      const answer = named === undefined || whole === null || typeof whole !== 'object'
        ? whole
        : Object.fromEntries(Object.entries(whole).filter(([key]) => named.includes(key)));
      return assistantResult({ text: JSON.stringify(answer), usage: { kind: 'unknown' }, requested: selection });
    },
  };
  return { engine, identity };
}

/**
 * The question keys a judge prompt (`{ state, questions }` as JSON) asks and
 * the round its packet names; each is undefined when the prompt omits it.
 */
function readPrompt(prompt: string): { questions?: string[]; round?: number } {
  try {
    const { state, questions } = JSON.parse(prompt) as { state?: { when?: { round?: unknown } }; questions?: unknown };
    const round = state?.when?.round;
    return {
      ...(questions !== null && typeof questions === 'object' && !Array.isArray(questions) ? { questions: Object.keys(questions) } : {}),
      ...(typeof round === 'number' ? { round } : {}),
    };
  } catch {
    return {};
  }
}
