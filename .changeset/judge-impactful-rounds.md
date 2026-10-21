---
"@obversa/runtime": minor
---

The judge sends back only findings that matter. A finding it holds back (wording, style, naming, an edge case outside real use, a nice-to-have) no longer sends the work back. It is collected, with its reviewer and the evidence it wrote, on the decision's `minorFindings` list, so a lead reads it before landing. Every finding the judge holds back lands on that list with its round, so no finding disappears.

A stop answer can end a run as a pass. When the judge answers `not_converging` or `over_polishing` with enough confidence to end the run and no finding goes back, the run stops as a pass with the held findings attached. A finding the judge acts on still sends the work back, whatever the stop answer.

A product answer is never thrown away. When the judge asks a person for a `product_decision`, even at the cap, a change the person asks for goes to the builder as one more round, and the record says why.

At the cap, a run neither stops short nor runs away. If the judge sends back fewer findings than in the round before, the run gets one more round and records why. Otherwise it pauses for a person, with the open findings attached, as a resumable product decision. A run never ends as a failure at the cap while the judge is still sending findings back.
