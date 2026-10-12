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
- git on the `PATH` for `gitHistory` and for the repository tiers of
  `knowledgeBase`; without it `gitHistory` reports `absent`, a pinned
  `knowledgeBase` cannot resolve its revision, and an unpinned one just
  skips the git tier

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
resolved once and used for every operation that read performs; a source
that cannot honour a pin answers `absent` rather than guess. A
candidate's `text` is the retained snapshot of the exact text scored.

## Markdown sources

`knowledgeBase(dir)` reads a directory of notes: one candidate per
`## ` section of each `.md` file, all role `reference`. A section longer
than `maxQuestionText` (700 characters by default, the budget `pick`
shows the decision model) is offered in parts cut at line ends so every
part is judged. A note that says it was replaced (`superseded`,
`retired`, `deprecated`, `obsolete`, `withdrawn` in frontmatter or the
first 400 characters of its body) keeps its candidates at a negative
signal: ranked lower, never hidden. A note's declared date (frontmatter `date`, `written`,
`effective` or `applies-from`) is carried with its meaning. When the
corpus sits inside a work tree and the note declares none, its last
committed change date is carried with meaning `changed` instead; outside
a repository, or for a note git has never tracked, there is no date.
Notes inside a work tree also carry `path` (their repository-relative
file) and `repository`, which is what lets a selected commit link them
in. A `revision` pin on `knowledgeBase` reads the tree that revision
names: the earlier contents, no later files, and the resolved SHA on the
result.

`rules(dir)` reads a folder of rules: one candidate per `.md` file, all
role `rule`, the folder's `README.md` excluded. Frontmatter
`applies: always` marks a rule that every task follows: `pick` selects
it without asking. Only a rules source emits role `rule`; a note can
never declare itself one.

## Git history

`gitHistory(repo)` reads a repository's commits: one candidate per
non-merge commit, newest first, with the subject as `title`, the body as
`text`, the commit date with meaning `recorded`, and `changedPaths`
holding every file the commit changed relative to the repository root.
`contentRef` keeps the full commit SHA and `id` shows the short one.
Git runs with no shell, a scrubbed environment, a time limit and an
output cap. Missing git, a path that is not a directory, or a directory
outside a work tree reports `absent`; a pin the repository does not have
throws.

With no exclusions, one `git log` pass carries everything. With
exclusions, paths are listed first and a commit that touched an excluded
path is dropped before its body is ever fetched. `blame: true` adds a
signal for commits that wrote lines still live in the task's named
paths; `coChange: true` adds one for commits that touched files which
historically change with them. Both are off unless asked for.

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
`gitHistory` fills it from the commit's diff, never from paths the text
mentions. After the threshold pass one more pass runs: a reference
candidate answered at or above `linkedPathBar` (0.4 by default, below
the reference threshold on purpose) still passes when a
threshold-selected commit from the same `repository` names its `path` in
`changedPaths`. The record entry names the commit that carried it over
in `link`, and a linked candidate never carries another. The bar is a
chosen default, not a measured best; `PickThresholds.linkedPathBar`
overrides it.
