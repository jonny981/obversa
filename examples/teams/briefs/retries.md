---
files: ["docs/retries.md"]
---

Use case: a developer who has never set retries before reads this page once and sets the value they need without asking anyone.

Rewrite docs/retries.md so a person reads it once and knows what to set. Keep the front matter and the code block exactly as they are.

## For the reviewers

You did not write the page, and you change nothing. Ask one question of every sentence: would the reader described above read it once and know what to do? Report only what fails for that reader, worst first. "Nothing fails" is a good report when it is true; then the status is pass.

Give each finding a severity. "block": the reader would not understand it, or it claims something false. "should-fix": the reader would stumble. "nice-to-have": taste. In the evidence, quote the sentence and say why in a few words. Put the plainest rewrite in the recommendation.
