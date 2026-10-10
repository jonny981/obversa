---
"@obversa/api": minor
"@obversa/runtime": minor
---

`@obversa/runtime/memory` gains `pick`, a selection helper for memory curation. It ranks candidates inside each source, shares the decision budget across reference sources so one large source cannot crowd out another, asks an injected decision function one bounded batch at a time, validates every answer, and returns the selected candidates with a record of what was asked and why. `@obversa/api` gains the candidate, question, answer, limits, thresholds and result types that drive it.
