---
"@obversa/runtime": patch
---

A workflow stage's reviewers now get the stage's task and gate in their instructions, the same two sentences the writer gets. A team's callback review now posts its question to the run's callbacks client and reads the answer when the run resumes: a refusal fails the review with the person's note, and members that finished do not run again.
