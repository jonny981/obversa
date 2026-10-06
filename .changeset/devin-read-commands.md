---
"@obversa/engine-devin-cli": patch
---

A Devin read step can run the commands you list. `devin(model, { commands })` and `new DevinCliEngine({ commands })` take command prefixes such as `git diff` or `rg`. There are none by default.

- **Read steps.** Each entry becomes an `Exec(<entry>)` allow rule in the config file the plugin writes for the attempt. A read step whose `allowedTools` hold `Exec(<entry>)` entries runs with those in place of the engine's list. With `clean: false`, that file is a copy of your own Devin config with the rules added; your own file is never written. Devin still refuses a command chained with `&&` or `;`, a redirect, or command substitution.
- **Write steps.** A write step does not get the commands, and its permission mode decides what it may run.
- **Refused entries.** An entry that is empty, or holds `&`, `;`, `|`, `<`, `>`, `` ` ``, `$` or a newline, throws a `TypeError` that names it.
- **The record.** `devin()` adds each rule to the seat's tools, and an attempt records the step's tools, so a step on that seat records the rules. A write step records them too, although Devin does not get them there. With `new DevinCliEngine({ commands })` and a step whose tools leave the rules out, the record does not show them. The record lists the seat's commands, and a step whose own list differs runs with its own list.

A refused tool does not cost a Devin read step its answer. In print mode Devin ends its run with no answer when it refuses a tool. The plugin continues the same Devin session with `devin -r <session id>`, with the same config file, permission mode and flags, and a message that says the tool call was refused, names the commands the step may run (or says it may run none), and asks Devin to finish with its file reading tools and those commands only. The continued run's answer is the step's answer.

- **How many times.** `refusalRetries`, an option of `devin(model, options)` and `new DevinCliEngine()`, sets how many times one attempt is continued. It is 2 by default. `refusalRetries: 0` turns it off. When Devin is refused again after the last continuation, the step fails with the refusal error, which says how many times Devin was refused.
- **Limits and usage.** Every run counts against the step's one time limit and one output limit. The result's usage covers every run in the attempt.
- **The record.** Each continuation sends a `devin --resume` tool event whose target says what the refused tool call acted on, such as `refused: rg TODO` for the command `rg TODO src`.
- **Write steps.** A write step is never continued.
