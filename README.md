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

Obversa lets you describe how a team works and run it with agents, code
and people. One agent writes, another reviews, and a judge decides whether
another revision is worth doing. The workflow carries the feedback back
to the writer. A person makes the calls you leave to them.

Put that process in a TypeScript file. Use the agent CLIs you already
have signed in, or give a role an API engine. Tests run as commands,
reviews return their notes, and the run keeps its record in a plain file.

Use the same patterns to review a research brief, shape an article,
answer a support ticket or deliver a feature. Notes go back to the
writer. A check decides whether work continues. A recorded workflow can
continue from its file after an interruption. No server, no database.

## Install

```bash
npm install @obversa/obversa
```

Node.js 22.12 or later. `@obversa/obversa` installs the runtime and every
plugin but four engines, which you install on their own:
`npm install @obversa/engine-jev-api` for Jev,
`npm install @obversa/engine-devin-cli` for Devin,
`npm install @obversa/engine-mastra @mastra/core` for a Mastra agent and
`npm install @obversa/engine-openai-agents @openai/agents zod` for an
OpenAI Agents SDK agent.
Use Claude Code, Codex, Grok or OpenCode with the command line tools you
already have signed in, or use an API engine.
[Installation](https://docs.obversa.ai/get-started/installation) covers
setup. [First run](https://docs.obversa.ai/get-started/first-run) walks
through a complete file.

## Familiar patterns

These are the parts of a process you recognise from working with people.
Each snippet comes from a runnable example. Follow its link for the full
file, inputs and result.

### Get a second opinion

A writer drafts a post and a different model reads it against the house
style. The writer gets the review notes and revises the draft. In the
[editorial example](https://docs.obversa.ai/workflows/editorial/writer-grader-cap),
Claude writes, Codex reviews, and a person is the editor:

```ts examples/use-cases/editorial/writer-grader-cap.ts (excerpt)
    roles: {
      write: engines.claude('claude-sonnet-4-5'),
      grade: [engines.codex('gpt-5.6-luna')],
      editor: person('Publish this post?'),
    },
```

`stage()` from `@obversa/runtime` gives the writer a reviewer and a budget
for revisions:

```ts examples/use-cases/editorial/writer-grader-cap.ts (excerpt)
      stage('draft', {
        agent: 'write',
        writes: 'posts/draft.md',
        desc: 'Write the post from the brief, in the house style.',
        gate: 'The draft holds against every rule in style/house.md, as read by a grader from another model family.',
        reviewedBy: 'grade',
        // The judge. After a round the grader did not pass, Jev reads the
        // findings and the rounds so far and says whether another round is
        // worth it, for a finding tagged block too. The
        // rounds end when Jev stops them or the grader passes the draft.
        refine: judge(judgeSeat),
      }),
```

In `workflow()`, the reviewer has to come from a different model family
from the writer. [Get a second opinion](https://docs.obversa.ai/patterns/writer-and-reviewer)
explains the review loop.

### Know when to stop

A review can suggest changes that make little difference to the result.
Give a decision model the job of weighing those notes against the
purpose of the work and the revisions so far. `judge()` from
`@obversa/runtime` sets that stopping rule inside a `dag()` workflow:

```ts examples/teams/feature-delivery.ts (excerpt)
      maxKickbacks: { build: judge(judgeSeat) },
```

Here Jev makes the judgement, and the returns to the builder end when Jev
stops them or the review passes. Jev decides a blocking finding too. To
bound the returns as well, pass
`judge(judgeSeat, { cap: 4 })`: after the last review the cap allows, Jev is
asked once more, and the run fails unless Jev lets the work stand. [Know when to stop](https://docs.obversa.ai/patterns/judge-stops-the-loop)
shows the questions and a complete writing example.

### Ask a panel

Give the work to several reviewers and decide how many must agree. Each
opinion stays in the result, including dissent. A `workflow()` review
stage names the panel and the number of approvals it needs:

```ts examples/teams/threshold-panel.ts (excerpt)
      stage('review', {
        panel: 'review',
        agree: 1,
        desc: 'Have both reviewers read the change and count the acceptances.',
        gate: 'At least one reviewer has accepted.',
        sendsBackTo: 'implement',
      }),
```

This example needs one approval from its two reviewers. Set `agree` to
two when both must accept. [Ask a panel](https://docs.obversa.ai/patterns/review-panel)
shows the full team and what happens when a reviewer cannot answer.

### Ask a person

A model's review can be enough to request another draft. Publishing may
need an editor's decision. The editorial workflow asks the person named
in its `editor` role after the model review passes:

```ts examples/use-cases/editorial/writer-grader-cap.ts (excerpt)
      stage('publish', {
        input: 'editor',
        desc: 'Put the graded draft in front of the editor.',
        gate: 'The editor has said publish.',
        sendsBackTo: 'draft',
      }),
```

With no answer the run pauses. A refusal with notes goes to the writer.
Approval completes this example; a separate action would publish the
post. [Ask a person](https://docs.obversa.ai/patterns/approval) shows how
the question and answer become part of the run.

### Automate the routine work

Let a script check the facts while a model writes the report. The weekly
report example uses a command to check that the draft includes every
incident. Its exit code decides whether the writer tries again:

```ts examples/use-cases/ops/handoff-that-resumes.ts (excerpt)
      stage('check', {
        run: [process.execPath, 'tools/check-report.mjs'],
        desc: 'Fail the draft if an incident from the facts is missing.',
        gate: 'The check exits 0.',
        sendsBackTo: 'draft',
      }),
```

The workflow runs the command directly. The model spends its turn on the
draft. [Automate the routine work](https://docs.obversa.ai/patterns/command-kickback)
shows the same pattern with a test command.

### Pick up unfinished work

A weekly report stops after gathering its facts. The next worker opens
the saved record and continues with the draft, without gathering those
facts again. `run()` from `@obversa/runtime` resumes the same workflow:

```ts examples/use-cases/ops/handoff-that-resumes.ts (excerpt)
const second = await run(createReport(), {
  recordTo: record,
  resume: true,
  onEvent: watch('worker-2', worker2),
});
```

For steps declared with `workflow()` or `dag()`, the recovery rule is:

Steps that finished are never repeated. A step that was mid-flight when the
worker died runs again only if its binding declares it safe to retry; otherwise
the run pauses and asks a person to reconcile it before it continues, so
uncertain work is never repeated silently.
[The complete example](https://docs.obversa.ai/workflows/ops/handoff-that-resumes)
shows which stages each worker ran.

The [pattern collection](https://docs.obversa.ai/patterns) also covers
comparing different approaches, bringing a team together, and preparing
context before handing over a task. Patterns can be combined inside a
larger workflow.

## Complete workflows

A real use case combines these patterns around an outcome:

| Workflow | How the team works |
| --- | --- |
| [Review an article](https://docs.obversa.ai/workflows/editorial/writer-grader-cap) | A writer drafts, a different model reviews, and an editor decides whether it is ready to publish. |
| [Read research papers](https://docs.obversa.ai/workflows/research/literature-watch) | A model summarises supplied papers, a person selects the notes to keep, and those notes inform an answer. |
| [Handle support tickets](https://docs.obversa.ai/workflows/support/triage-with-escalation) | Classify each ticket, draft a reply, and refer uncertain or sensitive cases to a person. |
| [Prepare a shortlist](https://docs.obversa.ai/workflows/hiring/shortlist) | Apply rules in code, compare rankings from two models, and ask a person to choose the shortlist. |
| [Deliver a feature](https://docs.obversa.ai/workflows/feature-team) | Build and test the change, check every requirement, review it with three model families and approve the exact bytes. |

[Browse the workflows](https://docs.obversa.ai/workflows) for the full
files and examples from other fields.

### Deliver a feature

The feature team takes a ticket through seven steps:

1. **Build.** One seat builds the change from the ticket.
2. **Checks.** The ticket's tests run. A red test goes back to the
   builder with its output.
3. **Goal check.** A seat from another model family confirms that every
   requirement in the ticket was met.
4. **Review battery.** Three reviewers from three model families review
   the change at the same time.
5. **Synthesis.** Their reviews become one list.
6. **Judge.** Jev decides each finding, and the builder gets only the
   findings Jev acts on.
7. **Approval.** Attended, a person approves the exact bytes of every
   file the change adds, changes or deletes. With `--unattended`, the
   change lands without asking.

```ts examples/teams/feature-delivery.ts (excerpt)
      nodes: {
        build: { job: build(ticket.brief, files, tests) },
        goal: { needs: 'build', job: goalCheck(goalSeat, { target: 'build', text: ticket.brief }) },
        review: { needs: 'goal', job: review(ticket.brief, files) },
        ...(attended ? { approve: { needs: 'review', job: approve(start!) } } : {}),
      },
```

Each ticket runs in its own worktree, and the change lands on your branch
when the run passes. `examples/teams/feature-team-backlog.ts` points the
same team at a folder of tickets and delivers them one at a time. The
feature delivery file is `examples/teams/feature-delivery.ts`.

## Engines

A seat names the tool, the provider, the model family and the model.

| package | drives | needs |
| --- | --- | --- |
| `@obversa/engine-claude-cli` | Claude Code, one fresh process per attempt | Claude Code, signed in |
| `@obversa/engine-codex-cli` | Codex | Codex, signed in |
| `@obversa/engine-devin-cli` | Devin | Devin, signed in |
| `@obversa/engine-grok-cli` | Grok | the Grok command line tool |
| `@obversa/engine-opencode-cli` | OpenCode | the OpenCode command line tool |
| `@obversa/engine-claude-agent-sdk` | the Claude Agent SDK | Claude auth |
| `@obversa/engine-anthropic-api` | the Anthropic API | an API key |
| `@obversa/engine-jev-api` | Jev, typed decisions over recorded state | a Jev endpoint and API key |
| `@obversa/engine-mastra` | an agent you built with Mastra | `@mastra/core` and what your agent needs |
| `@obversa/engine-openai-agents` | an agent you built with the OpenAI Agents SDK | `@openai/agents`, `zod` and what your agent needs |

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

22 publishable packages. `packages/` holds the eight that define the
product: `@obversa/runtime` runs a workflow, `@obversa/api` holds the
engine and memory contracts, `@obversa/core` runs bounded child processes,
`@obversa/runner` supervises stored runs, `@obversa/builtin-workflows`
ships three ready-made teams, `@obversa/obversa` is the install above,
and `@obversa/surface` with `@obversa/surface-diff` is the local review
page. `plugins/` holds the fourteen adapters: the ten engines above, three
memories, and a notifier that posts run events to a URL.

[AGENTS.md](AGENTS.md) is the guide for anyone who changes this
repository: setup, the checks, and the rules every change follows.

## License

Obversa uses the [MIT License](LICENSE). Report security problems as
described in the [security policy](SECURITY.md).
