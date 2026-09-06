import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { commandCleanupCapability, OwnedCommandError, runOwnedCommand } from '@obversa/engine/command';

import { digestJson } from '@obversa/engine';
import { createLocalRunStorage, type LocalRunStorageOptions } from '@obversa/runtime/storage/local';
import {
  loadRunDefinition, persistRunDefinition, validateArtifactReference, validateEventStreamRef,
  type ArtifactReference, type JsonObject, type WorkspaceAnchor, type WorkspaceProvider,
  type GraphExecutorOptions, type GraphExecutorResult, type RunDefinition,
} from '@obversa/runtime';
import {
  hostModuleDigest, readGraphPosition, readSupervision, resolveHostModule, SupervisedRunError,
  supervisionWriter, supervisedElapsedMs, type SupervisedHostRecord,
} from './supervised-record.js';
import { readSupervisedRunStatus, type SupervisedRunStatus } from './supervised-status.js';

const DEFAULT_WORKER_ENVIRONMENT_VARIABLES = [
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'USERPROFILE', 'PATHEXT',
] as const;

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
  readonly environmentVariables?: readonly string[];
}

function copyEnvironmentVariables(value: unknown): string[] {
  if (value === undefined) return [];
  const names = Array.isArray(value) ? [...value] : undefined;
  if (names === undefined || names.some((name) =>
    typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))) {
    throw new SupervisedRunError('INVALID_OPTIONS', 'environmentVariables must be an array of portable environment variable names.');
  }
  return names;
}

export type SupervisedRunResult = Exclude<GraphExecutorResult, { readonly kind: 'waiting' | 'pause' }>
  | { readonly kind: 'pause'; readonly reason: string; readonly code?: 'WORKSPACE_DRIFT' | 'WORKSPACE_ANCHOR_MISSING' | 'WORKSPACE_ANCHOR_INVALID' | 'WORKSPACE_ANCHOR_WRITE' | 'RUN_STORAGE' | 'RESUME_EVENT_MISMATCH' };

export interface ResumeSupervisedRunOptions extends Omit<SupervisedRunOptions, 'definition' | 'module' | 'limits'> {
  readonly runId: string;
  readonly position: string;
}

type SupervisedTerminalRecord = Exclude<SupervisedRunResult, { readonly kind: 'complete' }>
  | { readonly kind: 'complete'; readonly outputArtifact: ArtifactReference };

export interface SupervisedWorkerInput {
  readonly runId: string;
  readonly runRoot: string;
  readonly scratchDirectory: string;
  readonly storage: LocalRunStorageOptions;
  readonly resume?: { readonly position: string; readonly pauseEventId: string };
}

export interface SupervisedRunHandle {
  readonly done: Promise<SupervisedRunResult>;
  stop(): Promise<SupervisedRunResult>;
  status(): Promise<SupervisedRunStatus>;
}

/** Start a bounded worker under this process's supervision. */
export async function startSupervisedRun(options: SupervisedRunOptions): Promise<SupervisedRunHandle> {
  return await superviseRun(options);
}

/** Reopen one recorded pause without replacing its definition or run bounds. */
export async function resumeSupervisedRun(options: ResumeSupervisedRunOptions): Promise<SupervisedRunHandle> {
  options = {
    ...options, storage: structuredClone(options.storage), restart: { ...options.restart },
    environmentVariables: copyEnvironmentVariables(options.environmentVariables),
  };
  const storage = createLocalRunStorage(options.storage);
  const storageOptions = { ...options.storage, directory: resolve(options.storage.directory) };
  const loaded = await loadRunDefinition(storage, options.runId);
  if (loaded.hostBindingBytes === null) throw new SupervisedRunError('HOST_MODULE', 'The run has no stored host module.');
  const host = JSON.parse(Buffer.from(loaded.hostBindingBytes).toString('utf8')) as SupervisedHostRecord;
  return await superviseRun({
    ...options, storage: storageOptions, module: host.module, limits: host.limits,
    definition: {
      runId: options.runId, graphDefinition: loaded.record.payload.definition.graphDefinition,
      resolvedPlan: loaded.resolvedPlan, resolvedInputs: loaded.record.payload.definition.resolvedInputs,
    },
  }, { loaded, host, position: options.position });
}

async function superviseRun(options: SupervisedRunOptions, resume?: {
  readonly loaded: Awaited<ReturnType<typeof loadRunDefinition>>;
  readonly host: SupervisedHostRecord;
  readonly position: string;
}): Promise<SupervisedRunHandle> {
  options = {
    ...options,
    definition: structuredClone(options.definition),
    storage: structuredClone(options.storage),
    limits: Object.freeze({ ...options.limits }),
    restart: Object.freeze({ ...options.restart }),
    environmentVariables: copyEnvironmentVariables(options.environmentVariables),
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
  const storageOptions = { ...options.storage, directory: resolve(options.storage.directory) };
  const runId = validateEventStreamRef({ namespace: storage.record.namespace, streamId: options.definition.runId }).streamId;
  const runRoot = await realpath(options.runRoot);
  const modulePath = resolveHostModule(runRoot, options.module);
  const host: SupervisedHostRecord = resume?.host ?? {
    schemaVersion: 1, module: options.module, digest: await hostModuleDigest(modulePath),
    cleanupCapability: commandCleanupCapability(), limits: options.limits,
  };
  if (resume !== undefined && await hostModuleDigest(modulePath) !== host.digest) {
    throw new SupervisedRunError('HOST_MODULE_CHANGED', 'The host module differs from its stored digest.');
  }
  let anchor: WorkspaceAnchor | undefined;
  if (resume === undefined) {
    try {
      anchor = await options.workspace.capture();
    } catch (cause) {
      throw new SupervisedRunError('WORKSPACE_CAPTURE', 'The workspace could not be captured.', { cause });
    }
  }
  if (anchor !== undefined && await realpath(anchor.root) !== runRoot) {
    throw new SupervisedRunError('WORKSPACE_ROOT', 'The workspace provider must own the worker root.');
  }
  const locks = join(storageOptions.directory, 'runner-locks', storage.record.namespace);
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
    let resumeInput: SupervisedWorkerInput['resume'];
    let resumeRefusal: Extract<SupervisedRunResult, { kind: 'pause' }> | undefined;
    let pauseAnchorArtifact: ArtifactReference | undefined;
    let pendingAnchor: { readonly digest: string; readonly scope: readonly string[] | null } | undefined;
    const pauseEvidence = (): JsonObject => pauseAnchorArtifact !== undefined ? { anchorArtifact: pauseAnchorArtifact }
      : pendingAnchor !== undefined ? { pendingAnchor } : {};
    let restartCount = 0;
    if (resume !== undefined) {
      const records = await readSupervision(storage, runId);
      const paused = records.at(-1);
      if (paused?.type !== 'runner:paused' || (paused.payload as JsonObject).leaseRetained === true
        || (paused.payload as JsonObject).cleanupSafe === false) {
        throw new SupervisedRunError('RUN_NOT_PAUSED', 'Resume requires a paused run with safely released ownership.');
      }
      const position = await readGraphPosition(storage, runId, resume.position);
      if (position?.type !== 'graph:node-paused') {
        throw new SupervisedRunError('RESUME_POSITION', 'Resume requires an exact recorded paused position.');
      }
      resumeInput = { position: resume.position, pauseEventId: position.eventId };
      const launch = records.findLast((event) => event.type === 'runner:worker-launching');
      restartCount = launch === undefined ? 0 : Number((launch.payload as JsonObject).restartCount);
      const saved = (paused.payload as JsonObject).anchorArtifact;
      const pending = (paused.payload as JsonObject).pendingAnchor;
      if (saved === undefined && pending === undefined) {
        resumeRefusal = { kind: 'pause', code: 'WORKSPACE_ANCHOR_MISSING', reason: 'The pause has no saved workspace anchor.' };
      } else {
        try {
          if (saved !== undefined) {
            pauseAnchorArtifact = validateArtifactReference(saved);
            if (pauseAnchorArtifact.purpose !== 'runner-pause-anchor' || pauseAnchorArtifact.mediaType !== 'application/json') {
              throw new Error('The saved reference is not a pause workspace anchor.');
            }
            const bytes = await storage.artifactStore.read({ namespace: storage.record.namespace, runId }, pauseAnchorArtifact);
            anchor = JSON.parse(Buffer.from(bytes).toString('utf8')) as WorkspaceAnchor;
          } else {
            if (pending === null || typeof pending !== 'object' || Array.isArray(pending)) {
              throw new Error('The pending pause workspace anchor has an invalid digest or scope.');
            }
            const metadata = pending as JsonObject;
            if (typeof metadata.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(metadata.digest)
              || !(metadata.scope === null || Array.isArray(metadata.scope) && metadata.scope.every((path) => typeof path === 'string'))) {
              throw new Error('The pending pause workspace anchor has an invalid digest or scope.');
            }
            pendingAnchor = { digest: metadata.digest, scope: metadata.scope as readonly string[] | null };
            try {
              anchor = await options.workspace.capture(pendingAnchor.scope ?? undefined);
            } catch (cause) {
              throw new SupervisedRunError('WORKSPACE_ANCHOR_WRITE', 'The paused workspace could not be captured for comparison.', { cause });
            }
          }
          if (anchor === null || Array.isArray(anchor) || anchor.schemaVersion !== 1
            || typeof anchor.root !== 'string' || typeof anchor.repositoryId !== 'string'
            || typeof anchor.head !== 'string' || typeof anchor.fingerprint !== 'string'
            || !(anchor.scope === null || Array.isArray(anchor.scope) && anchor.scope.every((path) => typeof path === 'string'))
            || !Array.isArray(anchor.files) || !anchor.files.every((file) => file !== null && typeof file === 'object' && !Array.isArray(file))
            || await realpath(anchor.root) !== runRoot) {
            throw new Error('The saved workspace anchor has an invalid shape or worker root.');
          }
          if (pendingAnchor !== undefined && digestJson(anchor) !== pendingAnchor.digest) {
            anchor = undefined;
            resumeRefusal = { kind: 'pause', code: 'WORKSPACE_DRIFT', reason: 'The workspace changed after the captured pause.' };
          }
        } catch (error) {
          anchor = undefined;
          resumeRefusal = pendingAnchor !== undefined && error instanceof SupervisedRunError && error.code === 'WORKSPACE_ANCHOR_WRITE'
            ? { kind: 'pause', code: error.code, reason: error.message }
            : { kind: 'pause', code: 'WORKSPACE_ANCHOR_INVALID', reason: 'The saved pause workspace anchor could not be verified.' };
        }
      }
    }
    if (anchor !== undefined) {
      const lease = await options.workspace.acquireLease(`runner:${runId}`, runId, anchor);
      if (!lease.ok) throw new SupervisedRunError('WORKSPACE_LEASE', 'The workspace lease is unavailable.');
      leaseToken = lease.token;
      const verified = await options.workspace.verify(anchor);
      if (!verified.ok) {
        if (resume === undefined) throw new SupervisedRunError('WORKSPACE_DRIFT', 'The workspace changed before the run started.');
        resumeRefusal = { kind: 'pause', code: 'WORKSPACE_DRIFT', reason: 'The workspace changed after the saved pause.' };
      }
    }
    const scratchDirectory = join(resolve(options.directory), 'scratch');
    await mkdir(scratchDirectory, { recursive: true });
    const started = resume?.loaded.record ?? await persistRunDefinition(storage, {
      ...options.definition, eventId: randomUUID(), timestamp: new Date().toISOString(),
      workspaceBinding: anchor!,
      hostBinding: { bytes: Buffer.from(JSON.stringify(host)), mediaType: 'application/json' },
    }).catch((cause: unknown) => {
      throw new SupervisedRunError('RUN_STORAGE', 'Run persistence failed; any published evidence is retained.', { cause });
    });
    const append = supervisionWriter(storage, runId);
    const cancellation = new AbortController();
    const carriedRemaining = options.limits.timeoutMs
      - supervisedElapsedMs(started.timestamp, await readSupervision(storage, runId), Date.now());
    let deadline = resume === undefined ? Date.parse(started.timestamp) + options.limits.timeoutMs : undefined;
    let leaseReleaseFailed = false;
    const release = async () => {
      if (leaseToken === undefined) return;
      try {
        const released = await options.workspace.releaseLease(leaseToken);
        if (!released.ok) throw new SupervisedRunError('WORKSPACE_RELEASE', 'The watchdog could not release its workspace lease.');
        leaseToken = undefined;
      } catch (error) { leaseReleaseFailed = true; throw error; }
    };
    const savePauseAnchor = async (snapshot?: WorkspaceAnchor): Promise<ArtifactReference> => {
      pauseAnchorArtifact = undefined;
      pendingAnchor = undefined;
      try {
        snapshot ??= await options.workspace.capture();
      } catch (cause) {
        throw new SupervisedRunError('WORKSPACE_ANCHOR_WRITE', 'The pause workspace anchor could not be captured.', { cause });
      }
      pendingAnchor = { digest: digestJson(snapshot), scope: snapshot.scope };
      try {
        pauseAnchorArtifact = await storage.artifactStore.write({ namespace: storage.record.namespace, runId }, {
          bytes: Buffer.from(JSON.stringify(snapshot)), mediaType: 'application/json', purpose: 'runner-pause-anchor', contentMode: 'state',
        });
        await append('pause-anchor', { anchorArtifact: pauseAnchorArtifact });
        pendingAnchor = undefined;
        return pauseAnchorArtifact;
      } catch (cause) {
        throw new SupervisedRunError('WORKSPACE_ANCHOR_WRITE', 'The pause workspace anchor could not be stored.', { cause });
      }
    };
    const finish = async (outcome: SupervisedTerminalRecord, details: JsonObject = {}): Promise<SupervisedRunResult> => {
      let result: SupervisedRunResult;
      if (outcome.kind === 'complete') {
        try {
          const bytes = await storage.artifactStore.read({ namespace: storage.record.namespace, runId }, outcome.outputArtifact);
          result = { kind: 'complete', output: JSON.parse(Buffer.from(bytes).toString('utf8')) };
        } catch (cause) {
          throw new SupervisedRunError('TERMINAL_ARTIFACT', 'The terminal output artifact could not be verified.', { cause });
        }
      } else result = outcome;
      const phase = outcome.kind === 'complete' ? 'completed' : outcome.kind === 'pause' ? 'paused'
        : outcome.code === 'STOPPED' ? 'stopped' : 'failed';
      const type = outcome.kind === 'complete' ? 'completed' : outcome.kind === 'pause' ? 'paused'
        : outcome.code === 'STOPPED' ? 'stopped' : outcome.code === 'TIMEOUT' ? 'timeout'
          : outcome.code === 'BUDGET_STOP' ? 'budget-stop' : 'failed';
      await append(type, { ...outcome, phase, ...details });
      return result;
    };
    const done = (async (): Promise<SupervisedRunResult> => {
      let cleanupSafe = true;
      try {
        if (resumeRefusal !== undefined) {
          await release();
          return await finish(resumeRefusal, pauseEvidence());
        }
        if (pendingAnchor !== undefined) await savePauseAnchor(anchor!);
        const input: SupervisedWorkerInput = {
          runId, runRoot, scratchDirectory, storage: storageOptions,
          ...(resumeInput === undefined ? {} : { resume: resumeInput }),
        };
        const workerEnvironment: Record<string, string> = {};
        for (const name of [...DEFAULT_WORKER_ENVIRONMENT_VARIABLES, ...options.environmentVariables ?? []]) {
          const value = process.env[name];
          if (value !== undefined) workerEnvironment[name] = value;
        }
        for (;;) {
          const remaining = deadline === undefined ? carriedRemaining : deadline - Date.now();
          if (cancellation.signal.aborted || remaining <= 0) {
            await release();
            return await finish({ kind: 'fail', code: cancellation.signal.aborted ? 'STOPPED' : 'TIMEOUT', message: 'The watchdog stopped the run.' });
          }
          const attemptId = digestJson({ worker: randomUUID() });
          const ownerId = digestJson({ owner: randomUUID() });
          try {
            await append('worker-launching', { attemptId, ownerId, restartCount, ...(resumeInput === undefined ? {} : { resume: resumeInput }) });
          } catch (cause) {
            if (resume === undefined || pauseAnchorArtifact === undefined) throw cause;
            throw new SupervisedRunError('RUN_STORAGE', 'The resume worker launch could not be recorded.', { cause });
          }
          const launch = (await readSupervision(storage, runId)).at(-1)!;
          const revision = launch.revision;
          // Set this once: replacement workers spend the same resumed interval.
          deadline ??= Date.parse(launch.timestamp) + carriedRemaining;
          const launchRemaining = deadline - Date.now();
          if (launchRemaining <= 0 || cancellation.signal.aborted) continue;
          pauseAnchorArtifact = undefined;
          pendingAnchor = undefined;
          cleanupSafe = false;
          const command = await runOwnedCommand({
            executable: process.execPath,
            args: [fileURLToPath(new URL('./dist/supervised-worker.js', import.meta.resolve('@obversa/runner/package.json')))],
            cwd: runRoot, env: workerEnvironment, inheritParentEnv: false, stdin: JSON.stringify(input), runId,
            ownerId, attemptId,
            timeoutMs: launchRemaining, teardownGraceMs: options.teardownGraceMs,
            maxOutputBytes: 1_000_000, maxMemoryBytes: Number.MAX_SAFE_INTEGER,
          }, cancellation.signal);
          cleanupSafe = command.remainingProcesses.length === 0;
          if (!cleanupSafe) throw new SupervisedRunError('TEARDOWN_INCOMPLETE', 'Owned processes remain; the lease is retained.');
          const events = await readSupervision(storage, runId);
          const record = events.findLast((event) => event.revision > revision && event.type === 'runner:worker-result');
          const result = record?.payload as SupervisedTerminalRecord | undefined;
          await append('worker-exited', { exitCode: command.exitCode, restartCount });
          if (result !== undefined) {
            const details: JsonObject = result.kind === 'pause'
              ? { anchorArtifact: await savePauseAnchor() } : {};
            await release();
            return await finish(result, details);
          }
          if (cancellation.signal.aborted || command.timedOut) {
            await release();
            return await finish({ kind: 'fail', code: cancellation.signal.aborted ? 'STOPPED' : 'TIMEOUT', message: 'The watchdog stopped the run.' });
          }
          await append('worker-crashed', { exitCode: command.exitCode, restartCount });
          if (restartCount >= options.restart.maxRestarts) {
            await release();
            return await finish({ kind: 'fail', code: 'RESTART_EXHAUSTED', message: 'The worker restart limit was reached.' });
          }
          try {
            anchor = await options.workspace.capture();
          } catch (cause) {
            throw new SupervisedRunError('WORKSPACE_ANCHOR_WRITE', 'The restart workspace anchor could not be captured.', { cause });
          }
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
            const anchorArtifact = await savePauseAnchor(anchor);
            await release();
            return await finish({ kind: 'pause', code: 'WORKSPACE_DRIFT', reason: 'The workspace changed while the restart lease was released.' }, { anchorArtifact });
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
        if (cleanupSafe && !leaseReleaseFailed && error instanceof SupervisedRunError
          && (error.code === 'WORKSPACE_ANCHOR_WRITE' || error.code === 'RUN_STORAGE')
          && (pauseAnchorArtifact !== undefined || pendingAnchor !== undefined)) {
          return await finish({ kind: 'pause', code: error.code, reason: error.message }, {
            ...pauseEvidence(), cleanupSafe, leaseRetained: false,
          });
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
      status: async () => await readSupervisedRunStatus({ storage: storageOptions, runId }),
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
