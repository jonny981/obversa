/**
 * Engine plugin: the `claude` CLI as a subprocess. A fresh process per call =
 * a fresh context. Spawning, abort, and timeout via `execa`; output is the
 * same stream-json schema the Agent SDK emits, so we reuse `mapMessage`.
 */

import {
  CLAUDE_SUBAGENT_TOOLS,
  EngineError,
  attemptEnvironment,
  classifyEngineFailure,
  engineSelection,
  mapMessage,
  newAccumulator,
  scrubCapture,
  validateAgentResult,
  type AgentRequest,
  type AgentResult,
  type Engine,
  type EngineEventSink,
} from '@obversa/engine';
import {
  DEFAULT_OWNED_COMMAND_LIMITS,
  ownedCommandIdentity,
  resolveCommandExecutable,
  runOwnedCommand,
} from '@obversa/engine/command';

export interface ClaudeCliEngineOptions {
  readonly defaultModel?: string;
  readonly cliBinary?: string;
  readonly cliArgs?: readonly string[];
  readonly permissionMode?:
    | 'default'
    | 'acceptEdits'
    | 'bypassPermissions'
    | 'plan'
    | 'dontAsk'
    | 'auto';
}

function modelFor(
  request: AgentRequest,
  options: ClaudeCliEngineOptions,
): string | undefined {
  return (request.model ?? options.defaultModel)?.replace(
    /\s*\[[^\]]+\]\s*$/,
    '',
  );
}

/**
 * Classify redacted CLI failure text as a provider limit. Billing keeps the
 * historical quota kind. Ambiguous usage/session/quota text is rate-limit;
 * a parsed reset is retained without deciding the allowance duration.
 * Unrelated failures return undefined for the existing generic error path.
 */
export function classifyCliLimit(text: string): EngineError | undefined {
  const classified = classifyEngineFailure(new Error(text));
  if (classified !== 'billing' && classified !== 'quota' && classified !== 'rate-limit') {
    return undefined;
  }
  const kind = classified === 'billing' ? 'quota' : classified;
  const resetAt = parseResetAt(text);
  return new EngineError({
    kind,
    message: kind === 'quota'
      ? `claude usage limit: ${text}`
      : `claude rate limited: ${text}`,
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
  opts: ClaudeCliEngineOptions,
): string[] {
  const model = modelFor(req, opts);
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
  if (req.leaf)
    args.push('--disallowedTools', CLAUDE_SUBAGENT_TOOLS.join(','));
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
  if (opts.cliArgs?.length) args.push(...opts.cliArgs);
  return args;
}

export class ClaudeCliEngine implements Engine {
  readonly name = 'claude-cli';
  private executable: string | undefined;
  constructor(private readonly opts: ClaudeCliEngineOptions = {}) {}

  private commandExecutable(): string {
    this.executable ??= resolveCommandExecutable(this.opts.cliBinary ?? 'claude');
    return this.executable;
  }

  async run(
    req: AgentRequest,
    onEvent: EngineEventSink,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    if (signal.aborted)
      throw new EngineError({
        kind: 'aborted',
        message: 'claude-cli run aborted',
      });
    const bin = this.commandExecutable();
    const model = modelFor(req, this.opts);
    const args = buildClaudeArgs(req, this.opts);
    const env = attemptEnvironment(req);
    const startedAt = Date.now();
    const owner = ownedCommandIdentity({
      adapter: 'claude-cli',
      runId: req.attempt?.runId,
      leafId: req.attempt?.leafId,
      attemptId: req.attempt?.attemptId,
    });

    const acc = newAccumulator(model);
    const decoder = new TextDecoder();
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
    const result = await runOwnedCommand(
      {
        executable: bin,
        args,
        cwd: req.cwd ?? process.cwd(),
        env: env ?? {},
        stdin: req.prompt,
        ...owner,
        ...DEFAULT_OWNED_COMMAND_LIMITS,
        timeoutMs: req.timeoutMs ?? DEFAULT_OWNED_COMMAND_LIMITS.timeoutMs,
        teardownGraceMs:
          req.timeoutGraceMs ?? DEFAULT_OWNED_COMMAND_LIMITS.teardownGraceMs,
        maxOutputBytes:
          req.maxOutputBytes ?? DEFAULT_OWNED_COMMAND_LIMITS.maxOutputBytes,
        maxMemoryBytes:
          req.maxMemoryBytes ?? DEFAULT_OWNED_COMMAND_LIMITS.maxMemoryBytes,
      },
      signal,
      {
        onStdout(chunk) {
          buffer += decoder.decode(chunk, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            flush(buffer.slice(0, idx));
            buffer = buffer.slice(idx + 1);
          }
        },
      },
    );
    buffer += decoder.decode();
    if (buffer) flush(buffer);

    const aborted = result.aborted || signal.aborted;
    const completed = acc.terminal && acc.parts.some((part) => part.final);
    if (aborted && !completed)
      throw new EngineError({
        kind: 'aborted',
        message: 'claude-cli run aborted',
      });
    const late =
      typeof req.timeoutMs === 'number' && Date.now() - startedAt > req.timeoutMs;
    const failed = aborted || result.timedOut || result.exitCode !== 0;
    if (failed) {
      // The child's stderr is outside our control and may echo credentials on
      // an auth failure. `scrubCapture` redacts (env values verbatim, then
      // shape patterns, both on the FULL stream, before the cut) so nothing
      // secret lands in events/logs/the summary.
      const stderr = scrubCapture(
        new TextDecoder().decode(result.stderr),
        env,
        400,
      );
      if (acc.terminal && acc.parts.some((part) => part.final)) {
        const requested = engineSelection({
          adapter: 'claude-cli',
          provider: 'anthropic',
          model: model ?? null,
          executable: bin,
        });
        const effective = engineSelection({
          adapter: 'claude-cli',
          provider: 'anthropic',
          model: acc.model,
          executable: bin,
        });
        onEvent({
          type: 'usage',
          usage: acc.usage,
          model: acc.model ?? model ?? 'claude-cli',
        });
        return validateAgentResult({
          parts: acc.parts,
          usage: acc.usage,
          requested,
          effective,
          ...(acc.stopReason === undefined
            ? {}
            : { stopReason: acc.stopReason }),
          transportFailure: {
            kind: aborted ? 'aborted' : result.timedOut ? 'timeout' : 'unknown',
            message: `claude completed but exited ${result.exitCode ?? '?'} during teardown${
              stderr ? `: ${stderr}` : ''
            }`,
            exitCode: result.exitCode ?? null,
          },
        });
      }
      // A rate/usage limit can land on either stream; check both (redacted)
      // before falling through to the generic exit-code error.
      if (!result.timedOut) {
        const stdout = scrubCapture(
          new TextDecoder().decode(result.stdout),
          env,
          400,
        );
        const limit = classifyCliLimit(`${stderr}\n${stdout}`);
        if (limit) throw limit;
      }
      throw new EngineError({
        kind: result.timedOut ? 'timeout' : 'unknown',
        message: `claude exited ${result.exitCode ?? '?'}${stderr ? `: ${stderr}` : ''}`,
      });
    }

    onEvent({
      type: 'usage',
      usage: acc.usage,
      model: acc.model ?? model ?? 'claude-cli',
    });
    const requested = engineSelection({
      adapter: 'claude-cli',
      provider: 'anthropic',
      model: model ?? null,
      executable: bin,
    });
    const effective = engineSelection({
      adapter: 'claude-cli',
      provider: 'anthropic',
      model: acc.model,
      executable: bin,
    });
    return validateAgentResult({
      parts: acc.parts,
      usage: acc.usage,
      requested,
      effective,
      ...(acc.stopReason === undefined
        ? {}
        : { stopReason: acc.stopReason }),
      ...(late
        ? {
            transportFailure: {
              kind: 'timeout' as const,
              message: 'claude result arrived after the soft timeout',
              exitCode: result.exitCode ?? null,
            },
          }
        : {}),
    });
  }
}
