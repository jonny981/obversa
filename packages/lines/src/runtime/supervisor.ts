/** Filesystem-backed status for a run that another process can inspect. */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  JobMeta,
  LoopEvent,
  Outcome,
  ProofRecord,
} from '../core/types.js';

const NOISE: ReadonlySet<LoopEvent['kind']> = new Set([
  'engine:text',
  'engine:thinking',
]);
const PROGRESS_TAIL = 200;
const PROGRESS_TAIL_BYTES = 256 * 1024;

export function runsHome(): string {
  return join(process.env.LINES_HOME ?? join(homedir(), '.lines'), 'runs');
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'run'
  );
}

export function newRunId(title: string): string {
  return `${slug(title)}-${randomBytes(3).toString('hex')}`;
}

export interface CurrentWork {
  kind: 'job' | 'dag-node';
  path: string[];
  label?: string;
  node?: string;
  startedAt: number;
  timeoutMs?: number;
  deadlineAt?: number;
}

export interface RunLive {
  path: string[];
  iteration: number;
  current?: CurrentWork;
  active?: Record<string, CurrentWork>;
  lastGate?: {
    which: string;
    met: boolean;
    confidence?: number;
    reason: string;
  };
  lastOutcome?: { status: string; summary?: string; late?: boolean };
  usage: {
    inputTokens: number;
    outputTokens: number;
    calls: number;
    unknownUsageCalls: number;
  };
}

export interface RunStatus {
  runId: string;
  pid: number;
  cwd: string;
  title: string;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  status: 'running' | Outcome['status'];
  alive?: boolean;
  shape?: JobMeta;
  live: RunLive;
  evidence?: {
    count: number;
    indexPath: string;
    latest?: ProofRecord;
  };
}

export interface Supervisor {
  runId: string;
  dir: string;
  sink: (event: LoopEvent) => void;
  finish: (outcome: Outcome) => void;
}

export function startSupervisor(input: {
  runId: string;
  cwd: string;
  title: string;
  shape?: JobMeta;
}): Supervisor {
  const dir = join(runsHome(), input.runId);
  const eventsPath = join(dir, 'events.jsonl');
  const proofsPath = join(dir, 'proofs.jsonl');
  const statusPath = join(dir, 'status.json');
  mkdirSync(dir, { recursive: true });
  writeBestEffort(eventsPath, '');
  writeBestEffort(proofsPath, '');

  const startedAt = Date.now();
  const status: RunStatus = {
    runId: input.runId,
    pid: process.pid,
    cwd: input.cwd,
    title: input.title,
    startedAt,
    updatedAt: startedAt,
    status: 'running',
    shape: input.shape,
    live: {
      path: [],
      iteration: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        calls: 0,
        unknownUsageCalls: 0,
      },
    },
  };
  const active = new Map<string, CurrentWork>();
  let proofCount = 0;

  const writeStatus = () => {
    status.updatedAt = Date.now();
    writeBestEffort(statusPath, JSON.stringify(status, null, 2));
  };
  const refreshCurrent = () => {
    status.live.active = active.size
      ? Object.fromEntries(active.entries())
      : undefined;
    status.live.current = [...active.values()].sort((a, b) => {
      const deadline =
        (a.deadlineAt ?? Number.POSITIVE_INFINITY) -
        (b.deadlineAt ?? Number.POSITIVE_INFINITY);
      return deadline || b.startedAt - a.startedAt;
    })[0];
  };
  const activeKey = (kind: CurrentWork['kind'], path: readonly string[]) =>
    `${kind}:${path.join('\u0000')}`;

  writeStatus();

  const sink = (event: LoopEvent) => {
    if (!NOISE.has(event.kind)) appendBestEffort(eventsPath, event);

    switch (event.kind) {
      case 'loop:iteration':
        status.live.path = event.path;
        status.live.iteration = event.iteration;
        break;
      case 'loop:condition':
        status.live.lastGate = {
          which: event.which,
          met: event.result.met,
          confidence: event.result.confidence,
          reason: event.result.reason,
        };
        break;
      case 'condition:result':
        status.live.lastGate = {
          which: event.label,
          met: event.result.met,
          confidence: event.result.confidence,
          reason: event.result.reason,
        };
        break;
      case 'dag:node': {
        const path = [...event.path, event.node];
        status.live.path = path;
        if (event.phase === 'start') {
          active.set(activeKey('dag-node', path), {
            kind: 'dag-node',
            path,
            node: event.node,
            startedAt: event.ts,
            timeoutMs: event.timeoutMs,
            deadlineAt: event.timeoutMs ? event.ts + event.timeoutMs : undefined,
          });
        } else {
          active.delete(activeKey('dag-node', path));
        }
        refreshCurrent();
        break;
      }
      case 'job:start': {
        const path = [...event.path, event.label];
        active.set(activeKey('job', path), {
          kind: 'job',
          path: event.path,
          label: event.label,
          startedAt: event.ts,
          timeoutMs: event.timeoutMs,
          deadlineAt: event.timeoutMs ? event.ts + event.timeoutMs : undefined,
        });
        refreshCurrent();
        break;
      }
      case 'loop:end':
      case 'dag:end':
      case 'job:end':
        status.live.path = event.path;
        status.live.lastOutcome = outcomeSummary(event.outcome);
        if (event.kind === 'job:end') {
          active.delete(activeKey('job', [...event.path, event.label]));
          refreshCurrent();
        }
        break;
      case 'engine:usage':
        status.live.usage.calls += 1;
        if (event.usage.kind === 'unknown') {
          status.live.usage.unknownUsageCalls += 1;
        } else {
          status.live.usage.inputTokens += event.usage.inputTokens;
          status.live.usage.outputTokens += event.usage.outputTokens;
        }
        break;
      case 'proof': {
        const proof: ProofRecord = {
          name: event.name,
          path: event.path,
          artifact: event.artifact,
        };
        proofCount += 1;
        appendBestEffort(proofsPath, proof);
        status.evidence = {
          count: proofCount,
          indexPath: proofsPath,
          latest: proof,
        };
        break;
      }
    }

    if (!NOISE.has(event.kind)) writeStatus();
  };

  const finish = (outcome: Outcome) => {
    status.status = outcome.status;
    status.endedAt = Date.now();
    status.live.current = undefined;
    status.live.active = undefined;
    status.live.lastOutcome = outcomeSummary(outcome);
    writeStatus();
  };

  return { runId: input.runId, dir, sink, finish };
}

function outcomeSummary(outcome: Outcome): RunLive['lastOutcome'] {
  return {
    status: outcome.status,
    summary: outcome.summary,
    late: outcome.late,
  };
}

function writeBestEffort(path: string, text: string): void {
  try {
    writeFileSync(path, text);
  } catch {
    // Supervision must not stop the run.
  }
}

function appendBestEffort(path: string, value: unknown): void {
  try {
    appendFileSync(path, `${JSON.stringify(value)}\n`);
  } catch {
    // Supervision must not stop the run.
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readRunStatus(runId: string): RunStatus | undefined {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(runId)) return undefined;
  try {
    const status = JSON.parse(
      readFileSync(join(runsHome(), runId, 'status.json'), 'utf8'),
    ) as RunStatus;
    status.alive = status.status === 'running' ? isAlive(status.pid) : false;
    return status;
  } catch {
    return undefined;
  }
}

export function listRuns(): RunStatus[] {
  if (!existsSync(runsHome())) return [];
  return readdirSync(runsHome())
    .map(readRunStatus)
    .filter((status): status is RunStatus => status !== undefined)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function runEventsPath(runId: string): string {
  return join(runsHome(), runId, 'events.jsonl');
}

export function runEvidenceIndexPath(runId: string): string {
  return join(runsHome(), runId, 'proofs.jsonl');
}

export interface RunProgress {
  runId: string;
  status: RunStatus['status'];
  alive?: boolean;
  title: string;
  stage: string;
  iteration: number;
  lastGate?: RunLive['lastGate'];
  lastOutcome?: RunLive['lastOutcome'];
  usage: RunLive['usage'];
  current?: RunLive['current'] & {
    elapsedMs: number;
    remainingMs?: number;
  };
  evidence?: RunStatus['evidence'];
  startedAt: number;
  updatedAt: number;
  blocker?: {
    kind: 'gate-failing' | 'limit-pause' | 'error';
    detail: string;
  };
  recent: string[];
}

function readEventTail(runId: string): LoopEvent[] {
  let raw: string;
  try {
    const fd = openSync(runEventsPath(runId), 'r');
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - PROGRESS_TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      readSync(fd, buffer, 0, buffer.length, start);
      raw = buffer.toString('utf8');
      if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }

  const events: LoopEvent[] = [];
  for (const line of raw.split('\n').slice(-PROGRESS_TAIL)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as LoopEvent);
    } catch {
      // Ignore a partial last line.
    }
  }
  return events;
}

function deriveBlocker(
  status: RunStatus['status'],
  events: LoopEvent[],
  live: RunLive,
): RunProgress['blocker'] {
  if (status === 'pass') return undefined;
  let progressSince = false;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.kind === 'limit:pause')
      return { kind: 'limit-pause', detail: event.reason };
    if (event.kind === 'error' && !progressSince)
      return { kind: 'error', detail: event.message };
    if (
      event.kind === 'loop:iteration' ||
      event.kind === 'dag:node' ||
      ((event.kind === 'loop:end' || event.kind === 'dag:end') &&
        event.outcome.status === 'pass')
    )
      progressSince = true;
  }
  if (live.lastGate?.met === false)
    return { kind: 'gate-failing', detail: live.lastGate.reason };
  return undefined;
}

export function readRunProgress(
  runId: string,
  options?: { recent?: number },
): RunProgress | undefined {
  const status = readRunStatus(runId);
  if (!status) return undefined;
  const events = readEventTail(runId);
  const now = Date.now();
  const current = status.live.current
    ? {
        ...status.live.current,
        elapsedMs: Math.max(0, now - status.live.current.startedAt),
        remainingMs: status.live.current.deadlineAt
          ? Math.max(0, status.live.current.deadlineAt - now)
          : undefined,
      }
    : undefined;
  return {
    runId: status.runId,
    status: status.status,
    alive: status.alive,
    title: status.title,
    stage: status.live.path.length ? status.live.path.join(' / ') : '(root)',
    iteration: status.live.iteration,
    lastGate: status.live.lastGate,
    lastOutcome: status.live.lastOutcome,
    usage: status.live.usage,
    current,
    evidence: status.evidence,
    startedAt: status.startedAt,
    updatedAt: status.updatedAt,
    blocker: deriveBlocker(status.status, events, status.live),
    recent: events.slice(-(options?.recent ?? 10)).map(formatEvent),
  };
}

export function toLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ');
}

export function formatEvent(event: LoopEvent): string {
  return toLine(renderEvent(event));
}

function renderEvent(event: LoopEvent): string {
  const at = event.path.length ? `${event.path.join(' › ')} ` : '';
  switch (event.kind) {
    case 'loop:start':
      return `${at}▸ loop${event.max ? ` (max ${event.max})` : ''}`;
    case 'dag:start':
      return `${at}▸ dag (${event.nodes.length} nodes)`;
    case 'loop:iteration':
      return `${at}· iteration ${event.iteration}`;
    case 'loop:condition':
      return `${at}· ${event.which} ${event.result.met ? 'met' : 'not met'}: ${event.result.reason}`;
    case 'condition:result':
      return `${at}· ${event.label} ${event.result.met ? 'met' : 'not met'}: ${event.result.reason}`;
    case 'loop:review':
      return `${at}· review: ${event.outcome.status}${event.outcome.late ? ' late' : ''}`;
    case 'loop:end':
      return `${at}◂ ${event.outcome.status}${event.outcome.late ? ' late' : ''} (${event.iterations} iter)`;
    case 'dag:node':
      return `${at}· node ${event.node}: ${event.phase}${event.outcome ? ` (${event.outcome.status}${event.outcome.late ? ' late' : ''})` : ''}`;
    case 'dag:kickback':
      return `${at}↩ kickback ${event.accepted ? 'accepted' : 'rejected'} ${event.from} -> ${event.to}: ${event.reason}${event.note ? ` (${event.note})` : ''}`;
    case 'dag:end':
      return `${at}◂ dag ${event.outcome.status}${event.outcome.late ? ' late' : ''}`;
    case 'job:start':
      return `${at}• ${event.label}`;
    case 'advisor:consult':
      return `${at}◇ advisor ${event.label} #${event.call}: ${event.question}`;
    case 'proof':
      return `${at}◈ proof ${event.name}: ${event.artifact.title ?? event.artifact.path ?? event.artifact.kind}`;
    case 'job:end':
      return `${at}• ${event.label}: ${event.outcome.status}${event.outcome.late ? ' late' : ''}`;
    case 'engine:tool':
      return `${at}  tool ${event.name} ${event.phase}`;
    case 'engine:usage':
      return event.usage.kind === 'unknown'
        ? `${at}  ${event.model}: usage unknown`
        : `${at}  ${event.model}: ${event.usage.inputTokens}/${event.usage.outputTokens} tok`;
    case 'loop:stall':
      return `${at}⏹ stalled after ${event.report.iterations.length} no-progress iterations: ${event.report.reason}`;
    case 'limit:wait':
      return `${at}⏸ limit ${event.code}: waiting ${Math.round(event.waitMs / 1000)}s`;
    case 'limit:pause':
      return `${at}⏸ paused (${event.code}): ${event.reason}`;
    case 'log':
      return `${at}${event.message}`;
    case 'error':
      return `${at}✗ ${event.code}: ${event.message}`;
    default:
      return `${at}${event.kind}`;
  }
}
