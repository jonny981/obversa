# @obversa/builtin-workflows

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
