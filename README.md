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
import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex-cli';
import { run } from '@obversa/runtime';
import { briefFromFile, person, stage, workflow, type TeamSeat } from '@obversa/runtime';

interface FeatureDeliveryEngines {
  readonly claude: (model: string) => TeamSeat;
  readonly codex: (model: string) => TeamSeat;
}

const realEngines: FeatureDeliveryEngines = { claude, codex };

/**
 * A feature, delivered the way a team delivers one. The roles are named once;
 * every stage is a small block of nouns: who does it, what it writes, who
 * reads it, where a red result goes back to. Inference happens only where a
 * role is named; every other stage is a command or a person.
 */
function createFeatureDelivery(engines: FeatureDeliveryEngines = realEngines) {
  return workflow('feature-delivery', {
    brief: briefFromFile('briefs/triple.md'),
    options: { timeout: '10m' },

    roles: {
      analyse: engines.claude('claude-sonnet-4-5'),
      implement: engines.codex('gpt-5.6-luna'),
      'research-review': [engines.codex('gpt-5.6-luna')],
      'code-review': [engines.claude('claude-sonnet-4-5')],
      approve: person('Ship this change?'),
    },

    stages: [
      stage('research-context', {
        agent: 'analyse',
        writes: 'team-output/research-context.md',
        desc: 'Read the workspace and write down what the change touches.',
        gate: 'The context note is in the workspace and a reviewer has accepted it.',
        reviewedBy: 'research-review',
        refine: 3,
      }),

      stage('research-requirements', {
        agent: 'analyse',
        writes: 'team-output/research-requirements.md',
        desc: 'Turn the brief and the context note into requirements, one REQ-n per line.',
        gate: 'The requirements note is in the workspace and a reviewer has accepted it.',
        reviewedBy: 'research-review',
        refine: 3,
      }),

      stage('plan', {
        agent: 'analyse',
        writes: 'team-output/plan.md',
        desc: 'Write an executable plan from the requirements, one check per REQ-n.',
        gate: 'Every requirement has a check in the plan.',
        reviewedBy: 'research-review',
        refine: 3,
      }),

      stage('tests-first', {
        agent: 'implement',
        writes: 'test/triple.test.mjs',
        desc: 'Write the declared test files from the accepted plan before any implementation exists.',
        gate: 'Every declared test file exists and covers the plan.',
        reviewedBy: 'code-review',
        refine: 3,
      }),

      stage('implement', {
        agent: 'implement',
        writes: 'src/triple.mjs',
        desc: 'Write the code to the plan and the tests.',
        gate: 'The source file exists.',
        refine: 3,
      }),

      stage('test', {
        run: ['node', '--test', 'test/triple.test.mjs'],
        desc: 'Run the tests; a red run goes back to implement with the output.',
        gate: 'The test command exits 0.',
        sendsBackTo: 'implement',
      }),

      stage('review', {
        panel: 'code-review',
        agree: 1,
        desc: 'Read the change and the test result against the plan.',
        gate: 'At least one reviewer has accepted the change.',
        sendsBackTo: 'implement',
      }),

      stage('approve', {
        input: 'approve',
        desc: 'Put the verified change in front of a person.',
        gate: 'A person has said yes.',
      }),

      stage('close', {
        agent: 'analyse',
        writes: ['team-output/evidence.md', 'team-output/learning.md'],
        desc: 'Write the evidence of the run and what was learned, from the record alone.',
        gate: 'Both notes are in the workspace.',
      }),
    ],
  });
}

const result = await run(createFeatureDelivery());
console.log(JSON.stringify(result.outcome, null, 2));
```

Every stage says what it does and what must be true for it to count, and
both reach the reviewers and the record. A red test or a rejected review
runs the stage that owns the fix again with the findings, up to the
`refine` on that stage.

| stage | done when |
| --- | --- |
| research-context | The context note is in the workspace and a reviewer has accepted it. |
| research-requirements | The requirements note is in the workspace and a reviewer has accepted it. |
| plan | Every requirement has a check in the plan. |
| tests-first | Every declared test file exists and covers the plan. |
| implement | The source file exists. |
| test | The test command exits 0. |
| review | At least one reviewer has accepted the change. |
| approve | A person has said yes. |
| close | Both notes are in the workspace. |

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
