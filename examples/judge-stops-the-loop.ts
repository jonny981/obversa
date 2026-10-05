import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex-cli';
import { jev } from '@obversa/engine-jev-api';
import {
  approval,
  briefFromFile,
  formatEvent,
  judge,
  run,
  stage,
  workflow,
  type ApprovalAnswer,
  type Job,
  type Outcome,
} from '@obversa/runtime';
import { recordedJudge } from '@obversa/runtime/testing';

/**
 * A loop whose stopping rule is a judge, not a count. Claude rewrites the
 * page the brief names; Codex, from another model family, reads every
 * sentence as a person would and reports what fails, each finding tagged
 * block, should-fix or nice-to-have. Jev decides each finding, a block
 * included: act on it or skip it. The writer gets
 * only the findings Jev acts on, and the reader is told what was skipped.
 * When Jev skips every finding, the page stands. With no cap, the rounds end
 * when Jev stops them or the reader passes the page.
 * A person then approves the exact bytes, with their sha in the question.
 */

// ── The seats ───────────────────────────────────────────────────────────────

const writer = claude('claude-sonnet-4-5');
const reader = codex('gpt-5.6-luna');

// Offline, the judge replays the answers recorded in judge.json, one answer
// object for each round it is asked, repeating the last, so the example runs
// with no key. `JUDGE=jev` asks Jev instead.
const judgeSeat = process.env.JUDGE === 'jev' ? jev() : recordedJudge('judge.json');

// ── The team ────────────────────────────────────────────────────────────────

// The brief names the page, and both seats read it: its first paragraph is
// the use case the judge weighs, and it tells the reader how to tag findings.
const brief = briefFromFile('briefs/page.md');
const file = brief.files?.[0];
if (file === undefined) throw new Error('briefs/page.md names no file in its front matter');

// A person approves the exact bytes: the sha is in the question. With an
// approve.json beside the brief the answer is recorded (a proof, a script
// that decides); without one the run pauses until a person answers.
const recorded: ApprovalAnswer | undefined = existsSync('approve.json')
  ? JSON.parse(await readFile('approve.json', 'utf8')) as ApprovalAnswer
  : undefined;
const approve: Job = async (ctx) => {
  const bytes = await readFile(join(ctx.workspace.dir, file));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return approval('approve', {
    question: `Keep ${file} as it now stands (sha256 ${sha256.slice(0, 12)})? A no with a note sends the note to the writer.`,
    input: { file, sha256 },
    target: 'write',
    ...(recorded ? { answer: () => recorded } : {}),
  })(ctx);
};

const team = workflow('judge-stops-the-loop', {
  brief,
  roles: { write: writer, read: [reader] },
  stages: [
    stage('write', {
      agent: 'write',
      writes: file,
      reviewedBy: 'read',
      refine: judge(judgeSeat),
      desc: 'Rewrite the page so a person reads it once and knows what to do. On a later round, change only the sentences the findings name.',
      gate: 'The reader finds nothing that fails, or the judge says the page holds for this use case.',
    }),
    stage('approve', {
      fn: approve,
      sendsBackTo: 'write',
      desc: 'A person approves the exact bytes of the page.',
      gate: 'The person approves.',
    }),
  ],
});

const result = await run(team, {
  recordTo: 'records/judge-stops-the-loop.jsonl',
  runId: 'judge-stops-the-loop',
  onEvent: (event) => console.log(formatEvent(event)),
});

const stages = (result.outcome.data ?? {}) as Record<string, Outcome | undefined>;
console.log(JSON.stringify({
  status: result.outcome.status,
  stop: stages.write?.summary,
  approved: stages.approve?.status === 'pass',
}, null, 2));
