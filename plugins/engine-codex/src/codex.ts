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
import { join } from 'node:path';
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
  type UsageReceipt,
} from '@obversa/engine';
import {
  DEFAULT_OWNED_COMMAND_LIMITS,
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

export class CodexEngine implements Engine {
  readonly name = 'codex';
  private executable: string | undefined;
  constructor(private readonly opts: CodexEngineOptions = {}) {}

  private commandExecutable(): string {
    this.executable ??= resolveCommandExecutable(this.opts.cliBinary ?? 'codex');
    return this.executable;
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
    const executable = this.commandExecutable();
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
      );
      let text = '';
      try {
        text = readFileSync(outFile, 'utf8').trim();
      } catch {
        /* no final message written */
      }
      if ((sub.aborted || signal.aborted) && !(sub.timedOut && text))
        throw new EngineError({ kind: 'aborted', message: 'codex run aborted' });
      const stdout = new TextDecoder().decode(sub.stdout);
      const stderr = new TextDecoder().decode(sub.stderr);
      const failed = sub.timedOut || sub.exitCode !== 0;
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
          kind: sub.timedOut ? 'timeout' : 'unknown',
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
      const requested = engineSelection({
        adapter: 'codex',
        provider: 'openai',
        model: model ?? 'codex',
        executable,
      });
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
