---
"@obversa/runtime": patch
---

A loop that runs out of rounds, or stalls, before its review passes fails the graph around it. In a `dag()`, a required node that ends `exhausted` fails the graph like a plain failure: the run exits non-zero, nodes that need it do not run, and the summary names the node and why it ran out. A `workflow()` stage reviewed by a panel or a person that runs out of rounds fails the run the same way. The exhausted outcome keeps the last review's findings in its `revision`, so the failure says what was still wrong. An optional node that ends `exhausted` still does not fail the graph, and a later node with `when: failed(name)` on it runs, so its recovery path is not skipped.
