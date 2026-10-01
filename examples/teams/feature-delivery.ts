import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveCommandExecutable } from '@obversa/core/command';
import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex-cli';
import { jev } from '@obversa/engine-jev-api';
import { opencode } from '@obversa/engine-opencode-cli';
import {
  agentJob,
  approval,
  briefFromFile,
  commandJob,
  dag,
  fnJob,
  formatEvent,
  judge,
  predicate,
  reviewPanel,
  revisionRequest,
  run,
  tournament,
  workflow,
  type Job,
  type TeamSeat,
} from '@obversa/runtime';
import { recordedJudge } from '@obversa/runtime/testing';
import { requireNoFiles, requireNonEmptyFiles } from '@obversa/runtime/workflow-support';

/**
 * A ticket, delivered the way a team delivers one: a cheap typed decision
 * routes it before an expensive seat sees it; the requirements and the plan
 * are cross-model reviewed; two seats implement in their own worktrees and a
 * command picks the winner; a red test sends the loser's fix back; a panel
 * reviews the change with a judge standing between its verdict and another
 * round; a person approves the exact bytes; the last note comes from the
 * record alone. Composed as a `dag()` of the runtime's own pieces;
 * `research` is the one part small enough to stay a nested `workflow()`.
 */
const writer = claude('claude-sonnet-4-5');
const implementer = codex('gpt-5.6-luna');
const secondReviewer = opencode('opencode/big-pickle', { executable: resolveCommandExecutable('opencode') });

// Offline, recorded answers stand in for Jev so the example runs with no key:
// triage.json and judge.json each hold one answer object per call, and the
// last one repeats. `JEV=live` asks Jev for both.
const live = process.env.JEV === 'live';
const triageSeat = live ? jev() : recordedJudge('triage.json');
const judgeSeat = live ? jev() : recordedJudge('judge.json');

const { brief } = briefFromFile('briefs/ticket.md');

/** A cheap typed decision: bug or feature, and how risky. The expensive seats never see it. */
const triage: Job = agentJob({
  label: 'triage', engine: triageSeat.engine, model: triageSeat.identity.model, workspaceMode: 'none', tools: [], leaf: true,
  prompt: JSON.stringify({
    state: { ticket: brief },
    questions: {
      kind: { type: 'choice', instructions: 'Is this ticket a bug fix or a feature?', criteria: { bug: 'Fixes broken behaviour.', feature: 'Adds behaviour that did not exist.' } },
      risk: { type: 'score', instructions: 'How risky is this change?', criteria: ['blast radius', 'reversibility'] },
    },
  }),
  outcome: (text) => ({ status: 'pass', summary: text.slice(0, 120), data: JSON.parse(text) }),
});

/** A feature only: requirements and a plan, one Claude writer, one Codex panel, refined up to twice. */
const research = workflow('research', {
  brief,
  roles: { analyse: writer, review: [implementer] },
  stages: [{
    name: 'plan', config: {
      agent: 'analyse', writes: 'team-output/plan.md', reviewedBy: 'review', refine: 2,
      desc: 'Write requirements and a plan from the ticket, one check per requirement.',
      gate: 'The plan is in the workspace and the panel has accepted it.',
    },
  }],
});

/** Two candidates, two worktrees, one command deciding: the tournament helper the runtime ships. */
const candidate = (seat: TeamSeat, i: number) => fnJob(`candidate-${i}`, async (ctx) => {
  const plan = existsSync(join(ctx.workspace.dir, 'team-output/plan.md'))
    ? await readFile(join(ctx.workspace.dir, 'team-output/plan.md'), 'utf8')
    : brief;
  // A retried round forks from HEAD, which already carries a prior round's
  // landed file. Remove it first so a candidate that writes nothing fails
  // this attempt instead of silently passing on an old implementation.
  await rm(join(ctx.workspace.dir, 'src/triple.mjs'), { force: true });
  const write = agentJob({
    label: `candidate-${i}`, engine: seat.engine, model: seat.identity.model,
    tools: ['Write'], allowedTools: ['Write'], workspaceMode: 'write', leaf: true,
    prompt: `${plan}\n\nWrite src/triple.mjs only.`,
  });
  const written = await requireNonEmptyFiles(`candidate-${i}`, write, ctx.workspace.dir, ['src/triple.mjs'])(ctx);
  if (written.status !== 'pass') return written;
  return commandJob(`candidate-${i}-test`, ['node', '--test', 'test/triple.test.mjs'])(ctx);
});
const implement = tournament({
  name: 'implement', n: 2, concurrency: 1,
  candidate: (i) => candidate(i === 0 ? writer : implementer, i),
  judge: (outcome) => (outcome.status === 'pass' ? 1 : 0),
});

/** Codex and OpenCode, agreeing once is enough; a block always goes back, otherwise Jev decides. */
const reviewer = (seat: TeamSeat): Job => agentJob({
  label: 'review', engine: seat.engine, model: seat.identity.model, tools: [seat.identity.adapter === 'opencode-cli' ? 'read' : 'Read'], workspaceMode: 'read', leaf: true,
  prompt: 'Read src/triple.mjs against the plan. Reply as one JSON object: {"status":"pass"|"revise","summary":"...","findings":[{"severity":"block"|"should-fix","evidence":"..."}]}.',
  outcome: (text) => {
    const decision = JSON.parse(text.slice(text.indexOf('{'))) as { status: string; summary: string; findings?: { severity: 'block' | 'should-fix'; evidence: string }[] };
    return decision.status === 'pass'
      ? { status: 'pass', summary: decision.summary }
      : revisionRequest({ target: 'implement', reason: decision.summary, findings: decision.findings });
  },
});
const review = reviewPanel({
  label: 'review', target: 'implement', pass: 1, concurrency: 1,
  reviewers: [{ name: 'codex', job: reviewer(implementer) }, { name: 'opencode', job: reviewer(secondReviewer) }],
});

const approve: Job = async (ctx) => {
  const bytes = await readFile(join(ctx.workspace.dir, 'src/triple.mjs'));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const recorded = existsSync('approve.json') ? JSON.parse(await readFile('approve.json', 'utf8')) : undefined;
  return approval('approve', {
    question: `Ship src/triple.mjs as it now stands (sha256 ${sha256.slice(0, 12)})? A no with a note sends it back to implement.`,
    input: { file: 'src/triple.mjs', sha256 }, target: 'implement',
    ...(recorded ? { answer: () => recorded } : {}),
  })(ctx);
};

const recordPath = 'records/feature-delivery.jsonl';
const close: Job = async (ctx) => {
  const record = existsSync(recordPath) ? await readFile(recordPath, 'utf8') : '';
  const write = agentJob({
    label: 'close', engine: writer.engine, model: writer.identity.model,
    tools: ['Write'], allowedTools: ['Write'], workspaceMode: 'write', leaf: true,
    prompt: `Write team-output/evidence.md: one paragraph of evidence for this run, using only this record, inventing nothing it does not show:\n\n${record}`,
  });
  return requireNoFiles('close', requireNonEmptyFiles('close', write, ctx.workspace.dir, ['team-output/evidence.md']), ctx.workspace.dir, ['src/triple.mjs', 'team-output/plan.md'], 'body')(ctx);
};

const team = dag({
  name: 'feature-delivery',
  nodes: {
    triage,
    // Isolated so its commit lands on HEAD: the tournament's own worktrees
    // fork from HEAD, and need the plan committed there to read it.
    research: { needs: 'triage', optional: true, isolate: true, when: predicate((ctx) => (ctx.needs?.triage?.data as { kind?: { choice?: string } })?.kind?.choice === 'feature', 'triage chose a feature'), job: research },
    implement: { needs: ['triage', 'research'], job: implement },
    test: { needs: 'implement', job: commandJob('test', ['node', '--test', 'test/triple.test.mjs'], { target: 'implement' }) },
    // Isolated for the same reason as research: on a reject the worktree is
    // discarded rather than merged, so a second kickback into `implement`
    // forks its own tournament round from an untouched HEAD.
    review: { needs: 'test', isolate: true, job: review },
    approve: { needs: 'review', job: approve },
    close: { needs: 'approve', job: close },
  },
  // A block finding always goes back on its own; otherwise Jev, capped at 4
  // rounds, says when another pass on `implement` stops being worth it.
  maxKickbacks: { implement: judge(judgeSeat, { cap: 4 }) },
});

// Without approve.json the run waits for the person and prints the address
// of a page to answer on. The wait lives in this process: stop it before the
// person answers, and the question goes with it.
const resume = process.argv.includes('--resume');
const result = await run(team, {
  recordTo: recordPath,
  resume,
  onCallback: 'wait',
  monitor: true,
  onEvent: (event) => console.log(event.kind === 'monitor' ? `Answer the approval on ${event.url}` : formatEvent(event)),
});
await result.monitor?.close();
console.log(JSON.stringify({ status: result.outcome.status, summary: result.outcome.summary, recordPath }, null, 2));
