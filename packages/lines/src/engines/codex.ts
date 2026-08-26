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
import { execa } from 'execa';
import type {
  AgentRequest,
  AgentResult,
  Engine,
  EngineEventSink,
  EngineOptions,
  UsageReceipt,
} from './engine.js';
import { modelFor, requestEnv } from './engine.js';
import { settleOnExit } from './settle.js';
import { LoopError } from '../core/errors.js';
import { scrubCapture } from '../core/redact.js';
import {
  assistantResult,
  engineSelection,
  reportedUsage,
} from '../runtime/result-parts.js';

const DIAGNOSTIC_MAX = 700;
const DIAGNOSTIC_HEAD = 180;

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
  opts: EngineOptions,
  outFile: string,
): string[] {
  const model = modelFor(req, opts, 'codex');
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
  constructor(private readonly opts: EngineOptions = {}) {}

  async run(
    req: AgentRequest,
    onEvent: EngineEventSink,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    if (req.tools?.length === 0)
      throw new LoopError({
        code: 'CONFIG',
        phase: 'engine',
        message: 'codex cannot honor tools: []; choose an engine that supports disabling tools',
      });
    const model = modelFor(req, this.opts, 'codex');
    const dir = mkdtempSync(join(tmpdir(), 'lines-codex-'));
    const outFile = join(dir, 'last.txt');
    const args = buildCodexArgs(req, this.opts, outFile);
    const env = requestEnv(req);
    const prompt = req.system ? `${req.system}\n\n---\n\n${req.prompt}` : req.prompt;
    const hardTimeout =
      req.timeoutMs && req.timeoutGraceMs
        ? req.timeoutMs + req.timeoutGraceMs
        : req.timeoutMs;
    const startedAt = Date.now();

    try {
      // Settled on process exit, not stream close: codex spawns MCP transport
      // workers and hook processes that inherit its stdio, and an orphan
      // holding the pipes would otherwise pin this await forever (see settle.ts).
      const sub = await settleOnExit(
        execa(this.opts.cliBinary ?? 'codex', args, {
          // execa merges this over `process.env` (`extendEnv` default); undefined
          // is inert, so a request with no env changes nothing.
          env,
          input: prompt,
          cancelSignal: signal,
          forceKillAfterDelay: 5000,
          reject: false,
          timeout: hardTimeout,
        }),
      );
      if (signal.aborted)
        throw new LoopError({ code: 'ABORTED', phase: 'engine', message: 'codex run aborted' });

      let text = '';
      try {
        text = readFileSync(outFile, 'utf8').trim();
      } catch {
        /* no final message written */
      }
      const diagnostic = diagnosticCapture(sub.stderr, sub.stdout, env);
      let transportFailure: AgentResult['transportFailure'];
      if (sub.failed && (sub.timedOut || !text))
        throw new LoopError({
          code: sub.timedOut ? 'TIMEOUT' : 'ENGINE',
          phase: 'engine',
          // The combined streams are scrubbed in full before the middle cut,
          // so provider diagnostics survive without exposing a split secret.
          message: `codex exited ${sub.exitCode ?? '?'}${
            diagnostic ? `: ${diagnostic}` : ''
          }`,
        });
      if (sub.failed) {
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
      const usage = usageFromJsonl(sub.stdout);
      if (text) onEvent({ type: 'text', delta: text });
      onEvent({ type: 'usage', usage, model: model ?? 'codex' });
      const requested = engineSelection({
        adapter: 'codex',
        provider: 'openai',
        model: model ?? 'codex',
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
