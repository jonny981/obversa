import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex-cli';
import {
  briefFromFile,
  formatEvent,
  person,
  run,
  stage,
  workflow,
  type TeamSeat,
} from '@obversa/runtime';

interface TranslateEngines {
  readonly claude: (model: string) => TeamSeat;
  readonly codex: (model: string) => TeamSeat;
}

const realEngines: TranslateEngines = { claude, codex };

/**
 * Translate, reflect, glossary, and the last part is you. One model
 * translates the article with the glossary open; a model from another
 * family reads the translation the way an editor would and sends it back
 * with what to change, not a score; the translator writes down how every
 * glossary term was rendered and where the glossary and natural French
 * pulled apart. The person who knows the readers decides the nuance and
 * says publish.
 */
function createTranslateReflect(engines: TranslateEngines = realEngines) {
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
        // Three attempts, not two: the allowance matches how open-ended the
        // work is. A translation that honours a glossary and still reads
        // naturally has many defensible answers, so reviewer and writer need
        // room to meet.
        retry: 3,
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

const result = await run(createTranslateReflect(), {
  onEvent: (event) => console.log(formatEvent(event)),
});
console.log(JSON.stringify(result.outcome, null, 2));
