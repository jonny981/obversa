---
"@obversa/engine-devin-cli": patch
---

A Devin builder can run commands. `devin(model, { permissionMode })` and `new DevinCliEngine({ permissionMode })` take Devin's own modes: `auto`, `accept-edits`, `smart` or `dangerous`.

- **Write steps.** The mode applies to a step that may write. A builder that runs its tests or builds needs `dangerous`. Without the option, a write step runs with `accept-edits` as before, which edits files but cannot run commands.
- **Read steps.** A read step runs with `auto`. A read step with any other mode fails with `invalid-config` before Devin starts, so read-only holds.
