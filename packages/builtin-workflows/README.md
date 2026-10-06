# @obversa/builtin-workflows

`@obversa/builtin-workflows` supplies three ready-made teams and two workflows
for improving a workflow file. One proposes a change from a run’s record;
the other scores a change before you keep it.
Use `workflow`, `stage`, `person`, and `briefFromFile` from
`@obversa/runtime` to write your own.

```bash
npm install @obversa/runtime @obversa/builtin-workflows
```

## What you get

- **`writerReviewerPair`, `thresholdPanel`, `featureDelivery`.** The three
  teams as functions, for a program that builds a team from parts, and
  `outcomeFromAgentText`, which reads a reviewer's decision out of its text.
- **`improveWorkflow`.** Reads the record of a workflow's run and proposes
  one change to the workflow file. A seat from another model family checks
  it, and it applies only when a person says yes.
- **The builders they are made of**, `workflow`, `stage`, `person` and
  `briefFromFile`, come from `@obversa/runtime`. This package ships none of
  them.
- **Seats** come from the engine plugins: `claude(model)`, `codex(model)`,
  `opencode(model, { executable })`.
- **`climbWorkflow`.** Runs a workflow on tuning tasks and held-out tasks,
  with and without a proposed change, and keeps the change only when the
  workflow scores better with it. A person approves a kept change. In
  `auto` mode the numbers alone decide for a change that the `auto` option
  allows: the files, and the settings keys and values, it may change.
  `formatClimbReport` prints the comparison.

Every stage carries a `desc` and a `gate` sentence that reach the reviewers
and the record. A stage that promises a file fails by name when the file
is missing or empty, a command stage passes on its exit code, a reviewer's
decision is the file it writes, and every reviewer must be a different model
family from the writer it reads.

## What it does not do

It ships no command and chooses no model. Every seat comes from an engine
plugin you install.

The full pages, with a complete file and its captured output for each team,
are at [obversa.ai/docs/workflows](https://obversa.ai/docs/workflows).
