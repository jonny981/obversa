# @obversa/core

## 0.2.15

### Patch Changes

- @obversa/api@0.2.15

## 0.2.14

### Patch Changes

- @obversa/api@0.2.14

## 0.2.13

### Patch Changes

- @obversa/api@0.2.13

## 0.2.12

### Patch Changes

- 229276b: A run's record now holds what you need to tell whether a workflow got better or worse between two runs. Each engine call records what it cost in US dollars: the engine's own figure, an estimate from a price table the runtime ships (which you can override with the `prices` run option, with no new release), or unknown. Each call also records whether it ran on the person's own plan or on an API key, and the result an engine returns to a job carries the same figure. `run:end` (across every session of a resumed record), each `dag:node` done line and each review round carry their total tokens and dollars, and name the models with no figure. A call that failed is counted too, each engine a `fallbackEngine` chain tried included, and marked `failed`, an API engine's failed call names the model it called and `api` billing, and the Claude CLI, Codex, Grok, OpenCode, Mastra and OpenAI Agents engines keep the tokens a failed call had reported; the token budget counts the tokens a failed call reported and leaves out a failed call with no tokens, so a refused call does not stop a fallback route. The calls of a merge an agent resolves count too. The `source` run option records the workflow file's path and SHA-256 on `run:start`. A SIGINT or SIGTERM writes `run:abort` before the process stops, and a `heartbeat` line every minute shows roughly when a killed run died. Each job and node records how long it took, and a `commandJob` outcome records the command, its arguments, its exit code and its duration. Every line carries the number of the session that wrote it. In a git workspace, each refine round and each node run a kickback causes records the files and lines it changed (in the node's own worktree when it has one, pass or fail), and the ids of the findings it was sent back to answer.
- Updated dependencies [229276b]
  - @obversa/api@0.2.12

## 0.2.11

### Patch Changes

- @obversa/api@0.2.11

## 0.2.10

### Patch Changes

- 3cd2d5c: On Linux, finding the processes a command started survives one of them exiting during the scan: a process that is gone by the time its environment is read is skipped, as one whose folder has already disappeared is.
  - @obversa/api@0.2.10

## 0.2.9

### Patch Changes

- @obversa/api@0.2.9

## 0.2.8

### Patch Changes

- @obversa/api@0.2.8

## 0.2.7

### Patch Changes

- @obversa/api@0.2.7

## 0.2.6

### Patch Changes

- @obversa/api@0.2.6

## 0.2.5

### Patch Changes

- Updated dependencies [909029f]
  - @obversa/api@0.2.5

## 0.2.4

### Patch Changes

- Updated dependencies [14f9f24]
  - @obversa/api@0.2.4

## 0.2.3

### Patch Changes

- @obversa/api@0.2.3

## 0.2.2

### Patch Changes

- @obversa/api@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies
  - @obversa/api@0.2.1

## 0.2.0

### Minor Changes

- A review loop can stop on a judge's word instead of a count. A `workflow()` stage's `retry` field is now `refine`, and it takes a count or `judge(seat, { cap, questions })`: a seat that reads what the reviewer found and the rounds so far, and says whether another round is worth it. A block finding always goes back, the cap always ends the rounds, and every answer is a `refine:judge` event on the record. The same `judge()` value works on a `dag()`'s `maxKickbacks`. `stopQuestions()` is the default question set.

  A tool event carries the file, command, URL or pattern it acted on, so the run's page and the console print `tool Read use src/a.ts`. The run's page prints the record in the console's own words and shows the question's input and a link above the yes and no buttons. `renderRecord()`, `summarizeRecord()` and the `obversa-record` command print a run record as Markdown a person scans.

### Patch Changes

- Updated dependencies
  - @obversa/api@0.2.0
