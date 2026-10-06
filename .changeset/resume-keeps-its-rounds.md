---
"@obversa/runtime": patch
---

A resumed `dag()` or `workflow()` graph carries on in the round it reached, even when something outside its shape changed before the resume: the prompt of a job a `dag()` node runs, a node's timeout, or a workflow's `timeout` option.

Before, such a change made the resumed run count its send-backs from round 1 again, while the steps the stopped run had finished still stood. A send-back after the resume then reused a build from an earlier round instead of running it, so the builder never received the new findings and the next review read the same work. A step that was never interrupted in its round could also pause on the question "Did stage ... finish?", because an earlier round of it had been interrupted. The rounds a graph saves now stand exactly when its finished steps do, so a new round never reads an earlier round's record.

A change to a declared setting of a `workflow()` stage, such as its `desc`, `gate`, `writes` or `effort`, starts the run again from the first round. An edit to the body of a function made by `fnJob()` that a `fn` stage runs does not start the run again. Before, that stage's review could read the state the stopped run saved for it and finish without building.
