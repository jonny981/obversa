---
"@obversa/core": patch
"@obversa/engine-claude-cli": patch
---

A Claude session that spans two turns now returns one answer. This happens when a command started in the background ends the first turn and the CLI starts a second turn when it finishes. Each turn ends with its own result message. The answer from the last result is the one final part, and earlier turns' answers stay as parts that are not final. The recorded tokens add up every turn. The cost keeps the last result's figure, because Claude reports cost as a running total for the session.

A Claude CLI stream that ends without exactly one final answer now fails with the `invalid-config` kind, which is not retried on the same lane, instead of an unclassified error that a retry would repeat.
