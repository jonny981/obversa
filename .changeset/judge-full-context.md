---
"@obversa/runtime": patch
---

A judge decides each finding with the whole picture: why the work exists, what changed, how the round went and where the rounds stand. The runtime builds this in code, with no extra model call, and a `workflow()` stage and a `dag()` give the judge the same input for the same rounds.

- **Why.** The judge reads the brief, the use case, and the target's `desc` and `gate`. A `dag()` takes an optional `brief`, as a `workflow()` does.
- **What.** In a git workspace, the judge reads each file changed since the run began, with the lines added and removed, and the diff around each file and line a finding cites. When the target names a file, the judge also reads its content.
- **How.** The judge reads each check step's command, its status and, when it did not pass, its output. It reads the verdicts of the target's own goal check, and for each finding who raised it, its severity, and the other reviewers' votes and reasons when the panel synthesised.
- **When.** The judge reads the round, the cap and whether this is the last round, every earlier round with its own decision on each finding and its reason, and the files changed since the last round.
- **A size limit.** What the judge reads is kept to 50000 characters, counted as JSON. Set another limit with `run(job, { judgeContextLimit })`. The longest parts are cut first, and the findings to decide are never cut. The judge is told what the limit cut, and each `refine:judge` event records the size of what the judge read and the same list of cuts.

The judge's prompt keeps the `{ state, questions }` shape. Its `state` holds four labelled parts, `why`, `what`, `how` and `when`, always in that order, then `cut` when the size limit cut something. The questions and the routing are unchanged.
