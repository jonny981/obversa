import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pass, recordEvents, shouldFix, sourceDir, withExample } from '../proof-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const samples = sourceDir(here);
const brief = await readFile(join(samples, 'briefs/backlog.md'), 'utf8');
const raw = await readFile(join(samples, 'backlog/raw.md'), 'utf8');
const judgeJson = await readFile(join(samples, 'judge.json'), 'utf8');

const story = (title: string, from: string, sentence: string, ...checks: string[]): string =>
  `## ${title}\n\nFrom: ${from}\n\n${sentence}\n\n${checks.map((check) => `- ${check}`).join('\n')}\n\n`;

const threeStories = [
  story('Download an invoice as a PDF', 'where is my invoice PDF?', 'A user downloads any paid invoice as a PDF file.', 'Download on a paid invoice saves a PDF, not the in-app view', 'The PDF shows the same totals as the invoice page'),
  story('Export trial sign-ups', 'CSV of trial sign-ups', 'A sales user exports trial sign-ups for a date range as CSV.', 'The CSV has one row per trial with the plan picked', 'The range defaults to the last 30 days'),
  story('Yearly export finishes for large accounts', 'Export takes forever', 'A user with thousands of invoices gets the yearly export without a timeout.', 'An account with 3,000 invoices exports in under 30 seconds', 'The export never times out; a long one is emailed when ready'),
].join('');
const fourStories = `${threeStories}${story('Dark mode', 'Dark mode pls', 'A user switches the app to a dark theme that follows the system setting by default.', 'Every screen has a dark variant with readable contrast', 'The choice is remembered per user')}`;

// The reviewer sends the first split back with one finding the judge says
// is worth another round; the second split covers all four and the
// reviewer's remaining note is taste, so the judge stops the loop. The
// questions are written and accepted, and the run waits for the owner,
// who answers on the run's page.
await withExample({
  here,
  example: 'backlog-groom-then-rank',
  files: { 'briefs/backlog.md': brief, 'backlog/raw.md': raw, 'judge.json': judgeJson },
  answer: { approved: true, note: 'Ship the PDF download first, then the export fix.' },
  seats: {
    claude: [
      { writes: { 'backlog/stories.md': threeStories }, reply: pass('three stories from four tickets') },
      { writes: { 'backlog/stories.md': fourStories }, reply: pass('four stories, one per ticket; the dark mode wish is now a story with checks') },
      { writes: { 'backlog/questions.md': '## Download an invoice as a PDF\n\n- Is the PDF also emailed to the client? Proposed: no, download only, for now.\n\n## Export trial sign-ups\n\n- Who may run it? Proposed: admins only.\n\n## Yearly export finishes for large accounts\n\n- no open questions\n\n## Dark mode\n\n- Follow the system setting or a manual switch? Proposed: both, system by default.\n' }, reply: pass('questions written with proposed answers') },
    ],
    codex: [
      { reply: shouldFix('one raw ticket has no story', 'the "Dark mode pls" ticket is not covered by any story') },
      { reply: shouldFix('one taste note', 'the PDF story could name the file size limit in its checks; nice to have') },
      { reply: pass('every story has its questions or says it has none') },
    ],
  },
}, async (run) => {
  assert.match(run.stdout, /http:\/\/127\.0\.0\.1:\d+\//, 'the run prints the page to answer on');
  assert.equal(run.question, 'Which of these go into the next cycle, and in what order?', 'the page shows the owner the question');
  assert.equal(run.printed.status, 'pass', `the owner's answer finishes the run: ${run.stdout}`);
  assert.equal(run.printed.data?.rank?.status, 'pass');
  assert.equal(run.seatCalls.filter((call) => call.role === 'claude').length, 3, 'split twice, clarify once');
  assert.equal(run.seatCalls.filter((call) => call.role === 'codex').length, 3, 'two reviews of the split, one of the questions');
  const stories = await run.read('backlog/stories.md');
  assert.match(stories, /## Dark mode/, 'the missing ticket is a story now');
  assert.equal((stories.match(/^## /gm) ?? []).length, 4);
  assert.match(await run.read('backlog/questions.md'), /no open questions/);
  assert.match(run.stdout, /tok/, 'the run prints its usage lines');

  const record = await recordEvents(run, 'records/backlog-groom-then-rank.jsonl');
  const judged = record.filter((event) => event.kind === 'refine:judge');
  assert.deepEqual(judged.map((event) => event.reason), [
    'the judge chose continue',
    'the judge chose holds',
  ]);
  const rank = record.filter((event) => event.kind === 'dag:node' && event.node === 'rank' && event.phase === 'done');
  assert.deepEqual(rank.map((event) => (event.outcome as { status: string }).status), ['paused', 'pass'], 'the run pauses at the owner, then the answer passes the step');
  const starts = record.filter((event) => event.kind === 'dag:node' && event.phase === 'start').map((event) => event.node);
  assert.deepEqual(starts, ['split', 'clarify', 'rank'], 'each stage starts once: the answer repeats no finished work');

  console.log(JSON.stringify({
    status: 'pass',
    stages: 3,
    rawTickets: 4,
    stories: 4,
    reviewKickbacks: 1,
    judge: ['continue', 'holds'],
    answeredOnPage: 'rank',
    mode: run.mode,
  }, null, 2));
});
