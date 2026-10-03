# @obversa/engine-anthropic-api

## 0.1.3

### Patch Changes

- 909029f: Every engine takes `effort`, the reasoning level a step runs at, under that one name: on the engine, on an `agentJob`, on a workflow agent stage, and on each request. An engine whose tool has a setting passes the level through it unchanged; an engine whose tool has none refuses the option with a clear error instead of ignoring it. The level a step asked for is recorded with its identity, so a record shows the effort each attempt ran at.
- Updated dependencies [909029f]
  - @obversa/api@0.2.5
  - @obversa/core@0.2.5

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
