import { spawn, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const MAX_TIMER_MS = 2_147_483_647;
const DRAIN_GRACE_MS = 500;
const PARENT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
type ParentSignal = (typeof PARENT_SIGNALS)[number];

interface LiveChild {
  readonly child: ChildProcess;
  readonly detached: boolean;
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

function signalProcess(child: ChildProcess, signal: NodeJS.Signals, detached: boolean): boolean {
  if (child.pid === undefined) return false;
  try {
    if (detached) return process.kill(-child.pid, signal);
    return child.kill(signal);
  } catch {
    return false;
  }
}

function stopLiveChildren(signal: NodeJS.Signals): void {
  for (const { child, detached } of liveChildren) {
    signalProcess(child, signal, detached);
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

function registerLiveChild(child: ChildProcess, detached: boolean): () => void {
  installParentCleanup();
  const entry = { child, detached };
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
  const unregisterChild = registerLiveChild(child, detached);

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
      signalProcess(child, 'SIGTERM', detached);
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
          signalProcess(child, 'SIGKILL', detached);
          teardownTimer = setTimeout(() => {
            if (closed) return;
            destroyOutput();
            fail(new RunChildError('TEARDOWN_INCOMPLETE', 'child process did not stop after SIGKILL', output()));
          }, limits.killGraceMs);
        }, limits.killGraceMs);
      })();
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
