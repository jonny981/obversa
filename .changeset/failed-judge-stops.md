---
"@obversa/runtime": minor
---

A judge that cannot answer now stops the round instead of buying another build. A judge call that ends in any status but pass pauses the run with the engine's own error; a reply that does not parse, or that leaves an asked question unanswered or answered in a shape the question does not allow, pauses it with a validation error. Before, those replies were read as "no clear answer" and the work went back for another build it never earned. A paused run resumes by asking the judge again for the same round over the state it saved: no build runs and no reviewer is re-asked first.

A judge must answer every question it is asked, including the per-finding questions generated when it decides each finding. A `score` question accepts the rating a judge engine reports (a finite `score`), or a probability per named criterion (keyed by criterion, or a list of `{label, probability}` per level).

The record gains a `refine:judge-request` event written before the judge's engine call: the bounded packet it was sent, the complete question set, a digest of the question set and the decision options, and the seat's declared model identity, so a failed call still leaves what was asked. Secret shapes and injected environment values in the packet and the questions are kept as `[redacted]` in that event; the judge still reads them in full. `refine:judge` events can now carry `status: 'paused'` with the failure, and `agentJob` accepts a public `onResult` option for the effective model identity the result reports.
