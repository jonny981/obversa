---
"@obversa/engine-claude-cli": patch
"@obversa/engine-claude-agent-sdk": patch
"@obversa/engine-grok-cli": patch
"@obversa/engine-opencode-cli": patch
---

Every engine now runs its CLI the way you run it: with your own login and settings, and the repository's `AGENTS.md` and `CLAUDE.md` read as the CLI normally reads them. A step still adds only what it needs through the CLI's own flags: the tools it may use and read-only mode where it only reads. The Grok and OpenCode engines no longer refuse a repository that holds instruction files, and use your normal Grok and OpenCode login; Grok works with the current Grok CLI. Read-only Claude steps load your settings like any other Claude Code run. `opencode()` accepts `auth` as an explicit override.
