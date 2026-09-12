/** One bounded live call through the selected engine, with validated evidence. */

import {
  EngineError, EngineIncompleteResultError,
  type AgentResult, type AttemptMetadata, type Engine,
  type EngineIncompleteResultEvidence, type EngineSelectionRecord,
  type UsageReceipt,
} from './engine.js';
import { classifyEngineFailure, type EngineFailureKind } from './failure.js';
import {
  engineSelection, reportedUsage, requireFinalResultText,
  validateAgentResult, validateIncompleteResultEvidence,
} from '../runtime/result-parts.js';

export interface PreflightResult {
  engine: string;
  model?: string;
  ok: boolean;
  /** Set when the probe failed, using the live engine-failure vocabulary. */
  failure?: EngineFailureKind;
  /** One line of evidence: the reply, or the error message. */
  detail: string;
  latencyMs: number;
  usage?: UsageReceipt;
  effective?: EngineSelectionRecord;
  evidence?:
    | { readonly kind: 'complete'; readonly result: Omit<AgentResult, 'raw'> }
    | { readonly kind: 'incomplete'; readonly result: Omit<EngineIncompleteResultEvidence, 'raw'> };
}

export interface PreflightOptions {
  model?: string;
  /** Hard limit on waiting for the probe. Default 60s. */
  timeoutMs?: number;
  signal?: AbortSignal;
  cwd?: string;
  attempt?: AttemptMetadata;
}

const PROBE_PROMPT = 'Reply with the single word: ok';
const UNKNOWN_USAGE: UsageReceipt = Object.freeze({ kind: 'unknown' });

/** Probe one engine with a tiny live turn. Failures are returned, not thrown. */
export async function preflightEngine(
  engine: Engine,
  opts: PreflightOptions = {},
): Promise<PreflightResult> {
  const name = engine.name;
  const started = performance.now();
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const deadline = started + timeoutMs;
  let usage: UsageReceipt = UNKNOWN_USAGE;
  const latency = () => Math.max(0, Math.round(performance.now() - started));
  const failed = (
    failure: EngineFailureKind,
    detail: string,
    extra: Pick<PreflightResult, 'evidence' | 'effective'> = {},
  ): PreflightResult => ({
    engine: name, model: opts.model, ok: false, failure, detail,
    latencyMs: latency(), usage, ...extra,
  });
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    return failed('invalid-config', 'preflight timeoutMs must be a positive safe integer at most 2147483647');
  }
  if (opts.signal?.aborted) return failed('aborted', 'preflight was aborted');

  const controller = new AbortController();
  let closed = false;
  let stopped: 'timeout' | 'aborted' | undefined;
  let resolveStop!: () => void;
  const interruption = new Promise<void>((resolve) => { resolveStop = resolve; });
  const stop = (kind: 'timeout' | 'aborted'): void => {
    if (stopped !== undefined) return;
    stopped = kind;
    closed = true;
    resolveStop();
    controller.abort();
  };
  const onAbort = (): void => stop('aborted');
  const timer = setTimeout(() => stop('timeout'), Math.max(0, Math.ceil(deadline - performance.now())));
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const stoppedResult = (
    extra: Pick<PreflightResult, 'evidence' | 'effective'> = {},
  ): PreflightResult | undefined => {
    if (stopped === undefined && performance.now() >= deadline) stop('timeout');
    return stopped === undefined ? undefined : failed(stopped,
      stopped === 'aborted' ? 'preflight was aborted' : 'preflight exceeded its time limit', extra);
  };

  try {
    if (opts.signal?.aborted) {
      stop('aborted');
      return failed('aborted', 'preflight was aborted');
    }
    let pending: Promise<AgentResult>;
    try {
      pending = Promise.resolve(engine.run({
        prompt: PROBE_PROMPT, model: opts.model,
        purpose: 'preflight', tools: [], allowedTools: [], workspaceMode: 'none',
        maxTokens: 16, timeoutMs, leaf: true,
        ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
        ...(opts.attempt === undefined ? {} : {
          attempt: { ...opts.attempt, path: [...opts.attempt.path], leaf: true },
        }),
      }, (event) => {
        if (closed || performance.now() >= deadline || event.type !== 'usage') return;
        try {
          if (event.usage.kind === 'unknown') usage = UNKNOWN_USAGE;
          else if (event.usage.kind === 'reported') usage = reportedUsage(event.usage);
        } catch {
          // A malformed stream receipt cannot replace a validated receipt.
        }
      }, controller.signal));
    } catch (error) {
      pending = Promise.reject(error);
    }
    let settled: { kind: 'value'; value: AgentResult } | { kind: 'error'; error: unknown } | undefined;
    const operation = pending.then(
      (value) => { settled = { kind: 'value', value }; return settled; },
      (error: unknown) => { settled = { kind: 'error', error }; return settled; },
    );
    const first = await Promise.race([
      operation,
      interruption.then(() => ({ kind: 'stopped' as const })),
    ]);
    const outcome = first.kind === 'stopped' ? settled : first;
    if (outcome === undefined) return stoppedResult()!;

    if (outcome.kind === 'error') {
      const error = outcome.error;
      if (error instanceof EngineIncompleteResultError) {
        let result: Omit<EngineIncompleteResultEvidence, 'raw'>;
        try {
          const { raw: _raw, ...safe } = validateIncompleteResultEvidence(error.evidence);
          result = Object.freeze(safe);
        } catch {
          return stoppedResult() ?? failed('unknown', 'engine returned malformed incomplete evidence');
        }
        usage = result.usage;
        const extra = {
          effective: result.effective,
          evidence: Object.freeze({ kind: 'incomplete' as const, result }),
        };
        return stoppedResult(extra) ?? failed('unknown', error.message, extra);
      }
      let effective: EngineSelectionRecord | undefined;
      try {
        if (error instanceof EngineError && error.effective !== undefined) {
          effective = engineSelection(error.effective);
        }
      } catch {
        return stoppedResult() ?? failed('unknown', 'engine returned malformed failure identity');
      }
      const extra = effective === undefined ? {} : { effective };
      return stoppedResult(extra) ?? failed(classifyEngineFailure(error),
        error instanceof Error ? error.message : String(error), extra);
    }

    let result: Omit<AgentResult, 'raw'>;
    try {
      const { raw: _raw, ...safe } = validateAgentResult(outcome.value);
      result = Object.freeze(safe);
    } catch {
      return stoppedResult() ?? failed('unknown', 'engine returned a malformed result');
    }
    usage = result.usage;
    const evidence = Object.freeze({ kind: 'complete' as const, result });
    const extra = { evidence, effective: result.effective };
    const interrupted = stoppedResult(extra);
    if (interrupted !== undefined) return interrupted;
    let reply: string;
    try { reply = requireFinalResultText(result).trim(); }
    catch {
      return stoppedResult(extra) ?? failed('unknown', 'engine result must end with assistant text', extra);
    }
    return stoppedResult(extra) ?? {
      engine: name,
      model: opts.model ?? result.effective.model ?? undefined,
      ok: true,
      detail: reply ? `replied: ${reply.slice(0, 60)}` : 'replied (empty text)',
      latencyMs: latency(), usage, effective: result.effective, evidence,
    };
  } finally {
    closed = true;
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** Probe several engines concurrently (they are independent lanes). */
export async function preflight(
  engines: readonly Engine[],
  opts: PreflightOptions = {},
): Promise<PreflightResult[]> {
  return Promise.all(engines.map((engine) => preflightEngine(engine, opts)));
}

/** One line per lane, for terminals and logs. */
export function formatPreflight(result: PreflightResult): string {
  const head = result.ok ? '✓' : '✗';
  const lane = result.model ? `${result.engine} (${result.model})` : result.engine;
  const verdict = result.ok
    ? result.detail
    : `${result.failure}: ${result.detail}`;
  return `${head} ${lane}  ${verdict}  [${result.latencyMs}ms]`;
}
