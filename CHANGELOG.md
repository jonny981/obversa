# Changelog

All notable changes to the Obversa packages. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org).

The runtime package (`@obversa/runtime`) tracks the repository tag. The
engine and memory packages track their own versions independently.

## [Unreleased]

## [1.0.0] - 2026-09-05

### Added

- `@obversa/runtime` 1.0.0: stored graph plans, bounded node attempts,
  durable events and artifacts, restartable execution, workspace checks,
  Callback Gates, and proof-bound decisions.
- `@obversa/engine` 0.1.0 and six engine plugins at 0.1.0: typed engine
  results through Agent SDK, Claude, Codex, Grok, OpenCode, and Anthropic adapters.
- `@obversa/runner` 0.1.0: local worker supervision with stored run inputs,
  bounded restart, workspace leases, status, and process cleanup within the
  reported platform capability. Worker stdout and stderr share a fixed
  1,000,000-byte cap; excess output can fail the run with `OUTPUT_LIMIT`.
- `@obversa/runner`: `resumeSupervisedRun` and `ResumeSupervisedRunOptions`
  reopen an exact recorded graph pause using the stored definition and run
  limits. The host action policy runs again before node effects.
- Action-policy `wait` decisions record a graph pause with its reason and
  request. A `deny` decision records a failed node with `DENIED`.
- `@obversa/engine/command`: optional `ownerId` on command and cleanup requests,
  inherited `OBVERSA_RUN_OWNER` markers, `commandCleanupCapability`,
  `CommandCleanupCapability`, and `inspectOwnerMarkedProcesses` for process
  ownership and cleanup inspection.
- `@obversa/memory` 0.1.0 with `@obversa/memory-simple` and
  `@obversa/memory-git` at 0.1.0: replaceable memory with conformance tests.
- `@obversa/source` 0.1.0 and `@obversa/surfacer` 0.1.0: local review
  surfaces over public package contracts.
- Public guides and runnable examples for installation, graphs, storage,
  memory, workspaces, callbacks, proof-bound approval, hosts, and offline
  review.
