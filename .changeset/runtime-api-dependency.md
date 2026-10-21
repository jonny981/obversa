---
"@obversa/runtime": patch
---

`@obversa/runtime` now installs `@obversa/api` as a regular dependency instead of asking for it as a peer dependency. The version is the same exact version as before, so a project that installs the core packages together still gets one copy of `@obversa/api`.
