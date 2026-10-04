/**
 * The loop primitive. `loop(config)` returns a `Job`, so loop jobs nest by simply
 * passing one as another's `body` or `review`.
 *
 * Lifecycle of one loop:
 *   1. `start` gate (one-or-many conditions) — unmet => `aborted`.
 *   2. repeat, up to `max`:
 *        run `body` (fresh context each turn) → `stopOn`? → `until`?
 *        if `until` is met and there's a `review`, run it:
 *          review `pass`  => loop completes `pass`
 *          review !pass   => re-enter the loop  ← "review fails, run main loop again"
 *          review !pass on the last round `max` allows => `fail`
 *      with no `until`, a `pass` body ends the loop; `max` reached => `exhausted`.
 *   3. `onComplete` post-action runs once, whatever the status.
 *
 * The review-restart cycle is bounded: by `max` (shared with ordinary
 * iterations) and, independently, by `maxReviewRestarts`. The failed review is
 * threaded to the next iteration as `ctx.lastReview` so the body can act on it.
 *
 * Every piece of user code (conditions, the body, hooks, the review) is guarded:
 * a throw is classified and ends the loop with `fail`, but `loop:end` and the
 * `onComplete` post-action still run.
 */

import type {
  Condition,
  ConditionResult,
  JobContext,
  LoopConfig,
  Outcome,
  Job,
} from './types.js';
import { childContext } from './context.js';
import { prepareCondition } from './condition.js';
import { setMeta, jobMeta, describeConditions } from './describe.js';
import { LoopError, type LoopPhase } from './errors.js';
import { isLimitError, waitMsFor } from './limits.js';
import { ProgressTracker, resolveNoProgress } from './progress.js';
import { roundRule } from './rounds.js';
import { workspaceFingerprint } from './git.js';
import { checkpointInteraction, interactionDeclaration, interactionIdentity, jsonSnapshot, outcomeSnapshot, savedInteraction } from './interaction.js';
import type { ProgressSample } from './progress.js';

const VALID_STATUS = new Set<Outcome['status']>([
  'pass',
  'fail',
  'aborted',
  'exhausted',
  'paused',
]);

/** A limit policy's verdict for one limited iteration. */
type LimitAction =
  | { kind: 'wait'; waitMs: number }
  | { kind: 'pause'; reason: string };

/**
 * Decide what to do about a limit error under the run's `onLimit` policy.
 *   - `fail`         → never handled here (caller treats it as fatal).
 *   - `auto`         → wait when the reset is known AND within `maxWaitMs`
 *                      (BUDGET never refreshes, so it always pauses).
 *   - `wait`         → wait whenever the reset is known (no ceiling).
 *   - `exit`         → never wait; always pause.
 */
function decideLimit(error: LoopError, ctx: JobContext): LimitAction {
  const reason = error.message;
  if (ctx.onLimit === 'exit') return { kind: 'pause', reason };
  const waitMs = waitMsFor(error);
  if (waitMs == null) return { kind: 'pause', reason };
  if (ctx.onLimit === 'wait') return { kind: 'wait', waitMs };
  // auto: wait only within the ceiling.
  if (waitMs <= ctx.maxWaitMs) return { kind: 'wait', waitMs };
  return {
    kind: 'pause',
    reason: `${reason} (reset in ${Math.round(waitMs / 1000)}s exceeds maxWait ${Math.round(ctx.maxWaitMs / 1000)}s)`,
  };
}
const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * The last rejected review's revision, kept on the outcome of a loop that
 * ran out so it says what was still wrong. Its target is dropped: a loop that ran out sends
 * nothing back.
 */
function lastFindings(review: Outcome | undefined): Pick<Outcome, 'revision'> {
  if (!review?.revision) return {};
  const { target: _target, rerun: _rerun, ...revision } = review.revision;
  return { revision };
}

export function loop(config: LoopConfig): Job {
  if (!config.name)
    throw new LoopError({
      code: 'CONFIG',
      message: 'loop() requires a non-empty name',
    });
  if (config.checkFirst && config.until == null)
    throw new LoopError({
      code: 'CONFIG',
      message: 'loop() checkFirst requires an explicit until gate',
    });
  const onError = config.retry?.onError ?? 'continue';
  const noProgress = resolveNoProgress(config.noProgress);

  const job: Job = async (parent: JobContext): Promise<Outcome> => {
    const path = [...parent.path, config.name];
    const depth = parent.depth + 1;
    const ts = () => Date.now();

    const checkpointPath = [...path, '@interaction-loop'];
    const identity = interactionIdentity({ config, params: parent.params });
    const saved = savedInteraction(parent, checkpointPath, identity);
    let checkpointed = saved !== undefined;
    let resumePhase = saved?.phase as 'body' | 'review' | undefined;
    let lastReview = (saved?.lastReview as unknown as Outcome | undefined) ?? parent.lastReview;
    let lastGate = saved?.lastGate as unknown as ConditionResult | undefined;
    let iteration = typeof saved?.iteration === 'number' ? saved.iteration : 0;
    if (resumePhase === 'body') iteration -= 1;
    const ctxAt = (iter: number, lastOutcome?: Outcome): JobContext =>
      childContext(parent, {
        depth,
        path,
        iteration: iter,
        lastOutcome,
        lastReview,
        lastGate,
      });

    parent.emit({ kind: 'loop:start', ts: ts(), path, depth, max: config.max });

    const finish = async (
      outcome: Outcome,
      iterations: number,
    ): Promise<Outcome> => {
      if (checkpointed && outcome.status !== 'paused' && outcome.status !== 'aborted') checkpointInteraction(parent, checkpointPath, identity, null);
      parent.emit({ kind: 'loop:end', ts: ts(), path, outcome, iterations });
      if (config.onComplete) {
        try {
          await config.onComplete(outcome, ctxAt(iterations));
        } catch (e) {
          const error = LoopError.from(e, {
            code: 'BODY',
            phase: 'review',
            path,
            iteration: iterations,
          });
          parent.emit({
            kind: 'error',
            ts: ts(),
            path,
            message: `onComplete threw: ${error.message}`,
            code: error.code,
          });
        }
      }
      return outcome;
    };

    // Evaluate a gate, classifying any throw with the gate's phase.
    const gate = async (
      cond: Condition,
      which: LoopPhase,
      ctx: JobContext,
      last: Outcome | undefined,
    ) => {
      try {
        return await cond(ctx, last);
      } catch (e) {
        throw LoopError.from(e, {
          code: 'VALIDATION',
          phase: which,
          path,
          iteration,
        });
      }
    };

    try {
      if (parent.signal.aborted)
        return finish(
          { status: 'aborted', summary: 'aborted by signal' },
          0,
        );
      const entryContext = ctxAt(0);
      const [start, until, stopOn] = await Promise.all([
        config.start ? prepareCondition(config.start, entryContext) : undefined,
        config.until ? prepareCondition(config.until, entryContext) : undefined,
        config.stopOn ? prepareCondition(config.stopOn, entryContext) : undefined,
      ]);

      // 1. start gate
      if (start && !saved) {
        const r = await gate(start, 'start', ctxAt(0), undefined);
        parent.emit({
          kind: 'loop:condition',
          ts: ts(),
          path,
          which: 'start',
          iteration: 0,
          result: r,
        });
        if (!r.met)
          return finish(
            { status: 'aborted', summary: `start gate not met: ${r.reason}` },
            0,
          );
      }

      let last = saved?.last as unknown as Outcome | undefined;
      let consecutiveErrors = Number(saved?.consecutiveErrors ?? 0);
      let consecutiveReviewFails = Number(saved?.consecutiveReviewFails ?? 0);
      // The last review this loop rejected, for an exhausted outcome's findings.
      let rejectedReview: Outcome | undefined;
      // Per-invocation, so a re-run of the same Job (a kickback, a nested loop's
      // second pass) starts with a clean novelty set.
      const tracker = noProgress
        ? new ProgressTracker(noProgress)
        : undefined;
      const samples = [...((saved?.samples ?? []) as unknown as ProgressSample[])];
      for (const sample of samples) tracker?.record(sample);
      let warnedInert = false;
      const checkpointContext = (ctx: JobContext, phase: 'body' | 'review'): JobContext => ({
        ...ctx,
        interactionCheckpoint() {
          checkpointed = true;
          parent.interactionCheckpoint?.();
          checkpointInteraction(parent, checkpointPath, identity, jsonSnapshot({
            phase, iteration, consecutiveErrors, consecutiveReviewFails, samples,
            ...(last ? { last: outcomeSnapshot(last) } : {}),
            ...(lastReview ? { lastReview: outcomeSnapshot(lastReview) } : {}),
            ...(lastGate ? { lastGate: Object.fromEntries(Object.entries(lastGate).filter(([, value]) => value !== undefined)) } : {}),
          }));
        },
      });

      type ConvergenceAttempt = {
        conv: ConditionResult;
        turnReview?: Outcome;
        terminal?: Outcome;
      };
      const evaluateConvergence = async (
        at: number,
        gateContext: JobContext,
        bodyOutcome: Outcome | undefined,
      ): Promise<ConvergenceAttempt> => {
        // Explicit `until`, else the ordinary post-body pass verdict. checkFirst
        // requires `until`, so the synthesized branch always has a body outcome.
        const conv: ConditionResult = until
          ? await gate(until, 'until', gateContext, bodyOutcome)
          : {
              met: bodyOutcome!.status === 'pass',
              confidence: bodyOutcome!.confidence,
              reason: `body status = ${bodyOutcome!.status}`,
            };
        if (parent.signal.aborted) {
          return {
            conv,
            terminal: { status: 'aborted', summary: 'aborted by signal' },
          };
        }
        if (until) {
          parent.emit({
            kind: 'loop:condition',
            ts: ts(),
            path,
            which: 'until',
            iteration: at,
            result: conv,
          });
          // Thread the latest explicit verdict (met or not) to the next body
          // as `ctx.lastGate`. Set before the met-branch so a review-reject
          // re-entry carries it too. The synthesized body-pass verdict is never
          // threaded because it carries no diagnostic value.
          lastGate = conv;
        }

        if (!conv.met) return { conv };

        if (!config.review) {
          if (parent.signal.aborted) {
            return {
              conv,
              terminal: { status: 'aborted', summary: 'aborted by signal' },
            };
          }
          return {
            conv,
            terminal: {
              status: 'pass',
              confidence: conv.confidence ?? bodyOutcome?.confidence,
              ...(bodyOutcome?.late ? { late: true } : {}),
              summary: bodyOutcome ? bodyOutcome.summary : conv.reason,
              data: bodyOutcome?.data,
            },
          };
        }

        let reviewOutcome: Outcome;
        try {
          reviewOutcome = await config.review(checkpointContext(ctxAt(at, bodyOutcome), 'review'));
        } catch (e) {
          throw LoopError.from(e, {
            code: 'VALIDATION',
            phase: 'review',
            path,
            iteration: at,
          });
        }
        if (parent.signal.aborted) {
          return {
            conv,
            terminal: { status: 'aborted', summary: 'aborted by signal' },
          };
        }
        // A paused review is a deliberate halt, not a rejection. Propagate it
        // instead of burning iterations. This runs before `loop:review`, so a
        // consumer never reads the pause as a rejected review.
        if (reviewOutcome.status === 'paused') {
          return { conv, terminal: { ...reviewOutcome } };
        }
        // Decide whether this failing review will actually re-enter the loop
        // before emitting, so the event carries an accurate accept/reject bit
        // (a downstream records consumer must not read a dropped review as
        // acted-on). Re-entry is blocked by the restart bound or by having no
        // iteration left; `consecutiveReviewFails` is still pre-increment here.
        const reviewPassed = reviewOutcome.status === 'pass';
        const restartsExhausted =
          config.maxReviewRestarts != null &&
          consecutiveReviewFails + 1 >= config.maxReviewRestarts;
        // `max` counts every body run, so it allows `max - 1` refinements
        // after the first.
        const iterationsRemain = roundRule(at, config.max == null ? undefined : config.max - 1).another;
        const willReenter =
          !reviewPassed && !restartsExhausted && iterationsRemain;
        parent.emit({
          kind: 'loop:review',
          ts: ts(),
          path,
          outcome: reviewOutcome,
          accepted: willReenter,
        });
        if (reviewPassed) {
          if (parent.signal.aborted) {
            return {
              conv,
              terminal: { status: 'aborted', summary: 'aborted by signal' },
            };
          }
          return {
            conv,
            terminal: {
              status: 'pass',
              confidence: reviewOutcome.confidence ?? conv.confidence,
              ...(bodyOutcome?.late || reviewOutcome.late
                ? { late: true }
                : {}),
              summary:
                reviewOutcome.summary ??
                (bodyOutcome ? bodyOutcome.summary : conv.reason),
              data: bodyOutcome?.data,
              ...(reviewOutcome.openFindings ? { openFindings: reviewOutcome.openFindings } : {}),
            },
          };
        }
        // Review rejected: thread the verdict to the next iteration
        // (context-scoped, not run-global, so concurrent sibling loop jobs do not
        // cross-contaminate) and bound the restart cycle.
        consecutiveReviewFails += 1;
        lastReview = reviewOutcome;
        rejectedReview = reviewOutcome;
        parent.log(
          `review did not pass (${reviewOutcome.summary ?? reviewOutcome.status}); re-entering ${config.name}`,
          'warn',
        );
        if (restartsExhausted) {
          return {
            conv,
            turnReview: reviewOutcome,
            terminal: {
              status: 'exhausted',
              summary: `review rejected ${consecutiveReviewFails}× (maxReviewRestarts)`,
              ...(bodyOutcome?.late || reviewOutcome.late
                ? { late: true }
                : {}),
              data: bodyOutcome?.data,
              ...lastFindings(reviewOutcome),
            },
          };
        }
        if (!iterationsRemain) {
          // The review of the last round `max` allows rejected the work: the
          // loop fails with its findings, as a graph does when its
          // send-backs run out.
          return {
            conv,
            turnReview: reviewOutcome,
            terminal: {
              status: 'fail',
              summary: `review rejected round ${at} with no refinements left: ${reviewOutcome.summary ?? 'no reason given'}`,
              ...(bodyOutcome?.late || reviewOutcome.late
                ? { late: true }
                : {}),
              data: bodyOutcome?.data,
              ...lastFindings(reviewOutcome),
            },
          };
        }
        return { conv, turnReview: reviewOutcome };
      };

      if (config.checkFirst && !saved) {
        await yieldToLoop();
        if (parent.signal.aborted)
          return finish(
            { status: 'aborted', summary: 'aborted by signal' },
            0,
          );
        const precheck = await evaluateConvergence(0, ctxAt(0), undefined);
        if (precheck.terminal) return finish(precheck.terminal, 0);
      }

      // 2. iterate
      while (true) {
        await yieldToLoop(); // ensure an abort/SIGINT can be delivered even with a synchronous body
        if (parent.signal.aborted)
          return finish(
            { status: 'aborted', summary: 'aborted by signal' },
            iteration,
          );
        if (resumePhase !== 'review' && config.max != null && iteration >= config.max) {
          return finish(
            {
              status: 'exhausted',
              summary:
                last?.summary ?? `reached max iterations (${config.max})`,
              confidence: last?.confidence,
              ...(last?.late ? { late: true } : {}),
              data: last?.data,
              ...lastFindings(rejectedReview),
            },
            iteration,
          );
        }

        const resumingReview = resumePhase === 'review';
        resumePhase = undefined;
        if (!resumingReview) iteration += 1;
        const ctx = ctxAt(iteration, last);
        // The review outcome of THIS turn, when one ran and rejected — feeds the
        // no-progress sample (its confidence/summary gated the continuation).
        let turnReview: Outcome | undefined;
        if (!resumingReview) parent.emit({ kind: 'loop:iteration', ts: ts(), path, iteration });

        // run the body (fresh context this turn)
        let bodyThrew = false;
        try {
          if (!resumingReview) last = await config.body(checkpointContext(ctx, 'body'));
          consecutiveErrors = 0;
        } catch (e) {
          bodyThrew = true;
          const error = LoopError.from(e, {
            code: 'BODY',
            phase: 'body',
            path,
            iteration,
          });
          parent.emit({
            kind: 'error',
            ts: ts(),
            path,
            message: error.message,
            code: error.code,
          });
          consecutiveErrors += 1;
          // A thrown body error is governed by the retry policy (default: continue).
          const tooMany =
            config.retry?.maxConsecutive != null &&
            consecutiveErrors >= config.retry.maxConsecutive;
          if (onError === 'fail' || tooMany)
            return finish(
              { status: 'fail', summary: error.message, error },
              iteration,
            );
          last = { status: 'fail', summary: error.message, error };
          if (config.retry?.backoffMs)
            await delay(config.retry.backoffMs, parent.signal);
        }

        // a malformed Outcome (e.g. a body that forgot `status`) is a bug — fail loudly, don't spin
        if (!last || !VALID_STATUS.has(last.status)) {
          const error = new LoopError({
            code: 'VALIDATION',
            phase: 'body',
            path,
            iteration,
            message: `body returned an Outcome with no valid "status" (got ${JSON.stringify(last?.status)})`,
          });
          parent.emit({
            kind: 'error',
            ts: ts(),
            path,
            message: error.message,
            code: error.code,
          });
          return finish(
            { status: 'fail', summary: error.message, error },
            iteration,
          );
        }
        // A body-returned `paused` is a deliberate halt. Finish with it instead
        // of treating the turn as failed and iterating again. No overlap
        // with the limit handling below: that path keys on status 'fail'.
        if (last.status === 'paused') {
          return finish({ ...last }, iteration);
        }
        // A rate limit / quota / budget hit is governed by the `onLimit` policy
        // (default `auto`): wait out a known, bounded reset and retry the same
        // step, else pause. `fail` opts out
        // and lets the generic fatal handling below treat it as terminal.
        if (
          last.status === 'fail' &&
          isLimitError(last.error) &&
          ctx.onLimit !== 'fail'
        ) {
          const action = decideLimit(last.error, ctx);
          if (action.kind === 'wait') {
            const now = ts();
            parent.emit({
              kind: 'limit:wait',
              ts: now,
              path,
              code: last.error.code,
              waitMs: action.waitMs,
              resumeAt: now + action.waitMs,
            });
            await delay(action.waitMs, parent.signal);
            // Don't burn an iteration on a throttled attempt: re-run this step.
            iteration -= 1;
            last = undefined;
            continue;
          }
          parent.emit({
            kind: 'limit:pause',
            ts: ts(),
            path,
            code: last.error.code,
            reason: action.reason,
          });
          return finish(
            {
              status: 'paused',
              summary: action.reason,
              error: last.error,
              data: last.data,
            },
            iteration,
          );
        }

        // A *returned* fail outcome carrying an unrecoverable error (e.g. an
        // engine auth/config failure) must not loop to `exhausted`. Thrown
        // errors are excluded — the retry policy above owns those.
        if (
          !bodyThrew &&
          last.status === 'fail' &&
          last.error &&
          !last.error.retryable
        ) {
          return finish(
            { status: 'fail', summary: last.summary, error: last.error },
            iteration,
          );
        }

        if (config.onIteration && !resumingReview) {
          try {
            await config.onIteration(last, ctx);
          } catch (e) {
            throw LoopError.from(e, {
              code: 'VALIDATION',
              phase: 'body',
              path,
              iteration,
            });
          }
        }

        // hard early-exit
        if (stopOn && !resumingReview) {
          const r = await gate(stopOn, 'stopOn', ctx, last);
          parent.emit({
            kind: 'loop:condition',
            ts: ts(),
            path,
            which: 'stopOn',
            iteration,
            result: r,
          });
          if (r.met)
            return finish(
              {
                status: 'aborted',
                summary: `stopOn met: ${r.reason}`,
                data: last.data,
              },
              iteration,
            );
        }

        const convergence = await evaluateConvergence(iteration, ctx, last);
        const { conv } = convergence;
        turnReview = convergence.turnReview;
        if (convergence.terminal)
          return finish(convergence.terminal, iteration);

        // No-progress check — the loop is about to go again, so ask whether the
        // turn that just finished reached any state this run had not already
        // seen. A throttled turn never gets here (the limit path re-runs the
        // step), so a rate-limit wait is not evidence of a stall.
        if (tracker) {
          let fingerprint: string | undefined;
          if (noProgress!.workspace !== false) {
            // Best-effort: a git hiccup drops the channel for this turn, it
            // never sinks the run (undefined = "no evidence", not "unchanged").
            fingerprint = await workspaceFingerprint({
              cwd: ctx.workspace.dir,
              signal: parent.signal,
              excludePaths: ctx.fingerprintExcludePaths,
            });
          }
          let signalValue: string | undefined;
          if (noProgress!.signal) {
            try {
              const v = await noProgress!.signal(ctx, last);
              signalValue = v == null ? undefined : String(v);
            } catch (e) {
              // A broken signal fn is a bug in the definition; silently losing
              // the channel would leave the user believing they are protected.
              throw LoopError.from(e, {
                code: 'VALIDATION',
                phase: 'body',
                path,
                iteration,
              });
            }
          }
          const sample: ProgressSample = {
            iteration,
            fingerprint,
            signal: signalValue,
            // An absent output leaves the channel out of this turn's evidence
            // (indeterminate) — never a fabricated value.
            gate:
              noProgress!.gate && until && !conv.met ? conv.output : undefined,
            confidence:
              turnReview?.confidence ?? conv.confidence ?? last.confidence,
            reason: turnReview
              ? (turnReview.summary ?? 'review rejected')
              : conv.reason,
          };
          samples.push(Object.fromEntries(Object.entries(sample).filter(([, value]) => value !== undefined)) as unknown as ProgressSample);
          const report = tracker.record(sample);
          if (!warnedInert && tracker.isInert()) {
            warnedInert = true;
            parent.log(
              `noProgress is set on ${config.name} but no evidence channel exists ` +
                `(no git workspace, no gate confidence, no custom signal); ` +
                `stall detection is inert`,
              'warn',
            );
          }
          if (report) {
            parent.emit({
              kind: 'loop:stall',
              ts: ts(),
              path,
              iteration,
              report,
            });
            return finish(
              {
                status: 'exhausted',
                summary:
                  `stalled after ${report.iterations.length} iterations with ` +
                  `no observable progress: ${report.reason}`,
                confidence: last.confidence,
                ...(last.late ? { late: true } : {}),
                data: last.data,
                stall: report,
                ...lastFindings(rejectedReview),
              },
              iteration,
            );
          }
        }

        if (config.delayMs) await delay(config.delayMs, parent.signal);
      }
    } catch (e) {
      const error = LoopError.from(e, { code: 'UNKNOWN', path, iteration });
      if (parent.signal.aborted || error.code === 'ABORTED') {
        return finish(
          {
            status: 'aborted',
            summary: parent.signal.aborted ? 'aborted by signal' : error.message,
            error,
          },
          iteration,
        );
      }
      parent.emit({
        kind: 'error',
        ts: ts(),
        path,
        message: error.message,
        code: error.code,
      });
      return finish(
        { status: 'fail', summary: error.message, error },
        iteration,
      );
    }
  };

  return interactionDeclaration(setMeta(job, {
    kind: 'loop',
    name: config.name,
    max: config.max,
    noProgress: noProgress?.window,
    checkFirst: !!config.checkFirst,
    start: describeConditions(config.start),
    gate: describeConditions(config.until),
    stopOn: describeConditions(config.stopOn),
    review: !!config.review,
    maxReviewRestarts: config.maxReviewRestarts,
    body: jobMeta(config.body),
  }), config);
}

/** Sleep that resolves early (does not reject) when the signal aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
