/**
 * Engine adapter: the `claude` CLI as a subprocess. A fresh process per call =
 * a fresh context. Spawning, abort, and timeout via `execa`; output is the
 * same stream-json schema the Agent SDK emits, so we reuse `mapMessage`.
 */

import { execa } from 'execa';
import {
  SUBAGENT_TOOLS,
  modelFor,
  requestEnv,
  type AgentRequest,
  type AgentResult,
  type Engine,
  type EngineEventSink,
  type EngineOptions,
} from './engine.js';
import { mapMessage, newAccumulator } from './message-map.js';
import { settleOnExit } from './settle.js';
import { LoopError } from '../core/errors.js';
import { scrubCapture } from '../core/redact.js';

/**
 * Classify a failed `claude` subprocess into a provider-limit `LoopError`, or
 * return `undefined` to fall through to the generic ENGINE/TIMEOUT mapping. The
 * CLI has no structured limit channel on a hard failure, so we read its
 * (already-redacted) output text:
 *   - a usage/quota limit ("usage limit reached", "out of credits") → QUOTA.
 *     A reset time, when the message states one (epoch seconds or an absolute
 *     time the CLI prints), makes it auto-waitable; otherwise QUOTA has no
 *     reset and the run policy waits or pauses.
 *   - a plain "rate limit" → RATE_LIMIT (resets on its own).
 * Order matters: usage/quota is checked first so a usage message that also
 * contains the words "rate limit" is not mis-tagged as a transient throttle.
 *
 * Exported for unit testing without spawning a subprocess (mirrors
 * `buildClaudeArgs`).
 */
export function classifyCliLimit(text: string): LoopError | undefined {
  const lower = text.toLowerCase();
  const isUsage =
    /usage limit|session limit|out of credits|insufficient credits|quota|billing/.test(
      lower,
    );
  const isRate = /rate limit|rate-limit|too many requests|429/.test(lower);
  if (!isUsage && !isRate) return undefined;

  const resetAt = parseResetAt(text);
  if (isUsage) {
    return new LoopError({
      code: 'QUOTA',
      phase: 'engine',
      message: `claude usage limit: ${text}`,
      resetAt,
    });
  }
  return new LoopError({
    code: 'RATE_LIMIT',
    phase: 'engine',
    message: `claude rate limited: ${text}`,
    resetAt,
  });
}

/**
 * Pull a reset time (epoch ms) out of CLI limit text. The CLI may state a reset
 * as an epoch seconds/ms value (`resets at 1700000000`) or as a wall-clock time
 * with an optional IANA zone (`resets 4:50pm (Europe/London)`). Returns
 * `undefined` when no reset is stated — a quota with no parseable reset is not
 * auto-waitable.
 */
export function parseResetAt(
  text: string,
  now: number = Date.now(),
): number | undefined {
  const m = /(?:reset|resets|retry|available)\D{0,20}(\d{10,13})/i.exec(text);
  if (m) {
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return undefined;
    // 10-digit values are epoch seconds; 13-digit are already ms.
    return m[1]!.length <= 10 ? n * 1000 : n;
  }

  const clock =
    /(?:reset|resets|retry|available)[^\n\d]*(\d{1,2})(?::(\d{2}))?\s*([ap]m)\b(?:\s*\(([^)]+)\))?/i.exec(
      text,
    );
  if (!clock) return undefined;
  let hour = Number(clock[1]);
  const minute = clock[2] ? Number(clock[2]) : 0;
  const meridiem = clock[3]!.toLowerCase();
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return undefined;
  if (meridiem === 'pm' && hour !== 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;

  const zone = clock[4]?.trim();
  let candidate = zone
    ? zonedWallClockMs(now, hour, minute, zone)
    : localWallClockMs(now, hour, minute);
  if (candidate <= now) {
    const nextDay = now + 24 * 60 * 60 * 1000;
    candidate = zone
      ? zonedWallClockMs(nextDay, hour, minute, zone)
      : localWallClockMs(nextDay, hour, minute);
  }
  return candidate;
}

function localWallClockMs(now: number, hour: number, minute: number): number {
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

function zonedWallClockMs(
  now: number,
  hour: number,
  minute: number,
  zone: string,
): number {
  const parts = zonedParts(now, zone);
  if (!parts) return localWallClockMs(now, hour, minute);
  return wallClockToUtc(
    parts.year,
    parts.month,
    parts.day,
    hour,
    minute,
    zone,
  );
}

function wallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string,
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let utc = wall - zoneOffsetMs(zone, wall);
  utc = wall - zoneOffsetMs(zone, utc);
  return utc;
}

function zoneOffsetMs(zone: string, utcMs: number): number {
  const parts = zonedParts(utcMs, zone);
  if (!parts) return new Date(utcMs).getTimezoneOffset() * -60_000;
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - utcMs;
}

function zonedParts(
  ms: number,
  zone: string,
):
  | {
      year: number;
      month: number;
      day: number;
      hour: number;
      minute: number;
      second: number;
    }
  | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(new Date(ms));
    const value = (type: string) =>
      Number(parts.find((p) => p.type === type)?.value);
    return {
      year: value('year'),
      month: value('month'),
      day: value('day'),
      hour: value('hour'),
      minute: value('minute'),
      second: value('second'),
    };
  } catch {
    return undefined;
  }
}

/**
 * Build the `claude` argv for one run. Extracted (and exported) so the flag
 * wiring (model, system prompt, tool allowlist, permission mode, the `--`
 * argument-smuggling guard) is unit-testable without spawning a process.
 */
export function buildClaudeArgs(
  req: AgentRequest,
  opts: EngineOptions,
): string[] {
  const model = modelFor(req, opts, 'claude-cli');
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (model) args.push('--model', model);
  if (req.system)
    args.push(
      req.systemMode === 'replace' ? '--system-prompt' : '--append-system-prompt',
      req.system,
    );
  if (req.tools) args.push('--tools', req.tools.join(','));
  if (req.allowedTools?.length)
    args.push('--allowedTools', req.allowedTools.join(','));
  // A leaf agent may not spawn sub-agents, so disallow the spawn tool (wins over any allowlist).
  if (req.leaf) args.push('--disallowedTools', SUBAGENT_TOOLS.join(','));
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
  if (opts.cliArgs?.length) args.push(...opts.cliArgs);
  return args;
}

export class ClaudeCliEngine implements Engine {
  readonly name = 'claude-cli';
  constructor(private readonly opts: EngineOptions = {}) {}

  async run(
    req: AgentRequest,
    onEvent: EngineEventSink,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    const bin = this.opts.cliBinary ?? 'claude';
    const model = modelFor(req, this.opts, 'claude-cli');
    const args = buildClaudeArgs(req, this.opts);
    const env = requestEnv(req);
    const hardTimeout =
      req.timeoutMs && req.timeoutGraceMs
        ? req.timeoutMs + req.timeoutGraceMs
        : req.timeoutMs;
    const startedAt = Date.now();

    const acc = newAccumulator(model ?? 'claude-cli');
    // Buffered (default) so `stderr` is a string for error messages; we still
    // attach a `data` listener to stream stdout line-by-line as it arrives.
    const sub = execa(bin, args, {
      cwd: req.cwd,
      // execa merges this over `process.env` (`extendEnv` default); undefined
      // is inert, so a request with no env changes nothing.
      env,
      input: req.prompt,
      cancelSignal: signal,
      // If the child ignores the SIGTERM from an abort/timeout, escalate to
      // SIGKILL so a wedged subprocess can't make Ctrl-C hang.
      forceKillAfterDelay: 5000,
      reject: false,
      timeout: hardTimeout,
      stripFinalNewline: false,
    });

    let buffer = '';
    const flush = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        mapMessage(JSON.parse(trimmed), acc, onEvent);
      } catch {
        /* ignore non-JSON banner lines */
      }
    };
    sub.stdout?.setEncoding('utf8');
    sub.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        flush(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    });

    // Settled on process exit, not stream close: the CLI's MCP servers inherit
    // its stdio, and an orphan holding the pipes would otherwise pin this
    // await forever (see settle.ts). The final stream-json line lands before
    // exit, so the bounded drain preserves it.
    const result = await settleOnExit(sub);
    if (buffer) flush(buffer);

    if (signal.aborted)
      throw new LoopError({
        code: 'ABORTED',
        phase: 'engine',
        message: 'claude-cli run aborted',
      });
    const late =
      typeof req.timeoutMs === 'number' && Date.now() - startedAt > req.timeoutMs;
    if (result.failed) {
      if (result.timedOut && req.timeoutGraceMs && acc.terminal && acc.text) {
        onEvent({ type: 'usage', usage: acc.usage, model: acc.model });
        return {
          text: acc.text,
          usage: acc.usage,
          model: acc.model,
          stopReason: acc.stopReason,
          late: true,
        };
      }
      // The child's stderr is outside our control and may echo credentials on
      // an auth failure. `scrubCapture` redacts (env values verbatim, then
      // shape patterns, both on the FULL stream, before the cut) so nothing
      // secret lands in events/logs/the summary.
      const stderr =
        typeof result.stderr === 'string'
          ? scrubCapture(result.stderr, env, 400)
          : '';
      // A rate/usage limit can land on either stream; check both (redacted)
      // before falling through to the generic exit-code error.
      if (!result.timedOut) {
        const stdout =
          typeof result.stdout === 'string'
            ? scrubCapture(result.stdout, env, 400)
            : '';
        const limit = classifyCliLimit(`${stderr}\n${stdout}`);
        if (limit) throw limit;
      }
      throw new LoopError({
        code: result.timedOut ? 'TIMEOUT' : 'ENGINE',
        phase: 'engine',
        message: `claude exited ${result.exitCode ?? '?'}${stderr ? `: ${stderr}` : ''}`,
      });
    }

    onEvent({ type: 'usage', usage: acc.usage, model: acc.model });
    return {
      text: acc.text,
      usage: acc.usage,
      model: acc.model,
      stopReason: acc.stopReason,
      late,
    };
  }
}
