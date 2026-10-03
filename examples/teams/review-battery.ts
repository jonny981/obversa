import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex-cli';
import { resolveCommandExecutable } from '@obversa/core/command';
import { jev } from '@obversa/engine-jev-api';
import { opencode } from '@obversa/engine-opencode-cli';
import {
  briefFromFile,
  formatEvent,
  judge,
  run,
  stage,
  workflow,
  type LoopEvent,
} from '@obversa/runtime';
import { recordedJudge } from '@obversa/runtime/testing';

/**
 * A review battery. One seat writes a page. Three reviewers from three
 * other model families read it at the same time. Their reviews become one:
 * the first reviewer's seat merges the findings that name the same problem,
 * then each reviewer votes once on the findings it did not raise, and a
 * finding is dropped when the reviewers who reject it outnumber those who
 * raised or backed it, unless it is a block. A judge then
 * decides each finding that is left: act on it or skip it. The writer gets
 * only the findings the judge acts on. When the judge skips every finding,
 * the page stands. With no cap, the judge or the reviewers end the rounds.
 */

// ── The seats ───────────────────────────────────────────────────────────────

// OpenCode's adapter needs an absolute command path.
const openCode = (model: string) => opencode(model, { executable: resolveCommandExecutable('opencode') });

const writer = openCode('opencode/big-pickle');
const reviewers = [
  claude('claude-sonnet-4-5'),
  codex('gpt-5.6-luna'),
  openCode('google/gemini-2.5-pro'),
];

// Offline, the judge replays the answers recorded in judge.json, one answer
// object for each round it is asked, repeating the last, so the example runs
// with no key. Each object answers the round's questions and, under
// finding-1, finding-2 and so on, each finding. `JUDGE=jev` asks Jev instead.
const judgeSeat = process.env.JUDGE === 'jev' ? jev() : recordedJudge('judge.json');

// ── The team ────────────────────────────────────────────────────────────────

const brief = briefFromFile('briefs/retries.md');
const file = brief.files?.[0];
if (file === undefined) throw new Error('briefs/retries.md names no file in its front matter');

const team = workflow('review-battery', {
  brief,
  roles: { write: writer, review: reviewers },
  stages: [
    stage('write', {
      agent: 'write',
      writes: file,
      reviewedBy: 'review',
      synthesise: true,
      refine: judge(judgeSeat),
      desc: 'Rewrite the page so a person reads it once and knows what to set. On a later round, change only the sentences the findings name.',
      gate: 'Every reviewer passes, or the judge skips every finding that is left.',
    }),
  ],
});

const events: LoopEvent[] = [];
const result = await run(team, {
  recordTo: 'records/review-battery.jsonl',
  runId: 'review-battery',
  onEvent: (event) => {
    events.push(event);
    const line = formatEvent(event);
    if (line) console.log(line);
  },
});

// What each review round did with its findings, and what the judge decided
// on each finding the round kept. Here the judge reads the kept findings in
// the order the synthesis lists them.
const rounds = events.flatMap((event) => event.kind === 'review:synthesis' ? [event.entries] : []);
const decisions: { route: string; reason: string; findings: string[] }[] = [];
let kept: string[] = [];
for (const event of events) {
  if (event.kind === 'review:synthesis') {
    kept = event.entries.filter((entry) => entry.result !== 'dropped').map((entry) => entry.finding.evidence);
  }
  if (event.kind === 'refine:judge') {
    decisions.push({
      route: event.route,
      reason: event.reason,
      findings: (event.findings ?? []).map((finding, at) => `${finding.decision}: ${kept[at]} (${finding.reason})`),
    });
  }
}
console.log(JSON.stringify({
  status: result.outcome.status,
  rounds: rounds.map((entries) => entries.map(({ result: outcome, finding }) => ({
    result: outcome,
    raisedBy: finding.raisedBy,
    severity: finding.severity,
    evidence: finding.evidence,
    ...(finding.votes ? { votes: finding.votes.map((vote) => `${vote.reviewer} ${vote.vote}: ${vote.reason}`) } : {}),
  }))),
  judge: decisions,
}, null, 2));
