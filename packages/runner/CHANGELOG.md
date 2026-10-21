# @obversa/runner

## 0.3.0

### Patch Changes

- f1b183a: The cleanup after an engine command no longer stops processes that are not part of that command.

  A stopped process could be another run, its agents, a test worker, or a command still within its time limit, which then reported a plain failed exit instead of a timeout. A busy machine made each of these more likely. Three paths reached such a process, and each is closed:

  - **A reused socket address.** On macOS, the cleanup looks for processes that still hold the command's output sockets. When the command's end of a socket closed during that search, macOS could give the socket's address to a new socket in any other process. The cleanup now checks the command's sockets again after the search, and stops only the processes that hold a socket that is still connected.
  - **A reused process id.** When a command and every process left in its group have exited, the system can give the command's process id to a new process, which can lead a process group with that same id. The cleanup took every process in that group for part of the command. The runner now reads the command's start time as it starts it. The command's process id counts only while that same process is alive. When the command leads its own group, that group counts until a different process holds the command's process id.
  - **A group signal.** `runChild` with `detached: true` signalled the child's whole process group, also after the child had already exited, for example on an abort while a helper still held the output open. It now reads the members of the child's group while the child runs and signals each one that started no earlier than the child by its own process id. After the child exits, a member read earlier that `ps` still shows once the child's output has closed gets SIGKILL when the grace ends, matched by its process id and start time, so a helper that ignores SIGTERM is still stopped.

  `stopOwnedProcessTree`, `inspectOwnedProcessTree` and `measureOwnedProcessMemory` accept `rootStartedAt`, the root's start time. On Linux and macOS, the root's process id counts only while a process with that id and start time is alive. When the root leads its own group, that group counts until a different process holds the root's id. Neither counts when `rootStartedAt` is not given. `readProcessIdentity(pid)` reads that start time; call it while the root is alive.

- Updated dependencies [fd3a11d]
- Updated dependencies [eee9606]
- Updated dependencies [92facaa]
- Updated dependencies [56a7020]
- Updated dependencies [d9e9fc8]
- Updated dependencies [a6f95ac]
- Updated dependencies [8a40811]
- Updated dependencies [7c0a425]
- Updated dependencies [f1b183a]
- Updated dependencies [8fe9940]
- Updated dependencies [1d951ce]
- Updated dependencies [fd3a11d]
- Updated dependencies [9027c75]
  - @obversa/runtime@0.3.0
  - @obversa/core@0.3.0
  - @obversa/api@0.3.0

## 0.2.15

### Patch Changes

- Updated dependencies [f52eb86]
- Updated dependencies [063af5a]
  - @obversa/runtime@0.2.15
  - @obversa/api@0.2.15
  - @obversa/core@0.2.15

## 0.2.14

### Patch Changes

- Updated dependencies [512249e]
  - @obversa/runtime@0.2.14
  - @obversa/api@0.2.14
  - @obversa/core@0.2.14

## 0.2.13

### Patch Changes

- Updated dependencies [13b4f6d]
  - @obversa/runtime@0.2.13
  - @obversa/api@0.2.13
  - @obversa/core@0.2.13

## 0.2.12

### Patch Changes

- Updated dependencies [6ea2ab2]
- Updated dependencies [229276b]
  - @obversa/runtime@0.2.12
  - @obversa/api@0.2.12
  - @obversa/core@0.2.12

## 0.2.11

### Patch Changes

- Updated dependencies [b24059a]
  - @obversa/runtime@0.2.11
  - @obversa/api@0.2.11
  - @obversa/core@0.2.11

## 0.2.10

### Patch Changes

- Updated dependencies [3cd2d5c]
  - @obversa/core@0.2.10
  - @obversa/runtime@0.2.10
  - @obversa/api@0.2.10

## 0.2.9

### Patch Changes

- Updated dependencies [9b9e01c]
  - @obversa/runtime@0.2.9
  - @obversa/api@0.2.9
  - @obversa/core@0.2.9

## 0.2.8

### Patch Changes

- Updated dependencies [afdce94]
- Updated dependencies [afdce94]
  - @obversa/runtime@0.2.8
  - @obversa/api@0.2.8
  - @obversa/core@0.2.8

## 0.2.7

### Patch Changes

- Updated dependencies [da3fb0f]
- Updated dependencies [9721b9c]
  - @obversa/runtime@0.2.7
  - @obversa/api@0.2.7
  - @obversa/core@0.2.7

## 0.2.6

### Patch Changes

- Updated dependencies [c955f03]
  - @obversa/runtime@0.2.6
  - @obversa/api@0.2.6
  - @obversa/core@0.2.6

## 0.2.5

### Patch Changes

- Updated dependencies [909029f]
- Updated dependencies [2720fd4]
- Updated dependencies [f6ed5e7]
  - @obversa/api@0.2.5
  - @obversa/runtime@0.2.5
  - @obversa/core@0.2.5

## 0.2.4

### Patch Changes

- Updated dependencies [14f9f24]
- Updated dependencies [14f9f24]
  - @obversa/api@0.2.4
  - @obversa/runtime@0.2.4
  - @obversa/core@0.2.4

## 0.2.3

### Patch Changes

- Updated dependencies [768c936]
  - @obversa/runtime@0.2.3
  - @obversa/api@0.2.3
  - @obversa/core@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies
  - @obversa/runtime@0.2.2
  - @obversa/api@0.2.2
  - @obversa/core@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies
  - @obversa/api@0.2.1
  - @obversa/runtime@0.2.1
  - @obversa/core@0.2.1

## 0.2.0

### Minor Changes

- A review loop can stop on a judge's word instead of a count. A `workflow()` stage's `retry` field is now `refine`, and it takes a count or `judge(seat, { cap, questions })`: a seat that reads what the reviewer found and the rounds so far, and says whether another round is worth it. A block finding always goes back, the cap always ends the rounds, and every answer is a `refine:judge` event on the record. The same `judge()` value works on a `dag()`'s `maxKickbacks`. `stopQuestions()` is the default question set.

  A tool event carries the file, command, URL or pattern it acted on, so the run's page and the console print `tool Read use src/a.ts`. The run's page prints the record in the console's own words and shows the question's input and a link above the yes and no buttons. `renderRecord()`, `summarizeRecord()` and the `obversa-record` command print a run record as Markdown a person scans.

### Patch Changes

- Updated dependencies
  - @obversa/runtime@0.2.0
  - @obversa/api@0.2.0
  - @obversa/core@0.2.0
