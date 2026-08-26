import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import {
  basename,
  delimiter,
  extname,
  isAbsolute,
  join,
} from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { execa } from 'execa';

import { digestJson, type Sha256Digest } from '../graph/value.js';
import {
  capturePipeOwnerProbe,
  inspectAttemptMarkedProcesses,
  inspectOwnedProcessTree,
  inspectPipeHoldingProcesses,
  measureOwnedProcessMemory,
  stopOwnedProcessTree,
  type ProcessIdentity,
} from '../runtime/process-tree.js';
import { validateStorageId } from '../storage/id.js';

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const PROCESS_SAMPLE_MS = process.platform === 'win32' ? 250 : 20;

export const DEFAULT_OWNED_COMMAND_LIMITS = Object.freeze({
  timeoutMs: 10 * 60 * 1_000,
  teardownGraceMs: 5_000,
  maxOutputBytes: 16 * 1_024 * 1_024,
  maxMemoryBytes: 4 * 1_024 * 1_024 * 1_024,
});

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
  readonly stdin: string;
  readonly attemptId: Sha256Digest;
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
  readonly attemptId?: Sha256Digest;
}): { readonly attemptId: Sha256Digest; readonly runId: string } {
  const runId = validateStorageId(input.runId ?? 'standalone', '/runId');
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

function executablePath(path: string): string | undefined {
  try {
    if (!statSync(path).isFile()) return undefined;
    accessSync(path, constants.X_OK);
    return realpathSync(path);
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

  return {
    ...request,
    attemptId: validateAttemptId(request.attemptId),
    runId: validateStorageId(request.runId, '/runId'),
    timeoutMs: positiveSafeInteger(request.timeoutMs, 'timeoutMs'),
    teardownGraceMs: nonNegativeSafeInteger(
      request.teardownGraceMs,
      'teardownGraceMs',
    ),
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

  const cancellation = new AbortController();
  const subprocess = execa(request.executable, [...request.args], {
    cwd: request.cwd,
    env: {
      ...request.env,
      LINES_ATTEMPT_ID: request.attemptId,
      LINES_RUN_ID: request.runId,
      LINES_HEADLESS: '1',
    },
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

    const remainingProcesses = await cleanupPromise!;
    monitorStopped = true;
    await monitorPromise;
    clearTimeout(timeout);
    signal.removeEventListener('abort', onAbort);
    subprocess.stdout?.destroy();
    subprocess.stderr?.destroy();
    await subprocess;

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
