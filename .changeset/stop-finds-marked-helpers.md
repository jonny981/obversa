---
"@obversa/core": patch
---

On Linux, the cleanup after an engine command stops a helper the command started, also when the helper's parent has already exited.

A helper that runs in its own process group is reachable through the command's process tree only while its parent is alive. The cleanup looked for the command's attempt marker once, before it stopped anything. A helper started after that look, whose parent then exited, could keep running while the cleanup reported that nothing was left. `stopOwnedProcessTree` now looks for the processes that carry the request's `attemptId` on every pass, looks once more before it reports that nothing is left, and signals each process it finds during the forced stop. The look by marker finds only processes that carry this request's `attemptId`, so a process that carries another attempt's marker and is not part of the command's tree is not stopped.
