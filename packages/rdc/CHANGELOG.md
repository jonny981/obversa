# @obversa/rdc

## 0.2.0

### Minor Changes

- a6f95ac: Memory curation moves into its own package, `@obversa/rdc`. `pick` now lives there, with the candidate, question, answer, limits, thresholds and result types that drive it. It ranks candidates inside each source, shares the decision budget across reference sources so one large source cannot crowd out another, asks an injected decision function one bounded batch at a time, validates every answer, and returns the selected candidates with a record of what was asked and why. The API and the runtime no longer export it. It was never released, so nothing published changes.

  The package also adds the contract a memory source implements (`CandidateSource`, with `CandidateReadRequest`, `CandidateReadResult` and `SourceReadError`) and two Markdown sources. `knowledgeBase(dir)` emits one reference candidate per `## ` section of each note. `rules(dir)` emits one rule candidate per file and honours `applies: always` frontmatter. `pickFromSources` reads the sources, then picks over the combined candidates, and a rule source that could not list every rule makes the record's `rulesCoverage` `'incomplete'`. `MemoryCandidate` gains an optional `changedPaths`: the repository paths a candidate changed.

- 8583d06: `gitHistory(repo)` turns a repository's commit history into candidates: one per non-merge commit, newest first, carrying the subject, body, commit date and the files the commit changed. The reader runs git through the package's own child-process helper, with no shell, a scrubbed environment, a time limit, an output cap, and the request's abort signal reaching the process. A pinned `revision` resolves once at read start and every later call uses the SHA it returned. Missing git, a path that is not a directory, and a directory outside a work tree report `absent` rather than throwing. `blame` and `coChange` are opt-in options that add signals for lines still live in the task's named paths and files that historically change with them.

  `knowledgeBase` learns a second date tier: when the corpus sits inside a work tree, a note with no frontmatter date takes its last committed change date with meaning `'changed'`. Notes inside a work tree also carry `path` and `repository`, and a pinned `revision` reads the tree the pin names: earlier file contents, no later files, and the resolved SHA on the result.

  `pick` learns the commit-to-note link: after the threshold pass, a reference candidate answered at or above the new `linkedPathBar` (default 0.4) still passes when a threshold-selected commit from the same `repository` names its `path` in `changedPaths`. The record entry names the commit that carried it over in `link`, and `PickRecordEntry` carries `contentRef`, `path` and `repository` beside `changedPaths`.
