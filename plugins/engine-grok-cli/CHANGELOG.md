# @obversa/engine-grok-cli

## 0.1.5

### Patch Changes

- 909029f: Every engine takes `effort`, the reasoning level a step runs at, under that one name: on the engine, on an `agentJob`, on a workflow agent stage, and on each request. An engine whose tool has a setting passes the level through it unchanged; an engine whose tool has none refuses the option with a clear error instead of ignoring it. The level a step asked for is recorded with its identity, so a record shows the effort each attempt ran at.
- Updated dependencies [909029f]
  - @obversa/api@0.2.5
  - @obversa/core@0.2.5

## 0.1.4

### Patch Changes

- 14f9f24: Engines run clean by default: your login and the repository's own setup stay in, and your own user-level settings, hooks, plugins, skills and MCP servers stay out, so a workflow behaves the same for everyone who runs it. Set `clean: false` to run the tool exactly as you run it. Grok has no clean mode and always runs on your setup; `clean: true` there throws with the reason. The engine conformance kit lets an engine declare clean mode unsupported, and a reduced declaration passes.
- Updated dependencies [14f9f24]
  - @obversa/api@0.2.4
  - @obversa/core@0.2.4

## 0.1.3

### Patch Changes

- 768c936: Every engine now runs its CLI the way you run it: with your own login and settings, and the repository's `AGENTS.md` and `CLAUDE.md` read as the CLI normally reads them. A step still adds only what it needs through the CLI's own flags: the tools it may use and read-only mode where it only reads. The Grok and OpenCode engines no longer refuse a repository that holds instruction files, and use your normal Grok and OpenCode login; Grok works with the current Grok CLI. Read-only Claude steps load your settings like any other Claude Code run. `opencode()` accepts `auth` as an explicit override.
  - @obversa/api@0.2.3
  - @obversa/core@0.2.3

## 0.1.2

### Patch Changes

- Require the compatible core release in the published package dependencies.
- Updated dependencies
  - @obversa/api@0.2.1
  - @obversa/core@0.2.1

## 0.1.1

### Patch Changes

- Tool events name their target: the file for a read or an edit, the first two words of a command, the URL of a fetch, the pattern of a search. The built-in teams use the runtime's `refine` field.
- Updated dependencies
  - @obversa/api@0.2.0
  - @obversa/core@0.2.0
