---
"@obversa/core": patch
"@obversa/runner": patch
---

The cleanup after an engine command no longer stops processes that are not part of that command.

A stopped process could be another run, its agents, a test worker, or a command still within its time limit, which then reported a plain failed exit instead of a timeout. A busy machine made each of these more likely. Three paths reached such a process, and each is closed:

- **A reused socket address.** On macOS, the cleanup looks for processes that still hold the command's output sockets. When the command's end of a socket closed during that search, macOS could give the socket's address to a new socket in any other process. The cleanup now checks the command's sockets again after the search, and stops only the processes that hold a socket that is still connected.
- **A reused process id.** When a command and every process left in its group have exited, the system can give the command's process id to a new process, which can lead a process group with that same id. The cleanup took every process in that group for part of the command. The runner now reads the command's start time as it starts it. The command's process id counts only while that same process is alive. When the command leads its own group, that group counts until a different process holds the command's process id.
- **A group signal.** `runChild` with `detached: true` signalled the child's whole process group, also after the child had already exited, for example on an abort while a helper still held the output open. It now reads the members of the child's group while the child runs and signals each one that started no earlier than the child by its own process id. After the child exits, a member read earlier that `ps` still shows once the child's output has closed gets SIGKILL when the grace ends, matched by its process id and start time, so a helper that ignores SIGTERM is still stopped.

`stopOwnedProcessTree`, `inspectOwnedProcessTree` and `measureOwnedProcessMemory` accept `rootStartedAt`, the root's start time. On Linux and macOS, the root's process id counts only while a process with that id and start time is alive. When the root leads its own group, that group counts until a different process holds the root's id. Neither counts when `rootStartedAt` is not given. `readProcessIdentity(pid)` reads that start time; call it while the root is alive.
