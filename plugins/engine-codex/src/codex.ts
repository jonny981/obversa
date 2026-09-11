/**
 * Engine adapter: the `codex` CLI (GPT-5) as a non-interactive subprocess. A
 * different model behind the same `Engine` interface: point a reviewer at
 * `engine: 'codex'` for a second-model signal, with no bespoke integration.
 * Read-only by default: a report-only reviewer never edits, so the sandbox
 * forbids writes and the run cannot touch the workspace.
 *
 * `codex exec` reads the prompt from stdin (`-`) so large grounded prompts do
 * not ride argv; the final assistant message is captured via `-o <file>` rather
 * than scraped from the event stream.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  EngineError,
  assistantResult,
  attemptEnvironment,
  classifyEngineFailure,
  engineSelection,
  reportedUsage,
  scrubCapture,
  type AgentRequest,
  type AgentResult,
  type Engine,
  type EngineEventSink,
  type EngineSelectionRecord,
  type UsageReceipt,
} from '@obversa/engine';
import {
  DEFAULT_OWNED_COMMAND_LIMITS,
  OwnedCommandError,
  ownedCommandIdentity,
  resolveCommandExecutable,
  runOwnedCommand,
} from '@obversa/engine/command';

const DIAGNOSTIC_MAX = 700;
const DIAGNOSTIC_HEAD = 180;

export interface CodexEngineOptions {
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

function usageFromJsonl(stdout: unknown): UsageReceipt {
  if (typeof stdout !== 'string') return { kind: 'unknown' };
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      const event = JSON.parse(line) as {
        type?: unknown;
        usage?: {
          input_tokens?: unknown;
          cached_input_tokens?: unknown;
          output_tokens?: unknown;
        };
      };
      if (event.type !== 'turn.completed' || !event.usage) continue;
      const inputTokens = tokenCount(event.usage.input_tokens);
      const outputTokens = tokenCount(event.usage.output_tokens);
      const cacheReadInputTokens =
        event.usage.cached_input_tokens === undefined
          ? undefined
          : tokenCount(event.usage.cached_input_tokens);
      if (
        inputTokens === undefined ||
        outputTokens === undefined ||
        (event.usage.cached_input_tokens !== undefined &&
          cacheReadInputTokens === undefined)
      ) {
        return { kind: 'unknown' };
      }
      return reportedUsage({
        inputTokens,
        outputTokens,
        ...(event.usage.cached_input_tokens === undefined
          ? {}
          : { cacheReadInputTokens: cacheReadInputTokens! }),
      });
    } catch {
      /* ignore non-JSON output */
    }
  }
  return { kind: 'unknown' };
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function diagnosticCapture(
  stderr: unknown,
  stdout: unknown,
  env: Record<string, string> | undefined,
): string {
  const raw = [stderr, stdout]
    .filter(
      (value): value is string =>
        typeof value === 'string' && value.length > 0,
    )
    .join('\n');
  const scrubbed = scrubCapture(raw, env).trim();
  if (scrubbed.length <= DIAGNOSTIC_MAX) return scrubbed;
  const marker = '\n[diagnostic middle truncated]\n';
  const tail = DIAGNOSTIC_MAX - DIAGNOSTIC_HEAD - marker.length;
  return `${scrubbed.slice(0, DIAGNOSTIC_HEAD)}${marker}${scrubbed.slice(-tail)}`;
}

export function buildCodexArgs(
  req: AgentRequest,
  opts: CodexEngineOptions,
  outFile: string,
): string[] {
  const model = req.model ?? opts.defaultModel;
  const args = [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--color',
    'never',
    '--json',
  ];

  if (opts.permissionMode === 'bypassPermissions') {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('-s', 'read-only');
  }

  if (req.cwd) args.push('-C', req.cwd);
  if (model) args.push('-m', model);
  if (opts.cliArgs?.length) args.push(...opts.cliArgs);
  args.push('-o', outFile, '-');
  return args;
}

function assertCodexConfiguration(req: AgentRequest, opts: CodexEngineOptions): void {
  try {
    const args = buildCodexArgs(req, opts, join(req.cwd ?? process.cwd(), '.obversa-codex-admission-output'));
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
      throw new Error('invalid Codex command request');
    }
    ownedCommandIdentity({ adapter: 'codex', runId: req.attempt?.runId,
      leafId: req.attempt?.leafId, attemptId: req.attempt?.attemptId });
  } catch {
    throw new EngineError({ kind: 'invalid-config', message: 'invalid Codex command configuration' });
  }
}

function codexCommandError(error: unknown, executable?: string): unknown {
  if (!(error instanceof OwnedCommandError)) return error;
  if (error.code === 'INVALID_EXECUTABLE') {
    return new EngineError({ kind: 'missing-cli', message: 'Codex executable is not runnable' });
  }
  if (error.code === 'INVALID_COMMAND') {
    return new EngineError({ kind: 'invalid-config', message: 'invalid Codex command request' });
  }
  if (error.code === 'SPAWN_FAILED') {
    if (executable !== undefined) {
      try { resolveCommandExecutable(executable); }
      catch { return new EngineError({ kind: 'missing-cli', message: 'Codex executable is not runnable' }); }
    }
    return new EngineError({ kind: 'unknown', message: 'Codex command could not start' });
  }
  return error;
}

export class CodexEngine implements Engine {
  readonly name = 'codex';
  private executable: string | undefined;
  private version: Promise<string> | undefined;
  constructor(private readonly opts: CodexEngineOptions = {}) {}

  private commandExecutable(expected?: EngineSelectionRecord): string {
    const configured = this.opts.cliBinary ?? 'codex';
    if (configured.length === 0 || (!isAbsolute(configured) && basename(configured) !== configured)) {
      throw new EngineError({ kind: 'invalid-config', message: 'Codex command must be absolute or a bare name' });
    }
    if (expected && (expected.executable === null
      || (isAbsolute(configured) && configured !== expected.executable)
      || (this.executable !== undefined && this.executable !== expected.executable))) {
      throw new EngineError({ kind: 'invalid-config', message: 'Codex executable selection changed' });
    }
    try {
      this.executable ??= resolveCommandExecutable(expected?.executable ?? configured);
      return resolveCommandExecutable(this.executable);
    } catch (error) { throw codexCommandError(error, this.executable); }
  }

  private async observeVersion(req: AgentRequest, executable: string, signal: AbortSignal): Promise<string> {
    try {
      const result = await runOwnedCommand({
        executable, args: ['--version'], stdin: '',
        cwd: req.cwd ?? process.cwd(), env: attemptEnvironment(req) ?? {},
        ...ownedCommandIdentity({ adapter: 'codex', runId: req.attempt?.runId,
          leafId: req.attempt?.leafId, attemptId: req.attempt?.attemptId }),
        ...DEFAULT_OWNED_COMMAND_LIMITS,
        timeoutMs: Math.min(req.timeoutMs ?? 5_000, 5_000),
        teardownGraceMs: Math.min(req.timeoutGraceMs ?? 1_000, 1_000),
        maxOutputBytes: Math.min(req.maxOutputBytes ?? 4_096, 4_096),
        maxMemoryBytes: req.maxMemoryBytes ?? DEFAULT_OWNED_COMMAND_LIMITS.maxMemoryBytes,
      }, signal);
      if (result.aborted || signal.aborted) {
        throw new EngineError({ kind: 'aborted', message: 'Codex version observation aborted' });
      }
      if (result.timedOut) {
        throw new EngineError({ kind: 'timeout', message: 'Codex version observation timed out' });
      }
      if (result.exitCode !== 0) {
        throw new EngineError({ kind: 'unknown', message: 'Codex version command failed' });
      }
      const matched = /^codex-cli (\d+\.\d+\.\d+)$/.exec(new TextDecoder().decode(result.stdout).trim());
      if (!matched) {
        throw new EngineError({ kind: 'invalid-config', message: 'Codex version output is not recognized' });
      }
      return matched[1]!;
    } catch (error) {
      const mapped = codexCommandError(error, executable);
      if (mapped instanceof EngineError) throw mapped;
      throw new EngineError({ kind: 'unknown', message: 'Codex version observation failed' });
    }
  }

  async admit(
    request: Omit<AgentRequest, 'prompt'>,
    signal: AbortSignal,
    expectedSelection?: EngineSelectionRecord,
  ): Promise<EngineSelectionRecord> {
    if (request.tools?.length === 0)
      throw new EngineError({
        kind: 'invalid-config',
        message: 'codex cannot honor tools: []; choose an engine that supports disabling tools',
      });
    if (signal.aborted) throw new EngineError({ kind: 'aborted', message: 'Codex admission aborted' });
    const req: AgentRequest = { ...request, prompt: '' };
    assertCodexConfiguration(req, this.opts);
    let expected: EngineSelectionRecord | undefined;
    let proposed: EngineSelectionRecord;
    try {
      expected = expectedSelection === undefined ? undefined : engineSelection(expectedSelection);
      proposed = engineSelection({ adapter: 'codex', provider: 'openai',
        model: req.model ?? this.opts.defaultModel ?? 'codex', capabilities: req.tools ?? [] });
    } catch {
      throw new EngineError({ kind: 'invalid-config', message: 'invalid Codex selection' });
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
    if (signal.aborted) throw new EngineError({ kind: 'aborted', message: 'Codex admission aborted' });
    const selected = engineSelection({ ...proposed, executable, adapterVersion });
    if (expected && !isDeepStrictEqual(selected, expected)) {
      throw new EngineError({ kind: 'invalid-config', message: 'Codex selection changed' });
    }
    return selected;
  }

  async run(
    req: AgentRequest,
    onEvent: EngineEventSink,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    if (req.tools?.length === 0)
      throw new EngineError({
        kind: 'invalid-config',
        message: 'codex cannot honor tools: []; choose an engine that supports disabling tools',
      });
    if (signal.aborted)
      throw new EngineError({
        kind: 'aborted',
        message: 'codex run aborted',
      });
    const { prompt: _prompt, ...admissionRequest } = req;
    const requested = await this.admit(admissionRequest, signal);
    const executable = requested.executable!;
    const model = req.model ?? this.opts.defaultModel;
    const dir = mkdtempSync(join(tmpdir(), 'lines-codex-'));
    const outFile = join(dir, 'last.txt');
    const args = buildCodexArgs(req, this.opts, outFile);
    const env = attemptEnvironment(req);
    const prompt = req.system ? `${req.system}\n\n---\n\n${req.prompt}` : req.prompt;
    const startedAt = Date.now();
    const owner = ownedCommandIdentity({
      adapter: 'codex',
      runId: req.attempt?.runId,
      leafId: req.attempt?.leafId,
      attemptId: req.attempt?.attemptId,
    });

    try {
      const sub = await runOwnedCommand(
        {
          executable,
          args,
          cwd: req.cwd ?? process.cwd(),
          env: env ?? {},
          stdin: prompt,
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
      ).catch((error: unknown) => { throw codexCommandError(error, executable); });
      let text = '';
      try {
        text = readFileSync(outFile, 'utf8').trim();
      } catch {
        /* no final message written */
      }
      const aborted = sub.aborted || signal.aborted;
      if (aborted && !text)
        throw new EngineError({ kind: 'aborted', message: 'codex run aborted' });
      const stdout = new TextDecoder().decode(sub.stdout);
      const stderr = new TextDecoder().decode(sub.stderr);
      const failed = aborted || sub.timedOut || sub.exitCode !== 0;
      const diagnostic = diagnosticCapture(stderr, stdout, env);
      let transportFailure: AgentResult['transportFailure'];
      if (failed && !text)
        throw new EngineError({
          kind: sub.timedOut
            ? 'timeout'
            : classifyEngineFailure(new Error(diagnostic)),
          // The combined streams are scrubbed in full before the middle cut,
          // so provider diagnostics survive without exposing a split secret.
          message: `codex exited ${sub.exitCode ?? '?'}${
            diagnostic ? `: ${diagnostic}` : ''
          }`,
        });
      if (failed) {
        transportFailure = {
          kind: aborted ? 'aborted' : sub.timedOut ? 'timeout' : 'unknown',
          message: `codex completed but exited ${sub.exitCode ?? '?'} during teardown${
            diagnostic ? `: ${diagnostic}` : ''
          }`,
          exitCode: sub.exitCode ?? null,
        };
      }

      // `cached_input_tokens` is a subset of Codex `input_tokens`, so the
      // terminal total is already normalized for the run budget.
      const usage = usageFromJsonl(stdout);
      if (text) onEvent({ type: 'text', delta: text });
      onEvent({ type: 'usage', usage, model: model ?? 'codex' });
      const late =
        typeof req.timeoutMs === 'number' &&
        Date.now() - startedAt > req.timeoutMs;
      return assistantResult({
        text,
        usage,
        requested,
        stopReason: 'end_turn',
        ...(transportFailure
          ? { transportFailure }
          : late
            ? {
                transportFailure: {
                  kind: 'timeout' as const,
                  message: 'codex result arrived after the soft timeout',
                  exitCode: sub.exitCode ?? null,
                },
              }
            : {}),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
