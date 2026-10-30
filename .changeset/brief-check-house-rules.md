---
"@obversa/runtime": minor
"@obversa/builtin-workflows": minor
---

`featureDelivery` sends `houseRules` to every seat it prompts, and the brief check can block on them.

- **Every seat reads the house rules.** With `houseRules` given, the `=== the house rules ===` block now reaches the brief check, the proof check, the research, requirements and plan writers and their review panels, the tests-first writer and its reviewers, and the builder's corrected report, as it already did the build and the review. `TeamInput` gains `houseRules`, so a team built on it can send its rules the same way.
- **A house rule can block a brief.** The brief check's block list gains one reason: a house rule that says the brief check blocks it. A block still pauses the run for the brief to be fixed.
