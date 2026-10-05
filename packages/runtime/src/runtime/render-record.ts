import { readFileSync } from 'node:fs';

import type { LoopEvent } from '../core/types.js';
import { toLine } from './supervisor.js';

export interface RecordLine {
  readonly kind: string;
  readonly text: string;
}

export interface RecordEngineCall {
  readonly model: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface RecordToolUse {
  readonly name: string;
  readonly count: number;
  readonly targets: readonly string[];
}

export interface RecordKickback {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
  readonly count: number;
  readonly limit?: number;
  readonly accepted: boolean;
  readonly note?: string;
}

export interface RecordOutcome {
  readonly status: string;
  readonly summary?: string;
}

export interface RecordNodeRun {
  readonly attempt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly outcome: RecordOutcome | null;
  readonly kickback: RecordKickback | null;
  readonly engineCalls: readonly RecordEngineCall[];
  readonly tools: readonly RecordToolUse[];
  readonly lines: readonly RecordLine[];
}

export interface RecordNodeSummary {
  readonly node: string;
  readonly runs: readonly RecordNodeRun[];
}

export interface RecordUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly unmeasuredCalls: number;
}

export interface RecordSummary {
  readonly name: string | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly outcome: RecordOutcome | null;
  readonly usage: RecordUsage;
  readonly monitor: string | null;
  readonly nodes: readonly RecordNodeSummary[];
  readonly lines: readonly RecordLine[];
}

export interface RenderRecordOptions {
  readonly lineWidth?: number;
}

const DEFAULT_WIDTH = 100;

interface MutableRun {
  attempt: number;
  startedAt: number | null;
  endedAt: number | null;
  outcome: RecordOutcome | null;
  kickback: RecordKickback | null;
  engineCalls: RecordEngineCall[];
  tools: { name: string; count: number; targets: string[] }[];
  lines: RecordLine[];
}

interface MutableNode {
  node: string;
  runs: MutableRun[];
}

function firstLine(value: string): string {
  for (const raw of value.split('\n')) {
    const line = toLine(raw).trim().replace(/^(?:[-*]|\d+\.)\s+/, '');
    if (line.length > 0) return line;
  }
  return '';
}

function outcomeOf(outcome: { status: string; summary?: string } | undefined): RecordOutcome | null {
  return outcome ? { status: outcome.status, summary: outcome.summary } : null;
}

export function summarizeRecord(events: readonly LoopEvent[]): RecordSummary {
  const firstDag = events.find((e) => e.kind === 'dag:start');
  const rootDepth = firstDag && firstDag.kind === 'dag:start' ? firstDag.path.length : 0;

  let name: string | null = null;
  let startedAt: number | null = null;
  let endedAt: number | null = null;
  let outcome: RecordOutcome | null = null;
  let usage: RecordUsage | null = null;
  let monitor: string | null = null;
  const nodes: MutableNode[] = [];
  const lines: RecordLine[] = [];
  const measured: {
    -readonly [K in keyof RecordUsage]: RecordUsage[K];
  } = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    unmeasuredCalls: 0,
  };

  const nodeFor = (name_: string): MutableNode => {
    let n = nodes.find((x) => x.node === name_);
    if (!n) {
      n = { node: name_, runs: [] };
      nodes.push(n);
    }
    return n;
  };

  const runFor = (nodeName: string, attempt: number): MutableRun => {
    const n = nodeFor(nodeName);
    let r = n.runs.find((x) => x.attempt === attempt);
    if (!r) {
      r = {
        attempt,
        startedAt: null,
        endedAt: null,
        outcome: null,
        kickback: null,
        engineCalls: [],
        tools: [],
        lines: [],
      };
      n.runs.push(r);
      n.runs.sort((a, b) => a.attempt - b.attempt);
    }
    return r;
  };

  const latestRun = (nodeName: string): MutableRun => {
    const n = nodeFor(nodeName);
    const last = n.runs[n.runs.length - 1];
    if (last) return last;
    return runFor(nodeName, 1);
  };

  for (const event of events) {
    if (startedAt === null) startedAt = event.ts;
    // State a resume reads back; it is no step and no line of its own.
    if (event.kind === 'interaction:checkpoint') continue;

    if (event.kind === 'dag:node' && event.path.length === rootDepth) {
      const run = runFor(event.node, event.attempt ?? 1);
      if (event.phase === 'start') {
        run.startedAt = event.ts;
      } else {
        run.endedAt = event.ts;
        if (event.phase === 'skip') {
          run.outcome = { status: 'skipped', summary: event.outcome?.summary };
        } else if (event.outcome) {
          run.outcome = outcomeOf(event.outcome) ?? run.outcome;
          if (
            event.outcome.status === 'paused' &&
            event.outcome.summary &&
            !run.lines.some((l) => l.kind === 'paused')
          ) {
            run.lines.push({ kind: 'paused', text: `Paused: ${event.outcome.summary}` });
          }
        }
      }
      continue;
    }

    if (event.path.length > rootDepth) {
      const run = latestRun(event.path[rootDepth] ?? '');
      switch (event.kind) {
        case 'engine:usage': {
          if (event.usage.kind === 'reported') {
            run.engineCalls.push({
              model: event.model,
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
            });
            measured.inputTokens += event.usage.inputTokens;
            measured.outputTokens += event.usage.outputTokens;
            measured.cacheReadInputTokens += event.usage.cacheReadInputTokens ?? 0;
          } else {
            run.engineCalls.push({ model: event.model, inputTokens: null, outputTokens: null });
            measured.unmeasuredCalls += 1;
          }
          break;
        }
        case 'engine:tool': {
          if (event.phase === 'use') {
            const existing = run.tools.find((t) => t.name === event.name);
            if (existing) {
              existing.count += 1;
              if (event.target !== undefined && !existing.targets.includes(event.target)) {
                existing.targets.push(event.target);
              }
            } else {
              run.tools.push({
                name: event.name,
                count: 1,
                targets: event.target !== undefined ? [event.target] : [],
              });
            }
          }
          break;
        }
        case 'limit:pause':
          run.lines.push({ kind: event.kind, text: `Paused (${event.code}): ${event.reason}` });
          break;
        case 'dag:node':
          if (event.phase !== 'start') {
            const status =
              event.phase === 'skip'
                ? 'skipped'
                : (event.outcome?.status ?? 'no end recorded');
            const summary = event.outcome?.summary ? firstLine(event.outcome.summary) : '';
            const label = [...event.path.slice(rootDepth + 1), event.node].join('/');
            run.lines.push({ kind: event.kind, text: `${label}: ${status}${summary ? `, ${summary}` : ''}` });
          }
          break;
        case 'log':
          run.lines.push({ kind: event.kind, text: `log: ${event.message}` });
          break;
        case 'error':
          run.lines.push({ kind: event.kind, text: `error ${event.code}: ${event.message}` });
          break;
        case 'job:start':
        case 'job:end':
        case 'engine:text':
        case 'engine:thinking':
        case 'dag:start':
        case 'dag:end':
          break;
        default:
          run.lines.push({ kind: event.kind, text: event.kind });
      }
      continue;
    }

    // Record level: path.length <= rootDepth, not a top-level dag:node.
    switch (event.kind) {
      case 'run:start':
        if (name === null && event.runId) name = event.runId;
        break;
      case 'run:end':
        endedAt = event.ts;
        outcome = outcomeOf(event.outcome);
        usage = {
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          cacheReadInputTokens: event.usage.cacheReadInputTokens ?? 0,
          unmeasuredCalls: event.usage.unmeasuredCalls ?? 0,
        };
        break;
      case 'dag:start':
        if (name === null && event.path.length > 0) name = event.path[0] ?? null;
        break;
      case 'dag:end':
        break;
      case 'monitor':
        monitor = event.url;
        break;
      case 'heartbeat':
        break;
      case 'run:abort':
        lines.push({ kind: event.kind, text: `Stopped by ${event.signal}.` });
        break;
      case 'dag:kickback':
        if (event.accepted) {
          const run = runFor(event.to, event.count + 1);
          run.kickback = {
            from: event.from,
            to: event.to,
            reason: event.reason,
            count: event.count,
            ...(event.limit !== undefined ? { limit: event.limit } : {}),
            accepted: true,
            note: event.note,
          };
        } else {
          latestRun(event.to).lines.push({
            kind: event.kind,
            text: `Kickback from ${event.from} rejected${event.note ? ` (${event.note})` : ''}: ${event.reason}`,
          });
        }
        break;
      case 'log':
        lines.push({ kind: event.kind, text: `log: ${event.message}` });
        break;
      case 'error':
        lines.push({ kind: event.kind, text: `error ${event.code}: ${event.message}` });
        break;
      default:
        lines.push({ kind: event.kind, text: event.kind });
    }
  }

  if (name === null && firstDag && firstDag.kind === 'dag:start' && firstDag.path.length > 0) {
    name = firstDag.path[0] ?? null;
  }

  return {
    name,
    startedAt,
    endedAt,
    outcome,
    usage: usage ?? measured,
    monitor,
    nodes: nodes.map((n) => ({
      node: n.node,
      runs: n.runs.map((r) => ({
        attempt: r.attempt,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        outcome: r.outcome,
        kickback: r.kickback,
        engineCalls: r.engineCalls,
        tools: r.tools.map((t) => ({ name: t.name, count: t.count, targets: t.targets })),
        lines: r.lines,
      })),
    })),
    lines,
  };
}

const commas = (n: number): string => `${n}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function clockTime(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19);
}

function headerTime(ts: number): string {
  return `${new Date(ts).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fit(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width)}…` : text;
}

export function renderRecord(events: readonly LoopEvent[], options?: RenderRecordOptions): string {
  const width = options?.lineWidth ?? DEFAULT_WIDTH;
  const summary = summarizeRecord(events);
  const out: string[] = [];

  out.push(`# ${summary.name ?? 'run'}`);
  out.push('');

  if (summary.startedAt !== null && summary.endedAt === null) {
    out.push(`- Started ${headerTime(summary.startedAt)}. No end recorded.`);
  } else if (summary.startedAt !== null && summary.endedAt !== null) {
    out.push(
      `- Started ${headerTime(summary.startedAt)}, ended ${headerTime(summary.endedAt)} after ${formatDuration(summary.endedAt - summary.startedAt)}.`,
    );
    if (summary.outcome) {
      const text = summary.outcome.summary
        ? `${summary.outcome.status}. ${fit(firstLine(summary.outcome.summary), width)}`
        : `${summary.outcome.status}.`;
      out.push(`- Outcome: ${text}`);
    }
  }

  const usageParts = [`${commas(summary.usage.inputTokens)} in, ${commas(summary.usage.outputTokens)} out`];
  if (summary.usage.cacheReadInputTokens > 0) {
    usageParts.push(`${commas(summary.usage.cacheReadInputTokens)} read from cache`);
  }
  let tokensLine = `- Tokens: ${usageParts.join(', ')}.`;
  if (summary.usage.unmeasuredCalls > 0) {
    tokensLine = `- Tokens: ${usageParts.join(', ')}, usage unknown on ${summary.usage.unmeasuredCalls} calls.`;
  }
  out.push(tokensLine);

  if (summary.monitor) out.push(`- Monitor: ${summary.monitor}`);
  for (const line of summary.lines) out.push(`- ${fit(line.text, width)}`);

  for (const node of summary.nodes) {
    out.push('');
    out.push(`## ${node.node}`);
    for (const run of node.runs) {
      out.push('');
      if (run.kickback) {
        out.push(
          `Kickback from ${run.kickback.from}, ${run.kickback.count}${run.kickback.limit === undefined ? '' : ` of ${run.kickback.limit}`}: ${run.kickback.reason}`,
        );
        out.push('');
      }
      const status = run.endedAt === null ? 'no end recorded' : (run.outcome?.status ?? 'no outcome');
      const parts = [`### Run ${run.attempt}: ${status}`];
      if (run.startedAt !== null && run.endedAt !== null) {
        parts.push(formatDuration(run.endedAt - run.startedAt));
      }
      if (run.startedAt !== null) parts.push(`started ${clockTime(run.startedAt)}`);
      else if (run.endedAt !== null) parts.push(`at ${clockTime(run.endedAt)}`);
      out.push(parts.join(', '));

      if (run.outcome?.summary) {
        out.push('');
        out.push(fit(firstLine(run.outcome.summary), width));
      }
      if (run.engineCalls.length > 0 || run.tools.length > 0 || run.lines.length > 0) {
        out.push('');
        for (const call of run.engineCalls) {
          out.push(
            call.inputTokens === null || call.outputTokens === null
              ? `- ${call.model}: usage unknown`
              : `- ${call.model}: ${commas(call.inputTokens)} in, ${commas(call.outputTokens)} out`,
          );
        }
        if (run.tools.length > 0) {
          out.push(
            `- ${run.tools
              .map((t) => `${t.name} ×${t.count}${t.targets.length > 0 ? `: ${t.targets.join(', ')}` : ''}`)
              .join(', ')}`,
          );
        }
        for (const line of run.lines) {
          const uncut = line.kind === 'paused' || line.kind === 'limit:pause';
          out.push(`- ${uncut ? line.text : fit(line.text, width)}`);
        }
      }
    }
  }

  return `${out.join('\n')}\n`;
}

export function readRecordFile(path: string): { events: LoopEvent[]; unreadable: number } {
  const text = readFileSync(path, 'utf8');
  const events: LoopEvent[] = [];
  let unreadable = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line) as LoopEvent);
    } catch {
      unreadable += 1;
    }
  }
  return { events, unreadable };
}
