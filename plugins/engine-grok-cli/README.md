# @obversa/engine-grok-cli

`@obversa/engine-grok-cli` runs one Obversa engine attempt through a fresh
Grok CLI process.

The plugin runs Grok the way you run it: with your own home folder, your
Grok login and your Grok settings. Grok has no clean mode, so it doesn't
run clean by default the way the other command-line engines do. Grok loads the repository's instruction files under its own rules, such as
whether you trust the project. The plugin adds only what the step needs,
through Grok's own flags: the tools and permission rules the step declares,
read-only enforcement where the step only reads, subagents only when the
step asks for them, and structured output.

## Requirements

- Node.js 22.12 or later
- Grok CLI 1.0.44, the version the plugin is tested with
- Grok signed in with `grok login`, or a login file passed as `authFile`

## Install

```bash
pnpm add @obversa/engine-grok-cli
```

## Use

```ts
import { grok } from '@obversa/engine-grok-cli';

const seat = grok('grok-4', { executable: '/absolute/path/to/grok' });
```

`grok(model, options)` is the seat a workflow role takes. It reads with
`read_file`, `grep` and `list_dir` unless you pass `tools`, and takes
`version` and `effort` too. The engine on its own:

```ts
import { GrokCliEngine } from '@obversa/engine-grok-cli';

const engine = new GrokCliEngine({
  executable: '/absolute/path/to/grok',
  version: '1.0.44',
  identity: { provider: 'xai', modelFamily: 'grok-4' },
  permissionMode: 'dontAsk',
});
```

## Input limit and login errors

This engine declares an input limit of 500,000 tokens, the most the Grok
service accepts in one request. The runtime measures it as 1,000,000
characters. A review step sizes the change it reads to fit, and a step
whose input is still larger pauses before the call.

When Grok prints a login error on stderr while it runs, the engine stops
the attempt at once with an `auth` failure. It does not wait out the
step's time limit. The runtime then runs the same seat once more, then the
seat's next candidate.

## Login expiry

Each account entry in a Grok login file carries `expires_at`. The engine
reads the login a call uses: the `authFile` when one is set, or else
`auth.json` in the person's Grok home (`GROK_HOME`, or `~/.grok`).

Grok's strict sandbox cannot renew a login, because it cannot write the
login's lock file. So before a call that runs under `--sandbox strict` (a
read step, or a step with no workspace), the engine checks the login's
latest `expires_at`. When it is not later than now plus the call's time
limit, the engine refreshes the login with one call outside the sandbox:
`grok models`, run from an empty temporary folder, which reads no
repository file and changes none.

- **With no `authFile`,** the call runs on the person's own Grok home and
  renews that login.
- **With an `authFile`,** the call runs in a temporary Grok home that holds
  a copy of the file, and the engine writes the renewed login back to the
  file.

The engine then reads the login again. Only when the refresh fails, or the
login still expires too soon, does the call fail with `invalid-config`,
naming the expiry and the refresh's own reason. The record has a tool
event named `login-refresh` for each refresh. A login with no `expires_at`
is not checked, and a value that does not read as a date is ignored.

A step that writes runs under `--sandbox workspace`. There, an `authFile`
that expires before the call's time limit fails the call at once and
asks you to run `grok` once outside Obversa.

