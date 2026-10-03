---
"@obversa/engine-claude-cli": patch
"@obversa/engine-claude-agent-sdk": patch
"@obversa/engine-codex-cli": patch
"@obversa/engine-opencode-cli": patch
"@obversa/engine-devin-cli": patch
"@obversa/engine-grok-cli": patch
"@obversa/api": patch
---

Engines run clean by default: your login and the repository's own setup stay in, and your own user-level settings, hooks, plugins, skills and MCP servers stay out, so a workflow behaves the same for everyone who runs it. Set `clean: false` to run the tool exactly as you run it. Grok has no clean mode and always runs on your setup; `clean: true` there throws with the reason. The engine conformance kit lets an engine declare clean mode unsupported, and a reduced declaration passes.
