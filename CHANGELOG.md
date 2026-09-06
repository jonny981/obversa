# Changelog

All notable changes to the Obversa packages. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org).

The runtime package (`@obversa/runtime`) tracks the repository tag. The
engine and memory packages track their own versions independently.

## [Unreleased]

### Added

- **Host-selected worker environment:** Accept an optional readonly
  `environmentVariables` list on start and resume. Copy only present values of
  those names from the watchdog, without storing credentials in run inputs or
  host records. Default environment inheritance remains restrictive.

### Changed

- **Review identity records:** Every engine call managed by the graph executor
  records its requested and reported adapter, provider, model family, and
  model, including primary and fallback calls and calls without a reported
  identity. Review completion
  checks generator and repair history against reported reviewer identities,
  including cached passes. Unknown writer calls count as their declared
  targets; data-only nodes have no engine identity.
- **Review-loop graph type 3:** Generator and repair targets, including all
  declared substitutions, cannot share a provider or model family with any
  review target or substitution. This rule applies without reviewer diversity
  enabled. Stored graph type 1 and 2 plans are refused before execution.

- **Runner usage type:** `SupervisedRunUsage` exposes `reported`, `partial`,
  and `unknown` variants on run status and active-node usage. Consumers with an
  exhaustive switch must handle `partial`, whose totals are measured lower
  bounds and whose `unknownCalls` counts calls without receipts.

### Fixed

- **Documentation versions:** Refuse a docs build when a package version in
  the homepage table differs from its workspace manifest.
- **Unresolved merge markers:** Reject engine resolutions that retain conflict
  marker lines of seven or more characters, abort the merge, and name the file
  in a typed error. The failed resolution does not create a merge commit.
- **Gate command timeouts:** Name the timeout and its configured limit in the
  not-met result when a command exceeds that limit.
- **Stale pause-event resumes:** Bind each resume to one pause event. A
  replacement worker that finds a different pause at the same position returns
  a named pause with `code: 'RESUME_EVENT_MISMATCH'` and the exact reason
  `Resume expected pause event "<expected>" but found "<found>".` using both
  recorded IDs. Save its workspace anchor so a later explicit resume can reopen
  it. The replacement does not automatically resume the newer pause; an explicit
  resume can re-offer uncertain work without repeating completed occurrences.
- **Pause-anchor storage failures:** Report pause-time capture, snapshot artifact,
  or event write failures with `code: 'WORKSPACE_ANCHOR_WRITE'` after cleanup.
  These failures are terminal and do not write a resumable runner pause.
- **Paused runner budgets:** Freeze elapsed time at a settled pause until the
  next stored worker launch. Resume preflight spends no time; earlier execution
  and restart backoff remain spent across resumes and worker replacements.
- **Usage after worker crashes:** Preserve measured node totals as partial
  usage when calls lack receipts. Token totals are measured lower bounds,
  and `unknownCalls` keeps crash gaps visible after successful retries.
- **Recorded runner results:** Preserve a durably recorded worker result when
  stop or timeout occurs before worker exit, after verified cleanup and lease
  release. Cleanup failures still take precedence.
- **Worker environment:** By default, copy only `PATH`, `HOME`, `TMPDIR`, `TMP`, `TEMP`,
  `SystemRoot`, `USERPROFILE`, and `PATHEXT` from the watchdog into runner
  workers. Arbitrary parent variables such as API keys and `NODE_OPTIONS` are
  not inherited unless explicitly listed; runner identity and ownership markers
  are injected separately.
- **Host entry resolution:** Report every filesystem failure while resolving the
  selected host entry as a `SupervisedRunError` with `code: 'HOST_MODULE'` and the
  original cause. Run-root resolution and path containment checks keep their
  existing boundaries.

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
