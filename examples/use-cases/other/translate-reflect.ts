import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex-cli';
import { jev } from '@obversa/engine-jev-api';
import {
  briefFromFile,
  formatEvent,
  judge,
  person,
  run,
  stage,
  workflow,
  type TeamSeat,
} from '@obversa/runtime';
import { recordedJudge } from '@obversa/runtime/testing';

interface TranslateEngines {
  readonly claude: (model: string) => TeamSeat;
  readonly codex: (model: string) => TeamSeat;
}

const realEngines: TranslateEngines = { claude, codex };

/**
 * The judge that decides whether the translation goes round again: Jev over the
 * TypeSafe API when JUDGE=jev, otherwise the answers recorded in judge.json
 * beside the brief, one set per round, so the file runs offline.
 */
const judgeSeat = process.env.JUDGE === 'jev' ? jev() : recordedJudge('judge.json');

/**
 * Translate, reflect, a judge, glossary, and the last part is you. One model
 * translates the article with the glossary open; a model from another
 * family reads the translation the way an editor would and returns it
 * with what to change, not a score; the judge decides when another round
 * is worth it, until it stops them or the review passes; the translator writes down how every
 * glossary term was rendered and where the glossary and natural French
 * pulled apart. The person who knows the readers decides the nuance and
 * says publish.
 */
function createTranslateReflect(judgeSeat: TeamSeat, engines: TranslateEngines = realEngines) {
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
        // worth it; a finding tagged block goes back without asking. With no
        // cap, the rounds end when the judge stops them or the review passes.
        refine: judge(judgeSeat),
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

// The run waits for the editor and prints the address of a page to answer
// on. The wait lives in this process: stop it before the editor answers,
// and the next run starts again from the first stage.
const result = await run(createTranslateReflect(judgeSeat), {
  onCallback: 'wait',
  monitor: true,
  onEvent: (event) => console.log(event.kind === 'monitor' ? `Answer the editor's question on ${event.url}` : formatEvent(event)),
  recordTo: 'records/translate-reflect.jsonl',
});
await result.monitor?.close();
console.log(JSON.stringify(result.outcome, null, 2));
