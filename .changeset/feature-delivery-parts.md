---
"@obversa/api": minor
"@obversa/runtime": minor
"@obversa/builtin-workflows": minor
"@obversa/engine-grok-cli": minor
"@obversa/engine-claude-cli": patch
"@obversa/engine-codex-cli": patch
"@obversa/engine-devin-cli": patch
"@obversa/engine-opencode-cli": patch
---

A run now finishes alone, or pauses with one reason a person can act on.

- **Engine input limits.** An engine may declare `inputLimit` in characters or tokens. A step whose input is larger pauses before the call, naming the size and the limit. Codex declares 1,048,576 characters and Grok 500,000 tokens.
- **Review rounds.** A `reviewPanel` with a `target` keeps its rounds: from round 2 each reviewer reads its own open findings and the diff since its last round. A resume numbers on from the record, and a paused round does not count. With a `base`, each agent reviewer reads the change sized to its engine's limit, with data files listed by path, size and sha256 when the whole change does not fit.
- **A reviewer that never answers** is not a review. The panel decides on the reviewers that answered, and pauses only when too few answered for its pass rule. A round that paused after blocks came in sends those blocks to the target on resume, without reviewing the unchanged tree again.
- **A seat that could not answer** (a timeout, a stall past `agentJob`'s `stallMs`, a login error, a moved CLI version, no exit status, or a process the runtime could not watch) runs once more, then its next candidate. `EngineError` gains `versionMoved` and `noExitStatus`, and the Devin and OpenCode engines set them. The Claude, Codex and Devin engines keep the cause of a failed version check, so the runtime can tell when its watch on that check failed.
- **Carried work.** `run({ carryFrom })` hands the earlier run's open findings, accepted proofs and how it ended to every step as `ctx.carried`. A fresh run keeps an earlier record beside the new one instead of writing over it. `acceptProofs` and `standingProofs` keep a proof until a file it covers changes. `proofSendBacks` and `noteProofSendBack` keep a proof check's send-backs, so a resume reads them back. `ctx.fingerprintExcludePaths` names the run's own files, so a step's own snapshot can leave them out.
- **Commit on pass.** `run({ commit })`, or a `dag()`'s own `commit: { from }`, commits a passed run's work with the named step's message and the run's trailers. A hook that refuses leaves the work uncommitted, and the run still passes and says why.
- **Checks.** A `commandJob` with a target runs a failed command once more before it counts, and marks a check that then passes as flaky. A writer may answer a failed check with no change and its evidence; a further failure pauses the run. A failed check's output names the failing tests, quotes the failure lines and the end of each stream, and keeps the whole output in a file beside the record. The send-back carries that output once, in its finding, and `outputLimit` bounds the reason and the output together.
- **Grok logins.** The Grok engine stops an attempt at once on a login error, and refreshes a login that would expire during a strict-sandbox call with one call outside the sandbox.
- **Feature delivery.** `featureDelivery` runs a seat check, a brief check that lists every finding and pauses instead of ending, the build, the report, a size check, the checks, a proof check that keeps accepted proofs, and the review panel, with an optional commit. Every later step starts on the seat the seat check admitted. Only the review panel's verdicts go through the judge. Its research, plan and tests stages run first when their seats are given. Its config takes `checks`, `base`, `briefPath`, `buildMinutes`, `reviewMinutes`, `stallMinutes` and `commit`; `analyse` is optional, and `test` and `approve` are gone.
