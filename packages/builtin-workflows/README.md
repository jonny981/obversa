# @obversa/builtin-workflows

`@obversa/builtin-workflows` supplies three ready-made workflows.
Use `workflow`, `stage`, `person`, and `briefFromFile` from
`@obversa/runtime` to write your own.

```bash
npm install @obversa/runtime @obversa/builtin-workflows
```

## What you get

- **`workflow`, `stage`, `person`, and `briefFromFile`.** The runtime builds
  a workflow from named roles and stages.
- **Seats** come from the engine plugins: `claude(model)`, `codex(model)`,
  `opencode(model, { executable })`.
- **`writerReviewerPair`, `thresholdPanel`, `featureDelivery`.** The three
  teams as functions, for a program that builds a team from parts.
- **`outcomeFromAgentText`.** The runtime reads a reviewer's reply as a
  pass or a revise with findings.

Every stage carries a `desc` and a `gate` sentence that reach the reviewers
and the record. A stage that promises a file fails by name when the file
is missing or empty, a command stage passes on its exit code, a reviewer's
decision is the file it writes, and every reviewer must be a different model
family from the writer it reads.

## What it does not do

It ships no command and chooses no model. Every seat comes from an engine
plugin you install.

The full pages, with a complete file and its captured output for each team,
are at [docs.obversa.ai/workflows](https://docs.obversa.ai/workflows).
