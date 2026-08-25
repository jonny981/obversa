/**
 * Preflight: prove an engine can actually run **before** a loop spends a
 * turn discovering it can't. One deliberately tiny live turn per engine
 * (a few tokens), through the same `Engine` interface the run will use — so
 * it exercises the real lane end to end: binary present, authenticated,
 * funded, model reachable. A failure comes back classified
 * (`EngineFailureKind`), so "your key is dead" and "the CLI is not
 * installed" are distinct, actionable answers instead of iteration 1
 * burning its budget to find out.
 *
 * Definition validation is the offline pre-flight (zero spend). This module
 * provides the online pre-flight, which spends a few tokens to prove
 * the lanes). Run both before a long unattended run.
 */

import type { EngineRef, EngineOptions, Usage } from './engine.js';
import { isEngine } from './engine.js';
import { EngineRegistry } from './registry.js';
import { classifyEngineFailure, type EngineFailureKind } from './failure.js';

export interface PreflightResult {
  engine: string;
  model?: string;
  ok: boolean;
  /** Set when the probe failed, using the live engine-failure vocabulary. */
  failure?: EngineFailureKind;
  /** One line of evidence: the reply, or the error message. */
  detail: string;
  latencyMs: number;
  usage?: Usage;
}

export interface PreflightOptions {
  model?: string;
  /** Cap on the probe turn. Default 60s. */
  timeoutMs?: number;
  registry?: EngineRegistry;
  engineOptions?: EngineOptions;
  signal?: AbortSignal;
}

const PROBE_PROMPT = 'Reply with the single word: ok';

/** Probe one engine with a tiny live turn. Never throws — the answer is the result. */
export async function preflightEngine(
  ref: EngineRef,
  opts: PreflightOptions = {},
): Promise<PreflightResult> {
  const registry = opts.registry ?? new EngineRegistry(opts.engineOptions ?? {});
  const name = isEngine(ref) ? ref.name : String(ref);
  const started = Date.now();
  let usage: Usage | undefined;
  try {
    const engine = registry.create(ref, name);
    const result = await engine.run(
      {
        prompt: PROBE_PROMPT,
        model: opts.model,
        maxTokens: 16,
        timeoutMs: opts.timeoutMs ?? 60_000,
        leaf: true,
      },
      (event) => {
        if (event.type === 'usage') usage = event.usage;
      },
      opts.signal ?? new AbortController().signal,
    );
    const reply = result.text.trim();
    return {
      engine: name,
      model: opts.model ?? result.model,
      ok: true,
      detail: reply ? `replied: ${reply.slice(0, 60)}` : 'replied (empty text)',
      latencyMs: Date.now() - started,
      usage: usage ?? result.usage,
    };
  } catch (error) {
    return {
      engine: name,
      model: opts.model,
      ok: false,
      failure: classifyEngineFailure(error),
      detail: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - started,
      usage,
    };
  }
}

/** Probe several engines concurrently (they are independent lanes). */
export async function preflight(
  refs: readonly EngineRef[],
  opts: PreflightOptions = {},
): Promise<PreflightResult[]> {
  const registry = opts.registry ?? new EngineRegistry(opts.engineOptions ?? {});
  return Promise.all(refs.map((ref) => preflightEngine(ref, { ...opts, registry })));
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
