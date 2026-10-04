# @obversa/runtime

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
