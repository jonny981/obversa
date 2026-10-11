---
"@obversa/engine-opencode-cli": patch
---

The OpenCode engine's workspace check no longer fails a run when a folder or symlink disappears while it is being checked, such as a lock folder or a build's temporary output. A symlink that still exists but resolves nowhere is still refused.
