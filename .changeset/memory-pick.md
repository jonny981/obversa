---
"@obversa/rdc": minor
"@obversa/api": minor
"@obversa/runtime": minor
---

Memory curation moves into its own package, `@obversa/rdc`. `pick` now lives there, with the candidate, question, answer, limits, thresholds and result types that drive it. It ranks candidates inside each source, shares the decision budget across reference sources so one large source cannot crowd out another, asks an injected decision function one bounded batch at a time, validates every answer, and returns the selected candidates with a record of what was asked and why. The API and the runtime no longer export it. It was never released, so nothing published changes.

The package also adds the contract a memory source implements (`CandidateSource`, with `CandidateReadRequest`, `CandidateReadResult` and `SourceReadError`) and two Markdown sources. `knowledgeBase(dir)` emits one reference candidate per `## ` section of each note. `rules(dir)` emits one rule candidate per file and honours `applies: always` frontmatter. `pickFromSources` reads the sources, then picks over the combined candidates, and a rule source that could not list every rule makes the record's `rulesCoverage` `'incomplete'`. `MemoryCandidate` gains an optional `changedPaths`: the repository paths a candidate changed.
