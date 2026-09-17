import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pass, revise, withExample } from '../proof-host.ts';

const here = dirname(fileURLToPath(import.meta.url));
const brief = await readFile(join(here, 'briefs/backlog.md'), 'utf8');
const raw = await readFile(join(here, 'backlog/raw.md'), 'utf8');

const story = (title: string, from: string, sentence: string, ...checks: string[]): string =>
  `## ${title}\n\nFrom: ${from}\n\n${sentence}\n\n${checks.map((check) => `- ${check}`).join('\n')}\n\n`;

const threeStories = [
  story('Download an invoice as a PDF', 'where is my invoice PDF?', 'A user downloads any paid invoice as a PDF file.', 'Download on a paid invoice saves a PDF, not the in-app view', 'The PDF shows the same totals as the invoice page'),
  story('Export trial sign-ups', 'CSV of trial sign-ups', 'A sales user exports trial sign-ups for a date range as CSV.', 'The CSV has one row per trial with the plan picked', 'The range defaults to the last 30 days'),
  story('Yearly export finishes for large accounts', 'Export takes forever', 'A user with thousands of invoices gets the yearly export without a timeout.', 'An account with 3,000 invoices exports in under 30 seconds', 'The export never times out; a long one is emailed when ready'),
].join('');
const fourStories = `${threeStories}${story('Dark mode', 'Dark mode pls', 'A user switches the app to a dark theme that follows the system setting by default.', 'Every screen has a dark variant with readable contrast', 'The choice is remembered per user')}`;

// The reviewer sends the first split back: one raw ticket has no story. The
// second split covers all four, the questions are written and accepted, and
// the run stops at the owner.
await withExample({
  here,
  example: 'backlog-groom-then-rank',
  files: { 'briefs/backlog.md': brief, 'backlog/raw.md': raw },
  seats: {
    claude: [
      { writes: { 'backlog/stories.md': threeStories }, reply: pass('three stories from four tickets') },
      { writes: { 'backlog/stories.md': fourStories }, reply: pass('four stories, one per ticket; the dark mode wish is now a story with checks') },
      { writes: { 'backlog/questions.md': '## Download an invoice as a PDF\n\n- Is the PDF also emailed to the client? Proposed: no, download only, for now.\n\n## Export trial sign-ups\n\n- Who may run it? Proposed: admins only.\n\n## Yearly export finishes for large accounts\n\n- no open questions\n\n## Dark mode\n\n- Follow the system setting or a manual switch? Proposed: both, system by default.\n' }, reply: pass('questions written with proposed answers') },
    ],
    codex: [
      { reply: revise('one raw ticket has no story', 'the "Dark mode pls" ticket is not covered by any story') },
      { reply: pass('every raw ticket has a story with checks') },
      { reply: pass('every story has its questions or says it has none') },
    ],
  },
}, async (run) => {
  assert.equal(run.printed.status, 'paused', `the run stops at the owner: ${run.stdout}`);
  assert.equal(run.printed.data?.rank?.status, 'paused');
  assert.match(run.printed.summary ?? '', /next cycle/);
  assert.equal(run.seatCalls.filter((call) => call.role === 'claude').length, 3, 'split twice, clarify once');
  assert.equal(run.seatCalls.filter((call) => call.role === 'codex').length, 3, 'two reviews of the split, one of the questions');
  const stories = await run.read('backlog/stories.md');
  assert.match(stories, /## Dark mode/, 'the missing ticket is a story now');
  assert.equal((stories.match(/^## /gm) ?? []).length, 4);
  assert.match(await run.read('backlog/questions.md'), /no open questions/);
  assert.match(run.stdout, /tok/, 'the run prints its usage lines');

  console.log(JSON.stringify({
    status: 'pass',
    stages: 3,
    rawTickets: 4,
    stories: 4,
    reviewKickbacks: 1,
    pausedAt: 'rank',
    mode: run.mode,
  }, null, 2));
});
