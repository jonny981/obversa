# @obversa/engine-opencode-cli

`@obversa/engine-opencode-cli` runs one Obversa engine attempt through a
fresh OpenCode CLI process.

The plugin runs OpenCode clean by default: with your own home folder and
your OpenCode login, but with an empty config folder in place of yours, so
your OpenCode settings stay out. Set `clean: false` to run it the way you
run it, with your own config folder too. It adds only what the
step needs, through OpenCode's own config: the tools and permission rules
the step declares, no autoupdate and no sharing. Every other tool is set
to `ask`, so OpenCode turns down each call to it and the tool doesn't run.

## Requirements

- Node.js 22.12 or later
- OpenCode CLI 1.18.23, the version the plugin is tested with
- OpenCode signed in to your model's provider, or login data passed as `auth`
- Any model OpenCode runs, free models such as `opencode/big-pickle`
  included. [Free models](#free-models) says what they cost.

## OpenRouter

Pass a named OpenRouter model to the seat helper, for example
`opencode('openrouter/anthropic/claude-sonnet-4.5', { executable })`.
Run `opencode auth login` and select OpenRouter, or set
`OPENROUTER_API_KEY` in your environment.
Clean mode preserves access to your login and API key.

That model has provider `openrouter` and family `claude`.
The plugin refuses `openrouter/openrouter/auto` because OpenRouter
chooses the model, so the seat cannot declare its family.

## Free models

OpenCode's free models refuse any run whose config turns a tool off or
denies a permission. So the plugin does neither. It sets each tool the
step doesn't declare to `ask`. A declared tool the step limits to a
pattern, such as `Bash(git status)`, is set to `ask` for everything else.

A free model gives up nothing for this. `opencode run` turns down every
`ask`, because nobody is there to answer it, and the plugin never passes
the flags that would approve them, such as `--auto`. So a tool the step doesn't
declare never runs, and a step's limits hold the same way on a free model
as on a paid one.

What it costs: the model sees all of OpenCode's tools, not only the ones
the step declares. When it calls one the step doesn't declare, OpenCode
turns the call down and tells the model, and the model carries on with the
step.

## Install

```bash
pnpm add @obversa/engine-opencode-cli
```

## Use

```ts
import { OpenCodeCliEngine } from '@obversa/engine-opencode-cli';

const engine = new OpenCodeCliEngine({
  executable: '/absolute/path/to/opencode',
  version: '1.18.23',
  identity: { provider: 'anthropic', modelFamily: 'claude' },
});
```
