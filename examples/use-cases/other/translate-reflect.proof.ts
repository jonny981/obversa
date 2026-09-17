import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pass, revise, withExample } from '../proof-host.ts';

const here = dirname(fileURLToPath(import.meta.url));
const brief = await readFile(join(here, 'briefs/translation.md'), 'utf8');
const article = await readFile(join(here, 'source/article.md'), 'utf8');
const glossary = await readFile(join(here, 'glossary/en-fr.md'), 'utf8');

const literal = '# Les factures partent maintenant toutes seules\n\nÀ partir d\'aujourd\'hui, une facture récurrente s\'expédie elle-même. Réglez le calendrier une fois, et Ledgerline crée la facture, attache le PDF et l\'expédie le jour dit, puis la marque payée quand l\'argent arrive.\n\nVous restez aux commandes. Chaque facture attend dans Brouillons aussi longtemps que vous voulez avant son premier envoi, et vous pouvez mettre un calendrier en pause depuis la page de la facture.\n\nRien ne change pour les factures ponctuelles. Le bouton Envoyer fait ce qu\'il a toujours fait, et les rappels de paiement gardent leur rythme.\n';
const revised = literal
  .replace("s'expédie elle-même", "s'envoie toute seule")
  .replace("l'expédie le jour dit", "l'envoie le jour venu")
  .replace('les rappels de paiement', 'les relances de paiement');
const terms = '| English | Where | Rendered | Note |\n| --- | --- | --- | --- |\n| invoice | throughout | facture | |\n| recurring invoice | first paragraph | facture récurrente | |\n| Drafts | second paragraph | Brouillons | |\n| send | first and third paragraphs | envoyer | "expédier" reads more naturally for a parcel, not a PDF; the glossary is right here |\n| paid | first paragraph | payée | |\n| payment reminder | third paragraph | relance de paiement | "rappel" is what most people say; the glossary keeps "relance", the accounting term |\n';

// The reviewer reflects once: two glossary terms were rendered with the
// words the glossary rules out. The second translation follows the
// glossary, the terms note records where that cost naturalness, and the
// run stops at the editor.
await withExample({
  here,
  example: 'translate-reflect',
  files: { 'briefs/translation.md': brief, 'source/article.md': article, 'glossary/en-fr.md': glossary },
  seats: {
    claude: [
      { writes: { 'fr/article.md': literal }, reply: pass('translated; three paragraphs kept') },
      { writes: { 'fr/article.md': revised }, reply: pass('"envoyer" and "relance" now follow the glossary') },
      { writes: { 'fr/terms.md': terms }, reply: pass('six terms listed, two flagged') },
    ],
    codex: [
      { reply: revise('two glossary terms are rendered with the words the glossary rules out', '"s\'expédie" and "l\'expédie" where the glossary says "envoyer"', '"rappels de paiement" where the glossary says "relance de paiement"') },
      { reply: pass('reads as French written for a French reader, and the glossary holds') },
    ],
  },
}, async (run) => {
  assert.equal(run.printed.status, 'paused', `the run stops at the editor: ${run.stdout}`);
  assert.equal(run.printed.data?.nuance?.status, 'paused');
  assert.match(run.printed.summary ?? '', /Publish this translation/);
  assert.equal(run.seatCalls.filter((call) => call.role === 'claude').length, 3, 'translate twice, terms once');
  assert.equal(run.seatCalls.filter((call) => call.role === 'codex').length, 2, 'the reviewer reflects on both versions');
  const translation = await run.read('fr/article.md');
  assert.match(translation, /relances de paiement/, 'the glossary term is on disk');
  assert.doesNotMatch(translation, /expédie/, 'the ruled-out word is gone');
  assert.match(await run.read('fr/terms.md'), /relance/, 'the terms note is on disk');
  assert.match(run.stdout, /tok/, 'the run prints its usage lines');

  console.log(JSON.stringify({
    status: 'pass',
    stages: 3,
    translations: 2,
    reflections: 2,
    glossaryTerms: 6,
    pausedAt: 'nuance',
    mode: run.mode,
  }, null, 2));
});
