/**
 * Engine plugin: the `claude` CLI as a subprocess. A fresh process per call =
 * a fresh context. Spawning, abort, and timeout via `execa`; output is the
 * same stream-json schema the Agent SDK emits, so we reuse `mapMessage`.
 */

import {
  basename,
  isAbsolute,
} from 'node:path';
import { isDeepStrictEqual } from 'node:util';
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
  type EngineSelectionRecord,
} from '@obversa/engine';
import {
  DEFAULT_OWNED_COMMAND_LIMITS,
  OwnedCommandError,
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

function assertClaudeConfiguration(req: AgentRequest, opts: ClaudeCliEngineOptions): void {
  try {
    const args = buildClaudeArgs(req, opts);
    const env = attemptEnvironment(req) ?? {};
    const limits = {
      timeoutMs: req.timeoutMs ?? DEFAULT_OWNED_COMMAND_LIMITS.timeoutMs,
      teardownGraceMs: req.timeoutGraceMs ?? DEFAULT_OWNED_COMMAND_LIMITS.teardownGraceMs,
      maxOutputBytes: req.maxOutputBytes ?? DEFAULT_OWNED_COMMAND_LIMITS.maxOutputBytes,
      maxMemoryBytes: req.maxMemoryBytes ?? DEFAULT_OWNED_COMMAND_LIMITS.maxMemoryBytes,
    };
    if (!isAbsolute(req.cwd ?? process.cwd())
      || args.some((arg) => typeof arg !== 'string')
      || Object.values(env).some((value) => typeof value !== 'string')
      || !Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 1
      || !Number.isSafeInteger(limits.teardownGraceMs) || limits.teardownGraceMs < 0
      || limits.timeoutMs + limits.teardownGraceMs > 2_147_483_647
      || !Number.isSafeInteger(limits.maxOutputBytes) || limits.maxOutputBytes < 0
      || !Number.isSafeInteger(limits.maxMemoryBytes) || limits.maxMemoryBytes < 1) {
      throw new Error('invalid Claude command request');
    }
    ownedCommandIdentity({ adapter: 'claude-cli', runId: req.attempt?.runId,
      leafId: req.attempt?.leafId, attemptId: req.attempt?.attemptId });
  } catch {
    throw new EngineError({ kind: 'invalid-config', message: 'invalid Claude command configuration' });
  }
}

function claudeCommandError(error: unknown, executable?: string): unknown {
  if (!(error instanceof OwnedCommandError)) return error;
  if (error.code === 'INVALID_EXECUTABLE') {
    return new EngineError({ kind: 'missing-cli', message: 'Claude executable is not runnable' });
  }
  if (error.code === 'INVALID_COMMAND') {
    return new EngineError({ kind: 'invalid-config', message: 'invalid Claude command request' });
  }
  if (error.code === 'SPAWN_FAILED') {
    if (executable !== undefined) {
      try { resolveCommandExecutable(executable); }
      catch {
        return new EngineError({ kind: 'missing-cli', message: 'Claude executable is not runnable' });
      }
    }
    return new EngineError({ kind: 'unknown', message: 'Claude command could not start' });
  }
  return error;
}

export class ClaudeCliEngine implements Engine {
  readonly name = 'claude-cli';
  private executable: string | undefined;
  private version: Promise<string> | undefined;
  constructor(private readonly opts: ClaudeCliEngineOptions = {}) {}

  private commandExecutable(expected?: EngineSelectionRecord): string {
    const configured = this.opts.cliBinary ?? 'claude';
    if (configured.length === 0 || (!isAbsolute(configured) && basename(configured) !== configured)) {
      throw new EngineError({ kind: 'invalid-config', message: 'Claude command must be absolute or a bare name' });
    }
    if (expected && (expected.executable === null
      || (isAbsolute(configured) && configured !== expected.executable)
      || (this.executable !== undefined && this.executable !== expected.executable))) {
      throw new EngineError({ kind: 'invalid-config', message: 'Claude executable selection changed' });
    }
    try {
      this.executable ??= resolveCommandExecutable(expected?.executable ?? configured);
      return resolveCommandExecutable(this.executable);
    } catch (error) {
      throw claudeCommandError(error, this.executable);
    }
  }

  private async observeVersion(req: AgentRequest, executable: string, signal: AbortSignal): Promise<string> {
    try {
      const result = await runOwnedCommand({
        executable, args: ['--version'], stdin: '',
        cwd: req.cwd ?? process.cwd(), env: attemptEnvironment(req) ?? {},
        ...ownedCommandIdentity({ adapter: 'claude-cli', runId: req.attempt?.runId,
          leafId: req.attempt?.leafId, attemptId: req.attempt?.attemptId }),
        ...DEFAULT_OWNED_COMMAND_LIMITS,
        timeoutMs: Math.min(req.timeoutMs ?? 5_000, 5_000),
        teardownGraceMs: Math.min(req.timeoutGraceMs ?? 1_000, 1_000),
        maxOutputBytes: Math.min(req.maxOutputBytes ?? 4_096, 4_096),
        maxMemoryBytes: req.maxMemoryBytes ?? DEFAULT_OWNED_COMMAND_LIMITS.maxMemoryBytes,
      }, signal);
      if (result.aborted || signal.aborted) {
        throw new EngineError({ kind: 'aborted', message: 'Claude version observation aborted' });
      }
      if (result.timedOut) {
        throw new EngineError({ kind: 'timeout', message: 'Claude version observation timed out' });
      }
      if (result.exitCode !== 0) {
        throw new EngineError({ kind: 'unknown', message: 'Claude version command failed' });
      }
      const text = new TextDecoder().decode(result.stdout).trim();
      const matched = /^(\d+\.\d+\.\d+) \(Claude Code\)$/.exec(text);
      if (!matched) {
        throw new EngineError({ kind: 'invalid-config', message: 'Claude version output is not recognized' });
      }
      return matched[1]!;
    } catch (error) {
      const mapped = claudeCommandError(error, executable);
      if (mapped instanceof EngineError) throw mapped;
      throw new EngineError({ kind: 'unknown', message: 'Claude version observation failed' });
    }
  }

  async admit(
    request: Omit<AgentRequest, 'prompt'>,
    signal: AbortSignal,
    expectedSelection?: EngineSelectionRecord,
  ): Promise<EngineSelectionRecord> {
    if (signal.aborted) {
      throw new EngineError({ kind: 'aborted', message: 'Claude admission aborted' });
    }
    const req: AgentRequest = { ...request, prompt: '' };
    assertClaudeConfiguration(req, this.opts);
    let expected: EngineSelectionRecord | undefined;
    let proposed: EngineSelectionRecord;
    try {
      expected = expectedSelection === undefined ? undefined : engineSelection(expectedSelection);
      proposed = engineSelection({ adapter: 'claude-cli', provider: 'anthropic',
        model: modelFor(req, this.opts) ?? null, capabilities: req.tools ?? [] });
    } catch {
      throw new EngineError({ kind: 'invalid-config', message: 'invalid Claude selection' });
    }
    const executable = this.commandExecutable(expected);
    let observation = this.version;
    if (observation === undefined) {
      observation = this.observeVersion(req, executable, signal);
      this.version = observation;
    }
    let adapterVersion: string;
    try { adapterVersion = await observation; }
    catch (error) {
      if (this.version === observation) this.version = undefined;
      throw error;
    }
    if (signal.aborted) {
      throw new EngineError({ kind: 'aborted', message: 'Claude admission aborted' });
    }
    const selected = engineSelection({ ...proposed, executable, adapterVersion });
    if (expected && !isDeepStrictEqual(selected, expected)) {
      throw new EngineError({ kind: 'invalid-config', message: 'Claude selection changed' });
    }
    return selected;
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
    const { prompt: _prompt, ...admissionRequest } = req;
    const requested = await this.admit(admissionRequest, signal);
    const bin = requested.executable!;
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
    ).catch((error: unknown) => { throw claudeCommandError(error, bin); });
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
        const effective = engineSelection({
          ...requested, model: acc.model,
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
    const effective = engineSelection({
      ...requested, model: acc.model,
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
