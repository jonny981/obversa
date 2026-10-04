---
"@obversa/runtime": patch
---

A judge decides every finding, a block included, so a run with no cap always has someone deciding when to stop. A reviewer that tags every finding `block` cannot keep the rounds going on its own. The judge skips a block only when the case it names is outside how the work is really used, or the same class of finding keeps returning after it was answered; otherwise it acts on it. A skipped block appears in the `refine:judge` event with the judge's reason, and the next round's reviewers are told it was skipped and why. At a cap, a block in the last round goes to the judge too, and a skip lets the work stand with the block recorded in `openFindings`. Without a judge nothing changes: a plain number on `refine` or `maxKickbacks` still sends a block back.
