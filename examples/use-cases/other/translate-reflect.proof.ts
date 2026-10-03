import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pass, recordEvents, shouldFix, sourceDir, withExample } from '../proof-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const samples = sourceDir(here);
const brief = await readFile(join(samples, 'briefs/translation.md'), 'utf8');
const article = await readFile(join(samples, 'source/article.md'), 'utf8');
const glossary = await readFile(join(samples, 'glossary/en-fr.md'), 'utf8');
const judgeJson = await readFile(join(samples, 'judge.json'), 'utf8');

const literal = '# Les factures partent maintenant toutes seules\n\nÀ partir d\'aujourd\'hui, une facture récurrente s\'expédie elle-même. Réglez le calendrier une fois, et Ledgerline crée la facture, attache le PDF et l\'expédie le jour dit, puis la marque payée quand l\'argent arrive.\n\nVous restez aux commandes. Chaque facture attend dans Brouillons aussi longtemps que vous voulez avant son premier envoi, et vous pouvez mettre un calendrier en pause depuis la page de la facture.\n\nRien ne change pour les factures ponctuelles. Le bouton Envoyer fait ce qu\'il a toujours fait, et les rappels de paiement gardent leur rythme.\n';
const revised = literal
  .replace("s'expédie elle-même", "s'envoie toute seule")
  .replace("l'expédie le jour dit", "l'envoie le jour venu")
  .replace('les rappels de paiement', 'les relances de paiement');
const terms = '| English | Where | Rendered | Note |\n| --- | --- | --- | --- |\n| invoice | throughout | facture | |\n| recurring invoice | first paragraph | facture récurrente | |\n| Drafts | second paragraph | Brouillons | |\n| send | first and third paragraphs | envoyer | "expédier" reads more naturally for a parcel, not a PDF; the glossary is right here |\n| paid | first paragraph | payée | |\n| payment reminder | third paragraph | relance de paiement | "rappel" is what most people say; the glossary keeps "relance", the accounting term |\n';

// The reviewer reflects twice: two glossary terms rendered with the words
// the glossary rules out, then only a taste note. The judge sends the first
// back as worth another round and stops on the taste note; the terms note
// records where the glossary cost naturalness, and the run reaches the
// editor with the note still open, which is the point: a judge stopped it,
// not the reviewer. The editor answers on the run's page.
await withExample({
  here,
  example: 'translate-reflect',
  files: { 'briefs/translation.md': brief, 'source/article.md': article, 'glossary/en-fr.md': glossary, 'judge.json': judgeJson },
  answer: { approved: true },
  seats: {
    claude: [
      { writes: { 'fr/article.md': literal }, reply: pass('translated; three paragraphs kept') },
      { writes: { 'fr/article.md': revised }, reply: pass('"envoyer" and "relance" now follow the glossary') },
      { writes: { 'fr/terms.md': terms }, reply: pass('six terms listed, two flagged') },
    ],
    codex: [
      { reply: shouldFix('two glossary terms are rendered with the words the glossary rules out', '"s\'expédie" and "l\'expédie" where the glossary says "envoyer"', '"rappels de paiement" where the glossary says "relance de paiement"') },
      { reply: shouldFix('one taste note', '"le jour venu" is fine; "le jour dit" sat closer to the source, taste only') },
    ],
  },
}, async (run) => {
  assert.match(run.stdout, /http:\/\/127\.0\.0\.1:\d+\//, 'the run prints the page to answer on');
  assert.equal(run.question, 'Publish this translation?', 'the page shows the editor the question');
  assert.equal(run.printed.status, 'pass', `the editor's answer finishes the run: ${run.stdout}`);
  assert.equal(run.printed.data?.nuance?.status, 'pass');
  assert.equal(run.seatCalls.filter((call) => call.role === 'claude').length, 3, 'translate twice, terms once');
  assert.equal(run.seatCalls.filter((call) => call.role === 'codex').length, 2, 'the reviewer reflects on both versions');
  const translation = await run.read('fr/article.md');
  assert.match(translation, /relances de paiement/, 'the glossary term is on disk');
  assert.doesNotMatch(translation, /expédie/, 'the ruled-out word is gone');
  assert.match(await run.read('fr/terms.md'), /relance/, 'the terms note is on disk');
  assert.match(run.stdout, /tok/, 'the run prints its usage lines');

  const record = await recordEvents(run, 'records/translate-reflect.jsonl');
  const judged = record.filter((event) => event.kind === 'refine:judge');
  assert.deepEqual(judged.map((event) => event.reason), [
    'the judge chose continue',
    'the judge chose holds',
  ]);
  const nuance = record.filter((event) => event.kind === 'dag:node' && event.node === 'nuance' && event.phase === 'done');
  assert.deepEqual(nuance.map((event) => (event.outcome as { status: string }).status), ['paused', 'pass'], 'the run pauses at the editor, then the answer passes the step');
  const starts = record.filter((event) => event.kind === 'dag:node' && event.phase === 'start').map((event) => event.node);
  assert.deepEqual(starts, ['translate', 'terms', 'nuance'], 'each stage starts once: the answer repeats no finished work');

  console.log(JSON.stringify({
    status: 'pass',
    stages: 3,
    translations: 2,
    reflections: 2,
    glossaryTerms: 6,
    judge: ['continue', 'holds'],
    answeredOnPage: 'nuance',
    mode: run.mode,
  }, null, 2));
});
