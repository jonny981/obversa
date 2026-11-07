---
"@obversa/runtime": minor
---

A finding answer under the hand-off floor no longer pauses the round for a person on its own. The judge was already deciding each finding, so the unsure call is routed like any other call: when at least one finding is going back, the unsure finding goes back with it, still carrying its level, confidence and reason so the builder knows how much weight to give it, and the record marks it went back unsure. When no finding is going back, it is held onto `minorFindings` like any other held-back finding, for the person who reads the run before the work lands. A round that already pauses for a product decision, a hand-off the round answer raised or a spent cap still asks a person, and the judge's calls ride it as before.

A finding decision `pending` is no longer produced, but a question a saved checkpoint still holds can carry it: an `"act"` named under the finding's id in `feedback.findings` sends it back, and an answer that does not name it holds it, as before.
