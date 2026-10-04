---
"@obversa/runtime": patch
---

A workflow stage can check the brief was met before its reviews. Set `goal` to a seat, ideally from another model family than the builder's, on a stage a panel reviews. Each round, the seat reads the brief, the stage's `desc` and `gate`, and the work, and marks each requirement met or unmet with evidence. Any unmet requirement goes straight back to the builder with its evidence: the reviewers do not run that round, and a judge does not decide it, so a requirement in the brief is never skipped as polish. The check runs every round, because a fix for a reviewer can break a requirement. Each round adds a `goal:check` event to the record with every requirement, its verdict and its evidence. In a `dag()`, `goalCheck(seat, { target, text })` is the same check as one node between the build and the review, and a judge on its target does not decide the unmet requirements.
