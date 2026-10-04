---
"@obversa/core": patch
---

On Linux, finding the processes a command started survives one of them exiting during the scan: a process that is gone by the time its environment is read is skipped, as one whose folder has already disappeared is.
