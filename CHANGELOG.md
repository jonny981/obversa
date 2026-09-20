# Changelog

All notable changes to the Obversa packages. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org).

The runtime package (`@obversa/runtime`) tracks the repository tag. Every
other published package tracks its own version independently of it.

## [Unreleased]

## [1.0.0] - 2026-09-20

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
- **Type declarations for the review packages:** `@obversa/surface-decision`
  and `@obversa/surface-diff` ship declaration files generated from their
  JSDoc, with a `types` condition on every export entry. A TypeScript
  reader importing either package resolves types instead of failing with
  an implicit-any import. The clean-consumer check imports both strictly,
  so the declarations cannot be dropped without failing the check.
- `@obversa/runtime` 1.0.0: stored graph plans, bounded node attempts,
  durable events and artifacts, restartable execution, workspace checks,
  Callback Gates, and proof-bound decisions.
- `@obversa/api` 0.1.0 and `@obversa/core` 0.1.0: the engine and memory ports
  every adapter implements, and the helpers the runtime and the plugins share.
- Six engine plugins at 0.1.0, one per way of reaching a model, all returning
  typed engine results: `@obversa/engine-claude-agent-sdk`,
  `@obversa/engine-claude-cli`, `@obversa/engine-codex-cli`,
  `@obversa/engine-grok-cli`, `@obversa/engine-opencode-cli` and
  `@obversa/engine-anthropic-api`.
- `@obversa/runner` 0.1.0: local worker supervision with stored run inputs,
  bounded restart, workspace leases, status, and process cleanup within the
  reported platform capability. Worker stdout and stderr share a fixed
  1,000,000-byte cap; excess output can fail the run with `OUTPUT_LIMIT`.
- `@obversa/runner`: `resumeSupervisedRun` and `ResumeSupervisedRunOptions`
  reopen an exact recorded graph pause using the stored definition and run
  limits. The host action policy runs again before node effects.
- Action-policy `wait` decisions record a graph pause with its reason and
  request. A `deny` decision records a failed node with `DENIED`.
- `@obversa/core/command`: optional `ownerId` on command and cleanup requests,
  inherited `OBVERSA_RUN_OWNER` markers, `commandCleanupCapability`,
  `CommandCleanupCapability`, and `inspectOwnerMarkedProcesses` for process
  ownership and cleanup inspection.
- `@obversa/memory-simple` and `@obversa/memory-git` at 0.1.0: replaceable
  memory over the port in `@obversa/api`, with conformance tests.
- `@obversa/surface-decision` 0.1.0 and `@obversa/surface-diff` 0.1.0: local
  review surfaces over public package contracts.
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
  reviewedBy, sendsBackTo, retry })` from `@obversa/runtime` declare a team
  as an ordered list of stages, each a block of nouns, and compile it to
  the runtime's graph: a reviewed stage runs again with the findings, a red
  command or a rejected review goes back to the stage it names, `retry`
  bounds the stage that repeats, `writes` bounds what a stage may write,
  `person(question)` is a role a person fills, and `post.always` runs with
  the record.
- **Seats from the engine plugins:** `claude(model)`, `codex(model)` and
  `opencode(model, { executable })` return a seat with the identity the
  plugin records. The Claude and Codex seats start able to write files; the
  OpenCode seat starts able to read and search, and takes `tools` to widen
  that.
- **Briefs as markdown files:** `briefFromFile(path)` reads a brief beside the
  code; its front matter may carry `files`, the paths the brief expects
  written.
- The three team examples are written in the workflow form and shrink by
  more than half; the explicit functions stay.
- A reviewer that writes a declared file it does not own is a boundary
  breach: the panel records it as a blocking error and does not count it
  as a vote.
- **Feature delivery in eleven steps:** `featureDelivery`, from
  `@obversa/builtin-workflows`, researches the brief and writes the
  requirements and the plan, each reviewed; writes the
  declared `testFiles` before any code; implements until the test command
  exits 0 and the reviewers accept; runs the tests once more; records an
  approval carrying the run's marker; and writes the evidence and the
  learning from the record. A rejected plan, test or implementation goes
  back to the step that owns it, each target with its own `maxKickbacks`
  budget. Requirements carry `REQ-n` ids and the plan step compares them
  with the plan's checks; a note that comes back unchanged after a review
  fails plainly.
- **Reading a reviewer's decision:** a team reads a reviewer's decision
  file when the caller names one, and otherwise reads the first JSON object
  in the reply. A reply with no decision in either is asked for once more;
  a second one stops the review with a plain summary and sends nothing to
  the writer.
- `outcomeFromAgentText` is exported from `@obversa/runtime/workflow-support`:
  the parser that
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
- **Bounded child processes:** `@obversa/core` exports one function,
  `runChild`. It runs a child to a deadline and returns a typed
  result: the exit code, the captured bytes, and timed-out and aborted flags.
  Timeout and abort flags depend on the recorded exit time and the first
  accepted stop callback. Standard input is closed after the optional input.
  Output drains until the pipes close or a 500 ms grace expires after the exit
  hook completes. Parent-exit cleanup attempts to send SIGTERM to registered
  children; it does not verify that they stop. Every git and
  engine spawn in the runtime, the engine command runner, the Codex adapter
  and the Git memory adapter run through it.

- **Run boundaries are events:** every run that begins emits one root `run:start`
  before it dispatches work, and one root `run:end` before it returns, however
  it ends. A run whose process is killed leaves the start without an end. The
  end event carries the same outcome and token usage as `RunResult`; both
  events carry the run id and record path when present.
- **Supervised progress shows the run's own boundaries:** the recent-activity
  lines a supervised run prints include `▸ run` when it starts and
  `◂ run <status>` with its running token total when it ends, beside its loop
  and stage lines.
- **Gates wait in two ways:** attended, when a person is at the run, the
  process waits in place for the answer; unattended, the run records the
  question and exits, and a scheduled `resume: true` carries on when the
  answer has arrived or exits again with the same recorded pause and asks
  nothing a second time. The record is the same in both modes.
- **Search a local Markdown corpus before grounding it:**
  `@obversa/search-markdown` returns ranked passages with file paths and line
  ranges. Its read-only `Memory` view lets callers give only the selected files
  to `ground`, then pass the bounded result from `curate` into a job. Search is
  local and lexical, with no index, embedding service, or network call.
- **Webhook notifications:** `@obversa/notify-webhook` posts one message per
  interesting run event to a URL the caller supplies. `webhookNotifier({ url })`
  returns an `onEvent` handler for `run`, and six moments each become one
  message: the run started, a stage finished, a review sent work back, the run
  is waiting for a person, the run finished, the run failed. The body carries a
  `text` field, which is the field a Slack, Discord or Teams incoming webhook
  renders, so those three need no code of their own; the rest of the body is
  structured for a relay. Two messages carry the information rather than a
  pointer to it: the paused message names the run's page on its own line, and
  the sent-back message carries the reviewer's reason on its own line. A review
  sending work back is posted for both shapes the runtime produces it in: a
  graph kickback, which names the stage it went back to, and a loop review the
  loop will act on, which sends the work back to the loop's own body. A stage
  waiting for a person is reported as paused rather than as a stage finishing,
  which is the only message sent about the wait where the run stays up for the
  answer rather than ending on it. The paused message asks the person's own
  question, taken from the field the gate carries it in. A
  failure is reported from the event that ends the run and never from the
  `error` event, because a loop can emit `error` in one iteration and pass in
  the next. A notification that cannot be delivered reaches `onError` and never
  fails the run, and messages are posted in the order the run made them. The
  run's own news comes from the first graph or loop it reports, whose own
  ending is the run's ending at whatever depth it sits, so a job finishing
  inside a loop's iteration is not mistaken for the run and a graph wrapped by
  a workflow's `post.always` still reports its stages; news from inside a run,
  a stage finishing or a review sending work back, is not filtered by depth.
  Await `done()` after the run so the last message is not lost.
- **Workflow resume:** `run(job, { recordTo: path, resume: true })` resumes
  a declarative workflow from its own record instead of truncating it. The
  runtime seeds the recorded completions into the shared run state under
  the exported `RESUME_STAGE_OUTCOMES` key, and the workflow guard reads
  that state, never the record file.
  Stages whose passing completion is recorded under the same declared
  shape are skipped; a changed brief restarts from the top. For a job built
  with `workflow()`, a stage that was mid-flight when the process died runs
  again only when it carries `retrySafe: true`; otherwise the run pauses
  and asks a person to reconcile it, so uncertain work is never repeated
  silently. A resume that finds the gate still pending unanswered exits
  with the still-waiting code at once: it reads the record, observes the pending
  request through the callbacks client, and sends nothing - no model
  call, no second notification. Two processes resuming one record at once
  is out of scope.
- **Git as the reasoning record:** `@obversa/memory-git` opens a second
  thing beside its store, `openReasoningRecord`, and `@obversa/api` names
  the contract it implements. The store uses Git as a place to keep files;
  the record uses Git as the record of why a change was made. It writes no
  commit of its own: a stage that opts in is already run in its own
  worktree and committed there, and the record supplies that commit's
  message, so the reasoning sits on the change it explains rather than in
  a note beside it. Feed writer events to the record through `observe`. It keeps
  events under the supplied path, or binds to the first event path containing
  the stage name; supply the full path when that name appears in more than one
  branch. Composition that fails or returns nothing usable still
  yields a message built from the outcome. A stage that changed nothing
  produces no commit and no body.
- **Shared model identity for OpenCode and recorded review answers:**
  `@obversa/api` exports `modelIdentity`, which derives the model family and any
  explicit provider prefix from a model string, rejecting malformed strings and
  strings with no readable family. OpenCode derives its seat identity through
  it, and declarative workflow review gates use it to reject unreadable tagged
  answers and family collisions between writers and reviewers. The
  recorded-answer check does not verify that reviewers used different families
  from one another.
- **See what a run is spending while it runs:** a usage line reports the
  run's running total beside the call's own, as
  `<model>: 120/40 tok (run 1200/400 tok, 900 tok from cache)`. Pass the totals
  you already hold to `formatEvent(event, totals)`; omitting them changes
  nothing about what it prints. `StatsSnapshot` gains run-wide
  `totalCacheReadInputTokens` and `totalCacheCreationInputTokens`, kept
  separate because one is what was served from cache and the other what was
  paid to build it. A total that is missing calls says so, in the same words
  a single call uses: `usage unknown on 3 calls`.
  The monitor's `/state` carries the same totals, and `usageSummary` beside
  them: the line already written out, so nothing formats it twice.
- **Watch a run without writing a formatter:** `@obversa/runtime` exports
  `formatEvent`, which turns one event from `onEvent` into the line a person
  reads. Every use-case example prints its run through it.
- **Use-case examples outside software delivery:** Three complete
  `workflow()` files under `examples/use-cases/`, one per kind of work:
  grooming a backlog so a person can rank it, reading a contract against a
  playbook so a lawyer can send redlines, and translating an article
  against a glossary so a person can publish it. Each ends at a person, so
  a run stops before anything is sent or filed, and each page shows what
  one real run of that file printed, its events and its usage lines
  included. The grooming run did not finish: a reviewer from another
  family sent the stories back three times with real problems and the loop
  reached its allowance and stopped, which is on its page because a loop
  that halts rather than passing on unfinished work is the loop behaving.
- **Recorded engine usage:** The runtime exports `RECORDED_ENGINE_USAGE`,
  the shared state key under which an agent job records each engine usage
  event beside its job path, and the declarative panel guard reads
  that state.
- **A panel checks what actually answered:** A panel that requires its reviewers to differ
  in model family from the writers it reviews compares what actually
  answered against what each seat declared. The runtime records each engine
  usage event beside its job path, and the panel refuses when a recorded
  answer belongs to a family it must differ from, or when an answer carries
  no readable family at all. The refusal names the seats, their declared
  families and the answers.
  An agent job built with `recordAs: { role, stage }` records its answers
  with the seat's role and stage. The gate compares recorded seats, never
  job paths. A refusal is a `LoopError` the record keeps.
- **Workspace access ceilings:** a seat's workspace mode is
  a ceiling. An approval never adds a capability the mode withholds, and a
  bypass never exceeds it. An adapter that cannot express the declared access
  refuses before a model runs. Read workspace requests must declare tools;
  Claude, Grok and OpenCode also require a file-reading tool. The permission
  rules must allow access to the files under review. The engine conformance kit
  runs the `none`, `read` and `write` modes against every shipped adapter.
  Unsupported optional conformance cases are listed in
  `EngineAdapterConformanceReport.unsupported`, not counted as passes. Each
  workspace-mode case must either expose the expected access or refuse before a
  model call. `@obversa/core/claude-tools` exports `claudeToolOptions`, the helper
  the two Claude adapters share.

### Changed

- **Review-loop status typing:** `ConvergenceStatus` is a type alias rather
  than an interface, and `EngineReceiptRejection` is exported, so a consumer
  can name the rejection element type directly instead of by indexed access.
- **Tarball test selection:** Run the two package-command integration tests
  with `OBVERSA_TEST_REAL_PACK=1 pnpm test:tarballs`. The default command skips
  those tests; `verify:d15` enables them.
- **Review identity records:** Primary and fallback node calls record their
  requested adapter, provider, model family, and model, plus any valid reported
  identity, before fallback or node completion can proceed. Unknown reported
  identities are recorded as null. Recording failures stop execution; recovery
  adds a record with unknown requested and reported identities for an
  interrupted node attempt. Live preflight retains reported identities from
  validated results or recognised error evidence. Review completion
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
  An auth failure recorded without a provider recovers one from its lane, and an
  ambiguous recovery refuses before work with `ENGINE_IDENTITY_UNRESOLVED`.
- `LANE_DEAD_FAILURES` from `@obversa/runtime` includes `quota`, and the wording
  rules that classify a provider's message are: usage
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
  error together.
- A timeout is decided by the deadline against the moment the child's exit
  was observed. Teardown work after the exit never counts.

- **Workflow support stays on its public subpath:** `@obversa/runtime/workflow-support` exports the recipe helpers and their input types; import `dag` from `@obversa/runtime`.
- **One API contract package:** `@obversa/api` owns the engine and memory
  ports, their conformance kits, `EngineError`, and `modelIdentity`. It also
  owns shared graph, event, artifact, workspace, callback, proof, and run
  definition contracts and validation; runtime keeps execution and storage.
  `@obversa/core` owns bounded child processes and command execution.
  `@obversa/runtime` owns memory mechanics and the `workflow`, `stage`,
  `person`, and `briefFromFile` builders. The three ready-made recipes live
  in `@obversa/builtin-workflows`. The review packages are
  `@obversa/surface-decision` and `@obversa/surface-diff`; the CLI and Agent
  SDK adapters are `@obversa/engine-codex-cli` and
  `@obversa/engine-claude-agent-sdk`.
- **`command-kickback` example:** the two review gates and their descriptions
  state what each review node establishes ("has returned a verdict") rather
  than what a reviewer did. The page that quotes the file follows it.

### Fixed

- **Cross-family seat check:** An OpenCode seat derives its model family from the model name, taking the first hyphen-delimited segment after the provider prefix, so `opencode('anthropic/claude-sonnet-4-5')` declares the family `claude`. In a `workflow()`, a stage's seat and each of its reviewers must declare a different model family from one another, or the workflow is refused before any model runs. This includes seats naming one model through two adapters. The check compares what each seat declares about itself.
- Public workflow examples resolve their direct-run guard through real paths,
  so a symlinked directory cannot make a copied example exit successfully
  without running or printing its outcome.
- **OpenCode managed-config seam:** The OpenCode plugin does not read the
  `OPENCODE_TEST_MANAGED_CONFIG_DIR` environment variable, so an ambient
  variable cannot add a config source to a published package. The
  managed-config source list takes the directories it checks, production
  callers pass none, and the refusal check splits into a pure finder and
  the message thrower. The tests pass their fixture directory, and one
  case proves that variable is ignored.
- **Concurrent worktree registration:** Worktrees for isolated DAG nodes,
  `isolated()` jobs and tournaments are added and removed one at a time per
  repository within the runtime process. Linked checkouts share the
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
  under the C locale and UTC, so a worker with a restricted environment and a
  host watchdog spells one start time one way. A recorded identity merges
  with the same live process rather than splitting into two entries, and live
  status matches on a non-C host and across a timezone boundary.
- **Unresolved merge markers:** Reject engine resolutions that retain an ordered
  conflict block with matching opening, separator, and closing marker widths
  of seven or more characters. Abort the merge and name the file in a typed
  error without creating a merge commit. Standalone document underlines are
  permitted. Custom conflict marker widths below seven remain undetected.
- **Gate and ratchet command timeouts:** Commands reported with `timedOut: true`
  fail gates even when they exit zero, and ratchets return before parsing
  metrics or writing a baseline. Timeout messages name the limit when
  `timeoutMs` was supplied.
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
  With safe cleanup, a released lease and an existing workspace anchor, the
  runner can record a pause carrying that code so the work can be reopened; if
  any of those conditions is missing, it fails.
- **Paused runner budgets:** Freeze elapsed time at a settled pause until the
  next stored worker launch. Resume checks before that launch spend no elapsed
  budget; engine checks inside the worker, earlier execution and restart backoff
  remain spent across resumes and worker replacements.
- **Usage after worker crashes:** Preserve measured node totals as partial
  usage when calls lack receipts. Token totals are measured lower bounds,
  and `unknownCalls` keeps crash gaps visible after successful retries.
- **Recorded runner results:** A stop or timeout by itself does not replace a
  durably recorded worker result. Returning that result requires successful
  cleanup, lease release, any required pause-anchor capture, and storage reads
  and writes.
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
- **Stopped child outcomes:** A model CLI stopped at its deadline
  can report a timeout without an exit code. Cancellation, cleanup and protocol
  errors can take precedence; a completed answer can retain timeout information.
  After a child exits, completion waits for cleanup and output-pipe closure,
  with a 500 ms drain grace after the exit hook completes.
- **Invalid team turns:** Reject bad results before saving completion, and
  retain earlier messages when replay finds invalid saved result content.
- **Early team review validation:** Invalid panel or callback settings are
  rejected when a callable team is created, before its members start work.

- **The reasoning record scrubs its finished message.** The commit subject and
  body a reasoning record composes, fallback messages included, are scrubbed
  for recognised credential patterns before the body is truncated. This
  removes patterns the shared scrubber knows, including a value split across
  captured chunks. It is not a guarantee that a message carries no private
  text: the scrubber recognises patterns, it does not read meaning.
- The Claude CLI adapter classifies auth, model-unavailable, transient and
  invalid-config failures instead of reporting them as unknown.
