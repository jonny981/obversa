import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { commandCleanupCapability, OwnedCommandError, runOwnedCommand } from '@obversa/engine/command';

import { digestJson } from '@obversa/engine';
import { createLocalRunStorage, type LocalRunStorageOptions } from '@obversa/runtime/storage/local';
import {
  persistRunDefinition, validateEventStreamRef, type JsonObject, type WorkspaceProvider,
  type GraphExecutorOptions, type GraphExecutorResult, type RunDefinition,
} from '@obversa/runtime';
import {
  hostModuleDigest, readSupervision, resolveHostModule, SupervisedRunError,
  supervisionWriter, type SupervisedHostRecord,
} from './supervised-record.js';
import { readSupervisedRunStatus, type SupervisedRunStatus } from './supervised-status.js';

export type SupervisedRunBindings = Omit<GraphExecutorOptions, 'runId' | 'storage'>;
type PersistRunDefinitionInput = Parameters<typeof persistRunDefinition>[1];

export interface SupervisedHostContext {
  readonly definition: RunDefinition;
  readonly scratchDirectory: string;
}

export interface SupervisedRunOptions {
  readonly directory: string;
  readonly runRoot: string;
  readonly module: string;
  readonly storage: LocalRunStorageOptions;
  readonly workspace: WorkspaceProvider;
  readonly definition: Omit<PersistRunDefinitionInput,
    'eventId' | 'timestamp' | 'workspaceBinding' | 'hostBinding'>;
  readonly limits: { readonly timeoutMs: number; readonly maxDispatches: number };
  readonly restart: {
    readonly maxRestarts: number;
    readonly initialBackoffMs: number;
    readonly maxBackoffMs: number;
  };
  readonly teardownGraceMs: number;
}

export type SupervisedRunResult = Exclude<GraphExecutorResult, { readonly kind: 'waiting' | 'pause' }>
  | { readonly kind: 'pause'; readonly reason: string; readonly code?: 'WORKSPACE_DRIFT' };

export interface SupervisedWorkerInput {
  readonly runId: string;
  readonly runRoot: string;
  readonly scratchDirectory: string;
  readonly storage: LocalRunStorageOptions;
}

export interface SupervisedRunHandle {
  readonly done: Promise<SupervisedRunResult>;
  stop(): Promise<SupervisedRunResult>;
  status(): Promise<SupervisedRunStatus>;
}

/** Start a bounded worker under this process's supervision. */
export async function startSupervisedRun(options: SupervisedRunOptions): Promise<SupervisedRunHandle> {
  options = {
    ...options,
    definition: structuredClone(options.definition),
    storage: structuredClone(options.storage),
    limits: Object.freeze({ ...options.limits }),
    restart: Object.freeze({ ...options.restart }),
  };
  for (const [field, value] of Object.entries({ ...options.limits, ...options.restart, teardownGraceMs: options.teardownGraceMs })) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
      throw new SupervisedRunError('INVALID_OPTIONS', `${field} must be a non-negative bounded integer.`);
    }
  }
  if (options.limits.timeoutMs < 1 || options.restart.maxBackoffMs < options.restart.initialBackoffMs) {
    throw new SupervisedRunError('INVALID_OPTIONS', 'Timeout must be positive and backoff bounds ordered.');
  }
  if (options.limits.timeoutMs + options.teardownGraceMs > 2_147_483_647) {
    throw new SupervisedRunError('INVALID_OPTIONS', 'Timeout plus teardown grace must fit a Node timer.');
  }
  const storage = createLocalRunStorage(options.storage);
  const runId = validateEventStreamRef({ namespace: storage.record.namespace, streamId: options.definition.runId }).streamId;
  const runRoot = await realpath(options.runRoot);
  const modulePath = resolveHostModule(runRoot, options.module);
  const host: SupervisedHostRecord = {
    schemaVersion: 1, module: options.module, digest: await hostModuleDigest(modulePath),
    cleanupCapability: commandCleanupCapability(), limits: options.limits,
  };
  let anchor;
  try {
    anchor = await options.workspace.capture();
  } catch (cause) {
    throw new SupervisedRunError('WORKSPACE_CAPTURE', 'The workspace could not be captured.', { cause });
  }
  if (await realpath(anchor.root) !== runRoot) {
    throw new SupervisedRunError('WORKSPACE_ROOT', 'The workspace provider must own the worker root.');
  }
  const locks = join(resolve(options.storage.directory), 'runner-locks', storage.record.namespace);
  const lock = join(locks, runId);
  await mkdir(locks, { recursive: true });
  try {
    await mkdir(lock);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
    throw new SupervisedRunError('PROCESS_LOCKED', 'This run already has a watchdog.', { cause });
  }
  let leaseToken: string | undefined;
  try {
    const lease = await options.workspace.acquireLease(`runner:${runId}`, runId, anchor);
    if (!lease.ok) throw new SupervisedRunError('WORKSPACE_LEASE', 'The workspace lease is unavailable.');
    leaseToken = lease.token;
    const verified = await options.workspace.verify(anchor);
    if (!verified.ok) throw new SupervisedRunError('WORKSPACE_DRIFT', 'The workspace changed before the run started.');
    const scratchDirectory = join(resolve(options.directory), 'scratch');
    await mkdir(scratchDirectory, { recursive: true });
    const started = await persistRunDefinition(storage, {
      ...options.definition, eventId: randomUUID(), timestamp: new Date().toISOString(),
      workspaceBinding: anchor,
      hostBinding: { bytes: Buffer.from(JSON.stringify(host)), mediaType: 'application/json' },
    }).catch((cause: unknown) => {
      throw new SupervisedRunError('RUN_STORAGE', 'Run persistence failed; any published evidence is retained.', { cause });
    });
    const append = supervisionWriter(storage, runId);
    let restartCount = 0;
    const cancellation = new AbortController();
    const deadline = Date.parse(started.timestamp) + options.limits.timeoutMs;
    let leaseReleaseFailed = false;
    const release = async () => {
      if (leaseToken === undefined) return;
      try {
        const released = await options.workspace.releaseLease(leaseToken);
        if (!released.ok) throw new SupervisedRunError('WORKSPACE_RELEASE', 'The watchdog could not release its workspace lease.');
        leaseToken = undefined;
      } catch (error) { leaseReleaseFailed = true; throw error; }
    };
    const finish = async (outcome: SupervisedRunResult, details: JsonObject = {}) => {
      const phase = outcome.kind === 'complete' ? 'completed' : outcome.kind === 'pause' ? 'paused'
        : outcome.code === 'STOPPED' ? 'stopped' : 'failed';
      const type = outcome.kind === 'complete' ? 'completed' : outcome.kind === 'pause' ? 'paused'
        : outcome.code === 'STOPPED' ? 'stopped' : outcome.code === 'TIMEOUT' ? 'timeout'
          : outcome.code === 'BUDGET_STOP' ? 'budget-stop' : 'failed';
      await append(type, { ...outcome, phase, ...details });
      return outcome;
    };
    const done = (async (): Promise<SupervisedRunResult> => {
      let cleanupSafe = true;
      try {
        const input: SupervisedWorkerInput = {
          runId, runRoot, scratchDirectory, storage: options.storage,
        };
        for (;;) {
          const remaining = deadline - Date.now();
          if (cancellation.signal.aborted || remaining <= 0) {
            await release();
            return await finish({ kind: 'fail', code: cancellation.signal.aborted ? 'STOPPED' : 'TIMEOUT', message: 'The watchdog stopped the run.' });
          }
          const attemptId = digestJson({ worker: randomUUID() });
          const ownerId = digestJson({ owner: randomUUID() });
          await append('worker-launching', { attemptId, ownerId, restartCount });
          const revision = (await readSupervision(storage, runId)).at(-1)?.revision ?? 0;
          const launchRemaining = deadline - Date.now();
          if (launchRemaining <= 0 || cancellation.signal.aborted) continue;
          cleanupSafe = false;
          const command = await runOwnedCommand({
            executable: process.execPath,
            args: [fileURLToPath(new URL('./dist/supervised-worker.js', import.meta.resolve('@obversa/runner/package.json')))],
            cwd: runRoot, env: {}, stdin: JSON.stringify(input), runId,
            ownerId, attemptId,
            timeoutMs: launchRemaining, teardownGraceMs: options.teardownGraceMs,
            maxOutputBytes: 1_000_000, maxMemoryBytes: Number.MAX_SAFE_INTEGER,
          }, cancellation.signal);
          cleanupSafe = command.remainingProcesses.length === 0;
          if (!cleanupSafe) throw new SupervisedRunError('TEARDOWN_INCOMPLETE', 'Owned processes remain; the lease is retained.');
          const events = await readSupervision(storage, runId);
          const record = events.findLast((event) => event.revision > revision && event.type === 'runner:worker-result');
          const result = record?.payload as SupervisedRunResult | undefined;
          await append('worker-exited', { exitCode: command.exitCode, restartCount });
          if (cancellation.signal.aborted || command.timedOut) {
            await release();
            return await finish({ kind: 'fail', code: cancellation.signal.aborted ? 'STOPPED' : 'TIMEOUT', message: 'The watchdog stopped the run.' });
          }
          if (result !== undefined) { await release(); return await finish(result); }
          await append('worker-crashed', { exitCode: command.exitCode, restartCount });
          if (restartCount >= options.restart.maxRestarts) {
            await release();
            return await finish({ kind: 'fail', code: 'RESTART_EXHAUSTED', message: 'The worker restart limit was reached.' });
          }
          anchor = await options.workspace.capture();
          await append('restart-anchor', { anchor, restartCount });
          await release();
          const backoffMs = Math.min(options.restart.maxBackoffMs, options.restart.initialBackoffMs * 2 ** restartCount);
          await append('backoff', { delayMs: backoffMs, restartCount, until: new Date(Date.now() + backoffMs).toISOString() });
          await delay(Math.min(backoffMs, Math.max(0, deadline - Date.now())), undefined, { signal: cancellation.signal })
            .catch((error) => { if (!cancellation.signal.aborted) throw error; });
          if (cancellation.signal.aborted || Date.now() >= deadline) continue;
          const replacementLease = await options.workspace.acquireLease(`runner:${runId}`, runId, anchor);
          if (!replacementLease.ok) throw new SupervisedRunError('WORKSPACE_LEASE', 'The workspace lease is unavailable for restart.');
          leaseToken = replacementLease.token;
          const replacementVerified = await options.workspace.verify(anchor);
          if (!replacementVerified.ok) {
            await release();
            return await finish({ kind: 'pause', code: 'WORKSPACE_DRIFT', reason: 'The workspace changed while the restart lease was released.' });
          }
          restartCount += 1;
        }
      } catch (error) {
        if (error instanceof OwnedCommandError) {
          cleanupSafe = error.remainingProcesses.length === 0 && [
            'INVALID_EXECUTABLE', 'INVALID_COMMAND', 'SPAWN_FAILED', 'OUTPUT_LIMIT', 'MEMORY_LIMIT',
          ].includes(error.code);
        }
        if (cleanupSafe && !leaseReleaseFailed) {
          try { await release(); } catch { /* Keep the first failure and record the retained lease below. */ }
        }
        return await finish({
          kind: 'fail', code: error instanceof SupervisedRunError || error instanceof OwnedCommandError ? error.code : 'WATCHDOG_ERROR',
          message: 'The watchdog could not continue the run.',
        }, {
          cleanupSafe, leaseRetained: leaseToken !== undefined,
          ...(leaseReleaseFailed ? { releaseFailure: 'WORKSPACE_RELEASE' } : {}),
          remainingProcesses: error instanceof OwnedCommandError ? error.remainingProcesses : [],
        });
      } finally {
        if (cleanupSafe && !leaseReleaseFailed) {
          await release();
          await rmdir(lock);
        }
      }
    })();
    void done.catch(() => {});
    return Object.freeze({
      done,
      stop: async () => { cancellation.abort(); return await done; },
      status: async () => await readSupervisedRunStatus({ storage: options.storage, runId }),
    });
  } catch (error) {
    if (leaseToken !== undefined) {
      try {
        const released = await options.workspace.releaseLease(leaseToken);
        if (!released.ok) throw new Error('The provider refused to release the startup lease.');
      } catch (releaseError) {
        throw new SupervisedRunError('WORKSPACE_RELEASE', 'Startup failed and its lease could not be released; the process lock is retained.', {
          cause: new AggregateError([error, releaseError]),
        });
      }
    }
    await rmdir(lock);
    throw error;
  }
}

export { SupervisedRunError } from './supervised-record.js';
