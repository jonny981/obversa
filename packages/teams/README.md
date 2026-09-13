# @obversa/teams

Declare a team as a workflow file: the brief, the roles named once, the
stages in order, each a small block of nouns saying who does it, what it
writes, who reads it and where the work goes back to. The package
compiles that into a job for `run` from `@obversa/runtime`. Three
ready-made teams come with it as functions.

```bash
npm install @obversa/runtime @obversa/teams
```

## What you get

- **`workflow(name, { brief, roles, stages })`.** The team as a job. Stages
  run in the order written.
- **`stage(name, { agent | run | panel | input, writes, desc, gate,
  reviewedBy, sendsBackTo, retry })`.** One step.
- **`person(question)`** and **`fromFile(path)`.** A person as a role, and a
  brief kept as a markdown file with optional front matter for `files`.
- **Seats** come from the engine plugins: `claude(model)`, `codex(model)`,
  `opencode(model, { executable })`.
- **`writerReviewerPair`, `thresholdPanel`, `featureDelivery`.** The three
  teams as functions, for a program that builds a team from parts.
- **`outcomeFromAgentText`.** A reviewer's reply as a pass or a revise with
  findings.

Every stage carries a `desc` and a `gate` sentence that reach the reviewers
and the record. A stage that promises a file fails by name when the file
is missing or empty, a command stage passes on its exit code, a reviewer's
decision is the file it writes, and every reviewer must be a different model
family from the writer it reads.

## What it does not do

It ships no command. It adds no dependency beyond `@obversa/runtime`. It
chooses no model: every seat comes from an engine plugin you install.

The full pages, with a complete file and its captured output for each team,
are at [docs.obversa.ai/workflows](https://docs.obversa.ai/workflows).
