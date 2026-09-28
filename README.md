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
test, and a Codex seat reads the change. The team is
`examples/teams/writer-reviewer-pair.ts`, with its brief at `briefs/add.md`
beside it. This is the part you write:

```ts examples/teams/writer-reviewer-pair.ts (excerpt)
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
```

Copy the file, put the brief beside it, and run it from the directory the
work belongs in, with the Claude Code and Codex command line tools signed
in:

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

A ticket comes in. A small decision model types it as a bug or a feature
before an expensive seat reads it. For a feature, a Claude seat writes the
requirements and a plan and a Codex seat reviews them. Two seats implement
in their own worktrees and the test picks the winner; a red test sends the
work back. A panel reviews the change, a judge says when another round
stops being worth it, a person approves the exact bytes by their sha, and
the closing note is written from the record. That team is
`examples/teams/feature-delivery.ts`, in five parts.

Triage first. Jev, the small decision model, types the ticket before any
expensive seat runs, and its answer decides whether a plan gets written:

```ts examples/teams/feature-delivery.ts (excerpt)
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
```

Two seats implement in their own worktrees, and the test picks the winner:

```ts examples/teams/feature-delivery.ts (excerpt)
const implement = tournament({
  name: 'implement', n: 2, concurrency: 1,
  candidate: (i) => candidate(i === 0 ? writer : implementer, i),
  judge: (outcome) => (outcome.status === 'pass' ? 1 : 0),
});
```

A panel of the Codex seat and the OpenCode seat reviews the change. One
acceptance is enough, and a rejection goes back to `implement` with the
findings:

```ts examples/teams/feature-delivery.ts (excerpt)
const review = reviewPanel({
  label: 'review', target: 'implement', pass: 1, concurrency: 1,
  reviewers: [{ name: 'codex', job: reviewer(implementer) }, { name: 'opencode', job: reviewer(secondReviewer) }],
});
```

A person approves the exact bytes. The sha is in the question, and a no
with a note goes back to `implement`:

```ts examples/teams/feature-delivery.ts (excerpt)
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
```

The graph puts the seven steps in order. Research runs for a feature only.
A red test or a rejected review goes back to `implement`, and Jev, capped
at four rounds, says when another pass stops being worth it:

```ts examples/teams/feature-delivery.ts (excerpt)
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
```

Every node says what it does and where a rejection sends the work back,
and re-running a node re-runs everything downstream of it in turn.

| node | done when |
| --- | --- |
| triage | Jev has typed the ticket as a bug or a feature. |
| research | Only runs for a feature; the panel has accepted the plan. |
| implement | The tournament has a passing candidate to land. |
| test | The test command exits 0 against the landed candidate. |
| review | At least one of Codex and OpenCode has accepted the change. |
| approve | A person has said yes to the exact sha256 that landed. |
| close | The evidence note is in the workspace, from the record alone. |

The whole file, with the seats, the nested research workflow and the
closing note, is `examples/teams/feature-delivery.ts`.
[Feature delivery](https://docs.obversa.ai/workflows/feature-team) shows
what a run of it printed and the files the models wrote.

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

19 publishable packages. `packages/` holds the eight that define the
product: `@obversa/runtime` runs a workflow, `@obversa/api` holds the
engine and memory contracts, `@obversa/core` runs bounded child processes,
`@obversa/runner` supervises stored runs, `@obversa/builtin-workflows`
ships three ready-made teams, `@obversa/obversa` is the install above,
and `@obversa/surface` with `@obversa/surface-diff` is the local review
page. `plugins/` holds the eleven adapters: the seven engines above, three
memories, and a notifier that posts run events to a URL.

[AGENTS.md](AGENTS.md) is the guide for anyone who changes this
repository: setup, the checks, and the rules every change follows.

## License

Obversa uses the [MIT License](LICENSE). Report security problems as
described in the [security policy](SECURITY.md).
