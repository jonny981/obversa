# @obversa/engine-devin-cli

## 0.1.4

### Patch Changes

- 50aacd2: A Devin builder can run commands. `devin(model, { permissionMode })` and `new DevinCliEngine({ permissionMode })` take Devin's own modes: `auto`, `accept-edits`, `smart` or `dangerous`.

  - **Write steps.** The mode applies to a step that may write. A builder that runs its tests or builds needs `dangerous`. Without the option, a write step runs with `accept-edits` as before, which edits files but cannot run commands.
  - **Read steps.** A read step runs with `auto`. A read step with any other mode fails with `invalid-config` before Devin starts, so read-only holds.
  - @obversa/api@0.2.14
  - @obversa/core@0.2.14

## 0.1.3

### Patch Changes

- 4401f23: A Devin read step whose model tries to write fails with a message that says why. Devin refuses the write, so no file changes, and then ends its whole print-mode run without an answer. The error says that Devin refused a tool in read mode, which ends its run without an answer, and that no file changed. A read step that only reads answers as before.

## 0.1.2

### Patch Changes

- 909029f: Every engine takes `effort`, the reasoning level a step runs at, under that one name: on the engine, on an `agentJob`, on a workflow agent stage, and on each request. An engine whose tool has a setting passes the level through it unchanged; an engine whose tool has none refuses the option with a clear error instead of ignoring it. The level a step asked for is recorded with its identity, so a record shows the effort each attempt ran at.
- Updated dependencies [909029f]
  - @obversa/api@0.2.5
  - @obversa/core@0.2.5

## 0.1.1

### Patch Changes

- 14f9f24: Engines run clean by default: your login and the repository's own setup stay in, and your own user-level settings, hooks, plugins, skills and MCP servers stay out, so a workflow behaves the same for everyone who runs it. Set `clean: false` to run the tool exactly as you run it. Grok has no clean mode and always runs on your setup; `clean: true` there throws with the reason. The engine conformance kit lets an engine declare clean mode unsupported, and a reduced declaration passes.
- Updated dependencies [14f9f24]
  - @obversa/api@0.2.4
  - @obversa/core@0.2.4

## 0.1.0

### Minor Changes

- `devin(model?)` is a Devin seat for team workflows. Each attempt runs one fresh `devin -p` process with your own environment, Devin login and Devin settings. A read-only step runs with Devin's `auto` permission mode, and a step that may write runs with `accept-edits`.
