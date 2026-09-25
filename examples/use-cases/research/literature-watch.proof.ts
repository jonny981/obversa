import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pass, sourceDir, withExample } from '../proof-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const samples = sourceDir(here);
const read = (path: string) => readFile(join(samples, path), 'utf8');

const summaries = {
  'summaries/p-101.md': '# p-101\n\nClaim: sampling a soil sensor on a variance-set schedule cuts wake time by about a third.\nMethod: the previous day\'s variance sets the next day\'s interval; a bench fixture compares the curve.\nFor the lab: less wake time is more field life for a battery node.\nLimits (theirs): one sensor model, indoor fixture, no field trial.\n',
  'summaries/p-102.md': '# p-102\n\nClaim: no compact message encoding wins on both payload size and decode cost.\nMethod: four encodings compared on one microcontroller family with synthetic payloads.\nFor the lab: pick the encoding by which cost hurts more, radio time or CPU time.\nLimits (theirs): one microcontroller family, synthetic payloads.\n',
  'summaries/p-103.md': '# p-103\n\nClaim: the shape of a charge curve predicts remaining cycles for the first eighty percent of cell life.\nMethod: a small model fitted to charge curves on two chemistries under laboratory cycling.\nFor the lab: a node could report its own remaining life until late in life.\nLimits (theirs): laboratory cycling only, two chemistries, no temperature variation.\n',
};

const answer = [
  '# q-1: extending the field life of a sensor node',
  '',
  '- p-101: sample on a variance-set schedule; on a bench it cut wake time by about a third, which is the largest lever these notes offer. Not yet tried in the field.',
  '- p-103: read remaining battery life from the charge curve, good for the first eighty percent of cell life, so a node can report when it needs a visit.',
  '',
  'Not settled by these notes: anything about radio cost, since no kept note covers it.',
  '',
].join('\n');

// Three papers, one harvest, three decisions, one question. The person
// kept two summaries and refused the survey with a note, so memory holds
// two files and the answer is grounded on those two alone.
await withExample({
  here,
  example: 'literature-watch',
  files: {
    'briefs/literature.md': await read('briefs/literature.md'),
    'papers/p-101.md': await read('papers/p-101.md'),
    'papers/p-102.md': await read('papers/p-102.md'),
    'papers/p-103.md': await read('papers/p-103.md'),
    'curation.json': await read('curation.json'),
    'questions.json': await read('questions.json'),
  },
  seats: {
    claude: [
      { writes: summaries, reply: pass('three summaries written under summaries/') },
      { writes: { 'answers/q-1.md': answer }, reply: pass('answered from the two kept notes') },
    ],
  },
}, async (run) => {
  const printed = run.printed as unknown as {
    status: string;
    papers: string[];
    kept: string[];
    refused: { paper: string; note: string | null }[];
    answered: string[];
  };
  assert.equal(printed.status, 'pass', run.stdout);
  assert.deepEqual(printed.papers, ['p-101', 'p-102', 'p-103']);
  assert.deepEqual(printed.kept, ['p-101', 'p-103']);
  assert.equal(printed.refused.length, 1);
  assert.equal(printed.refused[0]?.paper, 'p-102');
  assert.match(printed.refused[0]?.note ?? '', /synthetic payloads/);
  assert.deepEqual(printed.answered, ['q-1']);

  assert.equal(run.seatCalls.length, 2, 'one harvest, one answer');
  assert.match(await run.read('answers/q-1.md'), /p-101/);
  assert.doesNotMatch(await run.read('answers/q-1.md'), /p-102/, 'the refused paper is not cited');
  for (const paper of printed.papers) {
    assert.ok(run.exists(`summaries/${paper}.md`), `${paper} was summarised`);
  }
  assert.ok(run.exists('records/literature-watch.jsonl'), 'the run has its record');

  console.log(JSON.stringify({
    status: 'pass',
    papers: 3,
    summarised: 3,
    kept: 2,
    refused: 1,
    answered: 1,
    mode: run.mode,
  }, null, 2));
});
