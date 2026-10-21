# @obversa/api

## 0.3.0

### Minor Changes

- 56a7020: The judge scores each finding and acts only when it is sure enough. Every round, each finding gets a `score` question with four levels: cosmetic, minor, impactful or blocking. The judge reports a confidence with each answer. A finding goes back to the builder only when it is scored impactful or blocking and its confidence clears the send-back bar for its level. A blocking finding has a lower bar. Every other finding goes on `minorFindings` with its level and confidence.

  The default round questions are two: `product_decision`, a yes/no on whether a person must settle a product question first, and `stop_reason`, a choice of how the run ends, with a new `none_applies` option. `holds`, `worth_doing` and `worth_another_round` are no longer asked by default. A stop answer that would end the run needs the stop bar. A person decides instead when the stop answer is under that bar, when the judge answers `none_applies`, and when any answer is under the hand-off bar. An answer with no confidence counts as unsure, so it never clears a bar.

  When the judge cannot score a finding surely enough to route it, the run pauses and asks a person to name "act" or "hold" for that finding. A finding they do not name is held. If no finding goes back, the work stands as a pass with no extra build.

  The bars are named constants in `JUDGE_CONFIDENCE`, exported with `FINDING_LEVELS` and `findingQuestions`. Their values are starting bars, not measured ones.

  The judge no longer counts or compares rounds itself. The runtime sends it, as numbers, the findings sent back this round and the round before, whether that count is falling, and which findings repeat an earlier one: the same reviewer, the same file and the same claim, with line numbers and punctuation ignored. Each finding's entry carries the brief lines it touches, or the whole brief when none match, and the diff hunks it cites. When the packet must be cut, the brief and the diffs are cut before the counts.

  In `@obversa/api`, an engine's `effective` record can carry `modelSource`: `reported` when the engine named the model that answered, `requested` when it named none and the record keeps the model id the request sent. `@obversa/engine-jev-api` uses it: when Jev reports no model, the record names the requested model instead of none.

- a6f95ac: Memory curation moves into its own package, `@obversa/rdc`. `pick` now lives there, with the candidate, question, answer, limits, thresholds and result types that drive it. It ranks candidates inside each source, shares the decision budget across reference sources so one large source cannot crowd out another, asks an injected decision function one bounded batch at a time, validates every answer, and returns the selected candidates with a record of what was asked and why. The API and the runtime no longer export it. It was never released, so nothing published changes.

  The package also adds the contract a memory source implements (`CandidateSource`, with `CandidateReadRequest`, `CandidateReadResult` and `SourceReadError`) and two Markdown sources. `knowledgeBase(dir)` emits one reference candidate per `## ` section of each note. `rules(dir)` emits one rule candidate per file and honours `applies: always` frontmatter. `pickFromSources` reads the sources, then picks over the combined candidates, and a rule source that could not list every rule makes the record's `rulesCoverage` `'incomplete'`. `MemoryCandidate` gains an optional `changedPaths`: the repository paths a candidate changed.

- 1d951ce: One seat can name its candidate models in order. Where a `dag()` node's `agent`, a `pipeline()` stage's `agent` or a seat in `review({ reviewers })` took a `TeamSeat`, it also takes `{ seat, candidates }`: the seat that runs first and the ordered alternatives behind it, each a full seat with its own engine, identity and tools. A call that fails on billing or quota runs the next candidate in the same step, and each attempt uses the candidate's own tool policy. A rate limit follows the step's `fallbackOn` policy, so it also moves to the next candidate when that policy allows it, as the default does. Any other failure ends the step exactly as before, and `agentJob`'s own `fallback` and `fallbackOn` are unchanged. When no candidate can run, the step ends on a `QUOTA` error that carries the earliest known reset, so the run's `onLimit` policy waits for that reset or pauses, as it does for a single model. An empty `candidates` list is refused, and a seat with none behaves exactly as before.

  The run records each move as a `seat:route` event: the requested identity, the selected candidate, the failure kind and the reset when one is known. What actually answered stays on `engine:usage` as before, and the recorded-model checks keep reading it.

  A run may carry an `AvailabilityStore` (`run({ availability })`; `fileAvailabilityStore(path)` is the plain-file default). When a billing or quota failure reports a proven reset, one a header or structured field stated rather than text parsed out of the error, the store remembers `(adapter, provider, model) -> until`, and a later run skips that candidate without a call and records the skip. A candidate with no proven reset is never written, a corrupt store file reads as empty with a warning, and a run with no candidate seats never touches the store.

  The distinct-family rule now reads every candidate a seat can resolve to: inside a review, no reviewer may reach the model family of another reviewer, the node's `agent` or its `fixer` over any combination of candidates, or the graph is refused before any model runs.

  In `@obversa/builtin-workflows`, a reviewer in `thresholdPanel` and `featureDelivery` is a `ReviewerSeat`, so it takes `{ seat, candidates }` the same way, and each workflow's distinct-family check reads every candidate a seat can resolve to.

### Patch Changes

- 7c0a425: Accept OpenRouter model names through the OpenCode engine, such as `openrouter/anthropic/claude-sonnet-4.5`. Record `openrouter` as the provider and derive the family from the final model name, so a Claude model remains in the Claude family across providers. Refuse OpenRouter routers such as `openrouter/openrouter/auto`, which cannot declare a fixed family.

## 0.2.15

## 0.2.14

## 0.2.13

## 0.2.12

### Patch Changes

- 229276b: A run's record now holds what you need to tell whether a workflow got better or worse between two runs. Each engine call records what it cost in US dollars: the engine's own figure, an estimate from a price table the runtime ships (which you can override with the `prices` run option, with no new release), or unknown. Each call also records whether it ran on the person's own plan or on an API key, and the result an engine returns to a job carries the same figure. `run:end` (across every session of a resumed record), each `dag:node` done line and each review round carry their total tokens and dollars, and name the models with no figure. A call that failed is counted too, each engine a `fallbackEngine` chain tried included, and marked `failed`, an API engine's failed call names the model it called and `api` billing, and the Claude CLI, Codex, Grok, OpenCode, Mastra and OpenAI Agents engines keep the tokens a failed call had reported; the token budget counts the tokens a failed call reported and leaves out a failed call with no tokens, so a refused call does not stop a fallback route. The calls of a merge an agent resolves count too. The `source` run option records the workflow file's path and SHA-256 on `run:start`. A SIGINT or SIGTERM writes `run:abort` before the process stops, and a `heartbeat` line every minute shows roughly when a killed run died. Each job and node records how long it took, and a `commandJob` outcome records the command, its arguments, its exit code and its duration. Every line carries the number of the session that wrote it. In a git workspace, each refine round and each node run a kickback causes records the files and lines it changed (in the node's own worktree when it has one, pass or fail), and the ids of the findings it was sent back to answer.

## 0.2.11

## 0.2.10

## 0.2.9

## 0.2.8

## 0.2.7

## 0.2.6

## 0.2.5

### Patch Changes

- 909029f: Every engine takes `effort`, the reasoning level a step runs at, under that one name: on the engine, on an `agentJob`, on a workflow agent stage, and on each request. An engine whose tool has a setting passes the level through it unchanged; an engine whose tool has none refuses the option with a clear error instead of ignoring it. The level a step asked for is recorded with its identity, so a record shows the effort each attempt ran at.

## 0.2.4

### Patch Changes

- 14f9f24: Engines run clean by default: your login and the repository's own setup stay in, and your own user-level settings, hooks, plugins, skills and MCP servers stay out, so a workflow behaves the same for everyone who runs it. Set `clean: false` to run the tool exactly as you run it. Grok has no clean mode and always runs on your setup; `clean: true` there throws with the reason. The engine conformance kit lets an engine declare clean mode unsupported, and a reduced declaration passes.

## 0.2.3

## 0.2.2

## 0.2.1

### Patch Changes

- Return structured feedback and a composed prompt from an interactive review surface to an agent. Human review can repeat until a person explicitly approves the work. Judges can ask a person to resolve a product decision before continuing.

  Run plain functions between workflow stages. Judge stop outcomes have the same meaning in workflows and dependency graphs.

## 0.2.0

### Minor Changes

- A review loop can stop on a judge's word instead of a count. A `workflow()` stage's `retry` field is now `refine`, and it takes a count or `judge(seat, { cap, questions })`: a seat that reads what the reviewer found and the rounds so far, and says whether another round is worth it. A block finding always goes back, the cap always ends the rounds, and every answer is a `refine:judge` event on the record. The same `judge()` value works on a `dag()`'s `maxKickbacks`. `stopQuestions()` is the default question set.

  A tool event carries the file, command, URL or pattern it acted on, so the run's page and the console print `tool Read use src/a.ts`. The run's page prints the record in the console's own words and shows the question's input and a link above the yes and no buttons. `renderRecord()`, `summarizeRecord()` and the `obversa-record` command print a run record as Markdown a person scans.
