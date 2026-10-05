---
"@obversa/runtime": patch
---

A resumed run carries on at the step that was interrupted, in whatever round it was, in `workflow()`, `dag()` and `loop()`, at any depth.

- **A reviewed stage that dies during its review resumes at that review.** The build it reviews does not run again, in any round. A stage that dies during a build builds that round again. A stage not marked `retrySafe` still asks a person first.
- **A graph inside a `dag()` node that was sent work back to resumes in that node's round.** A step that passed in an earlier round never stands in for one the run had not reached.
- **A `loop()` carries on in the round it reached.** When its body is a graph, the graph skips the steps it finished in that round. A loop inside another loop's body does the same, in the rounds of both. A loop that passed but runs again because a file it wrote is missing writes that file again in the round it passed in, not in round 1.
- **A finished step whose file is gone runs again.** Before a resume reuses a step, it checks that the files the step declares (a stage's `writes`, a node's `file`) are in the workspace. When one is missing, a `retrySafe` step runs again, and any other step pauses and asks a person. The record says which file was missing. Every step inside it runs again too, such as the steps of a graph or a loop's body, even when only the outer step declares the file, and even when the run stops again during that rebuild. Each later step that needs it runs again too, with every step inside it, so a review reads the rebuilt work rather than passing it on its old verdict. A loop's review runs again in the same way after its body runs again. This holds even when the run stops again after the rebuild and before the review starts. A step that its `when` condition skipped, or an optional step that failed, wrote nothing, so a resume does not look for its file.
- **A step's record names its round only past round 1.** The record keeps each step with the round it ran in. A step that passed and declares files also lists the files it wrote, so a resume checks them from a compact `recordTo: 'auto'` record too.
