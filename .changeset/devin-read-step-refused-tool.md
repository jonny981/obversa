---
"@obversa/engine-devin-cli": patch
---

A Devin read step whose model tries to write fails with a message that says why. Devin refuses the write, so no file changes, and then ends its whole print-mode run without an answer. The error says that Devin refused a tool in read mode, which ends its run without an answer, and that no file changed. A read step that only reads answers as before.
