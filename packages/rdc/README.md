# @obversa/rdc

`@obversa/rdc` is rank, decide, curate for agent memory. A memory source
turns a task into typed candidates. `pick` ranks those candidates, asks a
decision model which ones the step actually needs, and returns the
survivors with a record of every answer, rejection and unasked item.

The package depends on nothing else in this repository. A host brings its
own sources and its own `decide` call.

## Install

```bash
pnpm add @obversa/rdc
```

## Requirements

- Node.js 22.12 or later

## Sources

A source implements `CandidateSource`: it has an `id`, a declared `role`
(`reference`, `rule` or `mixed`), and a `read` that takes a
`CandidateReadRequest` and returns a `CandidateReadResult`.

`read` answers one of three outcomes:

- **`status: 'read'`**: candidates, plus `complete: false` whenever
  enumeration stopped early or skipped anything.
- **`status: 'absent'`**: the expected nothing: no directory, no store.
  Non-fatal, with its reason.
- **A thrown `SourceReadError`**: a real failure: an unreadable file, a
  corrupt store, or `code: 'cancelled'` when the read was aborted.

The request's `exclude` paths are refused before any content is opened,
so excluded text never reaches signals or a model. A `revision` pin is
resolved once and used for every operation; the Markdown readers below
resolve no revision, so they answer `absent` for any pin, `HEAD`
included. A candidate's `text` is the retained snapshot of the exact
text BM25 scored.

## Markdown sources

`knowledgeBase(dir)` reads a directory of notes: one candidate per
`## ` section of each `.md` file, all role `reference`. A section longer
than `maxQuestionText` (700 characters by default, the budget `pick`
shows the decision model) is offered in parts cut at line ends so every
part is judged. A note that says it was replaced (`superseded`,
`retired`, `deprecated`, `obsolete`, `withdrawn` in frontmatter or the
first 400 characters of its body) keeps its candidates at a negative
signal: ranked lower, never hidden. A note's declared date (frontmatter `date`, `written`,
`effective` or `applies-from`) is carried with its meaning; a note with
no declared date has no date.

`rules(dir)` reads a folder of rules: one candidate per `.md` file, all
role `rule`, the folder's `README.md` excluded. Frontmatter
`applies: always` marks a rule that every task follows: `pick` selects
it without asking. Only a rules source emits role `rule`; a note can
never declare itself one.

## Picking

`pick(candidates, { task, decide })` ranks the candidates, asks `decide`
in bounded batches, and returns the selected candidates with a
`PickRecord`. `pickFromSources(sources, request, options)` reads the
sources first, then picks over the combined candidates; a rule source
that returned `complete: false` or was absent makes the record's
`rulesCoverage` `'incomplete'`, even when every supplied rule was
answered. `rulesEnumerationComplete: false` in the options is honoured
the same way.

Each candidate's `changedPaths` names the repository paths it changed;
nothing produces it yet.
