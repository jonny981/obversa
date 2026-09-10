import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { execa } from 'execa';

import type {
  ConditionInput,
  ConditionResult,
  FeedbackActionSeverity,
  FeedbackDecision,
  FeedbackFinding,
  FeedbackSeverity,
  GraphPosition,
  Job,
  JobContext,
  Outcome,
  RevisionRequest,
  RevisionRerun,
} from './types.js';
import { toCondition } from './condition.js';
import { setMeta } from './describe.js';
import { isInfrastructureError, LoopError } from './errors.js';
import {
  DEFAULT_FANOUT_CONCURRENCY,
  mapWithConcurrency,
} from './concurrency.js';
import { oneLine, truncate } from './text.js';
import { workspaceFingerprint } from './git.js';
import { criterionFor } from './context.js';

export type {
  FeedbackActionSeverity,
  FeedbackDecision,
  FeedbackFinding,
  FeedbackSeverity,
  RevisionRequest,
  RevisionRerun,
} from './types.js';

export interface RevisionRequestInput {
  target?: string;
  reason?: string;
  findings?: FeedbackFinding[];
  rerun?: RevisionRerun;
  source?: string;
  decision?: FeedbackDecision;
}

export function normalizeFeedbackSeverity(
  severity: FeedbackSeverity | undefined,
): FeedbackActionSeverity {
  return severity ?? 'block';
}

export function isRequiredFeedbackSeverity(
  severity: FeedbackSeverity | undefined,
): boolean {
  const normalized = normalizeFeedbackSeverity(severity);
  return normalized === 'block' || normalized === 'should-fix';
}

function findingLine(finding: FeedbackFinding): string {
  const reviewer = finding.reviewer ? `${finding.reviewer} ` : '';
  const severity = normalizeFeedbackSeverity(finding.severity);
  const decision = finding.decision ? ` Decision: ${finding.decision}.` : '';
  const recommendation = finding.recommendation
    ? ` Recommendation: ${oneLine(finding.recommendation)}`
    : '';
  return `- ${reviewer}[${severity}]: ${oneLine(finding.evidence)}${decision}${recommendation}`;
}

function defaultReason(findings: FeedbackFinding[] | undefined): string {
  if (!findings?.length) return 'Revision requested';
  if (findings.length === 1) return oneLine(findings[0]!.evidence);
  return `${findings.length} findings require another pass`;
}

function normalizeRevision(input: RevisionRequestInput): RevisionRequest {
  const reason = input.reason?.trim() || defaultReason(input.findings);
  return {
    reason,
    target: input.target,
    findings: input.findings,
    rerun: input.rerun ?? (input.target ? 'target-and-dependents' : undefined),
    source: input.source,
    decision: input.decision,
  };
}

export function revisionRequest(
  input: RevisionRequestInput,
  over: Partial<Outcome> = {},
): Outcome {
  const revision = normalizeRevision(input);
  return {
    status: over.status ?? 'fail',
    confidence: over.confidence,
    summary: over.summary ?? revision.reason,
    data: over.data,
    error: over.error,
    revision,
  };
}

export function kickback(
  to: string,
  reason: string,
  over: Partial<Outcome> = {},
): Outcome {
  // A kickback is just a targeted revision request; `rerun` defaults to
  // 'target-and-dependents' in normalizeRevision because a target is set.
  return revisionRequest({ target: to, reason }, over);
}

/**
 * The single accessor for an outcome's revision request. `Outcome.revision` is
 * the one channel a producer sets (`revisionRequest`, `kickback`, `reviewPanel`,
 * dag routing), so there is exactly one place to read it — no parallel `kickback`
 * field or `data` copy to keep in sync.
 */
export function revisionFromOutcome(outcome: Outcome): RevisionRequest | undefined {
  return outcome.revision;
}

export function feedbackBlock(outcome: Outcome): string {
  const revision = revisionFromOutcome(outcome);
  const parts = [
    '## Feedback to address',
    'A review or downstream stage requested another pass. Address this before unrelated work.',
  ];
  if (revision?.target) parts.push(`Target: ${revision.target}`);
  if (revision?.source) parts.push(`Source: ${revision.source}`);
  if (revision?.decision) parts.push(`Caller decision: ${revision.decision}`);
  const reason = revision?.reason ?? outcome.summary;
  if (reason) parts.push(`Reason: ${reason}`);
  const findings = revision?.findings ?? [];
  if (findings.length) {
    parts.push('Findings:');
    parts.push(findings.map(findingLine).join('\n'));
  }
  return parts.join('\n\n');
}

export function graphPositionBlock(
  graph: GraphPosition,
  reviewerGate?: string | null,
): string {
  return [
    '## Graph position',
    `DAG: ${graph.dag}`,
    `Current node: ${graph.node}`,
    ...(graph.desc ? [`Description: ${graph.desc}`] : []),
    ...(reviewerGate ? [`Gate: ${reviewerGate}`] : []),
    `Path: ${graph.path.join(' > ')}`,
    `Depends on: ${graph.needs.length ? graph.needs.join(', ') : 'none'}`,
    `Direct dependents: ${
      graph.dependents.length ? graph.dependents.join(', ') : 'none'
    }`,
  ].join('\n');
}

type ReviewTarget = {
  name?: string;
  scope?: string;
  /** Stable reviewer criteria version. Required when passes are persisted. */
  cacheVersion?: string;
  /** Workspace paths whose content can invalidate this reviewer's persisted pass. */
  invalidateOn?: string[];
} & ({ review: ConditionInput } | { job: Job });

export interface ReviewPanelConfig {
  label?: string;
  reviewers: ReviewTarget[];
  /** Max reviewers running at once. Default 4. */
  concurrency?: number;
  /** Default `all`: every reviewer must pass. A number means k-of-n over all reviewers. */
  pass?: 'all' | number;
  /** Reuse only passing verdicts at or above this confidence while their evidence is unchanged. */
  persistPasses?: { minConfidence: number };
  /**
   * When set, findings scoped outside these surfaces are escalated and do not
   * count against this panel's pass/fail decision. Unscoped findings stay
   * actionable so a missing scope cannot bypass review.
   */
  actionableScopes?: string[];
  /** When set, a failing panel emits a targeted revision request for dag routing. */
  target?: string;
  rerun?: RevisionRerun;
}

interface ReviewVerdict {
  kind: 'verdict';
  name: string;
  met: boolean;
  confidence?: number;
  reason: string;
  scope?: string;
  findings?: FeedbackFinding[];
}

interface ReviewEngineError {
  kind: 'engine-error';
  name: string;
  reason: string;
  error?: LoopError;
  scope?: string;
  findings?: FeedbackFinding[];
}

type ReviewResult = ReviewVerdict | ReviewEngineError;

interface PersistedReviewPass {
  identity: string;
  fingerprint: string;
  confidence: number;
}

type PersistedReviewPasses = Record<string, unknown>;

const SHA256_FINGERPRINT = /^[0-9a-f]{64}$/;

function reviewerCacheIdentity(
  reviewer: ReviewTarget,
  reviewerGate?: string,
): string {
  const invalidateOn = [...new Set(reviewer.invalidateOn ?? [])]
    .map((path) => path.trim())
    .filter(Boolean)
    .sort();
  return createHash('sha256')
    .update(
      JSON.stringify({
        name: reviewer.name!.trim(),
        cacheVersion: reviewer.cacheVersion!.trim(),
        kind: 'job' in reviewer ? 'job' : 'review',
        scope: reviewer.scope ?? null,
        invalidateOn,
        reviewerGate: reviewerGate ?? null,
      }),
    )
    .digest('hex');
}

function reviewPassCacheKey(ctx: JobContext, label: string): string {
  return `lines:review-panel:${JSON.stringify([...ctx.path, label])}`;
}

function reviewPassCache(value: unknown): PersistedReviewPasses {
  const cache: PersistedReviewPasses = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return cache;
  for (const [name, entry] of Object.entries(value))
    Object.defineProperty(cache, name, {
      value: entry,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  return cache;
}

function setReviewPass(
  cache: PersistedReviewPasses,
  name: string,
  pass: PersistedReviewPass,
): void {
  Object.defineProperty(cache, name, {
    value: pass,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function reusableReviewPass(
  value: unknown,
  minConfidence: number,
  identity: string,
): value is PersistedReviewPass {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const pass = value as Partial<PersistedReviewPass>;
  return (
    pass.identity === identity &&
    typeof pass.fingerprint === 'string' &&
    SHA256_FINGERPRINT.test(pass.fingerprint) &&
    typeof pass.confidence === 'number' &&
    Number.isFinite(pass.confidence) &&
    pass.confidence >= minConfidence &&
    pass.confidence <= 1
  );
}

interface PersistedReviewRun {
  result: ReviewResult;
  reusedFingerprint?: string;
}

const REVIEW_PANEL_DEFAULT_CONCURRENCY = DEFAULT_FANOUT_CONCURRENCY;
function isReviewInfrastructureError(
  error: LoopError | undefined,
): error is LoopError {
  return isInfrastructureError(error);
}

function findingFromOutput(
  reviewer: string,
  scope: string | undefined,
  output: string | undefined,
): FeedbackFinding[] | undefined {
  const evidence = output?.trim();
  if (!evidence) return undefined;
  return [{ reviewer, severity: 'block', scope, evidence }];
}

function outputFromInfrastructureError(error: LoopError): string | undefined {
  const cause = (error as Error & { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) return undefined;
  const output = (cause as { output?: unknown }).output;
  return typeof output === 'string' ? output : undefined;
}

async function runReviewer(
  reviewer: ReviewTarget,
  index: number,
  ctx: JobContext,
): Promise<ReviewResult> {
  const name = reviewer.name ?? `reviewer-${index + 1}`;
  const reviewerCtx: JobContext = {
    ...ctx,
    reviewerGate: criterionFor(ctx),
  };
  try {
    if ('job' in reviewer) {
      const outcome = await reviewer.job(reviewerCtx);
      const outcomeError = outcome.error;
      if (isReviewInfrastructureError(outcomeError)) {
        return {
          kind: 'engine-error',
          name,
          scope: reviewer.scope,
          reason: outcome.summary ?? outcomeError.message,
          error: outcomeError,
        };
      }
      return {
        kind: 'verdict',
        name,
        met: outcome.status === 'pass',
        confidence: outcome.confidence,
        reason: outcome.summary ?? outcome.status,
        scope: reviewer.scope,
        findings: revisionFromOutcome(outcome)?.findings,
      };
    }
    const result: ConditionResult = await toCondition(reviewer.review)(
      reviewerCtx,
      ctx.lastOutcome,
    );
    return {
      kind: 'verdict',
      name,
      met: result.met,
      confidence: result.confidence,
      reason: result.reason,
      scope: reviewer.scope,
      findings: result.met
        ? undefined
        : findingFromOutput(name, reviewer.scope, result.output),
    };
  } catch (e) {
    // A genuine abort stops the whole run — let it propagate.
    if (ctx.signal.aborted) throw e;
    const error = e instanceof LoopError ? e : undefined;
    if (error && isReviewInfrastructureError(error)) {
      return {
        kind: 'engine-error',
        name,
        scope: reviewer.scope,
        reason: error.message,
        error,
        findings: findingFromOutput(
          name,
          reviewer.scope,
          outputFromInfrastructureError(error),
        ),
      };
    }
    return {
      kind: 'verdict',
      name,
      met: false,
      scope: reviewer.scope,
      reason: `reviewer errored: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

async function runPersistedReviewer(
  reviewer: ReviewTarget,
  index: number,
  ctx: JobContext,
  cache: PersistedReviewPasses,
  minConfidence: number,
): Promise<PersistedReviewRun> {
  const name = reviewer.name!;
  const identity = reviewerCacheIdentity(
    reviewer,
    criterionFor(ctx),
  );
  const before = await workspaceFingerprint({
    cwd: ctx.workspace.dir,
    signal: ctx.signal,
    excludePaths: ctx.fingerprintExcludePaths,
    includePaths: reviewer.invalidateOn,
  });
  const cached = cache[name];
  if (
    before !== undefined &&
    reusableReviewPass(cached, minConfidence, identity) &&
    cached.fingerprint === before
  ) {
    return {
      result: {
        kind: 'verdict',
        name,
        met: true,
        confidence: cached.confidence,
        reason: 'reused persisted pass',
        scope: reviewer.scope,
      },
      reusedFingerprint: before,
    };
  }

  delete cache[name];
  const result = await runReviewer(reviewer, index, ctx);
  if (
    before === undefined ||
    result.kind !== 'verdict' ||
    !result.met ||
    result.confidence === undefined ||
    !Number.isFinite(result.confidence) ||
    result.confidence < minConfidence ||
    result.confidence > 1
  )
    return { result };

  const after = await workspaceFingerprint({
    cwd: ctx.workspace.dir,
    signal: ctx.signal,
    excludePaths: ctx.fingerprintExcludePaths,
    includePaths: reviewer.invalidateOn,
  });
  if (after !== undefined && after === before)
    setReviewPass(cache, name, {
      identity,
      fingerprint: after,
      confidence: result.confidence,
    });
  return { result };
}

async function settlePersistedReviewers(
  reviewers: readonly ReviewTarget[],
  initial: readonly PersistedReviewRun[],
  ctx: JobContext,
  cache: PersistedReviewPasses,
  minConfidence: number,
  concurrency: number,
): Promise<ReviewResult[]> {
  // A reused seat can become stale while the other reviewers are running.
  // Finish the initial fan-out before checking every reuse against its evidence.
  const staleIndices = (
    await mapWithConcurrency(initial, concurrency, async (run, index) => {
      if (run.reusedFingerprint === undefined) return undefined;
      const current = await workspaceFingerprint({
        cwd: ctx.workspace.dir,
        signal: ctx.signal,
        excludePaths: ctx.fingerprintExcludePaths,
        includePaths: reviewers[index]!.invalidateOn,
      });
      return current === run.reusedFingerprint ? undefined : index;
    })
  ).filter((index): index is number => index !== undefined);

  for (const index of staleIndices) delete cache[reviewers[index]!.name!];

  const reruns = await mapWithConcurrency(
    staleIndices,
    concurrency,
    async (index) => ({
      index,
      run: await runPersistedReviewer(
        reviewers[index]!,
        index,
        ctx,
        cache,
        minConfidence,
      ),
    }),
  );
  const results = initial.map((run) => run.result);
  for (const { index, run } of reruns) results[index] = run.result;

  // A bounded rerun may invalidate any passing seat. Do not rerun again, but
  // fail this tally closed and evict the stale pass for the next invocation.
  await mapWithConcurrency(results, concurrency, async (result, index) => {
    if (result.kind !== 'verdict' || !result.met) return;
    const reviewer = reviewers[index]!;
    const name = reviewer.name!;
    const cached = cache[name];
    if (
      !reusableReviewPass(
        cached,
        minConfidence,
        reviewerCacheIdentity(
          reviewer,
          criterionFor(ctx),
        ),
      )
    )
      return;
    const current = await workspaceFingerprint({
      cwd: ctx.workspace.dir,
      signal: ctx.signal,
      excludePaths: ctx.fingerprintExcludePaths,
      includePaths: reviewer.invalidateOn,
    });
    if (current !== cached.fingerprint) {
      delete cache[name];
      results[index] = {
        ...result,
        met: false,
        reason: 'review evidence changed during panel',
      };
    }
  });

  return results;
}

function reviewFindings(result: ReviewVerdict): FeedbackFinding[] {
  const findings = result.findings?.length
    ? result.findings
    : [
        {
          reviewer: result.name,
          severity: 'block' as const,
          scope: result.scope,
          evidence: result.reason,
        },
      ];
  return findings.map((finding) => ({
    ...finding,
    reviewer: finding.reviewer ?? result.name,
    severity: finding.severity ?? 'block',
    scope: finding.scope ?? result.scope,
  }));
}

function isActionableFinding(
  finding: FeedbackFinding,
  actionableScopes: readonly string[] | undefined,
): boolean {
  if (!actionableScopes?.length) return true;
  return !finding.scope || actionableScopes.includes(finding.scope);
}

function escalatedFinding(finding: FeedbackFinding): FeedbackFinding {
  return { ...finding, decision: 'escalated' };
}

function findingSeverityCounts(
  findings: FeedbackFinding[],
): Partial<Record<FeedbackActionSeverity, number>> {
  const counts: Partial<Record<FeedbackActionSeverity, number>> = {};
  for (const finding of findings) {
    const severity = normalizeFeedbackSeverity(finding.severity);
    counts[severity] = (counts[severity] ?? 0) + 1;
  }
  return counts;
}

export function reviewPanel(config: ReviewPanelConfig): Job {
  const label = config.label ?? 'review-panel';
  // A panel with no reviewers would pass vacuously (0/0), letting unreviewed work
  // through a gate meant to enforce review. Reject it at construction.
  if (!config.reviewers.length)
    throw new LoopError({
      code: 'CONFIG',
      message: `reviewPanel "${label}": at least one reviewer is required`,
    });
  if (
    typeof config.pass === 'number' &&
    (!Number.isInteger(config.pass) ||
      config.pass < 1 ||
      config.pass > config.reviewers.length)
  )
    throw new LoopError({
      code: 'CONFIG',
      message:
        `reviewPanel "${label}": pass must be an integer from 1 to ` +
        `${config.reviewers.length} (got ${config.pass})`,
    });
  const concurrency = config.concurrency ?? REVIEW_PANEL_DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency <= 0)
    throw new LoopError({
      code: 'CONFIG',
      message: `reviewPanel "${label}": concurrency must be a positive integer`,
    });
  if (config.persistPasses) {
    const minConfidence = config.persistPasses.minConfidence;
    if (
      !Number.isFinite(minConfidence) ||
      minConfidence < 0 ||
      minConfidence > 1
    )
      throw new LoopError({
        code: 'CONFIG',
        message: `reviewPanel "${label}": persistPasses.minConfidence must be from 0 to 1`,
      });
    if (!config.label?.trim())
      throw new LoopError({
        code: 'CONFIG',
        message: 'reviewPanel persistPasses requires an explicit label',
      });
    const names = config.reviewers.map((reviewer) => reviewer.name?.trim());
    if (names.some((name) => !name))
      throw new LoopError({
        code: 'CONFIG',
        message: `reviewPanel "${label}" persistPasses requires every reviewer to have an explicit name`,
      });
    if (new Set(names).size !== names.length)
      throw new LoopError({
        code: 'CONFIG',
        message: `reviewPanel "${label}" persistPasses requires unique reviewer names`,
      });
    if (config.reviewers.some((reviewer) => !reviewer.cacheVersion?.trim()))
      throw new LoopError({
        code: 'CONFIG',
        message: `reviewPanel "${label}" persistPasses requires every reviewer to have an explicit cacheVersion`,
      });
  }
  const job: Job = async (ctx) => {
    ctx.emit({
      kind: 'job:start',
      ts: Date.now(),
      path: [...ctx.path],
      label,
      timeoutMs: ctx.timeoutMs,
    });
    const cacheKey = config.persistPasses
      ? reviewPassCacheKey(ctx, label)
      : undefined;
    const cache = cacheKey ? reviewPassCache(ctx.state[cacheKey]) : undefined;
    if (cache) {
      const names = new Set(config.reviewers.map((reviewer) => reviewer.name));
      for (const name of Object.keys(cache))
        if (!names.has(name)) delete cache[name];
    }
    if (cacheKey && cache) ctx.state[cacheKey] = cache;
    let results: ReviewResult[];
    if (cache && config.persistPasses) {
      const initial = await mapWithConcurrency(
        config.reviewers,
        concurrency,
        (reviewer, i) =>
          runPersistedReviewer(
            reviewer,
            i,
            ctx,
            cache,
            config.persistPasses!.minConfidence,
          ),
      );
      results = await settlePersistedReviewers(
        config.reviewers,
        initial,
        ctx,
        cache,
        config.persistPasses.minConfidence,
        concurrency,
      );
    } else {
      results = await mapWithConcurrency(
        config.reviewers,
        concurrency,
        (reviewer, i) => runReviewer(reviewer, i, ctx),
      );
    }
    if (cacheKey && cache && !Object.keys(cache).length)
      delete ctx.state[cacheKey];
    const verdicts = results.filter(
      (r): r is ReviewVerdict => r.kind === 'verdict',
    );
    const errors = results.filter(
      (r): r is ReviewEngineError => r.kind === 'engine-error',
    );
    const passedCount = verdicts.filter((r) => r.met).length;
    const required =
      config.pass === undefined || config.pass === 'all'
        ? results.length
        : config.pass;
    const rawFindings = [
      ...verdicts.filter((r) => !r.met).flatMap(reviewFindings),
      ...errors.flatMap((r) => r.findings ?? []),
    ];
    const findings = rawFindings.filter((f) =>
      isActionableFinding(f, config.actionableScopes),
    );
    const escalatedFindings = rawFindings
      .filter((f) => !isActionableFinding(f, config.actionableScopes))
      .map(escalatedFinding);
    const passed = verdicts.length > 0 && passedCount >= required;
    const summaryHead = `Review panel: ${passedCount}/${results.length} reviewer(s) cleared`;
    const summaryParts = [`${summaryHead}.`];
    if (findings.length) summaryParts.push(findings.map(findingLine).join('\n'));
    if (escalatedFindings.length)
      summaryParts.push(
        `Escalated:\n${escalatedFindings.map(findingLine).join('\n')}`,
      );
    if (errors.length)
      summaryParts.push(
        `Engine errors:\n${errors
          .map((e) => `- ${e.name}: ${oneLine(e.reason)}`)
          .join('\n')}`,
      );
    const summary = summaryParts.join('\n');
    // Average only the confidences reviewers actually reported. Coercing a
    // missing confidence to 0 conflates "no signal" with "zero confidence" and
    // can drag a cleanly-passing panel's confidence to 0, stalling an enclosing
    // loop's minConfidence gate (quorum likewise averages only the votes it has).
    const scored = verdicts
      .map((r) => r.confidence)
      .filter((c): c is number => c != null);
    const confidence = scored.length
      ? scored.reduce((sum, c) => sum + c, 0) / scored.length
      : undefined;
    const data = {
      findings,
      escalatedFindings,
      errors,
      results,
      passed: passedCount,
      required,
      severityCounts: findingSeverityCounts(findings),
    };
    const blockedByInfrastructure =
      errors.length > 0 &&
      (config.pass === undefined || config.pass === 'all'
        ? true
        : passedCount < required && passedCount + errors.length >= required);
    let outcome: Outcome;
    if (passed) {
      outcome = { status: 'pass', summary, confidence, data };
    } else if (blockedByInfrastructure || (!findings.length && errors.length)) {
      const first = errors[0]!;
      outcome = {
        status: 'paused',
        summary,
        confidence,
        data,
        error:
          first.error ??
          new LoopError({
            code: 'ENGINE',
            phase: 'review',
            message: first.reason,
          }),
      };
    } else if (!findings.length && escalatedFindings.length) {
      outcome = { status: 'pass', summary, confidence, data };
    } else {
      outcome = revisionRequest(
          {
            target: config.target,
            // A clean one-line reason. The findings ride the `findings` array, so
            // feedbackBlock renders them once (not embedded in the reason too) and
            // the records/tail `reason` stays a single tidy line. The full
            // multi-line `summary` is kept on the outcome below for host logs.
            reason: `${summaryHead}.`,
            findings,
            rerun: config.rerun,
          },
          { summary, confidence, data },
        );
    }
    ctx.emit({ kind: 'job:end', ts: Date.now(), path: [...ctx.path], label, outcome });
    return outcome;
  };
  return setMeta(job, {
    kind: 'reviewPanel',
    name: label,
    concurrency,
    actionableScopes: config.actionableScopes,
  });
}

export interface ReviewContextConfig {
  diff?: boolean;
  files?: string[];
  tests?: boolean | { command: string; args?: string[]; cwd?: string };
  maxChars?: number;
}

async function gitOutput(
  cwd: string,
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  const out = await execa('git', args, {
    cwd,
    reject: false,
    stripFinalNewline: false,
    cancelSignal: signal,
  });
  return out.stdout.trim();
}

async function resolveFiles(
  ctx: JobContext,
  patterns: string[],
): Promise<string[]> {
  const fromGit = await gitOutput(
    ctx.workspace.dir,
    ['ls-files', '--', ...patterns],
    ctx.signal,
  ).catch(() => '');
  const files = fromGit ? fromGit.split('\n').filter(Boolean) : [];
  if (files.length) return files;
  return patterns.filter((p) => existsSync(join(ctx.workspace.dir, p)));
}

export function reviewContext(config: ReviewContextConfig) {
  return async (ctx: JobContext, last: Outcome | undefined): Promise<string> => {
    const max = config.maxChars ?? 6000;

    const buildTests = async (): Promise<string[]> => {
      if (!config.tests) return [];
      if (config.tests === true) {
        const lines: string[] = [];
        if (last?.status) lines.push(`Last outcome status: ${last.status}`);
        if (last?.summary) lines.push(`Last outcome summary: ${last.summary}`);
        if (last?.data !== undefined) {
          // Guard the stringify: a circular or BigInt-bearing `data` would throw,
          // and agentCheck awaits context() outside its try/catch, so the throw
          // would fail the whole review instead of degrading the evidence.
          let rendered: string;
          try {
            rendered = JSON.stringify(last.data, null, 2);
          } catch {
            rendered = String(last.data);
          }
          lines.push(`Last outcome data: ${rendered}`);
        }
        return lines.length
          ? [`## Test and outcome context\n\n${lines.join('\n')}`]
          : [];
      }
      const cwd = config.tests.cwd ?? ctx.workspace.dir;
      // Unlike the git probes, an unspawnable or aborted command would otherwise
      // reject out of reviewContext and throw the whole review. Guard it, and
      // never report `exit: 0` for a command that did not actually run — that
      // would tell the judge the tests passed.
      const result = await execa(
        config.tests.command,
        config.tests.args ?? [],
        { cwd, reject: false, stripFinalNewline: false, cancelSignal: ctx.signal },
      ).catch((e: unknown) => {
        if (ctx.signal.aborted) throw e; // a real abort stops the run
        return {
          exitCode: undefined as number | undefined,
          stdout: '',
          stderr: e instanceof Error ? e.message : String(e),
        };
      });
      const exit = result.exitCode ?? '(command did not run)';
      return [
        `## Test command\n\n${config.tests.command} ${(config.tests.args ?? []).join(' ')}\n\n` +
          `exit: ${exit}\n\nstdout:\n${truncate(result.stdout ?? '', max)}\n\nstderr:\n${truncate(result.stderr ?? '', max)}`,
      ];
    };

    const buildDiff = async (): Promise<string[]> => {
      if (!config.diff) return [];
      const diff = await gitOutput(
        ctx.workspace.dir,
        ['diff', 'HEAD', '--'],
        ctx.signal,
      ).catch(() => '');
      return diff ? [`## Git diff\n\n${truncate(diff, max)}`] : [];
    };

    const buildFiles = async (): Promise<string[]> => {
      if (!config.files?.length) return [];
      const files = await resolveFiles(ctx, config.files);
      const out: string[] = [];
      for (const file of files) {
        const path = join(ctx.workspace.dir, file);
        if (!existsSync(path)) continue;
        out.push(`## File: ${file}\n\n${truncate(readFileSync(path, 'utf8'), max)}`);
      }
      return out;
    };

    // The three evidence sources are independent read-only probes; gather them
    // concurrently, then assemble in a fixed order.
    const [tests, diff, files] = await Promise.all([
      buildTests(),
      buildDiff(),
      buildFiles(),
    ]);
    const sections = [...tests, ...diff, ...files];
    return truncate(
      sections.join('\n\n---\n\n') || '(no review context)',
      max,
    );
  };
}
