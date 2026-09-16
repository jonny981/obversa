# Changelog

All notable changes to the Obversa packages. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org).

The runtime package (`@obversa/runtime`) tracks the repository tag. Every
other published package tracks its own version independently of it.

## [Unreleased]

### Added

- **Workflow resume:** `run(job, { recordTo: path, resume: true })` resumes
  a declarative workflow from its own record instead of truncating it.
  Stages whose passing completion is recorded under the same declared
  shape are skipped, interrupted stages re-run, a changed brief restarts
  from the top, and a person gate re-posts at its recorded position. Two
  processes resuming one record at once is out of scope.

## [1.0.0] - 2026-09-15

### Added

- `copyJobMeta` carries a job's shape (its name, kind and stage metadata) onto a wrapper that keeps its behaviour, so a guarded job retains its shape when the plan is rendered.
- A command stage may change the files it `writes` and no other declared file; a change to another declared file fails the stage by name.
- `run` takes `monitor: true` (on by default under `supervise`) and serves
  the run's own page on a free loopback port: the declared graph with each
  step's live state folded from the run's events, the returns, the pending
  questions a person can answer through the run's callbacks client, and the
  record tail. The address is one `monitor` event and one line in the record,
  never stdout; `RunResult.monitor` carries it and closes the page.
- `stage()` takes `when`, a runtime condition such as `passed()`, `failed()` or an async predicate, and `optional`. A stage whose `when` is not met is recorded as skipped and counts as passed for the stages after it.
- `stage()` takes `needs`, one or more earlier stage names, so a condition can read a stage further back than the one before it.

- **Type declarations for the review packages:** `@obversa/source` and
  `@obversa/surfacer` now ship declaration files generated from their
  JSDoc, with a `types` condition on every export entry. A TypeScript
  reader importing either package resolves types instead of failing with
  an implicit-any import. The clean-consumer check imports both strictly,
  so the declarations cannot be dropped without failing the check.
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
- **Forge helper example:** Ship `examples/forge-helper.ts` with
  its documentation page. It is the shipping step after a review gate:
  push the work branch, open or update one pull request with a body from
  the commit bodies, pass a strict gate that ships only an exact-revision
  pass, squash the merge with the same synthesis, and delete the branch.
  The gate prints strict `RESULT:` verdicts with the reason on the line.
  `pnpm example:forge` runs it offline against a mock host, and the
  clean-consumer check runs it from the packed tarballs.
- **Feature-delivery example:** Ship a runnable feature-delivery workflow,
  `examples/feature-delivery.ts`, with its documentation page. It takes one
  written issue through analysis, implementation, a real test run, a review
  panel with three reviewers and two required votes, a bounded kickback
  repair, and an approval bound to the exact bytes, using only public runtime
  exports. It names real seats, so running it needs accounts for those
  models. Beside it, `examples/feature-delivery.proof.ts` runs the same
  workflow with scripted seats and no model account, and `pnpm
  example:feature` runs it. The clean-consumer check installs the packed
  packages and runs that proof twice with one mutation each, refusing the
  approval and leaving the repair undone, and requires both to fail.

- **A team as a workflow file:** `workflow(name, { brief, roles, stages })`
  and `stage(name, { agent | run | panel | input, writes, desc, gate,
  reviewedBy, sendsBackTo, retry })` from `@obversa/teams` declare a team
  as an ordered list of stages, each a block of nouns, and compile it to
  the runtime's graph: a reviewed stage runs again with the findings, a red
  command or a rejected review goes back to the stage it names, `retry`
  bounds the stage that repeats, `writes` bounds what a stage may write,
  `person(question)` is a role a person fills, and `post.always` runs with
  the record.
- **Seats from the engine plugins:** `claude(model)`, `codex(model)` and
  `opencode(model, { executable })` return a seat with the identity the
  plugin records, started able to write files.
- **Briefs as markdown files:** `fromFile(path)` reads a brief beside the
  code; its front matter may carry `files`, the paths the brief expects
  written.
- The three team examples are written in the workflow form and shrink by
  more than half; the explicit functions stay.
- A reviewer that writes a declared file it does not own is a boundary
  breach: the panel records it as a blocking error and does not count it
  as a vote. Every other error a reviewer raises scores as it did before.
- **Feature delivery in eleven steps:** `featureDelivery` researches the
  brief and writes the requirements and the plan, each reviewed; writes the
  declared `testFiles` before any code; implements until the test command
  exits 0 and the reviewers accept; runs the tests once more; records an
  approval carrying the run's marker; and writes the evidence and the
  learning from the record. A rejected plan, test or implementation goes
  back to the step that owns it, each target with its own `maxKickbacks`
  budget. Requirements carry `REQ-n` ids and the plan step compares them
  with the plan's checks; a note that comes back unchanged after a review
  fails plainly.
- **A reviewer's decision is its file:** a team reads `reviews/<name>.json`
  when the reviewer wrote it in this turn, then the first JSON object in
  the reply. A reply with no decision in either is asked for once more;
  a second one stops the review with a plain summary and sends nothing to
  the writer.
- `outcomeFromAgentText` is exported from `@obversa/teams`: the parser that
  turns a reviewer's reply into a pass or a revise with findings, for a
  review panel of your own whose lenses must be able to say no.
- `fnJob` takes a function that returns a one-line summary or nothing, as
  well as a full outcome: a string is a pass with that summary, nothing is a
  pass with the label as its summary, and a throw is a fail carrying the
  error.
- `commandJob(label, command, opts)` runs a command as a step: pass on exit
  0, fail with the output as the evidence otherwise. `target` names the node
  that owns the fix, as `gateJob` does; the command is one string or an
  array, one argument per entry.
- `passed(name)` and `failed(name)` are conditions for a node's `when` that
  read the named dependency's outcome, so a branch follows a command's
  decision with no code reading `ctx.needs` by hand. A name the node does
  not depend on is a configuration error.
- `approval(label, { question, input?, target?, answer? })` is a person's
  decision as a step. It asks through the run's callbacks client: a yes
  passes, a no goes back to `target` with the note as the finding (or fails
  the step with the note), and no answer pauses the run with the request
  pending. Run again with the same client, the step finds the answer.
- `run` takes `callbacks`, the client the run's questions go through: the
  in-memory client or the stored client (`RunCallbacks`), and every job sees
  it as `ctx.callbacks`. The default is a fresh in-memory client for the
  run; the stored client is the one whose questions survive a process
  exit.
- A callback request posted again after being superseded is live again: the
  newest post is always the question a router can answer.
- `dag` refuses at build time a `when` that reads a dependency the node
  does not need, and a `failed(x)` on a node whose `x` is not
  `optional: true`, because a required node that fails blocks its
  dependents before any `when` runs. The check reads the condition itself,
  each item of an array and each input of `all`.

- A dag node accepts `needs` as one name or a list, and optional `desc` and
  `gate` sentences that reach the rendered plan, the `dag:node` record and
  the input the node's reviewer receives.
- A dag's `maxKickbacks` accepts a map of target name to count as well as
  a number, so each step that receives work back has its own budget. The
  `dag:kickback` event and the rendered plan carry the count and the limit.
- **Engine checks before graph work:** A plan may carry a preflight policy,
  one entry per lane with `live: 'required' | 'skip'` and
  `unsupportedStatic: 'block' | 'allow'`. Before the first dispatch the
  executor asks each engine to `admit` the seat with real node
  configuration and, where required, makes one tool-free live call per
  eligible seat, one at a time, stopping at the first that answers. A
  failed check pauses the run with `PREFLIGHT_PAUSED` before any work;
  `resume({ preflightEventId })` and `resumeSupervisedRun` with
  `preflightEventId` reopen that exact pause, repeat the static checks and
  reuse live receipts that still apply. `readRunPreflight` reads the record,
  and `interruptRunPreflight` closes a check the process died in the middle
  of, once the caller has verified the old worker is gone. When every target
  of a lane is excluded or blocked, the run ends with `PREFLIGHT_FAILED`, a
  terminal failure with no pause to resume from.
- `Engine.admit` on the engine contract: an engine reports the identity it
  will run under, and refuses when it would now run as something else.
  `AgentRequest.purpose: 'preflight'` marks a live check.
- `gateJob(label, condition, { target })`: when the condition is not met,
  the step returns a revision request to `target` carrying the condition's
  evidence, so a red test command sends its output straight back to the
  step that owns the fix with no agent in between.
- `ctx.needs` inside a dag node: the outcomes of the steps the node needs,
  by the names its `needs` list uses, read by the node's `when` predicate
  and its job, so a command's result can choose which branch runs next.
  Undefined outside a dag node.
- **Saved team conversations:** Compile named members and fixed rooms with
  `teamGraphType`. Posts in successful turn results queue mentioned members;
  a fresh executor rebuilds messages and requested turns from the run record.
  Each member receives its own result and permitted room messages, with
  explicit turn, concurrency and input limits.
- **Readable room files:** Build room copies from a saved team run with
  `projectTeamRooms`. The helper returns the revision it read, leaves the
  stored events unchanged and can rebuild deleted room files.

- **Bounded child processes:** The `@obversa/process` package exports one
  function, `runChild`. It runs a child to a deadline and returns a typed
  result: the exit code, the captured bytes, and timed-out and aborted flags
  decided from recorded facts, never from which callback fired first.
  Standard input is closed after the optional input, both output streams are
  drained until they close or for a short grace after the child exits, and
  live children are stopped when the parent process exits. Every git and
  engine spawn in the runtime, the engine command runner, the Codex adapter
  and the Git memory adapter run through it, and `execa` is no longer a
  dependency.

### Changed

- **The old runtime name:** Remove the pre-rename name from the twenty tracked
  files that carried it, including the consult instruction and the two plugin
  system prompts a model reads at run time. English uses of the word stay. A
  grep of the word now finds only the diff module's ordinary sentence.
- **Review-loop status typing:** `ConvergenceStatus` is a type alias rather
  than an interface, and `EngineReceiptRejection` is exported, so a consumer
  can name the rejection element type directly instead of by indexed access.
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

- A failed engine check or call retires what the failure proves: bad
  credentials retire the selected adapter and provider; a missing model,
  exhausted credit or an exhausted quota retire the provider and model; a
  missing command-line tool or an invalid configuration retire the
  adapter; a rate limit or a transport error retire nothing. The reported
  effective identity is evidence in the record and never widens the scope.
  An old auth record with no provider recovers one from its lane, and an
  ambiguous recovery refuses before work with `ENGINE_IDENTITY_UNRESOLVED`.
- `LANE_DEAD_FAILURES` from `@obversa/engine` now includes `quota`, and the
  wording rules that classify a provider's message changed with it: usage
  limit, allowance and session limit wording is a `rate-limit`, which
  clears in minutes; monthly usage limit and out-of-credits wording is a
  `quota`, which is an allowance gone for hours or longer and retires the
  provider and model.
- Usage that was not reported is unknown, not zero; usage from checks is
  recorded separately from usage from nodes. Preflight checks before a
  worker launches spend no run budget; checks inside a worker do.
- Environment variable names passed to a supervised run are validated and
  their values captured before any asynchronous work; no value reaches run
  storage.
- A child started through `runChild` sits in the caller's process group
  unless `detached: true` is passed. The engine command runner passes it, so
  its process sweep still sees the whole group.
- The Git memory adapter's output cap counts standard output and standard
  error together. It counted each stream on its own before.
- A timeout is decided by the deadline against the moment the child's exit
  was observed. Teardown work after the exit never counts.

### Fixed

- **Cross-family seat check:** An OpenCode seat derives its model family from the model name, taking the first hyphen-delimited segment after the provider prefix, so `opencode('anthropic/claude-sonnet-4-5')` declares the family `claude`. In a `workflow()`, a stage's seat and each of its reviewers must declare a different model family from one another, or the workflow is refused before any model runs. That now includes seats naming one model through two adapters. The check compares what each seat declares about itself.
- Public workflow examples resolve their direct-run guard through real paths,
  so a symlinked directory cannot make a copied example exit successfully
  without running or printing its outcome.

- **OpenCode managed-config seam:** The OpenCode plugin no longer reads the
  `OPENCODE_TEST_MANAGED_CONFIG_DIR` environment variable, so an ambient
  variable can no longer add a config source to a published package. The
  managed-config source list takes the directories it checks, production
  callers pass none, and the refusal check splits into a pure finder and
  the message thrower. The tests pass their fixture directory, and one
  case proves the retired variable is ignored.

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
  the homepage table differs from its workspace manifest, and when a
  publishable package has no homepage row at all.
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

- A result whose assistant text is not a string is rejected by the shared
  engine validator, in complete results and in incomplete evidence alike;
  an empty string is still valid text.
- **A child that never exits is a timeout:** A model CLI stopped at its
  deadline without an exit code is reported as a timeout, not as an exit
  with no code. A child that exits leaving a helper holding its output pipe
  no longer holds the result until the deadline.
- **Invalid team turns:** Reject bad results before saving completion, and
  retain earlier messages when replay finds invalid saved result content.
- **Early team review validation:** Invalid panel or callback settings are
  rejected when a callable team is created, before its members start work.
