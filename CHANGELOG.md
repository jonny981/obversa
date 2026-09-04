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
- `@obversa/memory` 0.1.0 with `@obversa/memory-simple` and
  `@obversa/memory-git` at 0.1.0: replaceable memory with conformance tests.
- `@obversa/source` 0.1.0 and `@obversa/surfacer` 0.1.0: local review
  surfaces over public package contracts.
- Public guides and runnable examples for installation, graphs, storage,
  memory, workspaces, callbacks, proof-bound approval, hosts, and offline
  review.
