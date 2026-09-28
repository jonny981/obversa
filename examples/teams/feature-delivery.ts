import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveCommandExecutable } from '@obversa/core/command';
import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex-cli';
import { JevApiEngine } from '@obversa/engine-jev-api';
import { opencode } from '@obversa/engine-opencode-cli';
import {
  agentJob,
  approval,
  briefFromFile,
  commandJob,
  dag,
  finalResultPart,
  fnJob,
  formatEvent,
  judge,
  predicate,
  reviewPanel,
  revisionRequest,
  run,
  tournament,
  workflow,
  type Engine,
  type Job,
  type TeamSeat,
} from '@obversa/runtime';
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

/** Jev, wrapped so `agentJob` gets text back: its answer is a structured part. */
function jevSeat(): TeamSeat {
  const endpoint = process.env.TYPESAFE_ENDPOINT;
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!endpoint || !apiKey) throw new Error('JEV=live needs TYPESAFE_ENDPOINT and TYPESAFE_API_KEY');
  const api = new JevApiEngine({ endpoint, apiKey });
  const engine: Engine = {
    name: 'jev-api',
    async run(request, onEvent, signal) {
      const result = await api.run(request, onEvent, signal);
      const part = finalResultPart(result);
      if (part.kind !== 'structured') return result;
      return { ...result, parts: [{ kind: 'assistant', text: JSON.stringify(part.value), final: true }] };
    },
  };
  return { engine, identity: { adapter: 'jev-api', provider: 'jev', modelFamily: 'jev', model: 'jev', tools: [] } };
}
/**
 * Offline, a recorded answer replaces Jev so the example runs with no key:
 * `jev.json` is `{ triage: [...], judge: [...] }`, one ordered list per
 * purpose (the judge's own prompt, built by `askJudge`, is the only one
 * carrying a `cap`), each read round-robin and repeating its last entry.
 */
async function recordedJev(): Promise<TeamSeat> {
  const scripts = JSON.parse(await readFile('jev.json', 'utf8')) as Record<string, unknown[]>;
  const seen: Record<string, number> = {};
  const engine: Engine = {
    name: 'jev-recorded',
    async run(request) {
      const purpose = request.prompt.includes('"cap"') ? 'judge' : 'triage';
      const list = scripts[purpose] ?? [];
      const i = seen[purpose] ?? 0;
      seen[purpose] = i + 1;
      const text = JSON.stringify(list[Math.min(i, list.length - 1)]);
      const selection = { adapter: 'jev-recorded', adapterVersion: null, provider: 'jev', modelFamily: 'jev', model: 'jev', executable: null, capabilities: [] };
      return { parts: [{ kind: 'assistant', text, final: true }], usage: { kind: 'unknown' }, requested: selection, effective: selection };
    },
  };
  return { engine, identity: { adapter: 'jev-recorded', provider: 'jev', modelFamily: 'jev', model: 'jev', tools: [] } };
}
const jev = process.env.JEV === 'live' ? jevSeat() : await recordedJev();

const { brief } = briefFromFile('briefs/ticket.md');

/** A cheap typed decision: bug or feature, and how risky. The expensive seats never see it. */
const triage: Job = agentJob({
  label: 'triage', engine: jev.engine, model: jev.identity.model, workspaceMode: 'none', tools: [], leaf: true,
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
  maxKickbacks: { implement: judge(jev, { cap: 4 }) },
});

// Only `workflow()` skips a finished stage on `--resume` today, so
// `research`'s plan stage does and every other node here runs again in full.
const resume = process.argv.includes('--resume');
const result = await run(team, { recordTo: recordPath, resume, onEvent: (event) => console.log(formatEvent(event)) });
console.log(JSON.stringify({ status: result.outcome.status, summary: result.outcome.summary, recordPath }, null, 2));
