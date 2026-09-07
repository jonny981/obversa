# Changelog

All notable changes to the Obversa packages. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org).

The runtime package (`@obversa/runtime`) tracks the repository tag. The
engine and memory packages track their own versions independently.

## [1.0.0]

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
- **Safe file changes:** Capture complete source records, bind approval to exact
  output bytes, back up targets, read each result back, and pause on a mismatch.
- **Stored proof reuse:** Resolve accepted results through the host cache with
  current evidence, graph, workspace anchor, and reviewer identity. Each lookup
  checks the stored completion and acceptance again.
- **Read-only proof packets:** Share bounded, immutable source evidence through
  a host cache. Check authoritative revisions, reuse unchanged source reads,
  and invalidate only dependent packets. Effectful jobs cannot use the cache.
- **Host-selected worker environment:** Accept an optional readonly
  `environmentVariables` list on start and resume. Copy only present values of
  those names from the watchdog, without storing credentials in run inputs or
  host records. Default environment inheritance remains restrictive.

### Changed

- **Tarball test selection:** Run the two package-command integration tests
  with `OBVERSA_TEST_REAL_PACK=1 pnpm test:tarballs`. The default command skips
  those tests; `verify:d15` enables them.
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

- **Concurrent worktree registration:** Add and remove Git worktrees one at a
  time per repository within the runtime process. Linked checkouts share the
  queue; unrelated repositories and the jobs in their worktrees stay concurrent.
  A failed command releases the queue for the next operation.
- **Release check errors:** Name a missing runtime manifest consistently in
  the changelog and publish checks.
- **Package archives:** Check the number of hashed chunks and use literal
  filenames for exports and source-map reads. Report a missing file once when
  it is listed as both a pinned file and an export. Resolve workspace packages
  when packing starts instead of when the checker is imported.
- **Scripted engine receipts:** Keep typed `INVALID_ENGINE_RECEIPT` records in
  the review-loop status when a receipt fails a version, lane, active position, or
  sequence check. Rejected receipts do not change accepted identities or quorum.
- **Attempt example checks:** Read exported attempt data from a separate JSON
  report. Printed JSON can change indentation while executable path checks
  remain enforced.
- **Documentation versions:** Refuse a docs build when a package version in
  the homepage table differs from its workspace manifest.
- **Process identities across locales and timezones:** Read the process table
  under the C locale and UTC. A worker with a restricted environment and a
  host watchdog previously spelled one start time two ways, so live status
  never matched on a non-C host or across a timezone boundary; a recorded
  identity now merges with the same live process instead of splitting it into
  two entries. A run recorded by an earlier version keeps the old spelling,
  so status on this version reports its worker as not running while it still
  runs; nothing restarts it, and a fresh run records the new spelling.
- **Unresolved merge markers:** Reject engine resolutions that retain an ordered
  conflict block with matching opening, separator, and closing marker widths
  of seven or more characters. Abort the merge and name the file in a typed
  error without creating a merge commit. Standalone document underlines are
  permitted. Custom conflict marker widths below seven remain undetected.
- **Gate and ratchet command timeouts:** Reject timed-out commands even when
  their termination handler exits zero. Name the timeout and its configured
  limit in the not-met result. A timed-out ratchet command cannot seed or
  change its saved baseline.
- **Run progress:** Keep a complete event record when the bounded tail read
  starts at its first byte.
- **Isolated merges:** Merge isolated DAG nodes and `isolated()` jobs one at a
  time through one process-wide lock.
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
