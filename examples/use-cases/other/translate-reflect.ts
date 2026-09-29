import { readFile } from 'node:fs/promises';

import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex-cli';
import { JevApiEngine } from '@obversa/engine-jev-api';
import {
  briefFromFile,
  finalResultPart,
  formatEvent,
  judge,
  person,
  run,
  stage,
  workflow,
  type Engine,
  type JudgeAnswer,
  type TeamSeat,
} from '@obversa/runtime';
import { MockEngine } from '@obversa/runtime/testing';

interface TranslateEngines {
  readonly claude: (model: string) => TeamSeat;
  readonly codex: (model: string) => TeamSeat;
}

const realEngines: TranslateEngines = { claude, codex };

/**
 * The judge that decides whether the translation goes round again: Jev over the
 * TypeSafe API when JUDGE=jev, otherwise the answers recorded in judge.json
 * beside the brief, one set per round, so the file runs offline. Jev answers
 * with a structured part and a stage wants text, so the seat wraps the
 * answers as JSON.
 */
async function judgeSeat(): Promise<TeamSeat> {
  const identity = { adapter: 'jev-api', provider: 'typesafe', modelFamily: 'jev', model: 'jev-latest', tools: [] };
  if (process.env.JUDGE === 'jev') {
    const endpoint = process.env.TYPESAFE_ENDPOINT;
    const apiKey = process.env.TYPESAFE_API_KEY;
    if (!endpoint || !apiKey) throw new Error('JUDGE=jev needs TYPESAFE_ENDPOINT and TYPESAFE_API_KEY');
    const api = new JevApiEngine({ endpoint, apiKey });
    const engine = {
      name: 'jev-api',
      async run(request, onEvent, signal) {
        const result = await api.run(request, onEvent, signal);
        const part = finalResultPart(result);
        return part.kind === 'structured' ? { ...result, parts: [{ kind: 'assistant', text: JSON.stringify(part.value), final: true }] } : result;
      },
    } as Engine;
    return { engine, identity };
  }
  const answers = JSON.parse(await readFile('judge.json', 'utf8')) as Record<string, JudgeAnswer>[];
  let round = 0;
  return { engine: new MockEngine(() => JSON.stringify(answers[Math.min(round++, answers.length - 1)])), identity: { ...identity, adapter: 'recorded' } };
}

/**
 * Translate, reflect, a judge, glossary, and the last part is you. One model
 * translates the article with the glossary open; a model from another
 * family reads the translation the way an editor would and returns it
 * with what to change, not a score; the judge decides when another round
 * is worth it, with the cap as the backstop; the translator writes down how every
 * glossary term was rendered and where the glossary and natural French
 * pulled apart. The person who knows the readers decides the nuance and
 * says publish.
 */
function createTranslateReflect(jev: TeamSeat, engines: TranslateEngines = realEngines) {
  return workflow('translate-reflect', {
    brief: briefFromFile('briefs/translation.md'),
    options: { timeout: '10m' },

    roles: {
      translate: engines.claude('claude-sonnet-4-5'),
      reflect: [engines.codex('gpt-5.6-luna')],
      editor: person('Publish this translation?'),
    },

    stages: [
      stage('translate', {
        agent: 'translate',
        writes: 'fr/article.md',
        desc: 'Translate source/article.md into French for a reader in France, in the tone the brief names, rendering every term in glossary/en-fr.md as the glossary says.',
        gate: 'The translation is complete and a reviewer from another family, reading it as an editor would, has accepted it.',
        reviewedBy: 'reflect',
        // The judge. After a round the reflection did not pass, Jev reads the
        // findings and the rounds so far and says whether another round is
        // worth it; a finding tagged block goes back without asking. The
        // cap is the backstop: three rounds at most, whatever the judge says.
        refine: judge(jev, { cap: 3 }),
      }),

      stage('terms', {
        agent: 'translate',
        writes: 'fr/terms.md',
        desc: 'List every glossary term, where it appears, and how it was rendered; flag each place where the glossary and natural French pulled apart.',
        gate: 'Every glossary term is on the list.',
      }),

      stage('nuance', {
        input: 'editor',
        desc: 'Put the translation and the terms note in front of the person who knows the readers.',
        gate: 'A person has said publish.',
        sendsBackTo: 'translate',
      }),
    ],
  });
}

const result = await run(createTranslateReflect(await judgeSeat()), {
  onEvent: (event) => console.log(formatEvent(event)),
  recordTo: 'records/translate-reflect.jsonl',
});
console.log(JSON.stringify(result.outcome, null, 2));
