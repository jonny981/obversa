# @obversa/core

## 0.3.0

### Patch Changes

- eee9606: A Claude session that spans two turns now returns one answer. This happens when a command started in the background ends the first turn and the CLI starts a second turn when it finishes. Each turn ends with its own result message. The answer from the last result is the one final part, and earlier turns' answers stay as parts that are not final. The recorded tokens add up every turn. The cost keeps the last result's figure, because Claude reports cost as a running total for the session.

  A Claude CLI stream that ends without exactly one final answer now fails with the `invalid-config` kind, which is not retried on the same lane, instead of an unclassified error that a retry would repeat.

- f1b183a: The cleanup after an engine command no longer stops processes that are not part of that command.

  A stopped process could be another run, its agents, a test worker, or a command still within its time limit, which then reported a plain failed exit instead of a timeout. A busy machine made each of these more likely. Three paths reached such a process, and each is closed:

  - **A reused socket address.** On macOS, the cleanup looks for processes that still hold the command's output sockets. When the command's end of a socket closed during that search, macOS could give the socket's address to a new socket in any other process. The cleanup now checks the command's sockets again after the search, and stops only the processes that hold a socket that is still connected.
  - **A reused process id.** When a command and every process left in its group have exited, the system can give the command's process id to a new process, which can lead a process group with that same id. The cleanup took every process in that group for part of the command. The runner now reads the command's start time as it starts it. The command's process id counts only while that same process is alive. When the command leads its own group, that group counts until a different process holds the command's process id.
  - **A group signal.** `runChild` with `detached: true` signalled the child's whole process group, also after the child had already exited, for example on an abort while a helper still held the output open. It now reads the members of the child's group while the child runs and signals each one that started no earlier than the child by its own process id. After the child exits, a member read earlier that `ps` still shows once the child's output has closed gets SIGKILL when the grace ends, matched by its process id and start time, so a helper that ignores SIGTERM is still stopped.

  `stopOwnedProcessTree`, `inspectOwnedProcessTree` and `measureOwnedProcessMemory` accept `rootStartedAt`, the root's start time. On Linux and macOS, the root's process id counts only while a process with that id and start time is alive. When the root leads its own group, that group counts until a different process holds the root's id. Neither counts when `rootStartedAt` is not given. `readProcessIdentity(pid)` reads that start time; call it while the root is alive.

- fd3a11d: A CLI that the system refuses to start under load is no longer reported as a missing CLI. When starting the process fails with `EAGAIN`, `EMFILE` or `ENOMEM`, the Claude, Codex, Devin, Grok and OpenCode engines fail with a `transient` error, which can be tried again, and the message names the code, for example `the system refused to start the Claude process (EAGAIN)`. A missing executable still fails as `missing-cli`. `OwnedCommandError` and `RunChildError` carry the system error code of a process that could not start as `spawnCode`.
- 9027c75: On Linux, the cleanup after an engine command stops a helper the command started, also when the helper's parent has already exited.

  A helper that runs in its own process group is reachable through the command's process tree only while its parent is alive. The cleanup looked for the command's attempt marker once, before it stopped anything. A helper started after that look, whose parent then exited, could keep running while the cleanup reported that nothing was left. `stopOwnedProcessTree` now looks for the processes that carry the request's `attemptId` on every pass, looks once more before it reports that nothing is left, and signals each process it finds during the forced stop. The look by marker finds only processes that carry this request's `attemptId`, so a process that carries another attempt's marker and is not part of the command's tree is not stopped.

- Updated dependencies [56a7020]
- Updated dependencies [a6f95ac]
- Updated dependencies [7c0a425]
- Updated dependencies [1d951ce]
  - @obversa/api@0.3.0

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
