# @obversa/engine-claude-cli

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
