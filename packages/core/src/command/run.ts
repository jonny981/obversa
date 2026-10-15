import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import {
  basename,
  delimiter,
  extname,
  isAbsolute,
  join,
} from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { RunChildError, runChild, type RunChildOptions } from '../index.js';

import { digestJson, type Sha256Digest } from '@obversa/api';
import {
  capturePipeOwnerProbe,
  describeCountedProcesses,
  inspectAttemptMarkedProcesses,
  inspectOwnedProcessTree,
  inspectPipeHoldingProcesses,
  measureOwnedProcessTree,
  readProcessIdentity,
  stopOwnedProcessTree,
  type CountedProcess,
  type ProcessIdentity,
} from './process-tree.js';
import { attemptEnvironment } from './attempt-env.js';
import { retryAfterHeaderToMs } from './retry-after.js';
import { redactEnvValues, redactSecrets, scrubCapture } from './scrub.js';

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SAFE_COMMAND_MARKER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PROCESS_SAMPLE_MS = process.platform === 'win32' ? 250 : 20;
const MAX_TIMER_MS = 2_147_483_647;

export const DEFAULT_OWNED_COMMAND_LIMITS = Object.freeze({
  timeoutMs: 10 * 60 * 1_000,
  teardownGraceMs: 5_000,
  maxOutputBytes: 16 * 1_024 * 1_024,
  maxMemoryBytes: 4 * 1_024 * 1_024 * 1_024,
});

export type CommandCleanupCapability = 'inherited-owner' | 'observed-processes';

/**
 * Linux can discover exact inherited owner markers. Other platforms clean
 * observed processes (and retained pipes on macOS). On macOS a helper that
 * moves into a new session and drops the command's pipes before any
 * inspection observes it can escape.
 */
export function commandCleanupCapability(): CommandCleanupCapability {
  return process.platform === 'linux' ? 'inherited-owner' : 'observed-processes';
}

export type OwnedCommandErrorCode =
  | 'INVALID_EXECUTABLE'
  | 'INVALID_COMMAND'
  | 'SPAWN_FAILED'
  | 'OUTPUT_LIMIT'
  | 'MEMORY_LIMIT'
  | 'PROCESS_INSPECTION'
  | 'TEARDOWN_INCOMPLETE';

export class OwnedCommandError extends Error {
  readonly code: OwnedCommandErrorCode;
  readonly spawnCode?: string;
  readonly remainingProcesses: readonly ProcessIdentity[];
  /**
   * The processes teardown sent a signal to. A signalled process that is
   * still running is on `remainingProcesses` too.
   */
  readonly stoppedProcesses: readonly ProcessIdentity[];
  /**
   * On a memory-limit stop, every process the last measure counted, with its
   * command line and the reasons it counted. Empty on other failures.
   */
  readonly countedProcesses: readonly CountedProcess[];

  constructor(
    code: OwnedCommandErrorCode,
    message: string,
    remainingProcesses: readonly ProcessIdentity[] = [],
    spawnCode?: string,
    stoppedProcesses: readonly ProcessIdentity[] = [],
    countedProcesses: readonly CountedProcess[] = [],
  ) {
    super(message);
    this.name = 'OwnedCommandError';
    this.code = code;
    this.spawnCode = spawnCode;
    this.remainingProcesses = Object.freeze([...remainingProcesses]);
    this.stoppedProcesses = Object.freeze([...stoppedProcesses]);
    this.countedProcesses = Object.freeze([...countedProcesses]);
  }
}

export interface OwnedCommandRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Whether the process helper may merge the parent environment. Default true. */
  readonly inheritParentEnv?: boolean;
  readonly stdin: string;
  readonly attemptId: Sha256Digest;
  /** Fresh outer command owner; nested commands preserve an inherited owner. */
  readonly ownerId?: Sha256Digest;
  readonly runId: string;
  readonly timeoutMs: number;
  readonly teardownGraceMs: number;
  readonly maxOutputBytes: number;
  readonly maxMemoryBytes: number;
}

export interface OwnedCommandResult {
  readonly exitCode: number | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly peakMemoryBytes: number;
  /**
   * The processes teardown sent a signal to. `remainingProcesses` is empty:
   * a process still running makes the call throw instead.
   */
  readonly stoppedProcesses: readonly ProcessIdentity[];
  readonly remainingProcesses: readonly ProcessIdentity[];
}

export interface OwnedCommandObserver {
  readonly onStdout?: (chunk: Uint8Array) => void;
  readonly onStderr?: (chunk: Uint8Array) => void;
}

export function ownedCommandIdentity(input: {
  readonly adapter: string;
  readonly runId?: string;
  readonly leafId?: string;
  readonly attemptId?: string;
}): { readonly attemptId: Sha256Digest; readonly runId: string } {
  const runId = validateCommandMarker(input.runId ?? 'standalone', 'runId');
  const attemptId =
    input.attemptId === undefined
      ? digestJson({
          schemaVersion: 1,
          adapter: input.adapter,
          runId,
          leafId: input.leafId ?? 'standalone',
          nonce: randomUUID(),
        })
      : validateAttemptId(input.attemptId);
  return Object.freeze({ attemptId, runId });
}

type StopReason =
  | 'exit'
  | 'abort'
  | 'timeout'
  | 'output'
  | 'memory'
  | 'inspection';

type OwnedRunChildOptions = Omit<RunChildOptions, 'hooks'> & {
  readonly hooks: {
    readonly onSpawn: (child: ChildProcess, identity: ProcessIdentity | undefined) => void;
    readonly onExit: (code: number | null, signal: NodeJS.Signals | null) => void | Promise<void>;
    readonly onStdout?: (chunk: Uint8Array) => void;
    readonly onStderr?: (chunk: Uint8Array) => void;
    readonly onStop: (reason: 'timeout' | 'abort' | 'output') => void | Promise<void>;
    readonly onSignal: (processes: readonly ProcessIdentity[]) => void;
  };
};

function positiveSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new OwnedCommandError(
      'INVALID_COMMAND',
      `${field} must be a positive safe integer`,
    );
  }
  return value as number;
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new OwnedCommandError(
      'INVALID_COMMAND',
      `${field} must be a non-negative safe integer`,
    );
  }
  return value as number;
}

function validateAttemptId(value: unknown): Sha256Digest {
  if (typeof value !== 'string' || !SHA256_DIGEST.test(value)) {
    throw new OwnedCommandError(
      'INVALID_COMMAND',
      'attemptId must be a lowercase SHA-256 digest',
    );
  }
  return value as Sha256Digest;
}

function validateCommandMarker(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_COMMAND_MARKER.test(value)) {
    throw new OwnedCommandError(
      'INVALID_COMMAND',
      `${field} must contain 1 to 128 safe ASCII marker characters`,
    );
  }
  return value;
}

function executablePath(path: string): string | undefined {
  try {
    if (!statSync(path).isFile()) return undefined;
    accessSync(path, constants.X_OK);
    return path;
  } catch {
    return undefined;
  }
}

export function resolveCommandExecutable(
  command: string,
  searchPath = process.env.PATH ?? '',
): string {
  if (command.length === 0) {
    throw new OwnedCommandError(
      'INVALID_EXECUTABLE',
      'owned command executable must not be empty',
    );
  }
  if (isAbsolute(command)) {
    const resolved = executablePath(command);
    if (resolved !== undefined) return resolved;
    throw new OwnedCommandError(
      'INVALID_EXECUTABLE',
      `owned command executable is not runnable: ${command}`,
    );
  }
  if (basename(command) !== command) {
    throw new OwnedCommandError(
      'INVALID_EXECUTABLE',
      'owned command executable must be absolute or a bare command name',
    );
  }

  const extensions =
    process.platform === 'win32' && extname(command) === ''
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean)
      : [''];
  for (const directory of searchPath.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const resolved = executablePath(join(directory, `${command}${extension}`));
      if (resolved !== undefined) return resolved;
    }
  }
  throw new OwnedCommandError(
    'INVALID_EXECUTABLE',
    `owned command executable was not found: ${command}`,
  );
}

function validateRequest(request: OwnedCommandRequest): OwnedCommandRequest {
  if (typeof request.executable !== 'string' || !isAbsolute(request.executable)) {
    throw new OwnedCommandError(
      'INVALID_EXECUTABLE',
      'owned command executable must be an absolute path',
    );
  }
  if (typeof request.cwd !== 'string' || !isAbsolute(request.cwd)) {
    throw new OwnedCommandError(
      'INVALID_COMMAND',
      'owned command cwd must be an absolute path',
    );
  }
  if (
    !Array.isArray(request.args) ||
    request.args.some((arg) => typeof arg !== 'string')
  ) {
    throw new OwnedCommandError(
      'INVALID_COMMAND',
      'owned command args must be strings',
    );
  }
  if (typeof request.stdin !== 'string') {
    throw new OwnedCommandError('INVALID_COMMAND', 'owned command stdin must be text');
  }
  for (const [name, value] of Object.entries(request.env)) {
    if (typeof value !== 'string') {
      throw new OwnedCommandError(
        'INVALID_COMMAND',
        `owned command env ${name} must be text`,
      );
    }
  }
  if (
    request.inheritParentEnv !== undefined
    && typeof request.inheritParentEnv !== 'boolean'
  ) {
    throw new OwnedCommandError(
      'INVALID_COMMAND',
      'inheritParentEnv must be a boolean',
    );
  }

  const timeoutMs = positiveSafeInteger(request.timeoutMs, 'timeoutMs');
  if (request.ownerId !== undefined && (
    typeof request.ownerId !== 'string' || !SHA256_DIGEST.test(request.ownerId)
  )) {
    throw new OwnedCommandError('INVALID_COMMAND', 'ownerId must be a lowercase SHA-256 digest');
  }
  const teardownGraceMs = nonNegativeSafeInteger(
    request.teardownGraceMs,
    'teardownGraceMs',
  );
  if (timeoutMs > MAX_TIMER_MS) {
    throw new OwnedCommandError(
      'INVALID_COMMAND',
      `timeoutMs must be at most ${MAX_TIMER_MS}`,
    );
  }
  if (teardownGraceMs > MAX_TIMER_MS - timeoutMs) {
    throw new OwnedCommandError(
      'INVALID_COMMAND',
      `timeoutMs + teardownGraceMs must be at most ${MAX_TIMER_MS}`,
    );
  }

  return {
    ...request,
    inheritParentEnv: request.inheritParentEnv ?? true,
    attemptId: validateAttemptId(request.attemptId),
    runId: validateCommandMarker(request.runId, 'runId'),
    timeoutMs,
    teardownGraceMs,
    maxOutputBytes: nonNegativeSafeInteger(
      request.maxOutputBytes,
      'maxOutputBytes',
    ),
    maxMemoryBytes: positiveSafeInteger(
      request.maxMemoryBytes,
      'maxMemoryBytes',
    ),
  };
}

function mergeObserved(
  left: readonly ProcessIdentity[],
  right: readonly ProcessIdentity[],
): readonly ProcessIdentity[] {
  const merged = new Map(
    left.map((identity) => [`${identity.pid}:${identity.startedAt}`, identity]),
  );
  for (const identity of right) {
    merged.set(`${identity.pid}:${identity.startedAt}`, identity);
  }
  return [...merged.values()];
}

function pipeFileDescriptor(stream: unknown): number | undefined {
  const descriptor = (
    stream as { readonly _handle?: { readonly fd?: unknown } } | undefined
  )?._handle?.fd;
  return Number.isSafeInteger(descriptor) && (descriptor as number) >= 0
    ? descriptor as number
    : undefined;
}

function emptyResult(aborted: boolean): OwnedCommandResult {
  return Object.freeze({
    exitCode: null,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    timedOut: false,
    aborted,
    peakMemoryBytes: 0,
    stoppedProcesses: Object.freeze([]),
    remainingProcesses: Object.freeze([]),
  });
}

export async function runOwnedCommand(
  rawRequest: OwnedCommandRequest,
  signal: AbortSignal,
  observer: OwnedCommandObserver = {},
): Promise<OwnedCommandResult> {
  const request = validateRequest(rawRequest);
  if (signal.aborted) return emptyResult(true);

  const parentOwner = process.env.OBVERSA_RUN_OWNER;
  const inheritedOwner = parentOwner !== undefined && SHA256_DIGEST.test(parentOwner)
    ? parentOwner as Sha256Digest
    : undefined;
  const ownerId = inheritedOwner ?? request.ownerId;
  const ownsOwner = inheritedOwner === undefined && request.ownerId !== undefined;

  const cancellation = new AbortController();
  let treeRequest: {
    readonly attemptId: Sha256Digest;
    readonly ownerId?: Sha256Digest;
    readonly rootPid: number;
    readonly rootProcessGroupId: number;
    readonly rootStartedAt?: string;
  } | undefined;
  let pipeProbe: ReturnType<typeof capturePipeOwnerProbe> | undefined;
  let observed: readonly ProcessIdentity[] = [];
  let signaled: readonly ProcessIdentity[] = [];
  let countedProcesses: readonly CountedProcess[] = Object.freeze([]);
  let peakMemoryBytes = 0;
  let stopReason: StopReason | undefined;
  let cleanupPromise: Promise<readonly ProcessIdentity[]> | undefined;
  let monitorPromise: Promise<void> | undefined;
  let monitorStopped = false;
  let inspectionFailure: unknown;
  let cleanupError: unknown;

  const requestStop = (reason: StopReason): void => {
    if (stopReason !== undefined) return;
    stopReason = reason;
    if (reason !== 'exit') cancellation.abort();
  };

  const cleanup = (): Promise<readonly ProcessIdentity[]> => {
    if (cleanupPromise !== undefined) return cleanupPromise;
    if (treeRequest === undefined) return Promise.resolve(Object.freeze([]));
    cleanupPromise = (async () => {
      try {
        const [pipeHolders, markedProcesses] = await Promise.all([
          pipeProbe === undefined
            ? Promise.resolve(Object.freeze([]) as readonly ProcessIdentity[])
            : inspectPipeHoldingProcesses(pipeProbe.fileDescriptors),
          inspectAttemptMarkedProcesses(request.attemptId),
        ]);
        observed = mergeObserved(observed, pipeHolders);
        observed = mergeObserved(observed, markedProcesses);
      } catch (error) {
        inspectionFailure = error;
      }
      return await stopOwnedProcessTree({
        ...treeRequest,
        observed,
        graceMs: request.teardownGraceMs,
        ...(pipeProbe === undefined
          ? {}
          : { pipeFileDescriptors: pipeProbe.fileDescriptors }),
        onSignal: (processes) => {
          signaled = mergeObserved(signaled, processes);
        },
      });
    })();
    void cleanupPromise.catch(() => {});
    return cleanupPromise;
  };

  const monitor = async (): Promise<void> => {
    try {
      while (!monitorStopped && stopReason === undefined && treeRequest !== undefined) {
        const carried = observed;
        const found = await inspectOwnedProcessTree({
          ...treeRequest,
          observed,
        });
        observed = mergeObserved(observed, found);
        const measure = await measureOwnedProcessTree({
          ...treeRequest,
          observed,
        });
        peakMemoryBytes = Math.max(peakMemoryBytes, measure.residentBytes);
        if (measure.residentBytes > request.maxMemoryBytes) {
          countedProcesses = (
            await describeCountedProcesses(
              { ...treeRequest, observed: carried },
              measure.counted,
            )
          ).map((entry) => Object.freeze({
            ...entry,
            command: scrubCapture(entry.command, request.env, 200),
          }));
          requestStop('memory');
          return;
        }
        await delay(PROCESS_SAMPLE_MS);
      }
    } catch (error) {
      inspectionFailure = error;
      requestStop('inspection');
    }
  };

  const onAbort = (): void => requestStop('abort');
  signal.addEventListener('abort', onAbort, { once: true });

  let childResult: Awaited<ReturnType<typeof runChild>> | undefined;
  let childError: unknown;
  let remainingProcesses: readonly ProcessIdentity[] = Object.freeze([]);
  try {
    const childOptions: OwnedRunChildOptions = {
      executable: request.executable,
      args: request.args,
      cwd: request.cwd,
      env: {
        ...request.env,
        ...(ownerId === undefined ? {} : { OBVERSA_RUN_OWNER: ownerId }),
        OBVERSA_ATTEMPT_ID: request.attemptId,
        OBVERSA_RUN_ID: request.runId,
        OBVERSA_HEADLESS: '1',
      },
      inheritParentEnv: request.inheritParentEnv,
      stdin: request.stdin,
      timeoutMs: request.timeoutMs,
      killGraceMs: request.teardownGraceMs,
      maxOutputBytes: request.maxOutputBytes,
      detached: true,
      signal: cancellation.signal,
      hooks: {
        onSpawn: (child, identity) => {
          const rootPid = child.pid;
          if (rootPid === undefined) throw new Error('owned command has no process id');
          // runChild already read the identity as the process started; only a
          // missing read is retried, so a failed look still surfaces as an
          // inspection failure.
          let root = identity;
          if (root === undefined) {
            try {
              root = readProcessIdentity(rootPid);
            } catch (error) {
              inspectionFailure = error;
              throw error;
            }
          }
          treeRequest = {
            attemptId: request.attemptId,
            ...(ownsOwner ? { ownerId } : {}),
            rootPid,
            rootProcessGroupId: rootPid,
            ...(root === undefined ? {} : { rootStartedAt: root.startedAt }),
          };
          if (root !== undefined) observed = [root];
          const descriptors = [
            pipeFileDescriptor(child.stdout),
            pipeFileDescriptor(child.stderr),
          ].filter((descriptor): descriptor is number => descriptor !== undefined);
          try {
            pipeProbe = capturePipeOwnerProbe(descriptors);
          } catch (error) {
            inspectionFailure = error;
            throw error;
          }
          monitorPromise = monitor();
        },
        onExit: async () => {
          requestStop('exit');
          await cleanup();
        },
        onStdout: observer.onStdout,
        onStderr: observer.onStderr,
        onStop: async (reason) => {
          requestStop(reason);
          await cleanup();
        },
        onSignal: (processes) => {
          signaled = mergeObserved(signaled, processes);
        },
      },
    };
    childResult = await runChild(childOptions);
  } catch (error) {
    childError = error;
  } finally {
    monitorStopped = true;
    signal.removeEventListener('abort', onAbort);
    if (monitorPromise !== undefined) await monitorPromise;
    if (cleanupPromise !== undefined) {
      try {
        remainingProcesses = await cleanupPromise;
      } catch (error) {
        cleanupError = error;
      }
    }
  }

  // Every identity a signal was sent to stays on the record, including one
  // still running: remainingProcesses names those separately.
  const stopped = (): readonly ProcessIdentity[] => Object.freeze([...signaled]);

  if (cleanupError !== undefined) {
    pipeProbe?.close();
    if (treeRequest !== undefined) {
      cancellation.abort();
      try {
        remainingProcesses = await stopOwnedProcessTree({
          ...treeRequest,
          observed,
          graceMs: request.teardownGraceMs,
          onSignal: (processes) => {
            signaled = mergeObserved(signaled, processes);
          },
        });
      } catch (error) {
        inspectionFailure ??= error;
      }
    }
    throw new OwnedCommandError(
      'TEARDOWN_INCOMPLETE',
      cleanupError instanceof Error
        ? cleanupError.message
        : 'owned process teardown failed',
      remainingProcesses,
      undefined,
      stopped(),
    );
  }
  pipeProbe?.close();
  if (childError !== undefined) {
    if (remainingProcesses.length > 0) {
      throw new OwnedCommandError(
        'TEARDOWN_INCOMPLETE',
        childError instanceof Error ? childError.message : 'owned command left processes running after teardown',
        remainingProcesses,
        undefined,
        stopped(),
      );
    }
    if (childError instanceof RunChildError && childError.code === 'OUTPUT_LIMIT') {
      throw new OwnedCommandError(
        'OUTPUT_LIMIT',
        `owned command output exceeded ${request.maxOutputBytes} bytes`,
        [],
        undefined,
        stopped(),
      );
    }
    if (childError instanceof RunChildError && childError.code === 'SPAWN_FAILED') {
      throw new OwnedCommandError('SPAWN_FAILED', childError.message, [], childError.spawnCode);
    }
    if (childError instanceof RunChildError && childError.code === 'TEARDOWN_INCOMPLETE') {
      if (inspectionFailure !== undefined) {
        throw new OwnedCommandError(
          'PROCESS_INSPECTION',
          inspectionFailure instanceof Error
            ? inspectionFailure.message
            : 'owned process inspection failed',
          [],
          undefined,
          stopped(),
        );
      }
      throw new OwnedCommandError('TEARDOWN_INCOMPLETE', childError.message, [], undefined, stopped());
    }
    throw childError;
  }
  if (remainingProcesses.length > 0) {
    throw new OwnedCommandError(
      'TEARDOWN_INCOMPLETE',
      'owned command left processes running after teardown',
      remainingProcesses,
      undefined,
      stopped(),
    );
  }
  if (stopReason === 'output') {
    throw new OwnedCommandError(
      'OUTPUT_LIMIT',
      `owned command output exceeded ${request.maxOutputBytes} bytes`,
      [],
      undefined,
      stopped(),
    );
  }
  if (stopReason === 'memory') {
    throw new OwnedCommandError(
      'MEMORY_LIMIT',
      `owned process tree exceeded ${request.maxMemoryBytes} bytes`,
      [],
      undefined,
      stopped(),
      countedProcesses,
    );
  }
  if (stopReason === 'inspection' || inspectionFailure !== undefined) {
    throw new OwnedCommandError(
      'PROCESS_INSPECTION',
      inspectionFailure instanceof Error
        ? inspectionFailure.message
        : 'owned process inspection failed',
      [],
      undefined,
      stopped(),
    );
  }

  const result: OwnedCommandResult = {
    exitCode: childResult?.exitCode ?? null,
    stdout: childResult?.stdout ?? new Uint8Array(),
    stderr: childResult?.stderr ?? new Uint8Array(),
    timedOut: stopReason === 'timeout' || childResult?.timedOut === true,
    aborted: stopReason === 'abort',
    peakMemoryBytes,
    stoppedProcesses: stopped(),
    remainingProcesses: Object.freeze([]),
  };
  return Object.freeze(result);
}

export { attemptEnvironment };
export { retryAfterHeaderToMs };
export { redactEnvValues, redactSecrets, scrubCapture };
export {
  capturePipeOwnerProbe,
  inspectAttemptMarkedProcesses,
  inspectOwnerMarkedProcesses,
  inspectOwnedProcessTree,
  inspectPipeHoldingProcesses,
  measureOwnedProcessMemory,
  parseWindowsProcessRows,
  readAttemptMarkerProcessIds,
  readProcessIdentity,
  stopOwnedProcessTree,
  type CountedProcess,
  type OwnedProcessTreeRequest,
  type PipeOwnerProbe,
  type ProcessIdentity,
  type StopOwnedProcessTreeRequest,
} from './process-tree.js';
