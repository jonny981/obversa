---
"@obversa/builtin-workflows": patch
---

`improveWorkflow` proposes one change to a workflow file from the record of one of its runs, and applies it only when a person says yes.

- **What it reads.** The record a run wrote with `recordTo` and the `source` run option, and the workflow file the record names. A file whose SHA-256 differs from the one in the record is refused before any model runs, and the message names both hashes.
- **What it proposes.** One unified diff to the workflow file, with a reason that cites lines of the record. The diff must apply to the file, and every cited line must exist in the record.
- **What it may not change.** A seat from another model family checks that the change removes and weakens no review, check, goal check, judge, approval or guard, and that the record supports the reason. When it sends the proposal back, the run fails and nobody is asked.
- **Approval.** The run asks a person through its callbacks client, with the diff, the reason and the cited events. A yes applies the diff, after a check that the file still has the SHA-256 in the record. A no writes nothing. The last step's outcome keeps the decision, the record path, the diff, the reason, any note, and the file's SHA-256 before and after.
