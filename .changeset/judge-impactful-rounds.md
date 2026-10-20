---
"@obversa/runtime": minor
---

From round 2, the judge sends back only findings that matter. Round 1 keeps the act or skip question for each finding. From round 2, the judge asks whether each finding is impactful: behaviour wrong under normal use, a brief requirement not met, a test that cannot fail, data loss, a security problem or a broken house rule. A minor finding (wording, style, naming, an edge case outside real use, a nice-to-have) no longer sends the work back. It is collected, with its reviewer, file and line, on the decision's `minorFindings` list, so a lead reads it before landing. A finding the judge skips in any round lands on that list with its round, so no finding disappears.

A stop answer can end a run as a pass. When the judge answers `not_converging` or `over_polishing` and no impactful finding is acted on, the run stops as a pass with its minor findings attached. An acted impactful finding still sends the work back.

A product answer always gets its round. When the judge asks a person for a `product_decision`, even at the cap, the answer goes to the builder as one more round, and the record says why.

At the cap, a run neither stops short nor runs away. If fewer impactful findings are open than in the round before, the run gets one more round and records why. Otherwise it pauses for a person, with the open findings attached, as a resumable product decision. A run never ends as a silent failure while impactful findings are open.
