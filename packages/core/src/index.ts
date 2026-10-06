import { spawn, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import { readProcessIdentities, readProcessIdentity } from './command/process-tree.js';

const MAX_TIMER_MS = 2_147_483_647;
const DRAIN_GRACE_MS = 500;
const PARENT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
type ParentSignal = (typeof PARENT_SIGNALS)[number];

interface LiveChild {
  readonly child: ChildProcess;
  readonly detached: boolean;
  /** The child's start time, read as it starts; undefined if it could not be read. */
  readonly startedAt: number | undefined;
  /** Members of the child's group read while it ran: pid to start time. */
  readonly members: Map<number, string>;
}

const liveChildren = new Set<LiveChild>();
const parentSignalHandlers = new Map<ParentSignal, () => void>();
let parentCleanupInstalled = false;

export interface RunChildOptions {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: string | Uint8Array;
  readonly timeoutMs: number;
  readonly killGraceMs?: number;
  readonly maxOutputBytes: number;
  /** Merge `env` over the parent environment. Defaults to true. */
  readonly inheritParentEnv?: boolean;
  /** Place the child in its own process group. Defaults to false. */
  readonly detached?: boolean;
  readonly signal?: AbortSignal;
  /** @internal */
  readonly hooks?: RunChildHooks;
}

export interface RunChildResult {
  readonly exitCode: number | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

export type RunChildErrorCode =
  | 'INVALID_OPTIONS'
  | 'SPAWN_FAILED'
  | 'OUTPUT_LIMIT'
  | 'TEARDOWN_INCOMPLETE';

export class RunChildError extends Error {
  readonly code: RunChildErrorCode;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;

  constructor(
    code: RunChildErrorCode,
    message: string,
    output: { readonly stdout?: Uint8Array; readonly stderr?: Uint8Array } = {},
  ) {
    super(message);
    this.name = 'RunChildError';
    this.code = code;
    this.stdout = output.stdout ?? new Uint8Array();
    this.stderr = output.stderr ?? new Uint8Array();
  }
}

type StopReason = 'timeout' | 'abort' | 'output';

/** @internal Hooks used by the owned engine command wrapper. */
interface RunChildHooks {
  readonly onSpawn?: (child: ChildProcess) => void;
  readonly onExit?: (code: number | null, signal: NodeJS.Signals | null) => void | Promise<void>;
  readonly onStdout?: (chunk: Uint8Array) => void;
  readonly onStderr?: (chunk: Uint8Array) => void;
  readonly onStop?: (reason: StopReason) => void | Promise<void>;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_TIMER_MS) {
    throw new RunChildError(
      'INVALID_OPTIONS',
      `${field} must be a positive safe integer no greater than ${MAX_TIMER_MS}`,
    );
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_TIMER_MS) {
    throw new RunChildError(
      'INVALID_OPTIONS',
      `${field} must be a non-negative safe integer no greater than ${MAX_TIMER_MS}`,
    );
  }
  return value as number;
}

function validate(options: RunChildOptions): Required<Pick<RunChildOptions, 'timeoutMs' | 'killGraceMs' | 'maxOutputBytes'>> {
  if (typeof options.executable !== 'string' || options.executable.length === 0) {
    throw new RunChildError('INVALID_OPTIONS', 'executable must be a non-empty string');
  }
  if ((options.args ?? []).some((arg) => typeof arg !== 'string')) {
    throw new RunChildError('INVALID_OPTIONS', 'args must contain only strings');
  }
  if (options.stdin !== undefined && typeof options.stdin !== 'string' && !(options.stdin instanceof Uint8Array)) {
    throw new RunChildError('INVALID_OPTIONS', 'stdin must be text or bytes');
  }
  if (options.inheritParentEnv !== undefined && typeof options.inheritParentEnv !== 'boolean') {
    throw new RunChildError('INVALID_OPTIONS', 'inheritParentEnv must be a boolean');
  }
  return {
    timeoutMs: positiveInteger(options.timeoutMs, 'timeoutMs'),
    killGraceMs: nonNegativeInteger(options.killGraceMs ?? 1_000, 'killGraceMs'),
    maxOutputBytes: nonNegativeInteger(options.maxOutputBytes, 'maxOutputBytes'),
  };
}

/** A ps start time, read with LC_ALL=C and TZ=UTC, in milliseconds. */
function startTime(startedAt: string): number {
  return Date.parse(`${startedAt} UTC`);
}

function signalProcess(entry: LiveChild, signal: NodeJS.Signals): boolean {
  const { child, detached, members } = entry;
  const pid = child.pid;
  if (pid === undefined || pid < 1) return false;
  // After Node sees the exit, the system can give the child's pid, and so its
  // group id, to any new process.
  const running = child.exitCode === null && child.signalCode === null;
  if (detached) {
    // While the child runs, every process the table shows with the child's
    // pid as its group id gets the signal by its own pid and is recorded,
    // whatever its origin, if ps shows it starting no earlier than the child,
    // to the second. Nothing in the group is signalled when the child's start
    // time could not be read. After the child exits, only recorded members
    // still running with the same start time get it. A process that joins
    // the group after the last read is not signalled.
    let targets: readonly number[] = [];
    try {
      const table = readProcessIdentities();
      if (running) {
        const group = entry.startedAt === undefined ? [] : table.filter((member) =>
          member.processGroupId === pid &&
          member.pid !== pid &&
          startTime(member.startedAt) >= entry.startedAt!);
        for (const member of group) members.set(member.pid, member.startedAt);
        targets = group.map((member) => member.pid);
      } else {
        targets = table
          .filter((member) => members.get(member.pid) === member.startedAt)
          .map((member) => member.pid);
      }
    } catch {
      // The child is still signalled below.
    }
    for (const member of targets) {
      try {
        process.kill(member, signal);
      } catch {
        // The member may have exited since the table was read.
      }
    }
  }
  if (!running) return false;
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function stopLiveChildren(signal: NodeJS.Signals): void {
  for (const entry of liveChildren) {
    signalProcess(entry, signal);
  }
}

function removeParentSignalHandlers(): void {
  for (const [signal, handler] of parentSignalHandlers) {
    process.removeListener(signal, handler);
  }
  parentSignalHandlers.clear();
}

function handleParentSignal(signal: ParentSignal): void {
  if (process.listenerCount(signal) !== 1) return;
  stopLiveChildren(signal);
  removeParentSignalHandlers();
  try {
    process.kill(process.pid, signal);
  } catch {
    // The process may already be exiting.
  }
}

function installParentCleanup(): void {
  if (parentCleanupInstalled) return;
  parentCleanupInstalled = true;
  process.once('exit', () => stopLiveChildren('SIGTERM'));
  for (const signal of PARENT_SIGNALS) {
    const handler = (): void => handleParentSignal(signal);
    parentSignalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
}

function registerLiveChild(entry: LiveChild): () => void {
  installParentCleanup();
  liveChildren.add(entry);
  return () => liveChildren.delete(entry);
}

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? Buffer.from(value) : Uint8Array.from(value);
}

function joined(chunks: readonly Uint8Array[]): Uint8Array {
  return Uint8Array.from(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

/** Run one bounded child process and drain both output pipes until close or grace expiry. */
export function runChild(options: RunChildOptions): Promise<RunChildResult> {
  const limits = validate(options);
  const deadline = performance.now() + limits.timeoutMs;
  if (options.signal?.aborted) {
    return Promise.resolve(Object.freeze({
      exitCode: null,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      timedOut: false,
      aborted: true,
    }));
  }

  let child: ChildProcess;
  try {
    child = spawn(options.executable, [...(options.args ?? [])], {
      cwd: options.cwd,
      env: options.inheritParentEnv === false
        ? { ...(options.env ?? {}) }
        : options.env === undefined
          ? process.env
          : { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: options.detached === true && process.platform !== 'win32',
      windowsHide: true,
    });
  } catch (error) {
    throw new RunChildError(
      'SPAWN_FAILED',
      error instanceof Error ? error.message : 'child process could not start',
    );
  }

  const detached = options.detached === true && process.platform !== 'win32';
  let startedAt: number | undefined;
  if (detached && child.pid !== undefined) {
    try {
      const identity = readProcessIdentity(child.pid);
      if (identity !== undefined) startedAt = startTime(identity.startedAt);
    } catch {
      // The group is then left alone; the child is still signalled.
    }
  }
  const live: LiveChild = {
    child,
    detached,
    startedAt: startedAt !== undefined && Number.isFinite(startedAt) ? startedAt : undefined,
    members: new Map(),
  };
  const unregisterChild = registerLiveChild(live);

  return new Promise<RunChildResult>((resolve, reject) => {
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    let retainedBytes = 0;
    let stopReason: StopReason | undefined;
    let closed = false;
    let settled = false;
    let closeCode: number | null = null;
    let closeSignal: NodeJS.Signals | null = null;
    let stoppedAt: number | undefined;
    let stopSignalledAt: number | undefined;
    let stopPromise: Promise<void> | undefined;
    let exitPromise: Promise<void> | undefined;
    let stopError: unknown;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let teardownTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let drainStarted = false;
    let onAbort: (() => void) | undefined;

    const clearTimers = (): void => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      if (teardownTimer !== undefined) clearTimeout(teardownTimer);
      if (drainTimer !== undefined) clearTimeout(drainTimer);
    };

    const output = (): { readonly stdout: Uint8Array; readonly stderr: Uint8Array } => ({
      stdout: joined(stdoutChunks),
      stderr: joined(stderrChunks),
    });

    const fail = (error: RunChildError): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      options.signal?.removeEventListener('abort', onAbort!);
      unregisterChild();
      reject(error);
    };

    const destroyOutput = (): void => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    const startDrain = (): void => {
      if (drainStarted || closed || settled) return;
      drainStarted = true;
      drainTimer = setTimeout(() => {
        if (closed || settled) return;
        destroyOutput();
      }, DRAIN_GRACE_MS);
      drainTimer.unref?.();
    };

    const finish = (): void => {
      if (!closed || settled) return;
      clearTimers();
      const captured = output();
      if (stopReason === 'output') {
        fail(new RunChildError('OUTPUT_LIMIT', `child output exceeded ${limits.maxOutputBytes} bytes`, captured));
        return;
      }
      if (stopError !== undefined) {
        fail(new RunChildError(
          'TEARDOWN_INCOMPLETE',
          stopError instanceof Error ? stopError.message : 'child stop hook failed',
          captured,
        ));
        return;
      }
      settled = true;
      unregisterChild();
      resolve(Object.freeze({
        exitCode: closeSignal === null ? closeCode : null,
        stdout: captured.stdout,
        stderr: captured.stderr,
        timedOut: stopReason !== 'abort'
          && (stoppedAt ?? performance.now()) >= deadline,
        aborted: stopReason === 'abort',
      }));
    };

    const terminate = (reason: StopReason): void => {
      if (stopReason !== undefined || closed) return;
      stopReason = reason;
      let stopHook: Promise<void>;
      try {
        stopHook = Promise.resolve(options.hooks?.onStop?.(reason));
      } catch (error) {
        stopError = error;
        stopHook = Promise.resolve();
      }
      stopSignalledAt = performance.now();
      signalProcess(live, 'SIGTERM');
      stopPromise = (async () => {
        try {
          await Promise.race([
            stopHook,
            new Promise<void>((resolveDelay) => setTimeout(resolveDelay, limits.killGraceMs)),
          ]);
        } catch (error) {
          stopError = error;
        }
        if (closed) return;
        forceKillTimer = setTimeout(() => {
          if (closed) return;
          signalProcess(live, 'SIGKILL');
          teardownTimer = setTimeout(() => {
            if (closed) return;
            destroyOutput();
            fail(new RunChildError('TEARDOWN_INCOMPLETE', 'child process did not stop after SIGKILL', output()));
          }, limits.killGraceMs);
        }, limits.killGraceMs);
      })();
    };

    // A child that exits on SIGTERM cancels its SIGKILL. A recorded member of
    // its group that the table still shows once the output has closed gets
    // one here, when the grace ends.
    const killRemainingMembers = async (): Promise<void> => {
      if (stopSignalledAt === undefined || live.members.size === 0) return;
      try {
        const remaining = readProcessIdentities().some(
          (member) => live.members.get(member.pid) === member.startedAt,
        );
        if (!remaining) return;
      } catch {
        return;
      }
      const wait = stopSignalledAt + limits.killGraceMs - performance.now();
      if (wait > 0) await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, wait));
      signalProcess(live, 'SIGKILL');
    };

    const retain = (target: Uint8Array[], chunk: Uint8Array): void => {
      const remaining = Math.max(0, limits.maxOutputBytes - retainedBytes);
      if (remaining > 0) {
        const kept = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
        const copy = Uint8Array.from(kept);
        target.push(copy);
        retainedBytes += kept.byteLength;
        if (target === stdoutChunks) options.hooks?.onStdout?.(Uint8Array.from(copy));
        else options.hooks?.onStderr?.(Uint8Array.from(copy));
      }
      if (chunk.byteLength > remaining) terminate('output');
    };

    onAbort = (): void => terminate('abort');
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdin?.on('error', () => {});
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});
    child.stdout?.on('data', (chunk: Uint8Array) => retain(stdoutChunks, chunk));
    child.stderr?.on('data', (chunk: Uint8Array) => retain(stderrChunks, chunk));
    child.once('error', (error) => {
      options.signal?.removeEventListener('abort', onAbort);
      fail(new RunChildError('SPAWN_FAILED', error.message, output()));
    });
    child.once('exit', (code, signal) => {
      stoppedAt = performance.now();
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      if (teardownTimer !== undefined) clearTimeout(teardownTimer);
      try {
        exitPromise = Promise.resolve(options.hooks?.onExit?.(code, signal));
        void exitPromise.then(
          () => startDrain(),
          (error: unknown) => {
            stopError = error;
            destroyOutput();
          },
        );
      } catch (error) {
        stopError = error;
        exitPromise = Promise.resolve();
        destroyOutput();
      }
    });
    child.once('close', (code, signal) => {
      stoppedAt ??= performance.now();
      closed = true;
      closeCode = code;
      closeSignal = signal;
      options.signal?.removeEventListener('abort', onAbort);
      void (async () => {
        try {
          await exitPromise;
        } catch (error) {
          stopError = error;
        }
        await stopPromise;
        await killRemainingMembers();
        finish();
      })();
    });

    try {
      options.hooks?.onSpawn?.(child);
    } catch (error) {
      stopError = error;
      terminate('abort');
    }

    if (options.stdin === undefined) child.stdin?.end();
    else child.stdin?.end(bytes(options.stdin));
    timeoutTimer = setTimeout(() => terminate('timeout'), limits.timeoutMs);
    timeoutTimer.unref?.();
  });
}
