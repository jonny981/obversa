import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pass, revise, sourceDir, withExample } from '../proof-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const samples = sourceDir(here);
const brief = await readFile(join(samples, 'briefs/post.md'), 'utf8');
const style = await readFile(join(samples, 'style/house.md'), 'utf8');

const firstDraft = [
  'Every change we ship is read twice before a person sees it, and that second read is what makes our review the best in the business.',
  '',
  'Claude Code writes the change. Codex reads it against the plan and the tests and returns it with findings when something does not hold.',
  '',
  'Try it on your next change.',
  '',
].join('\n');

const secondDraft = [
  'Every change we ship is read twice before a person sees it.',
  '',
  'Claude Code writes the change. Codex reads it against the plan and the tests. When something does not hold, the change goes back with findings, and the writer runs again. That loop has cut our review time by 40 percent.',
  '',
  'Try it on your next change.',
  '',
].join('\n');

const thirdDraft = [
  'Every change we ship is read twice before a person sees it.',
  '',
  'Claude Code writes the change. Codex reads it against the plan and the tests. When something does not hold, the change goes back with findings, and the writer runs again. A person reads only what has already held.',
  '',
  'Try it on your next change.',
  '',
].join('\n');

// The grader returns the draft twice: a superlative, then a number the
// brief never gave. The third draft holds, and the run stops for the
// editor. Three writer turns, three grader turns, within the limit.
await withExample({
  here,
  example: 'writer-grader-cap',
  files: { 'briefs/post.md': brief, 'style/house.md': style },
  seats: {
    claude: [
      { writes: { 'posts/draft.md': firstDraft }, reply: pass('draft written') },
      { writes: { 'posts/draft.md': secondDraft }, reply: pass('superlative removed, the loop explained') },
      { writes: { 'posts/draft.md': thirdDraft }, reply: pass('the number is gone; the closing line stands') },
    ],
    codex: [
      { reply: revise('one rule broken', 'line 1: "the best in the business" breaks rule 3, no superlatives') },
      { reply: revise('one rule broken', 'line 3: "40 percent" breaks rule 4; the brief gives no number') },
      { reply: pass('every rule holds: one idea per sentence, what the reader gets first, no superlatives, no numbers, the tools named, a plain closing line') },
    ],
  },
}, async (run) => {
  assert.equal(run.printed.status, 'paused', `the run stops at the editor: ${run.stdout}`);
  assert.equal(run.printed.data?.publish?.status, 'paused');
  assert.match(run.printed.summary ?? '', /Publish this post/);
  assert.equal(run.seatCalls.filter((call) => call.role === 'claude').length, 3, 'the writer ran three times');
  assert.equal(run.seatCalls.filter((call) => call.role === 'codex').length, 3, 'the grader read every draft');
  const draft = await run.read('posts/draft.md');
  assert.doesNotMatch(draft, /best in the business/, 'the superlative is gone');
  assert.doesNotMatch(draft, /40 percent/, 'the invented number is gone');
  assert.match(draft, /Try it on your next change/);

  console.log(JSON.stringify({
    status: 'pass',
    stages: 2,
    drafts: 3,
    graderKickbacks: 2,
    limit: 3,
    pausedAt: 'publish',
    mode: run.mode,
  }, null, 2));
});
