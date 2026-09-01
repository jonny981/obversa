/**
 * No-progress (stall) detection: the third hard stop, alongside `max` and
 * `budget`. `max` bounds how many attempts a loop gets and `budget` bounds what
 * they cost; neither can tell slow-but-real convergence from the same failure
 * repeating. This module detects the latter, so a stalled loop exits at
 * iteration N+window instead of running to its cap.
 *
 * The decision rule is NOVELTY, not change. An iteration makes progress when it
 * reaches a state this run has never seen:
 *
 *   - the workspace fingerprint (HEAD + pending diff + untracked content) is new
 *     — so an agent oscillating A→B→A gets no credit for the return trip;
 *   - a caller-supplied `signal` value is new — the escape hatch for loop jobs whose
 *     progress lives outside the worktree (a queue length, a passing-test count);
 *   - the gate confidence beats its previous best by `minConfidenceDelta` — a
 *     high-water mark, so judge jitter around a flat score is not progress but
 *     slow, steady improvement accumulates until it clears the bar;
 *   - (opt-in, `gate: true`) the failing until-gate's diagnostic OUTPUT is new
 *     — the same failure signature repeating is stall evidence, for
 *     deterministic gates whose output is stable across identical failures.
 *
 * `window` consecutive iterations with evidence and no novelty = stalled. The
 * default is deliberately conservative (any channel's novelty counts): a false
 * "stalled" on work that was actually converging is worse than one more
 * iteration. An iteration with NO evidence channel at all (no git workspace, no
 * confidence, no signal) is indeterminate — it neither extends nor resets the
 * stall run, and the detector reports itself inert so the loop can warn once.
 * Gate/review reasons are deliberately NOT compared: judge prose varies between
 * identical verdicts, so it is quoted in the report but never used as evidence.
 */

import { createHash } from 'node:crypto';

import type { NoProgressConfig, NoProgressInput, StallReport } from './types.js';
export type { NoProgressConfig, NoProgressInput, StallReport } from './types.js';

/** One completed, non-converged iteration as the tracker sees it. */
export interface ProgressSample {
  iteration: number;
  /** Workspace fingerprint, when the workspace is a git repo. */
  fingerprint?: string;
  /** The confidence that gated this turn (review ?? until ?? body). */
  confidence?: number;
  /** The custom signal value, when a `signal` fn is configured. */
  signal?: string;
  /** The failing gate's diagnostic OUTPUT — never the prose reason. */
  gate?: string;
  /** The gate/review reason — reporting only, never evidence. */
  reason?: string;
}

/** Resolve the `noProgress` sugar (`3` ⇒ `{ window: 3 }`) with defaults applied. */
export function resolveNoProgress(
  input: NoProgressInput | undefined,
): Required<Pick<NoProgressConfig, 'window' | 'minConfidenceDelta' | 'gate'>> &
  NoProgressConfig | undefined {
  if (input == null) return undefined;
  const cfg = typeof input === 'number' ? { window: input } : input;
  return {
    ...cfg,
    window: cfg.window ?? 3,
    minConfidenceDelta: cfg.minConfidenceDelta ?? 0.02,
    gate: cfg.gate ?? false,
  };
}

/**
 * The novelty tracker behind `LoopConfig.noProgress`. Feed it one sample per
 * non-converged iteration; it returns a `StallReport` the moment `window`
 * consecutive samples show evidence and no novelty.
 */
export class ProgressTracker {
  readonly window: number;
  readonly minConfidenceDelta: number;
  /** Every state this run has reached, namespaced by channel. */
  private readonly seen = new Set<string>();
  /** Confidence high-water mark — the best score at the last progress point. */
  private best: number | undefined;
  /** The current run of consecutive no-progress iterations. */
  private stalledRun: number[] = [];
  private lastEvidence: string[] = [];
  private lastReason = 'gate not met';
  private indeterminate = 0;
  private sampled = 0;

  constructor(cfg: { window: number; minConfidenceDelta: number }) {
    this.window = cfg.window;
    this.minConfidenceDelta = cfg.minConfidenceDelta;
  }

  /**
   * Record one iteration. Returns a `StallReport` when this sample fills the
   * window, else undefined.
   */
  record(sample: ProgressSample): StallReport | undefined {
    this.sampled += 1;
    if (sample.reason) this.lastReason = sample.reason;

    const flat: string[] = []; // channels that saw no novelty this turn
    let progressed = false;
    let channels = 0;

    if (sample.fingerprint !== undefined) {
      channels += 1;
      const key = `fp:${sample.fingerprint}`;
      if (this.seen.has(key)) {
        flat.push('workspace: no state this run has not already visited');
      } else {
        this.seen.add(key);
        progressed = true;
      }
    }
    if (sample.signal !== undefined) {
      channels += 1;
      const key = `sig:${sample.signal}`;
      if (this.seen.has(key)) {
        flat.push(`signal: "${sample.signal}" already seen this run`);
      } else {
        this.seen.add(key);
        progressed = true;
      }
    }
    if (sample.gate !== undefined) {
      channels += 1;
      // Hashed so the run-wide seen set stays bounded whatever the output size.
      const key = `gate:${createHash('sha256').update(sample.gate).digest('hex')}`;
      if (this.seen.has(key)) {
        flat.push('gate: failure output already seen this run');
      } else {
        this.seen.add(key);
        progressed = true;
      }
    }
    if (sample.confidence !== undefined) {
      channels += 1;
      if (
        this.best === undefined ||
        sample.confidence >= this.best + this.minConfidenceDelta
      ) {
        this.best = Math.max(this.best ?? -Infinity, sample.confidence);
        progressed = true;
      } else {
        flat.push(
          `confidence ${sample.confidence.toFixed(2)} did not improve on ` +
            `${this.best.toFixed(2)} (needs +${this.minConfidenceDelta})`,
        );
      }
    }

    if (channels === 0) {
      // Indeterminate: no evidence either way. Neither extend nor reset.
      this.indeterminate += 1;
      return undefined;
    }
    if (progressed) {
      this.stalledRun = [];
      return undefined;
    }

    this.stalledRun.push(sample.iteration);
    this.lastEvidence = flat;
    if (this.stalledRun.length < this.window) return undefined;
    return {
      window: this.window,
      iterations: [...this.stalledRun],
      reason: this.lastReason,
      evidence: [...this.lastEvidence],
    };
  }

  /**
   * True when the detector has seen a full window of samples and none carried
   * any evidence channel — detection is configured but cannot fire. The loop
   * uses this to warn once instead of failing silently-inert.
   */
  isInert(): boolean {
    return this.indeterminate >= this.window && this.indeterminate === this.sampled;
  }
}
