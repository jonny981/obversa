# @obversa/engine-devin-cli

## 0.1.5

### Patch Changes

- 0c4f042: A Devin read step can run the commands you list. `devin(model, { commands })` and `new DevinCliEngine({ commands })` take command prefixes such as `git diff` or `rg`. There are none by default.

  - **Read steps.** Each entry becomes an `Exec(<entry>)` allow rule in the config file the plugin writes for the attempt. A read step whose `allowedTools` hold `Exec(<entry>)` entries runs with those in place of the engine's list. With `clean: false`, that file is a copy of your own Devin config with the rules added; your own file is never written. Devin still refuses a command chained with `&&` or `;`, a redirect, or command substitution.
  - **Write steps.** A write step does not get the commands, and its permission mode decides what it may run.
  - **Refused entries.** An entry that is empty, or holds `&`, `;`, `|`, `<`, `>`, `` ` ``, `$` or a newline, throws a `TypeError` that names it.
  - **The record.** `devin()` adds each rule to the seat's tools, and an attempt records the step's tools, so a step on that seat records the rules. A write step records them too, although Devin does not get them there. With `new DevinCliEngine({ commands })` and a step whose tools leave the rules out, the record does not show them. The record lists the seat's commands, and a step whose own list differs runs with its own list.

  A refused tool does not cost a Devin read step its answer. In print mode Devin ends its run with no answer when it refuses a tool. The plugin continues the same Devin session with `devin -r <session id>`, with the same config file, permission mode and flags, and a message that says the tool call was refused, names the commands the step may run (or says it may run none), and asks Devin to finish with its file reading tools and those commands only. The continued run's answer is the step's answer.

  - **How many times.** `refusalRetries`, an option of `devin(model, options)` and `new DevinCliEngine()`, sets how many times one attempt is continued. It is 2 by default. `refusalRetries: 0` turns it off. When Devin is refused again after the last continuation, the step fails with the refusal error, which says how many times Devin was refused.
  - **Limits and usage.** Every run counts against the step's one time limit and one output limit. The result's usage covers every run in the attempt.
  - **The record.** Each continuation sends a `devin --resume` tool event whose target says what the refused tool call acted on, such as `refused: rg TODO` for the command `rg TODO src`.
  - **Write steps.** A write step is never continued.
  - @obversa/api@0.2.15
  - @obversa/core@0.2.15

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
