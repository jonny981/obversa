<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/public/logo-dark.svg">
    <img src="docs/public/logo-light.svg" alt="Obversa" width="280">
  </picture>
</p>

<p align="center">
  <strong>Model real teamwork.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="license: MIT">
  <img src="https://img.shields.io/badge/node-%3E%3D22.12-3c873a" alt="node >=22.12">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6" alt="TypeScript strict">
</p>

Agent frameworks give you one clever session. When it dies, it starts over.
Workflow engines give you durable steps and a server to run them on. Neither
gives you a team: named roles, a review that returns work to whoever owns it, a
vote when one opinion is not enough, and a person to answer to.

That is the layer Obversa owns. You describe the work the way you would describe
it to people, and the runtime runs it one bounded engine call at a time.

Every step appends events to a file on disk, with its artifacts beside them.
That record is the whole story: no server, no database.

`@obversa/runner` supervises a run in its own worker. After a crash it starts
a fresh worker that reads the record and carries on. Steps that finished are
never repeated. A step that was mid-flight when the worker died runs again
only if its binding declares it safe to retry; otherwise the run pauses and
asks a person to reconcile it before it continues, so uncertain work is never
repeated silently. That is a separate layer with its own call, not something
a plain `run()` does by itself, and
[the runner's page](https://docs.obversa.ai/packages/runner) has it.

```bash
npm install @obversa/runtime   # Node >= 22.12
```

## A feature, as one file

Install the teams package and two engine plugins, and this file delivers a
change with a team of models: one seat researches the brief and writes
the requirements and the plan, each reviewed; another writes the tests
before any code, then implements until the tests pass and a reviewer from
a different model family accepts; then the change is put to a person; and
the evidence is written from the record. A red test or a rejected review
sends the work back to the stage that owns it, with the findings. The
file is complete; copy it, put your brief in, run it with Node.

```bash
npm install @obversa/runtime @obversa/teams @obversa/engine-claude-cli @obversa/engine-codex
```

```ts
import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex';
import { pathToFileURL } from 'node:url';
import { run } from '@obversa/runtime';
import { fromFile, person, stage, workflow, type TeamSeat } from '@obversa/teams';

export interface FeatureDeliveryEngines {
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
export function createFeatureDelivery(engines: FeatureDeliveryEngines = realEngines) {
  return workflow('feature-delivery', {
    brief: fromFile('briefs/triple.md'),
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
        retry: 3,
      }),

      stage('research-requirements', {
        agent: 'analyse',
        writes: 'team-output/research-requirements.md',
        desc: 'Turn the brief and the context note into requirements, one REQ-n per line.',
        gate: 'The requirements note is in the workspace and a reviewer has accepted it.',
        reviewedBy: 'research-review',
        retry: 3,
      }),

      stage('plan', {
        agent: 'analyse',
        writes: 'team-output/plan.md',
        desc: 'Write an executable plan from the requirements, one check per REQ-n.',
        gate: 'Every requirement has a check in the plan.',
        reviewedBy: 'research-review',
        retry: 3,
      }),

      stage('tests-first', {
        agent: 'implement',
        writes: 'test/triple.test.mjs',
        desc: 'Write the declared test files from the accepted plan before any implementation exists.',
        gate: 'Every declared test file exists and covers the plan.',
        reviewedBy: 'code-review',
        retry: 3,
      }),

      stage('implement', {
        agent: 'implement',
        writes: 'src/triple.mjs',
        desc: 'Write the code to the plan and the tests.',
        gate: 'The source file exists.',
        retry: 3,
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run(createFeatureDelivery());
  console.log(JSON.stringify(result.outcome, null, 2));
}
```

The roles are named once, from the seat helpers the engine plugins export,
and every stage refers to a role by name. The implementer and every
reviewer must be different model families, and the package refuses the
team before any model runs if they are not.

The team is a graph of nine named stages. Every step carries a sentence
saying what it does and a sentence saying what must be true for it to
count, and both reach the reviewers and the run record. Each step that
repeats carries its own `retry`.

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

A step that promises a file fails by name when the file is missing. The
test step passes on the command's exit code, never on a model's report,
and a reviewer's decision is the file it writes.
[Feature delivery](https://docs.obversa.ai/workflows/feature-team) shows
what a real run of this file printed and the files the models wrote; a
[writer and reviewer](https://docs.obversa.ai/workflows/writer-and-reviewer)
and a [review panel](https://docs.obversa.ai/workflows/review-panel) are
the two smaller teams in the same package, and
[the shape of a real process](https://docs.obversa.ai/workflows/real-process)
is the full-size one.

## Engines

An engine binding names the adapter, the provider, the model family and the
model. A review seat can be required to differ from the writer, so the model
that wrote the work is not the model that grades it.

| package | drives | needs |
| --- | --- | --- |
| `@obversa/engine-claude-cli` | the Claude CLI, one process per attempt | Claude CLI, host auth |
| `@obversa/engine-codex` | the Codex CLI | Codex CLI, host auth |
| `@obversa/engine-grok-cli` | the Grok CLI | Grok CLI 1.0.5 |
| `@obversa/engine-opencode-cli` | the OpenCode CLI | OpenCode CLI 1.18.23 |
| `@obversa/engine-anthropic-api` | the Anthropic API | an API key |
| `@obversa/engine-agent-sdk` | the Claude Agent SDK | host Claude auth |

Write your own against the engine contract; it must pass the conformance kit.

## Where to go

- **Site:** [obversa.ai](https://obversa.ai)
- **Docs:** [docs.obversa.ai](https://docs.obversa.ai)
- **Your first run:** [get started](https://docs.obversa.ai/get-started/first-run)
- **Contributing:** [AGENTS.md](AGENTS.md)

## What is in this repository

16 publishable packages. `packages/` holds the eight that define the
product: `@obversa/runtime` is the runtime and its public contract,
`@obversa/teams` is three ready-made teams built on it, `@obversa/runner`
supervises stored runs, `@obversa/engine` and `@obversa/memory` are the
engine and memory contracts, `@obversa/process` runs a child process to a
deadline, and `@obversa/surfacer` and `@obversa/source` are the local
review surface. `plugins/` holds the eight adapters: the six engines above
and two memories, one in process and one in private Git references.
`hosts/` holds the terminal host, which is not published.

## Requirements

- Node.js 22.12 or later
- pnpm 10.15.1

## Install the workspace

From an Obversa checkout, run:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

The install activates this repository's commit hooks for the checkout. See
[AGENTS.md](AGENTS.md) for what the hooks need before your first commit.

## Run the offline workflow

The first example uses deterministic function jobs. It does not use a model or
network service.

```bash
pnpm example:offline
```

The full form, if the shortcut is not available:

```bash
pnpm --filter @obversa/runtime exec tsx ../../examples/offline-review.ts
```

Expected result:

```json
{
  "status": "pass",
  "attempts": 2,
  "summary": "config is complete"
}
```

## Define an outside graph type

The graph contract lets a package define a pure graph type without importing
runtime implementation modules. It validates a graph definition, reduces
recorded events, makes graph commands, and describes a stable plan for a host.

Run the checked-in example from the workspace root:

```bash
pnpm example:graph
```

The example is `examples/custom-graph.ts`. It defines a graph type,
checks it with the public conformance kit, and prints its resolved plan bounds.

`validateGraphDescription(unknown)` returns a frozen valid description or
throws `GraphValidationError`. The conformance kit checks repeatable graph
behavior from independent compiled instances.

Read [the graph contract](docs/public/graphs/contract.mdx) and
[plan admission](docs/public/graphs/plan-admission.mdx) before a host uses a
graph package.

## Store events and artifacts

The runtime storage ports keep small JSON events separate from larger byte
content. Run the offline local-storage example from the workspace root:

```bash
pnpm example:storage
```

The example writes one large synthetic artifact, appends one small reference,
reopens the stores through a fresh binding, folds the same state, and runs the
event-store and artifact-store conformance kits.

Read [Events and artifacts](docs/public/recording/events-and-artifacts.mdx) for
the storage contract, limits, secret handling, conflict behavior, and integrity
checks. This storage layer does not execute graph work or recover a stopped
run.

## Run safe node attempts

The runtime adapters run one fresh CLI process for one bounded node attempt. The
offline example uses scripted Grok and OpenCode executables, validates both
structured results, keeps missing usage as `unknown`, and removes its temporary
fixture files.

```bash
pnpm example:attempt
```

Read [Safe node attempts](docs/public/recording/node-attempts.mdx) for result
parts, declared capabilities, workspace access, fallback, and cleanup limits.

## Documentation

The public documentation is in [`docs/public`](docs/public). It includes the
first-run guide, the memory contract, the guides to writing a workflow shape
and to what a run records, the examples,
[cmux host setup](docs/public/hosts/cmux.mdx), and
[reviewing a diff in a host pane](docs/public/hosts/review.mdx).

Validate the documentation from the workspace root:

```bash
pnpm docs:validate
```

## Development

```bash
pnpm typecheck
pnpm typecheck:ts6
pnpm test
pnpm build
```

## License

Obversa uses the [MIT License](LICENSE). Report security problems as described
in the [security policy](SECURITY.md).
