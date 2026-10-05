# @obversa/runtime

## 0.2.13

### Patch Changes

- 13b4f6d: A resumed run carries on at the step that was interrupted, in whatever round it was, in `workflow()`, `dag()` and `loop()`, at any depth.

  - **A reviewed stage that dies during its review resumes at that review.** The build it reviews does not run again, in any round. A stage that dies during a build builds that round again. A stage not marked `retrySafe` still asks a person first.
  - **A graph inside a `dag()` node that was sent work back to resumes in that node's round.** A step that passed in an earlier round never stands in for one the run had not reached.
  - **A `loop()` carries on in the round it reached.** When its body is a graph, the graph skips the steps it finished in that round. A loop inside another loop's body does the same, in the rounds of both. A loop that passed but runs again because a file it wrote is missing writes that file again in the round it passed in, not in round 1.
  - **A finished step whose file is gone runs again.** Before a resume reuses a step, it checks that the files the step declares (a stage's `writes`, a node's `file`) are in the workspace. When one is missing, a `retrySafe` step runs again, and any other step pauses and asks a person. The record says which file was missing. Every step inside it runs again too, such as the steps of a graph or a loop's body, even when only the outer step declares the file, and even when the run stops again during that rebuild. Each later step that needs it runs again too, with every step inside it, so a review reads the rebuilt work rather than passing it on its old verdict. A loop's review runs again in the same way after its body runs again. This holds even when the run stops again after the rebuild and before the review starts. A step that its `when` condition skipped, or an optional step that failed, wrote nothing, so a resume does not look for its file.
  - **A step's record names its round only past round 1.** The record keeps each step with the round it ran in. A step that passed and declares files also lists the files it wrote, so a resume checks them from a compact `recordTo: 'auto'` record too.
  - @obversa/api@0.2.13
  - @obversa/core@0.2.13

## 0.2.12

### Patch Changes

- 6ea2ab2: A judge decides each finding with the whole picture: why the work exists, what changed, how the round went and where the rounds stand. The runtime builds this in code, with no extra model call, and a `workflow()` stage and a `dag()` give the judge the same input for the same rounds.

  - **Why.** The judge reads the brief, the use case, and the target's `desc` and `gate`. A `dag()` takes an optional `brief`, as a `workflow()` does.
  - **What.** In a git workspace, the judge reads each file changed since the run began, with the lines added and removed, and the diff around each file and line a finding cites. When the target names a file, the judge also reads its content.
  - **How.** The judge reads each check step's command, its status and, when it did not pass, its output. It reads the verdicts of the target's own goal check, and for each finding who raised it, its severity, and the other reviewers' votes and reasons when the panel synthesised.
  - **When.** The judge reads the round, the cap and whether this is the last round, every earlier round with its own decision on each finding and its reason, and the files changed since the last round.
  - **A size limit.** What the judge reads is kept to 50000 characters, counted as JSON. Set another limit with `run(job, { judgeContextLimit })`. The longest parts are cut first, and the findings to decide are never cut. The judge is told what the limit cut, and each `refine:judge` event records the size of what the judge read and the same list of cuts.

  The judge's prompt keeps the `{ state, questions }` shape. Its `state` holds four labelled parts, `why`, `what`, `how` and `when`, always in that order, then `cut` when the size limit cut something. The questions and the routing are unchanged.

- 229276b: A run's record now holds what you need to tell whether a workflow got better or worse between two runs. Each engine call records what it cost in US dollars: the engine's own figure, an estimate from a price table the runtime ships (which you can override with the `prices` run option, with no new release), or unknown. Each call also records whether it ran on the person's own plan or on an API key, and the result an engine returns to a job carries the same figure. `run:end` (across every session of a resumed record), each `dag:node` done line and each review round carry their total tokens and dollars, and name the models with no figure. A call that failed is counted too, each engine a `fallbackEngine` chain tried included, and marked `failed`, an API engine's failed call names the model it called and `api` billing, and the Claude CLI, Codex, Grok, OpenCode, Mastra and OpenAI Agents engines keep the tokens a failed call had reported; the token budget counts the tokens a failed call reported and leaves out a failed call with no tokens, so a refused call does not stop a fallback route. The calls of a merge an agent resolves count too. The `source` run option records the workflow file's path and SHA-256 on `run:start`. A SIGINT or SIGTERM writes `run:abort` before the process stops, and a `heartbeat` line every minute shows roughly when a killed run died. Each job and node records how long it took, and a `commandJob` outcome records the command, its arguments, its exit code and its duration. Every line carries the number of the session that wrote it. In a git workspace, each refine round and each node run a kickback causes records the files and lines it changed (in the node's own worktree when it has one, pass or fail), and the ids of the findings it was sent back to answer.
- Updated dependencies [229276b]
  - @obversa/api@0.2.12
  - @obversa/core@0.2.12

## 0.2.11

### Patch Changes

- b24059a: The same review intent behaves the same whether you write it with `workflow()`, `dag()` or `loop()`: the same outcome, the same number of builds, the same judge consultations and the same judge input.

  - **`refine: N` means N refinements in every form.** A refinement is one more build after the first, with the review's findings, so `refine: N` allows N+1 builds and `refine: 0` allows one. A judge's `cap: N` changes the same way: at most N refinements, and the judge reads the review of the last build too. Each review of the same build is the same round, so a second reviewer, or a request the judge lets stand, does not use up the cap.
  - **A reviewed stage that is also sent work back to has one count.** Its own reviews and the send-backs from later stages share its refinements and its judge's rounds in one run. With `refine: 1`, a review that rejects the first build uses the one refinement, so a later send-back fails the run.
  - **A stage a person reviews consults its judge.** With `refine: judge(seat)`, each refusal goes to the judge, in both forms. While the person has not answered, the run pauses and the judge waits; an answer that arrives on a resume goes to the judge then.
  - **A writer that returns the reviewed work unchanged after feedback fails at once,** in every form. An agent step with `workspaceMode: 'write'` that runs after a review sent the work back, and leaves the files as they were, fails the step. Staging or committing the same files is not a change. When a stage declares `writes`, or a `dag()` node names its `file`, only those files count, even when Git ignores them: a change to any other file is not a change to the work.
  - **A reviewed stage runs every refinement its `refine` or judge allows,** as a `dag()` and a `loop()` do.
  - **A judge that stops the rounds fails the work with its findings.** The failed step keeps the last review's findings, and its summary gives the judge's reason, in every form.
  - **A `loop()` whose review rejects the last round `max` allows fails** with that review's findings (exit code 1), as a `dag()` does when its send-backs run out. A loop that reaches `max` with no review, stalls, or reaches `maxReviewRestarts` still ends `exhausted`.
  - **`agree` works on a stage a panel reviews,** as on a `panel:` stage and `reviewPanel({ pass })`.
  - **A node declares the nodes it sends work back to.** In a `dag()` or `pipeline()`, list them in `acceptsKickbackTo`; a send-back to a node not listed fails the sender with an error that names both nodes. A `workflow()` stage's `sendsBackTo` declares its target for you. The built-in teams declare theirs.
  - **A judge's state belongs to one run, and survives a resume.** Running the same workflow twice starts the judge with no rounds and no skipped findings. Once work has been sent back, by a review or by a goal check's unmet requirement, in a `workflow()` or a `dag()`, the record keeps the round count, the judge's earlier rounds, skipped findings and product answers. A resume after a pause, a stopped run, a worker that died or a run that failed counts on from the same round, so the refinements already used stay used. What a judge skipped reaches every node that can send work back to the target, and a send-back's feedback is read once. A step the resume reuses keeps the models its answers came from, so a later panel that needs a different model family still checks them.
  - **A `loop()` with a graph body passes its review to the graph.** Each step's first run in a round reads the loop's last review as `ctx.lastReview`. A step that fails with an error a retry cannot fix fails the graph with that error, so the loop stops there, as it does around the step alone.
  - **A judge in a `dag()` reads what a judge in a `workflow()` reads.** Give the dag a `useCase` and the target node a `file`, and its judge sees the use case, the current draft, and the size of each earlier round's change. A send-back from a later `workflow()` stage gives the stage's judge the same.
  - **The judge runs inside the time limit of the node that sent the work back,** in a `dag()` as in a `workflow()`, and each `refine:judge` event names the target and the round.
  - @obversa/api@0.2.11
  - @obversa/core@0.2.11

## 0.2.10

### Patch Changes

- Updated dependencies [3cd2d5c]
  - @obversa/core@0.2.10
  - @obversa/api@0.2.10

## 0.2.9

### Patch Changes

- 9b9e01c: A loop that runs out of rounds, or stalls, before its review passes fails the graph around it. In a `dag()`, a required node that ends `exhausted` fails the graph like a plain failure: the run exits non-zero, nodes that need it do not run, and the summary names the node and why it ran out. A `workflow()` stage reviewed by a panel or a person that runs out of rounds fails the run the same way. The exhausted outcome keeps the last review's findings in its `revision`, so the failure says what was still wrong. An optional node that ends `exhausted` still does not fail the graph, and a later node with `when: failed(name)` on it runs, so its recovery path is not skipped.
  - @obversa/api@0.2.9
  - @obversa/core@0.2.9

## 0.2.8

### Patch Changes

- afdce94: A workflow stage can check the brief was met before its reviews. Set `goal` to a seat, ideally from another model family than the builder's, on a stage a panel reviews. Each round, the seat reads the brief, the stage's `desc` and `gate`, and the work, and marks each requirement met or unmet with evidence. Any unmet requirement goes straight back to the builder with its evidence: the reviewers do not run that round, and a judge does not decide it, so a requirement in the brief is never skipped as polish. The check runs every round, because a fix for a reviewer can break a requirement. Each round adds a `goal:check` event to the record with every requirement, its verdict and its evidence. In a `dag()`, `goalCheck(seat, { target, text })` is the same check as one node between the build and the review, and a judge on its target does not decide the unmet requirements.
- afdce94: A judge decides every finding, a block included, so a run with no cap always has someone deciding when to stop. A reviewer that tags every finding `block` cannot keep the rounds going on its own. The judge skips a block only when the case it names is outside how the work is really used, or the same class of finding keeps returning after it was answered; otherwise it acts on it. A skipped block appears in the `refine:judge` event with the judge's reason, and the next round's reviewers are told it was skipped and why. At a cap, a block in the last round goes to the judge too, and a skip lets the work stand with the block recorded in `openFindings`. Without a judge nothing changes: a plain number on `refine` or `maxKickbacks` still sends a block back.
  - @obversa/api@0.2.8
  - @obversa/core@0.2.8

## 0.2.7

### Patch Changes

- da3fb0f: A run after an interrupted one starts cleanly when the earlier run left a fork branch behind. `isolated()` and `tournament()` skip a branch name that already exists and take another, as `dag()` does, and the old branch stays as it was so you can still recover its work. A reviewer's or writer's reply can show code, a JSON example or a braced aside before its answer: the decision is the last JSON object in the reply with a `status` of `pass` or `revise` and a non-empty `summary`, so such a reply reads as its final answer.
- 9721b9c: A judge decides every finding, a block included, so a run with no cap always has someone deciding when to stop. A reviewer that tags every finding `block` cannot keep the rounds going on its own. The judge skips a block only when the case it names is outside how the work is really used, or the same class of finding keeps returning after it was answered; otherwise it acts on it. A skipped block appears in the `refine:judge` event with the judge's reason, and the next round's reviewers are told it was skipped and why. At a cap, a block in the last round goes to the judge too, and a skip lets the work stand with the block recorded in `openFindings`. Without a judge nothing changes: a plain number on `refine` or `maxKickbacks` still sends a block back.
  - @obversa/api@0.2.7
  - @obversa/core@0.2.7

## 0.2.6

### Patch Changes

- c955f03: The run page answers a judge's product decision, not only approvals. A judge's product decision gets a box for your written decision and a Send button, so you answer it without posting JSON by hand. Any other question shows a labelled field for each field its answer needs. A question that accepts more than one shape of answer lets you pick the shape first. Approvals keep their Yes and No buttons and the note. `/state` sends each waiting question's `responseSchema`, and what you type stays in the form while the page polls and while other questions arrive or are answered. When the run refuses an answer, the reason stays on the page until you send again.
  - @obversa/api@0.2.6
  - @obversa/core@0.2.6

## 0.2.5

### Patch Changes

- 909029f: Every engine takes `effort`, the reasoning level a step runs at, under that one name: on the engine, on an `agentJob`, on a workflow agent stage, and on each request. An engine whose tool has a setting passes the level through it unchanged; an engine whose tool has none refuses the option with a clear error instead of ignoring it. The level a step asked for is recorded with its identity, so a record shows the effort each attempt ran at.
- 2720fd4: A judge needs no cap. With `judge(seat)`, the judge ends the rounds itself, and a run ends when the judge stops it or the review passes. When the judge decides each finding, which it does by default, acting on any finding runs another round and skipping every finding passes; only a `product_decision` answer still asks a person. When it judges whole rounds only, or answers no finding, its whole-round answer routes: `holds` or `over_polishing` passes, `not_converging` fails, and `product_decision` asks a person. A cap is an optional backstop. After the last review it allows, the judge is asked once more and told it is the last round, so its answer, not the cap, decides how the run ends. If it lets the work stand, the step passes and its open findings are on the outcome as `openFindings`. Any other answer fails with the cap named in the reason, and a person asked at that point has their answer recorded, but no further round runs. This holds for a `workflow()` stage's `refine` and a `dag()`'s `maxKickbacks` alike.
- f6ed5e7: A review panel can merge its reviews into one list before anyone acts on them. Set `synthesise` on a `workflow()` stage with several reviewers, a `panel:` stage, or `reviewPanel()`. Findings that name the same problem become one finding with the strongest severity, crediting every reviewer who raised it. Each reviewer then votes once on the others' findings: agree, disagree, or a better fix. A finding is dropped when the reviewers who disagree outnumber those who raised it, agreed, or offered a better fix; a better fix most voters back replaces the original; a tie stays marked disputed for the judge. A passing reviewer's findings are kept. The record shows who raised each finding, who agreed, and what was dropped and why.
- Updated dependencies [909029f]
  - @obversa/api@0.2.5
  - @obversa/core@0.2.5

## 0.2.4

### Patch Changes

- 14f9f24: The judge now decides each review finding (act or skip, with a reason): the builder gets only the findings worth acting on, skipped findings and their reasons reach the next round's reviewers, and a round where every finding is skipped ships. A chosen `continue` runs another round within the cap, and the judge's event records the route and the rule behind it. A person's answer to a product decision goes to the builder as the next round. A run deletes the branches of forks that ended without landing, recording any commits it threw away, keeps the fork of an interrupted attempt, a winner that could not merge, and a step that threw, and logs a cleanup that fails.
- Updated dependencies [14f9f24]
  - @obversa/api@0.2.4
  - @obversa/core@0.2.4

## 0.2.3

### Patch Changes

- 768c936: A workflow stage's reviewers now get the stage's task and gate in their instructions, the same two sentences the writer gets. A team's callback review now posts its question to the run's callbacks client and reads the answer when the run resumes: a refusal fails the review with the person's note, and members that finished do not run again.
  - @obversa/api@0.2.3
  - @obversa/core@0.2.3

## 0.2.2

### Patch Changes

- `run(job, { resume: true })` now skips a `dag()`'s finished nodes from the record, as it already did for a `workflow()`'s stages. A node can declare `retrySafe: true` to run again after an interruption without a person's answer. An interrupted node that ran in its own worktree asks before any new worktree exists: approve runs it again from the start, refuse stops the run, and its leftover worktree is never merged. `recordedJudge(path)` from `@obversa/runtime/testing` replays recorded judge answers for proofs and offline runs.
  - @obversa/api@0.2.2
  - @obversa/core@0.2.2

## 0.2.1

### Patch Changes

- Return structured feedback and a composed prompt from an interactive review surface to an agent. Human review can repeat until a person explicitly approves the work. Judges can ask a person to resolve a product decision before continuing.

  Run plain functions between workflow stages. Judge stop outcomes have the same meaning in workflows and dependency graphs.

- Updated dependencies
  - @obversa/api@0.2.1
  - @obversa/core@0.2.1

## 0.2.0

### Minor Changes

- A review loop can stop on a judge's word instead of a count. A `workflow()` stage's `retry` field is now `refine`, and it takes a count or `judge(seat, { cap, questions })`: a seat that reads what the reviewer found and the rounds so far, and says whether another round is worth it. A block finding always goes back, the cap always ends the rounds, and every answer is a `refine:judge` event on the record. The same `judge()` value works on a `dag()`'s `maxKickbacks`. `stopQuestions()` is the default question set.

  A tool event carries the file, command, URL or pattern it acted on, so the run's page and the console print `tool Read use src/a.ts`. The run's page prints the record in the console's own words and shows the question's input and a link above the yes and no buttons. `renderRecord()`, `summarizeRecord()` and the `obversa-record` command print a run record as Markdown a person scans.

### Patch Changes

- Updated dependencies
  - @obversa/api@0.2.0
  - @obversa/core@0.2.0
