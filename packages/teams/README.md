# @obversa/teams

Three teams of models you can run on your own work: a writer and a
reviewer, a review panel with a threshold, and feature delivery. Each is a
function that takes your brief, your workspace, your test command and one
engine per seat, and returns a job for `run` from `@obversa/runtime`.

```bash
npm install @obversa/runtime @obversa/teams
```

## What you get

- **`writerReviewerPair`.** One model writes the files your brief names, your
  test command runs, and a model from a different family reviews the result.
  A rejection sends the work back to the writer, once by default.
- **`thresholdPanel`.** One model implements, your test command runs, and
  several reviewers read the change at the same time. The change passes
  when at least the threshold number of them accept.
- **`featureDelivery`.** Analyse, implement, test, review, approve. The
  analyse step writes a delivery note, the reviewers can send the work back
  to the implementer, and the approve step writes an approval note.

Every team is a graph of named steps with a `desc` and a `gate` sentence on
each, and every seat is checked before a run: two seats in one model family
are refused, and a step that promises a file fails by name when the file is
missing or empty.

## What you give it

| field | what it is |
| --- | --- |
| `brief` | The work, as text. Every model in the team reads it. |
| `workspace` | The directory the team works in. Files are written here. |
| `files` | The paths, relative to the workspace, that the brief expects written. |
| `test` | The command and arguments that prove the files, run in the workspace. |
| seats | One `{ engine, identity }` per role. The identity names the adapter, provider, model family and model. |

The reviewers on a panel are a list of `{ name, seat }`, with the threshold
as a whole number from one to the number of reviewers.

## What it does not do

It ships no command. You import a team and run it from your own file. It
adds no dependency beyond `@obversa/runtime`. It does not choose engines for
you: every seat is one you construct from an engine plugin and pass in.

The full pages, with a complete file and its captured output for each team,
are at [docs.obversa.ai/workflows](https://docs.obversa.ai/workflows).
