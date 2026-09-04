import { accessSync, constants, statSync } from 'node:fs';
import {
  basename,
  delimiter,
  extname,
  isAbsolute,
  join,
} from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { execa } from 'execa';

import { digestJson, type Sha256Digest } from '../json.js';
import {
  capturePipeOwnerProbe,
  inspectAttemptMarkedProcesses,
  inspectOwnedProcessTree,
  inspectPipeHoldingProcesses,
  measureOwnedProcessMemory,
  stopOwnedProcessTree,
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
 * moves into a new session before the watchdog samples it is not swept.
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
  readonly remainingProcesses: readonly ProcessIdentity[];

  constructor(
    code: OwnedCommandErrorCode,
    message: string,
    remainingProcesses: readonly ProcessIdentity[] = [],
  ) {
    super(message);
    this.name = 'OwnedCommandError';
    this.code = code;
    this.remainingProcesses = Object.freeze([...remainingProcesses]);
  }
}

export interface OwnedCommandRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Whether Execa may merge the parent process environment. Default true. */
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

function bytes(chunk: unknown): Uint8Array {
  if (typeof chunk === 'string') return Buffer.from(chunk);
  if (chunk instanceof Uint8Array) return chunk;
  return Buffer.from(String(chunk));
}

function joined(chunks: readonly Uint8Array[]): Uint8Array {
  return Uint8Array.from(
    Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
  );
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
  const subprocess = execa(request.executable, [...request.args], {
    cwd: request.cwd,
    env: {
      ...request.env,
      ...(ownerId === undefined ? {} : { OBVERSA_RUN_OWNER: ownerId }),
      OBVERSA_ATTEMPT_ID: request.attemptId,
      OBVERSA_RUN_ID: request.runId,
      OBVERSA_HEADLESS: '1',
    },
    extendEnv: request.inheritParentEnv,
    input: request.stdin,
    cancelSignal: cancellation.signal,
    forceKillAfterDelay: false,
    reject: false,
    buffer: false,
    detached: process.platform !== 'win32',
    cleanup: true,
  });
  const rootPid = subprocess.pid;
  if (rootPid === undefined) {
    const result = await subprocess;
    throw new OwnedCommandError(
      'SPAWN_FAILED',
      result.shortMessage ?? `failed to spawn ${request.executable}`,
    );
  }
  const rootProcessGroupId = rootPid;
  const rawPipeFileDescriptors = [
    pipeFileDescriptor(subprocess.stdout),
    pipeFileDescriptor(subprocess.stderr),
  ].filter((descriptor): descriptor is number => descriptor !== undefined);
  const treeRequest = {
    attemptId: request.attemptId,
    ...(ownsOwner ? { ownerId } : {}),
    rootPid,
    rootProcessGroupId,
  } as const;

  let pipeProbe;
  try {
    pipeProbe = capturePipeOwnerProbe(rawPipeFileDescriptors);
  } catch (error) {
    cancellation.abort();
    const remaining = await stopOwnedProcessTree({
      ...treeRequest,
      graceMs: request.teardownGraceMs,
    });
    subprocess.stdout?.destroy();
    subprocess.stderr?.destroy();
    await subprocess;
    throw new OwnedCommandError(
      remaining.length === 0 ? 'PROCESS_INSPECTION' : 'TEARDOWN_INCOMPLETE',
      error instanceof Error ? error.message : 'could not retain pipe identity',
      remaining,
    );
  }

  try {
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    let outputBytes = 0;
    let observed: readonly ProcessIdentity[] = [];
    let peakMemoryBytes = 0;
    let stopReason: StopReason | undefined;
    let cleanupPromise: Promise<readonly ProcessIdentity[]> | undefined;
    let monitorStopped = false;
    let inspectionFailure: unknown;

    const requestStop = (reason: StopReason): void => {
      if (stopReason !== undefined) return;
      stopReason = reason;
      if (reason !== 'exit') cancellation.abort();
      cleanupPromise = (async () => {
        try {
          const [pipeHolders, markedProcesses] = await Promise.all([
            inspectPipeHoldingProcesses(pipeProbe.fileDescriptors),
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
        });
      })();
    };

    const retain = (
      target: Uint8Array[],
      chunk: unknown,
      observe: ((chunk: Uint8Array) => void) | undefined,
    ): void => {
      const value = bytes(chunk);
      const remaining = Math.max(0, request.maxOutputBytes - outputBytes);
      if (remaining > 0) {
        const kept =
          value.byteLength > remaining ? value.subarray(0, remaining) : value;
        const copy = Uint8Array.from(kept);
        target.push(copy);
        outputBytes += copy.byteLength;
        observe?.(Uint8Array.from(copy));
      }
      if (value.byteLength > remaining) requestStop('output');
    };

    subprocess.stdout?.on('data', (chunk) =>
      retain(stdoutChunks, chunk, observer.onStdout),
    );
    subprocess.stderr?.on('data', (chunk) =>
      retain(stderrChunks, chunk, observer.onStderr),
    );

    const monitorPromise = (async () => {
      try {
        while (!monitorStopped && stopReason === undefined) {
          const found = await inspectOwnedProcessTree({
            ...treeRequest,
            observed,
          });
          observed = mergeObserved(observed, found);
          const residentBytes = await measureOwnedProcessMemory({
            ...treeRequest,
            observed,
          });
          peakMemoryBytes = Math.max(peakMemoryBytes, residentBytes);
          if (residentBytes > request.maxMemoryBytes) {
            requestStop('memory');
            return;
          }
          await delay(PROCESS_SAMPLE_MS);
        }
      } catch (error) {
        inspectionFailure = error;
        requestStop('inspection');
      }
    })();

    const onAbort = (): void => requestStop('abort');
    signal.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => requestStop('timeout'), request.timeoutMs);
    timeout.unref?.();

    let exitCode: number | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        subprocess.once('exit', (code) => {
          exitCode = code;
          requestStop('exit');
          resolve();
        });
        subprocess.once('error', reject);
      });
    } catch (error) {
      requestStop('inspection');
      inspectionFailure = error;
    }

    let remainingProcesses: readonly ProcessIdentity[] = Object.freeze([]);
    let firstFailure: { readonly error: unknown } | undefined;
    let cleanupFailed = false;
    const rememberFailure = (error: unknown): void => {
      firstFailure ??= { error };
    };
    try {
      remainingProcesses = await cleanupPromise!;
    } catch (error) {
      cleanupFailed = true;
      rememberFailure(error);
    } finally {
      monitorStopped = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      subprocess.stdout?.destroy();
      subprocess.stderr?.destroy();
      try {
        await monitorPromise;
      } catch (error) {
        rememberFailure(error);
      }
      if (cleanupFailed) {
        cancellation.abort();
        try {
          remainingProcesses = await stopOwnedProcessTree({
            ...treeRequest,
            observed,
            graceMs: request.teardownGraceMs,
          });
        } catch (error) {
          inspectionFailure ??= error;
        }
      }
      try {
        await subprocess;
      } catch (error) {
        rememberFailure(error);
      }
    }
    if (firstFailure !== undefined) throw firstFailure.error;

    if (remainingProcesses.length > 0) {
      throw new OwnedCommandError(
        'TEARDOWN_INCOMPLETE',
        'owned command left processes running after teardown',
        remainingProcesses,
      );
    }
    if (stopReason === 'output') {
      throw new OwnedCommandError(
        'OUTPUT_LIMIT',
        `owned command output exceeded ${request.maxOutputBytes} bytes`,
      );
    }
    if (stopReason === 'memory') {
      throw new OwnedCommandError(
        'MEMORY_LIMIT',
        `owned process tree exceeded ${request.maxMemoryBytes} bytes`,
      );
    }
    if (stopReason === 'inspection') {
      throw new OwnedCommandError(
        'PROCESS_INSPECTION',
        inspectionFailure instanceof Error
          ? inspectionFailure.message
          : 'owned process inspection failed',
      );
    }
    if (inspectionFailure !== undefined) {
      throw new OwnedCommandError(
        'PROCESS_INSPECTION',
        inspectionFailure instanceof Error
          ? inspectionFailure.message
          : 'owned pipe inspection failed',
      );
    }

    const result: OwnedCommandResult = {
      exitCode,
      stdout: joined(stdoutChunks),
      stderr: joined(stderrChunks),
      timedOut: stopReason === 'timeout',
      aborted: stopReason === 'abort',
      peakMemoryBytes,
      remainingProcesses: Object.freeze([]),
    };
    return Object.freeze(result);
  } finally {
    pipeProbe.close();
  }
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
  stopOwnedProcessTree,
  type OwnedProcessTreeRequest,
  type PipeOwnerProbe,
  type ProcessIdentity,
  type StopOwnedProcessTreeRequest,
} from './process-tree.js';
