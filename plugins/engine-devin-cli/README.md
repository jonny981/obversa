# @obversa/engine-devin-cli

`@obversa/engine-devin-cli` runs Obversa engine requests through a fresh Devin
CLI process.

## Requirements

- Node.js 22.12 or later
- The Devin CLI, installed and signed in with your own account

## Install

```bash
pnpm add @obversa/engine-devin-cli
```

## Use

```ts
import { devin } from '@obversa/engine-devin-cli';

const seat = devin('swe-2-max');
```

Without a model, Devin runs its own default model, or the one your Devin settings choose with `clean: false`.

Devin runs clean by default: with your own environment and Devin login,
but with an empty config file in place of your Devin settings. Set
`clean: false` to run with your Devin settings too. A
read-only step runs with `--permission-mode auto`, and a step that may write
runs with `--permission-mode accept-edits`. A write step under
`accept-edits` cannot run commands, so a builder that runs its tests needs
`devin('swe-2-max', { permissionMode: 'dangerous' })`. A read step refuses
any mode but `auto`. Devin has no mode without a
folder and no flag for a list of named tools. The plugin passes
`--respect-workspace-trust false`, because print mode cannot show Devin's
folder trust prompt.

## Commands a read step may run

A read step runs with `--permission-mode auto`. Devin decides by itself
which commands `auto` runs, and refuses others, such as `rg`. In print mode
Devin ends the run without an answer when it refuses a command, and the
plugin then continues it, as the next section says. `commands`
lists more commands a read step may run; there are none by default. A list
for review steps:

```ts
import { devin } from '@obversa/engine-devin-cli';

const reviewer = devin('swe-2-max', {
  commands: ['git diff', 'git log', 'git show', 'git status', 'rg', 'grep', 'ls', 'cat', 'head', 'tail', 'wc'],
});
```

Each entry becomes an `Exec(<entry>)` allow rule in the config file the
plugin writes for each attempt. Devin runs a command that starts with the
entry as whole words, and still refuses a command chained with `&&` or `;`,
a redirect, or command substitution. A read step whose `allowedTools` hold
`Exec(<entry>)` entries runs with those in place of `commands`. With
`clean: false`, the plugin writes a copy of your own
`~/.config/devin/config.json` with the rules added, and never writes your
file. A write step does not get the commands. An entry
that is empty, or holds `&`, `;`, `|`, `<`, `>`, `` ` ``, `$` or a newline,
is refused. `devin()` adds each rule to the seat's tools, and an attempt
records the step's tools. So a write step on that seat records the rules
too, although Devin does not get them. With `new DevinCliEngine({ commands })`
and a step whose tools leave the rules out, the record does not show them.
The record lists the seat's commands, and a step whose own list differs runs
with its own list.

Name the commands in a reviewer's prompt. Devin may refuse a command
outside the list.

## A refused tool in a read step

When Devin refuses a tool in a read step, the plugin continues the same
Devin session with `devin -r <session id>`, the same config file, the same
permission mode and the same flags. The message it sends says the tool call
was refused, names the commands the step may run (or says it may run none),
and asks Devin to finish the task with its file reading tools and those
commands only. The continued run's answer is the step's answer.

The plugin continues the session up to `refusalRetries` times in one
attempt, 2 by default. `refusalRetries: 0` turns this off:

```ts
import { devin } from '@obversa/engine-devin-cli';

const reviewer = devin('swe-2-max', { refusalRetries: 0 });
```

When Devin is refused again after the last continuation, the step fails
with the refusal error, which says how many times Devin was refused. Every
run counts against the step's one time limit and one output limit, and the
result's usage covers every run. Each continuation sends a `devin --resume`
tool event whose target says what the refused tool call acted on, such as
`refused: rg TODO` for the command `rg TODO src`. A write step is
never continued.

See [Devin CLI Engine](https://obversa.ai/docs/packages/engine-devin-cli).
