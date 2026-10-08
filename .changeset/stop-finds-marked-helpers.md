---
"@obversa/core": patch
---

On Linux, the cleanup after an engine command stops a helper the command started, also when the helper's parent has already exited.

A helper that runs in its own process group is reachable through the command's process tree only while its parent is alive. The cleanup looked for the command's attempt marker once, before it stopped anything, so a helper started after that look, whose parent then exited, kept running while the cleanup reported that nothing was left. `stopOwnedProcessTree` now looks for the processes that carry the request's `attemptId` on every pass, looks once more before it reports that nothing is left, and signals each process it finds during the forced stop. Processes that carry another attempt's marker are not stopped.
