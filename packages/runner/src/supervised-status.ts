import {
  inspectOwnedProcessTree,
  type CommandCleanupCapability,
  type ProcessIdentity,
} from '@obversa/engine/command';

import { loadRunDefinition, type DomainEventEnvelope, type UsageReceipt, type JsonObject, type Sha256Digest } from '@obversa/runtime';
import { createLocalRunStorage, type LocalRunStorageOptions } from '@obversa/runtime/storage/local';
import { readSupervision, type SupervisedHostRecord } from './supervised-record.js';
import { localSupervisedCheckpoint } from './supervised-checkpoint.js';

export interface SupervisedRunStatus {
  readonly phase: 'starting' | 'running' | 'recovering' | 'backoff' | 'completed' | 'paused' | 'failed' | 'stopped';
  readonly cleanupCapability: CommandCleanupCapability;
  readonly workerAlive: boolean;
  readonly cleanupVerified: boolean | null;
  readonly leaseRetained: boolean;
  readonly processes: readonly ProcessIdentity[];
  readonly elapsedMs: number;
  readonly remainingTimeoutMs: number;
  readonly restartCount: number;
  readonly backoff: { readonly until: string; readonly remainingMs: number } | null;
  readonly pauseReasons: readonly string[];
  readonly active: readonly {
    readonly nodeId: string;
    readonly position: string;
    readonly phase: { readonly id: string; readonly name: string };
    readonly startedAt: string;
    readonly elapsedMs: number;
    readonly remainingTimeoutMs: number | null;
    readonly usage: UsageReceipt;
  }[];
  readonly usage: readonly { readonly nodeId: string; readonly usage: UsageReceipt }[];
}

export interface ReadSupervisedRunStatusOptions {
  readonly storage: LocalRunStorageOptions;
  readonly runId: string;
}

/** Read durable execution state together with a fresh process inspection. */
export async function readSupervisedRunStatus(options: ReadSupervisedRunStatusOptions): Promise<SupervisedRunStatus> {
  const storage = createLocalRunStorage(options.storage);
  const loaded = await loadRunDefinition(storage, options.runId);
  const host = JSON.parse(Buffer.from(loaded.hostBindingBytes!).toString('utf8')) as SupervisedHostRecord;
  const records = await readSupervision(storage, options.runId);
  const usageTotals = new Map<string, { pending: number; unknown: boolean; calls: number; input: number; output: number }>();
  for (const record of records) {
    if (!['runner:engine-started', 'runner:engine-completed', 'runner:engine-failed'].includes(record.type)) continue;
    const payload = record.payload as JsonObject;
    const nodeId = String(payload.nodeId);
    const total = usageTotals.get(nodeId) ?? { pending: 0, unknown: false, calls: 0, input: 0, output: 0 };
    if (record.type === 'runner:engine-started') { total.pending += 1; total.calls += 1; }
    else {
      total.pending -= 1;
      const receipt = payload.usage as UsageReceipt;
      if (receipt.kind === 'unknown') total.unknown = true;
      else { total.input += receipt.inputTokens; total.output += receipt.outputTokens; }
    }
    usageTotals.set(nodeId, total);
  }
  const usage = loaded.resolvedPlan.plan.nodes.map((node) => {
    const total = usageTotals.get(node.id);
    const receipt: UsageReceipt = total === undefined || total.calls === 0 || total.pending !== 0 || total.unknown
      || !Number.isSafeInteger(total.input) || !Number.isSafeInteger(total.output)
      ? { kind: 'unknown' } : { kind: 'reported', inputTokens: total.input, outputTokens: total.output };
    return { nodeId: node.id, usage: receipt };
  });
  const started = records.find((event) => event.type === 'runner:started');
  const launch = records.findLast((event) => event.type === 'runner:worker-launching');
  const worker = records.findLast((event) => event.type === 'runner:worker-started');
  const exited = records.findLast((event) => event.type === 'runner:worker-exited');
  const terminal = records.findLast((event) => [
    'runner:completed', 'runner:paused', 'runner:failed', 'runner:stopped', 'runner:timeout', 'runner:budget-stop',
  ].includes(event.type));
  const backedOff = records.findLast((event) => event.type === 'runner:backoff');
  let processes: readonly ProcessIdentity[] = [];
  let workerAlive = false;
  if (terminal !== undefined && (terminal.payload as JsonObject).cleanupSafe === false && launch !== undefined) {
    const observed = (terminal.payload as JsonObject).remainingProcesses as readonly ProcessIdentity[];
    const root = observed[0];
    if (root !== undefined) {
      const inspected = await inspectOwnedProcessTree({
        rootPid: root.pid, rootProcessGroupId: root.processGroupId, observed,
        attemptId: (launch.payload as JsonObject).attemptId as Sha256Digest,
      });
      processes = inspected.filter((item) => observed.some((saved) => saved.pid === item.pid && saved.startedAt === item.startedAt));
      const recordedWorker = (worker?.payload as JsonObject | undefined)?.process as ProcessIdentity | undefined;
      workerAlive = recordedWorker !== undefined && processes.some((item) => item.pid === recordedWorker.pid && item.startedAt === recordedWorker.startedAt);
    }
  } else if (terminal === undefined && worker !== undefined && launch !== undefined
    && worker.revision > launch.revision && worker.revision > (exited?.revision ?? 0)) {
    const recorded = (worker.payload as JsonObject).process as ProcessIdentity;
    const inspected = await inspectOwnedProcessTree({
      rootPid: recorded.pid, rootProcessGroupId: recorded.processGroupId,
      attemptId: (launch.payload as JsonObject).attemptId as Sha256Digest,
    });
    workerAlive = inspected.some((item) => item.pid === recorded.pid && item.startedAt === recorded.startedAt);
    if (workerAlive) processes = inspected;
  }
  const now = Date.now();
  const end = terminal === undefined ? now : Date.parse(terminal.timestamp);
  const startedAt = started?.timestamp ?? loaded.record.timestamp;
  const elapsedMs = Math.max(0, end - Date.parse(startedAt));
  const backoff = terminal === undefined && backedOff !== undefined && backedOff.revision > (launch?.revision ?? 0)
    ? { until: String((backedOff.payload as JsonObject).until), remainingMs: Math.max(0, Date.parse(String((backedOff.payload as JsonObject).until)) - now) }
    : null;
  const graphEvents: DomainEventEnvelope[] = [];
  for await (const event of storage.eventStore.read({ namespace: storage.record.namespace, streamId: options.runId })) {
    graphEvents.push(event);
  }
  const folded = await localSupervisedCheckpoint(options.storage.directory, storage.record.namespace, graphEvents);
  const bound = records.findLast((event) => event.type === 'runner:bound');
  const timeouts = (bound?.payload as JsonObject | undefined)?.timeouts as JsonObject | undefined;
  const active = workerAlive && terminal === undefined ? folded.active.map((item) => {
    const node = loaded.resolvedPlan.plan.nodes.find((node) => node.id === item.nodeId)!;
    const phase = loaded.resolvedPlan.plan.phases.find((phase) => phase.id === node.phaseId)!;
    const nodeElapsed = Math.max(0, now - Date.parse(item.startedAt));
    const timeout = timeouts?.[item.nodeId];
    return {
      nodeId: item.nodeId, position: item.position, phase: { id: phase.id, name: phase.name },
      startedAt: item.startedAt, elapsedMs: nodeElapsed,
      remainingTimeoutMs: typeof timeout === 'number' ? Math.max(0, timeout - nodeElapsed) : null,
      usage: usage.find((item) => item.nodeId === node.id)!.usage,
    };
  }) : [];
  const phase: SupervisedRunStatus['phase'] = terminal !== undefined
    ? (terminal.payload as JsonObject).phase as SupervisedRunStatus['phase']
    : backoff !== null ? 'backoff' : workerAlive ? 'running' : launch === undefined ? 'starting' : 'recovering';
  return {
    phase, cleanupCapability: host.cleanupCapability, workerAlive, processes,
    elapsedMs, remainingTimeoutMs: Math.max(0, host.limits.timeoutMs - elapsedMs),
    restartCount: launch === undefined ? 0 : Number((launch.payload as JsonObject).restartCount),
    backoff,
    pauseReasons: terminal?.type === 'runner:paused'
      ? [...new Set([...Object.values(folded.paused), String((terminal.payload as JsonObject).reason)])]
      : Object.values(folded.paused),
    active, usage,
    cleanupVerified: terminal === undefined ? null : (terminal.payload as JsonObject).cleanupSafe !== false,
    leaseRetained: terminal !== undefined && (terminal.payload as JsonObject).leaseRetained === true,
  };
}
