---
"@obversa/runtime": patch
---

`agentJob` takes `maxMemoryBytes` and `maxOutputBytes` and passes them to the engine request unchanged, the way it takes `timeoutMs`. A step that runs a large CLI can raise the 4 GiB memory cap for the process tree it owns. A dag node takes the same two settings, and an agent job in that node that sets neither uses the node's values. A value that is not a positive whole number fails the step with a message that names the setting, before the engine runs. With neither setting, the engine keeps its own default.
