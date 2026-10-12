---
"@obversa/rdc": minor
---

`gitHistory(repo)` turns a repository's commit history into candidates: one per non-merge commit, newest first, carrying the subject, body, commit date and the files the commit changed. The reader runs git through the package's own child-process helper, with no shell, a scrubbed environment, a time limit, an output cap, and the request's abort signal reaching the process. A pinned `revision` resolves once at read start and every later call uses the SHA it returned. Missing git, a path that is not a directory, and a directory outside a work tree report `absent` rather than throwing. `blame` and `coChange` are opt-in options that add signals for lines still live in the task's named paths and files that historically change with them.

`knowledgeBase` learns a second date tier: when the corpus sits inside a work tree, a note with no frontmatter date takes its last committed change date with meaning `'changed'`. Notes inside a work tree also carry `path` and `repository`, and a pinned `revision` reads the tree the pin names: earlier file contents, no later files, and the resolved SHA on the result.

`pick` learns the commit-to-note link: after the threshold pass, a reference candidate answered at or above the new `linkedPathBar` (default 0.4) still passes when a threshold-selected commit from the same `repository` names its `path` in `changedPaths`. The record entry names the commit that carried it over in `link`, and `PickRecordEntry` carries `contentRef`, `path` and `repository` beside `changedPaths`.
