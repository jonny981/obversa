import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import type { OwnedCommandError, ProcessIdentity, runOwnedCommand } from '@obversa/core/command';

import type { SupervisedRunOptions, SupervisedRunResult } from '../src/supervised-run.js';

export interface CommandFailure {
  attemptId: string;
  ownerId?: string;
  code: string;
  message: string;
  stack?: string;
  remainingProcesses: readonly ProcessIdentity[];
}

/** Preserve the real command failure before the watchdog replaces its message. */
export async function captureCommandFailure(
  run: typeof runOwnedCommand,
  args: Parameters<typeof runOwnedCommand>,
  failures: CommandFailure[],
): ReturnType<typeof runOwnedCommand> {
  try {
    const result = await run(...args);
    if (result.remainingProcesses.length > 0) failures.push({
      attemptId: args[0].attemptId,
      ownerId: args[0].ownerId,
      code: 'RETURNED_SURVIVORS',
      message: 'The command returned remaining processes.',
      remainingProcesses: result.remainingProcesses.slice(0, 16),
    });
    return result;
  } catch (error) {
    const failure = error as Partial<OwnedCommandError>;
    failures.push({
      attemptId: args[0].attemptId,
      ownerId: args[0].ownerId,
      code: String(failure?.code ?? 'UNKNOWN'),
      message: String(failure?.message ?? error).slice(0, 1000),
      stack: failure?.stack?.split('\n').slice(0, 8).join('\n'),
      remainingProcesses: failure?.remainingProcesses?.slice(0, 16) ?? [],
    });
    throw error;
  } finally {
    if (failures.length > 8) failures.splice(0, failures.length - 8);
  }
}

async function processEvidence(identity: ProcessIdentity) {
  try {
    // Avoid describing a different process which has reused the recorded pid.
    const { readProcessIdentity } = await import('@obversa/core/command');
    const current = readProcessIdentity(identity.pid);
    if (current?.startedAt !== identity.startedAt) return { ...identity, detail: 'exited or pid reused' };
    if (process.platform !== 'linux') return {
      ...identity,
      command: execFileSync('ps', ['-p', String(identity.pid), '-o', 'comm='], { encoding: 'utf8', timeout: 1000 }).trim(),
      detail: 'Environment markers sampled only on Linux',
    };
    const stat = await readFile(`/proc/${identity.pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const command = (await readFile(`/proc/${identity.pid}/cmdline`, 'utf8')).replaceAll('\0', ' ').slice(0, 1000);
    const markers = (await readFile(`/proc/${identity.pid}/environ`, 'utf8')).split('\0')
      .filter((entry) => /^(OBVERSA_ATTEMPT_ID|OBVERSA_RUN_OWNER)=/.test(entry));
    return { ...identity, state: fields[0], startTicks: fields[19], command, markers };
  } catch (error) {
    return { ...identity, detail: (error as NodeJS.ErrnoException).code ?? String(error) };
  }
}

/** No extra reads on success, and no diagnostic failure replaces the assertion. */
export async function teardownEvidence(
  result: SupervisedRunResult,
  options: Pick<SupervisedRunOptions, 'storage'> & { definition: { runId: string } },
  failures: readonly CommandFailure[],
): Promise<string> {
  if (result.kind !== 'fail' || result.code !== 'TEARDOWN_INCOMPLETE') return '';
  try {
    const { createLocalRunStorage } = await import('@obversa/runtime/storage/local');
    const { readSupervision } = await import('../src/supervised-record.js');
    const events = await readSupervision(createLocalRunStorage(options.storage), options.definition.runId);
    const lastKnownWorker = (events.findLast((event) => event.type === 'runner:worker-started')?.payload as
      { process?: ProcessIdentity } | undefined)?.process;
    const recordedRemaining = (events.at(-1)?.payload as
      { remainingProcesses?: ProcessIdentity[] } | undefined)?.remainingProcesses ?? [];
    const processes = new Map([
      ...failures.flatMap((failure) => failure.remainingProcesses),
      ...recordedRemaining.slice(0, 16),
      ...(lastKnownWorker === undefined ? [] : [lastKnownWorker]),
    ].map((identity) => [`${identity.pid}:${identity.startedAt}`, identity]));
    return `Supervised teardown evidence (command boundary, not internal stop trace):\n${JSON.stringify({
      result,
      platform: process.platform,
      node: process.version,
      commandFailures: failures,
      lastKnownWorker,
      processes: await Promise.all([...processes.values()].map(processEvidence)),
      events: events.slice(-16).map((event) => ({
        type: event.type,
        revision: event.revision,
        payload: Object.fromEntries(Object.entries(event.payload as Record<string, unknown>).filter(([key]) =>
          ['kind', 'code', 'message', 'phase', 'cleanupSafe', 'leaseRetained', 'remainingProcesses',
            'attemptId', 'ownerId', 'restartCount', 'exitCode', 'process'].includes(key))),
      })),
    }, null, 2)}`;
  } catch (error) {
    return `Supervised teardown evidence unavailable: ${String(error)}\n${JSON.stringify({ result, commandFailures: failures }, null, 2)}`;
  }
}
