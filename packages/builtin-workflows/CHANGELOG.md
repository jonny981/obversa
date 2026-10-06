# @obversa/builtin-workflows

## 0.1.5

### Patch Changes

- f52eb86: `climbWorkflow` keeps a change to a workflow file only when the workflow scores better with it. Give it the file, the change as a unified diff, a `load` function that turns a version of the file into the job for one task, and tasks split into tuning tasks and held-out tasks. It returns a job for `run`.

  - **How it scores.** Each task runs on the committed file and on the changed file, `runs` times each (3 by default). Every run starts from the commit the repository was at when the climb started, in a worktree of its own, with its own record whose `run:start` names the version of the file that ran. By default a run scores 1 when it passed and the last check of each goal check met every requirement, and 0 otherwise. The report gives, per task and in total, for each version: the pass rate, the mean score, the mean rounds, the mean cost, the calls with no cost figure, and the mean time.
  - **How it decides.** The change is kept only when it wins on the tuning tasks and does no worse on any held-out task. A higher mean score wins. On the same mean score, fewer mean rounds wins. On the same rounds, a lower mean cost wins, but only when every call on both sides had a cost figure. A cheaper change that passes less often loses.
  - **Attended and automatic.** In `attended` mode (the default) a person sees the comparison and the diff and approves; with no answer the run pauses with the question pending. In `auto` mode the numbers alone decide, but only for a change that the `auto` option allows. A kept change is applied and committed on its own, with the comparison in the message. It is not applied when the repository has a new commit since the climb started, and each file is put back when the commit fails.
  - **What automatic mode may change.** The `auto` option is a plain object, written inline or imported from a file. `files` lists globs of text files the change may edit, such as briefs. `settings.file` names the workflow's JSON settings file, `settings.may` maps a key path (dots between keys, `*` for one key of any name) to a rule (`true`, `{ oneOf }` or `{ min, max }`), and `settings.never` lists key paths that stay out even when a `may` rule matches. Paths are relative to the workflow file's folder. Before any run, the climb reads the change file by file and compares the settings file's values key by key, so a reformat is no change. Everything not listed, and the workflow file itself, goes to a person: the climb still measures the change, and a kept one goes to the same approval `attended` mode uses, with the report's `needsPerson` naming each file or key outside the option and the rule a value broke. With no `auto` option, `auto` mode allows nothing. `climbWorkflow` refuses a malformed `auto` object with a message that names the wrong key.
  - **Guards.** A change is never applied, in either mode, when it runs with less protection than the workflow as it is. After the runs on each task, the climb compares what they did: their records, and the questions they put to a person. On each task, each review, reviewer, check, judge, approval and goal check must appear in at least as many candidate runs as baseline runs. Otherwise the change is refused and no more runs start. A run that ends paused or aborted counts with what it recorded before it stopped, and the candidate run after a paused or aborted baseline run still runs, so the two can be compared. Each protection is named by the full path of its step, a check also by each command it ran, with each argument, and a combined check also by how it requires each command it was built from, a reviewer by its place in the panel, and an approval by the path of the step that asked it, which the runtime records. A judge counts when the workflow has it, whether or not a review failed in the run, so a change that drops a judge is refused. The report's `refused` names the task and each missing protection by its kind and its label.
  - **A budget.** `budget: { runs, usd }` stops the climb before the next run once that many runs have run, or once they cost that much. The report says so, and an unfinished comparison never keeps a change. A run that ends paused or aborted also leaves the comparison unfinished.

  `formatClimbReport` prints the comparison a person reads.

  In `@obversa/runtime`, an `approval` step's `job:end` names the question it put to a person, or found already answered, under `asked`: the request's id, its gate and its question. Two steps that ask the same question about the same input share one request and its answer, and the record shows each one under its own path. The request's `input` and id are unchanged.

  A combined check (an array, `all`, `any`, `not` or `quorum`) records the commands its parts ran, in the order they ran, as `commands` on its result, and how it requires each command it was built from, also one a round did not reach, as `requires`: a tree of `all`, `any`, `not` and `quorum` over its commands, with `other` for a part that holds no command. The climb gives a check a `requires` label for each command whose failure alone fails it, and one for the whole check when some command's failure alone does not. So a change that swaps a command inside a loop's `until` array is refused, even when no baseline round reached it, and so is a change from `all(test, lint)` to `any(test, lint)`, though both commands still run. A change that adds a command to an `all` keeps every label. A lone check requires its command, as an `all` of that one command does, so a change from `test` to `any(test, always)` is refused, and a change from `all(test)` to `test` keeps every label.

- Updated dependencies [f52eb86]
- Updated dependencies [063af5a]
  - @obversa/runtime@0.2.15
  - @obversa/api@0.2.15

## 0.1.4

### Patch Changes

- 10e3a18: `improveWorkflow` proposes one change to a workflow file from the record of one of its runs, and applies it only when a person says yes.

  - **What it reads.** The record a run wrote with `recordTo` and the `source` run option, and the workflow file the record names. A file whose SHA-256 differs from the one in the record is refused before any model runs, and the message names both hashes.
  - **What it proposes.** One unified diff to the workflow file, with a reason that cites lines of the record. The diff must apply to the file, and every cited line must exist in the record.
  - **What it may not change.** A seat from another model family checks that the change removes and weakens no review, check, goal check, judge, approval or guard, and that the record supports the reason. When it sends the proposal back, the run fails and nobody is asked.
  - **Approval.** The run asks a person through its callbacks client, with the diff, the reason and the cited events. A yes applies the diff, after a check that the file still has the SHA-256 in the record. A no writes nothing. The last step's outcome keeps the decision, the record path, the diff, the reason, any note, and the file's SHA-256 before and after.

- Updated dependencies [13b4f6d]
  - @obversa/runtime@0.2.13
  - @obversa/api@0.2.13

## 0.1.3

### Patch Changes

- b24059a: The same review intent behaves the same whether you write it with `workflow()`, `dag()` or `loop()`: the same outcome, the same number of builds, the same judge consultations and the same judge input.

  - **`refine: N` means N refinements in every form.** A refinement is one more build after the first, with the review's findings, so `refine: N` allows N+1 builds and `refine: 0` allows one. A judge's `cap: N` changes the same way: at most N refinements, and the judge reads the review of the last build too. Each review of the same build is the same round, so a second reviewer, or a request the judge lets stand, does not use up the cap.
  - **A reviewed stage that is also sent work back to has one count.** Its own reviews and the send-backs from later stages share its refinements and its judge's rounds in one run. With `refine: 1`, a review that rejects the first build uses the one refinement, so a later send-back fails the run.
  - **A stage a person reviews consults its judge.** With `refine: judge(seat)`, each refusal goes to the judge, in both forms. While the person has not answered, the run pauses and the judge waits; an answer that arrives on a resume goes to the judge then.
  - **A writer that returns the reviewed work unchanged after feedback fails at once,** in every form. An agent step with `workspaceMode: 'write'` that runs after a review sent the work back, and leaves the files as they were, fails the step. Staging or committing the same files is not a change. When a stage declares `writes`, or a `dag()` node names its `file`, only those files count, even when Git ignores them: a change to any other file is not a change to the work.
  - **A reviewed stage runs every refinement its `refine` or judge allows,** as a `dag()` and a `loop()` do.
  - **A judge that stops the rounds fails the work with its findings.** The failed step keeps the last review's findings, and its summary gives the judge's reason, in every form.
  - **A `loop()` whose review rejects the last round `max` allows fails** with that review's findings (exit code 1), as a `dag()` does when its send-backs run out. A loop that reaches `max` with no review, stalls, or reaches `maxReviewRestarts` still ends `exhausted`.
  - **`agree` works on a stage a panel reviews,** as on a `panel:` stage and `reviewPanel({ pass })`.
  - **A node declares the nodes it sends work back to.** In a `dag()` or `pipeline()`, list them in `acceptsKickbackTo`; a send-back to a node not listed fails the sender with an error that names both nodes. A `workflow()` stage's `sendsBackTo` declares its target for you. The built-in teams declare theirs.
  - **A judge's state belongs to one run, and survives a resume.** Running the same workflow twice starts the judge with no rounds and no skipped findings. Once work has been sent back, by a review or by a goal check's unmet requirement, in a `workflow()` or a `dag()`, the record keeps the round count, the judge's earlier rounds, skipped findings and product answers. A resume after a pause, a stopped run, a worker that died or a run that failed counts on from the same round, so the refinements already used stay used. What a judge skipped reaches every node that can send work back to the target, and a send-back's feedback is read once. A step the resume reuses keeps the models its answers came from, so a later panel that needs a different model family still checks them.
  - **A `loop()` with a graph body passes its review to the graph.** Each step's first run in a round reads the loop's last review as `ctx.lastReview`. A step that fails with an error a retry cannot fix fails the graph with that error, so the loop stops there, as it does around the step alone.
  - **A judge in a `dag()` reads what a judge in a `workflow()` reads.** Give the dag a `useCase` and the target node a `file`, and its judge sees the use case, the current draft, and the size of each earlier round's change. A send-back from a later `workflow()` stage gives the stage's judge the same.
  - **The judge runs inside the time limit of the node that sent the work back,** in a `dag()` as in a `workflow()`, and each `refine:judge` event names the target and the round.

- Updated dependencies [b24059a]
  - @obversa/runtime@0.2.11
  - @obversa/api@0.2.11

## 0.1.2

### Patch Changes

- Require the compatible core release in the published package dependencies.
- Updated dependencies
  - @obversa/api@0.2.1
  - @obversa/runtime@0.2.1

## 0.1.1

### Patch Changes

- Tool events name their target: the file for a read or an edit, the first two words of a command, the URL of a fetch, the pattern of a search. The built-in teams use the runtime's `refine` field.
- Updated dependencies
  - @obversa/runtime@0.2.0
  - @obversa/api@0.2.0
