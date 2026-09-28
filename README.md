<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/public/logo-dark.svg">
    <img src="docs/public/logo-light.svg" alt="Obversa" width="280">
  </picture>
</p>

<p align="center">
  <strong>Model how your team really works.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="license: MIT">
  <img src="https://img.shields.io/badge/node-%3E%3D22.12-3c873a" alt="node >=22.12">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6" alt="TypeScript strict">
  <a href="https://www.npmjs.com/package/@obversa/runtime"><img src="https://img.shields.io/npm/v/@obversa/runtime" alt="npm: @obversa/runtime"></a>
  <a href="https://github.com/jonny981/obversa/actions/workflows/ci.yml"><img src="https://github.com/jonny981/obversa/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

Obversa runs the coding agents you already use, Claude Code, Codex and the
rest, as a team, from a TypeScript file: who writes, who reviews, and when a
person signs off. When a reviewer asks for changes or a test fails, the
writer gets the notes and tries again. A judge can say when another round
stops being worth it. A person approves the exact bytes before anything
leaves. Every step goes on a record, so a killed run carries on from where
it stopped. No server, no database.

## Install

```bash
npm install @obversa/obversa
```

Node.js 22.12 or later. `@obversa/obversa` installs the runtime and every
plugin but the Jev engine, which is `npm install @obversa/engine-jev-api`.
The engines drive the command line tools you already have signed in:
Claude Code, Codex, Grok and OpenCode.
[The packages](https://docs.obversa.ai/packages) lists each with its page.

## First run

A Claude seat writes a function and its test from a brief, Node runs the
test, and a Codex seat reads the change. The whole team is this file,
`examples/teams/writer-reviewer-pair.ts`, with its brief at
`briefs/add.md` beside it:

```ts
import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex-cli';
import { run } from '@obversa/runtime';
import { briefFromFile, stage, workflow, type TeamSeat } from '@obversa/runtime';

interface WriterReviewerEngines {
  readonly claude: (model: string) => TeamSeat;
  readonly codex: (model: string) => TeamSeat;
}

const realEngines: WriterReviewerEngines = { claude, codex };

function createWriterReviewerPair(engines: WriterReviewerEngines = realEngines) {
  return workflow('writer-reviewer-pair', {
    brief: briefFromFile('briefs/add.md'),
    options: { timeout: '10m' },

    roles: {
      write: engines.claude('claude-sonnet-4-5'),
      review: [engines.codex('gpt-5.6-luna')],
    },

    stages: [
      stage('write', {
        agent: 'write',
        writes: ['src/add.mjs', 'test/add.test.mjs'],
        desc: 'Write the function and its test from the brief.',
        gate: 'The files named in the brief exist in the workspace.',
        refine: 1,
      }),
      stage('test', {
        run: ['node', '--test', 'test/add.test.mjs'],
        desc: 'Run the test command against the written files.',
        gate: 'The test command exits 0.',
        sendsBackTo: 'write',
      }),
      stage('review', {
        panel: 'review',
        agree: 1,
        desc: 'Read the code, the test and its result.',
        gate: 'The change meets the brief.',
        sendsBackTo: 'write',
      }),
    ],
  });
}

const result = await run(createWriterReviewerPair());
console.log(JSON.stringify(result.outcome, null, 2));
```

Run it from the directory the work belongs in, with the Claude Code and
Codex command line tools signed in:

```bash
npx tsx writer-reviewer-pair.ts
```

The `write` stage names the files it may write and fails by name when one
is missing. The `test` stage passes on the command's exit code, never on a
model's report; a red run goes back to `write` with the output. The
`review` stage is a reviewer from a different model family, and the runtime
refuses the team before any model runs if the reviewer shares the writer's
family. `refine: 1` on the writer is how many more rounds it gets.
[First run](https://docs.obversa.ai/get-started/first-run) shows what a
real run printed.

## Feature delivery

A ticket comes in. The team you would want reads the code and writes the
requirements and a plan, each reviewed before the next step; writes the
tests first, then the code until the tests pass and a reviewer from another
model family accepts; puts the change in front of a person; and writes the
evidence from the record. That team is `examples/teams/feature-delivery.ts`:

```ts
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
```

Every node says what it does and where a rejection sends the work back. A
red test or a rejected review kicks back to `implement`, and re-running it
re-runs everything downstream of it in turn.

| node | done when |
| --- | --- |
| triage | Jev has typed the ticket as a bug or a feature. |
| research | Only runs for a feature; the panel has accepted the plan. |
| implement | The tournament has a passing candidate to land. |
| test | The test command exits 0 against the landed candidate. |
| review | At least one of Codex and OpenCode has accepted the change. |
| approve | A person has said yes to the exact sha256 that landed. |
| close | The evidence note is in the workspace, from the record alone. |

[Feature delivery](https://docs.obversa.ai/workflows/feature-team) shows
what a real run of this file printed and the files the models wrote.

## The parts

- **A review loop that knows when to stop.** A failed review or test sends
  the findings to the step that owns the fix, and it runs again. Give a
  stage `refine: judge(seat, { cap: 6 })` instead of a count and a small
  model reads the findings and the rounds so far and says whether another
  round is worth it; the cap is the backstop.
  [Feedback loops](https://docs.obversa.ai/concepts/feedback-loops),
  [a judge stops the loop](https://docs.obversa.ai/patterns/judge-stops-the-loop).
- **A person approves the exact change.** The run stops and asks, and the
  yes is bound to the bytes the person saw; a changed byte asks again.
  [A person decides](https://docs.obversa.ai/patterns/approval).
- **The record.** An append-only event log is the run's only state. Under
  the supervised runner a killed run starts a fresh worker that reads the
  record and carries on. Steps that finished are never repeated. A step that
  was mid-flight when the worker died runs again only if its binding declares
  it safe to retry; otherwise the run pauses and asks a person to reconcile
  it before it continues, so uncertain work is never repeated silently.
  `obversa-record <path>` prints a record as a page a person scans.
  [The record](https://docs.obversa.ai/concepts/record),
  [read a record](https://docs.obversa.ai/recording/read-a-record).
- **A worktree per writer.** Writers that run at the same time never touch
  each other's files, and only the winner lands.
  [Workspace](https://docs.obversa.ai/concepts/workspace).
- **A run you can watch.** A local page shows each step, the record in the
  console's words, and the questions waiting for you.
  [Watch a run](https://docs.obversa.ai/driving/monitor).
- **Memory.** Files a step can open again later, behind a small port with
  three adapters: in process, in private Git references, over local
  Markdown. [Memory](https://docs.obversa.ai/memory).

## Engines

A seat names the tool, the provider, the model family and the model. A
reviewer can be required to come from a different family than the writer,
so the model that wrote the work is never the model that grades it.

| package | drives | needs |
| --- | --- | --- |
| `@obversa/engine-claude-cli` | Claude Code, one fresh process per attempt | Claude Code, signed in |
| `@obversa/engine-codex-cli` | Codex | Codex, signed in |
| `@obversa/engine-grok-cli` | Grok | the Grok command line tool |
| `@obversa/engine-opencode-cli` | OpenCode | the OpenCode command line tool |
| `@obversa/engine-claude-agent-sdk` | the Claude Agent SDK | Claude auth |
| `@obversa/engine-anthropic-api` | the Anthropic API | an API key |
| `@obversa/engine-jev-api` | Jev, typed decisions over recorded state | a Jev endpoint and API key |

Write your own against the engine contract in `@obversa/api`; it must pass
the conformance kit.

## Where a workflow lives

Keep a workflow in a central collection and point each run at a repository
with `run(job, { cwd })`, keep it beside the code it works on, or import it
from a service and call `run()` when the service decides. It runs the same
way from each.
[Where a workflow lives](https://docs.obversa.ai/concepts/where-a-workflow-lives).

## Documentation

[docs.obversa.ai](https://docs.obversa.ai): the first run, the concepts,
the patterns, examples by field, and how Obversa sits beside LangGraph,
CrewAI, Temporal, Claude Code subagents and eve.

## Working on Obversa

[AGENTS.md](AGENTS.md) is the guide for anyone who changes this
repository: setup, the checks, and the rules every change follows.

## License

Obversa uses the [MIT License](LICENSE). Report security problems as
described in the [security policy](SECURITY.md).
