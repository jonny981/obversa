# @obversa/engine-codex-cli

## 0.1.3

### Patch Changes

- 14f9f24: Engines run clean by default: your login and the repository's own setup stay in, and your own user-level settings, hooks, plugins, skills and MCP servers stay out, so a workflow behaves the same for everyone who runs it. Set `clean: false` to run the tool exactly as you run it. Grok has no clean mode and always runs on your setup; `clean: true` there throws with the reason. The engine conformance kit lets an engine declare clean mode unsupported, and a reduced declaration passes.
- Updated dependencies [14f9f24]
  - @obversa/api@0.2.4
  - @obversa/core@0.2.4

## 0.1.2

### Patch Changes

- Require the compatible core release in the published package dependencies.
- Updated dependencies
  - @obversa/api@0.2.1
  - @obversa/core@0.2.1

## 0.1.1

### Patch Changes

- Updated dependencies
  - @obversa/api@0.2.0
  - @obversa/core@0.2.0
