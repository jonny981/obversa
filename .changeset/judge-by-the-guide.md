---
"@obversa/runtime": minor
"@obversa/api": minor
"@obversa/engine-jev-api": patch
---

The judge scores each finding and acts only when it is sure enough. Every round, each finding gets a `score` question with four levels: cosmetic, minor, impactful or blocking. The judge reports a confidence with each answer. A finding goes back to the builder only when it is scored impactful or blocking and its confidence clears the send-back bar for its level. A blocking finding has a lower bar. Every other finding goes on `minorFindings` with its level and confidence.

The default round questions are two: `product_decision`, a yes/no on whether a person must settle a product question first, and `stop_reason`, a choice of how the run ends, with a new `none_applies` option. `holds`, `worth_doing` and `worth_another_round` are no longer asked by default. A stop answer that would end the run needs the stop bar. A person decides instead when the stop answer is under that bar, when the judge answers `none_applies`, and when any answer is under the hand-off bar. An answer with no confidence counts as unsure, so it never clears a bar.

When the judge cannot score a finding surely enough to route it, the run pauses and asks a person to name "act" or "hold" for that finding. A finding they do not name is held. If no finding goes back, the work stands as a pass with no extra build.

The bars are named constants in `JUDGE_CONFIDENCE`, exported with `FINDING_LEVELS` and `findingQuestions`. Their values are starting bars, not measured ones.

The judge no longer counts or compares rounds itself. The runtime sends it, as numbers, the findings sent back this round and the round before, whether that count is falling, and which findings repeat an earlier one: the same reviewer, the same file and the same claim, with line numbers and punctuation ignored. Each finding's entry carries the brief lines it touches, or the whole brief when none match, and the diff hunks it cites. When the packet must be cut, the brief and the diffs are cut before the counts.

In `@obversa/api`, an engine's `effective` record can carry `modelSource`: `reported` when the engine named the model that answered, `requested` when it named none and the record keeps the model id the request sent. `@obversa/engine-jev-api` uses it: when Jev reports no model, the record names the requested model instead of none.
