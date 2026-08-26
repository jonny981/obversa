/**
 * Job builders. A `Job` is the unit of work; these are the common shapes.
 * The agent launch (`agentJob`) is deliberately provider-agnostic: it only
 * ever calls `Engine.run`, so it knows nothing about Claude, the CLI, an SDK,
 * an HTTP API, or any framework — swap the engine and the same job runs.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import type {
  Outcome,
  Job,
  JobContext,
  ProofArtifact,
} from './types.js';
import { setMeta } from './describe.js';
import type { AgentResult, EngineRef } from '../engines/engine.js';
import { resolveEnv } from './env-overlay.js';
import { LoopError, type LoopErrorCode } from './errors.js';
import { scrubCapture } from './redact.js';
import { assertBudget } from './budget.js';
import { agentContract, resolveSystem, type AgentDef } from './agent.js';
import {
  feedbackBlock,
  graphPositionBlock,
  kickback,
  revisionRequest,
} from './feedback.js';
import {
  linesRequestMeta,
  logEngineTransportFailure,
} from './engine-meta.js';
import { cloneFrozenJson, type JsonValue } from '../graph/value.js';
import { requireFinalResultText } from '../runtime/result-parts.js';

export interface AgentJobConfig {
  /** Job label (for events). Defaults to the agent's name, then `'agent'`. */
  label?: string;
  /**
   * A reusable agent definition — supplies `system` (persona + skills), `model`, and
   * `tools` (the job's `system` and `model` override it when also set). The
   * persona lives in markdown via `fromFile`; this is the typed wrapper around it.
   */
  agent?: AgentDef;
  /** The prompt, or a function of the context (e.g. include the iteration). */
  prompt: string | ((ctx: JobContext) => string | Promise<string>);
  system?: string | ((ctx: JobContext) => string);
  /** Engine override: a registered name, your own `Engine`, or the default. */
  engine?: EngineRef;
  /** Bare model id — passed straight through to the engine. */
  model?: string;
  maxTokens?: number;
  allowedTools?: string[];
  /**
   * Mark this turn a leaf: forbid spawning sub-agents (the engine disallows the sub-agent
   * tool), so a branch bottoms out here. Falls back to the agent def's `leaf`.
   */
  leaf?: boolean;
  /**
   * Append the current `ctx.lastReview` / revision feedback to the prompt. This
   * keeps implementation agents from having to remember to manually read the
   * runtime feedback channel in every prompt function.
   */
  consumeFeedback?: boolean;
  /**
   * Append a compact DAG-position block: this node, its direct dependencies, and
   * its direct dependents, without handing the agent the whole orchestration graph.
   */
  graphContext?: boolean;
  /**
   * Bounded, visible escalation: the worker may ask for a consult by replying
   * with a `<consult_advisor>` block. Lines runs one model-pinned advisor turn,
   * records the question/reply, and then gives the reply back to the worker in a
   * fresh turn. This is the sanctioned alternative to shelling out to another
   * model from inside a leaf.
   */
  advisor?: AdvisorConfig;
  /** Working dir for the turn. Default: the workspace dir (the worktree). */
  cwd?: string;
  /**
   * Env vars pinned for this leaf's engine subprocess — the most specific
   * layer, over any `withEnv` overlay and the running environment's vars.
   * Engines that spawn no subprocess ignore it.
   */
  env?: Record<string, string>;
  /**
   * Soft timeout for each worker or fallback invocation. Advisor consults
   * inherit it unless overridden; each invocation receives its own window.
   */
  timeoutMs?: number;
  /** Extra hard-timeout window after `timeoutMs` for completed final results. */
  timeoutGraceMs?: number;
  /** Fallback route(s) used when the primary engine hits a configured error. */
  fallback?: AgentRoute | AgentRoute[];
  /** Error codes that may spill to `fallback`. Default: RATE_LIMIT and QUOTA. */
  fallbackOn?: LoopErrorCode[];
  /**
   * Map the agent's raw text into an `Outcome`. Default: `pass`, with the text
   * as the summary. Return `fail` to keep an enclosing loop going. `text` is
   * the reply after the capture scrub (injected env values and secret-shaped
   * tokens are redacted) before the outcome enters persisted records.
   */
  outcome?: (
    text: string,
    ctx: JobContext,
  ) => Outcome | Promise<Outcome>;
}

export interface AdvisorConfig {
  engine?: EngineRef;
  model?: string;
  systemPrompt?: string;
  maxCalls?: number;
  maxTokens?: number;
  timeoutMs?: number;
  timeoutGraceMs?: number;
}

export interface AgentRoute {
  engine?: EngineRef;
  model?: string;
  timeoutMs?: number;
  timeoutGraceMs?: number;
}

export type ProofDescriptor = ProofArtifact;
export type ProofProducer = (
  ctx: JobContext,
) => ProofDescriptor | Promise<ProofDescriptor>;

const TERMINAL = (text: string): Outcome => ({
  status: 'pass',
  summary: text.trim().slice(0, 280),
  data: text,
});

function advisorInstruction(maxCalls: number): string {
  return (
    `## Advisor consults\n` +
    `When you hit a hard design fork, you may request at most ${maxCalls} advisor ` +
    `consult${maxCalls === 1 ? '' : 's'}. Do not shell out to another model. ` +
    `Instead, make your whole reply exactly this block:\n\n` +
    `<consult_advisor>\n` +
    `<question>the precise question</question>\n` +
    `<context>the minimum context the advisor needs</context>\n` +
    `</consult_advisor>\n\n` +
    `Lines will record the consult and return the advisor reply to you.`
  );
}

function withOperationalContext(
  ctx: JobContext,
  userPrompt: string,
  config: Pick<AgentJobConfig, 'consumeFeedback' | 'graphContext' | 'advisor'>,
): string {
  const parts = [userPrompt];
  if (config.consumeFeedback && ctx.lastReview) {
    parts.push(feedbackBlock(ctx.lastReview));
  }
  if (config.graphContext && ctx.graph) {
    parts.push(graphPositionBlock(ctx.graph));
  }
  if (config.advisor) parts.push(advisorInstruction(config.advisor.maxCalls ?? 1));
  return parts.join('\n\n---\n\n');
}

interface AdvisorRequest {
  question: string;
  context?: string;
}

function tagValue(text: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'i').exec(text);
  return match?.[1]?.trim() || undefined;
}

function parseAdvisorRequest(text: string): AdvisorRequest | undefined {
  const block = /^\s*<consult_advisor>\s*([\s\S]*?)\s*<\/consult_advisor>\s*$/i.exec(text)?.[1];
  if (!block) return undefined;
  const question = tagValue(block, 'question') ?? block.trim();
  if (!question) return undefined;
  return { question, context: tagValue(block, 'context') };
}

function advisorFollowup(call: number, request: AdvisorRequest, reply: string): string {
  return (
    `Advisor consult #${call}\n\n` +
    `Question:\n${request.question}\n\n` +
    `${request.context ? `Context supplied:\n${request.context}\n\n` : ''}` +
    `Advisor reply:\n${reply}\n\n` +
    `Continue the original task. Do not ask the same question again.`
  );
}

async function runAdvisorConsult(
  ctx: JobContext,
  label: string,
  config: AdvisorConfig,
  call: number,
  request: AdvisorRequest,
  inherited: { maxTokens?: number; timeoutMs?: number; timeoutGraceMs?: number },
  redactionEnv: Record<string, string> | undefined,
): Promise<{ reply: string; model?: string }> {
  assertBudget(ctx);
  const engine = ctx.resolveEngine(config.engine);
  const result = await engine.run(
    {
      prompt:
        `Question:\n${request.question}` +
        (request.context ? `\n\nContext:\n${request.context}` : ''),
      system: config.systemPrompt,
      model: config.model,
      maxTokens: config.maxTokens ?? inherited.maxTokens,
      timeoutMs: config.timeoutMs ?? inherited.timeoutMs,
      timeoutGraceMs: config.timeoutGraceMs ?? inherited.timeoutGraceMs,
      cwd: ctx.workspace.dir,
      leaf: true,
      lines: linesRequestMeta(ctx, `${label}:advisor`),
      memory: ctx.memory,
    },
    (event) => {
      const ts = Date.now();
      if (event.type === 'usage') {
        ctx.emit({
          kind: 'engine:usage',
          ts,
          path: [...ctx.path],
          model: event.model,
          usage: event.usage,
        });
      } else if (event.type === 'tool') {
        ctx.emit({
          kind: 'engine:tool',
          ts,
          path: [...ctx.path],
          name: event.name,
          phase: event.phase,
        });
      }
    },
    ctx.signal,
  );
  logEngineTransportFailure(ctx, result, redactionEnv);
  const reply = scrubCapture(
    requireFinalResultText(result),
    redactionEnv,
  ).trim();
  ctx.emit({
    kind: 'advisor:consult',
    ts: Date.now(),
    path: [...ctx.path],
    label,
    call,
    question: request.question,
    reply,
    model: result.effective.model ?? undefined,
  });
  return { reply, model: result.effective.model ?? undefined };
}

/** Run one fresh agent turn through whichever engine is selected. */
export function agentJob(config: AgentJobConfig): Job {
  const job: Job = async (ctx) => {
    const path = [...ctx.path];
    const label = config.label ?? config.agent?.name ?? 'agent';
    const defaultTimeoutMs = config.timeoutMs ?? ctx.timeoutMs;
    const defaultTimeoutGraceMs = config.timeoutGraceMs ?? ctx.timeoutGraceMs;
    ctx.emit({
      kind: 'job:start',
      ts: Date.now(),
      path,
      label,
      timeoutMs: defaultTimeoutMs,
    });

    const userPrompt =
      typeof config.prompt === 'function'
        ? await config.prompt(ctx)
        : config.prompt;
    const contextualPrompt = withOperationalContext(ctx, userPrompt, config);
    // System precedence: an explicit `system` overrides the agent's (persona + skills).
    const system =
      config.system !== undefined
        ? typeof config.system === 'function'
          ? config.system(ctx)
          : config.system
        : config.agent
          ? resolveSystem(config.agent)
          : undefined;

    // Hoisted so the reply scrub below can strike the same injected values the
    // engine subprocess was handed.
    const env = resolveEnv(ctx, config.env);
    const fallbacks = config.fallback
      ? Array.isArray(config.fallback)
        ? config.fallback
        : [config.fallback]
      : [];
    const routes: AgentRoute[] = [
      {
        engine: config.engine,
        model: config.model ?? config.agent?.model,
        timeoutMs: defaultTimeoutMs,
        timeoutGraceMs: defaultTimeoutGraceMs,
      },
      ...fallbacks,
    ];
    const fallbackOn = new Set<LoopErrorCode>(
      config.fallbackOn ?? ['RATE_LIMIT', 'QUOTA'],
    );
    let result: AgentResult | undefined;
    for (let i = 0; i < routes.length; i += 1) {
      const route = routes[i]!;
      const routeModel = route.model;
      const timeoutMs = route.timeoutMs ?? defaultTimeoutMs;
      const timeoutGraceMs = route.timeoutGraceMs ?? defaultTimeoutGraceMs;
      try {
        const basePrompt = contextualPrompt;
        const engine = ctx.resolveEngine(route.engine ?? config.engine);
        const maxAdvisorCalls = config.advisor?.maxCalls ?? 1;
        const advisorReplies: string[] = [];
        for (;;) {
          const prompt = advisorReplies.length
            ? `${basePrompt}\n\n---\n\n${advisorReplies.join('\n\n---\n\n')}`
            : basePrompt;
          assertBudget(ctx);
          result = await engine.run(
            {
              prompt,
              system,
              model: routeModel,
              maxTokens: config.maxTokens,
              tools: config.agent?.tools,
              allowedTools: config.allowedTools ?? config.agent?.tools,
              leaf: config.leaf ?? config.agent?.leaf,
              cwd: config.cwd ?? ctx.workspace.dir,
              timeoutMs,
              timeoutGraceMs,
              env,
              lines: linesRequestMeta(ctx, label),
              memory: ctx.memory,
            },
            (e) => {
              const ts = Date.now();
              switch (e.type) {
                case 'text':
                  ctx.emit({ kind: 'engine:text', ts, path, delta: e.delta });
                  break;
                case 'thinking':
                  ctx.emit({ kind: 'engine:thinking', ts, path, delta: e.delta });
                  break;
                case 'tool':
                  ctx.emit({
                    kind: 'engine:tool',
                    ts,
                    path,
                    name: e.name,
                    phase: e.phase,
                  });
                  break;
                case 'usage':
                  ctx.emit({
                    kind: 'engine:usage',
                    ts,
                    path,
                    model: e.model,
                    usage: e.usage,
                  });
                  break;
              }
            },
            ctx.signal,
          );
          logEngineTransportFailure(ctx, result, env);
          const advisor = config.advisor;
          const capturedText = scrubCapture(
            requireFinalResultText(result),
            env,
          );
          const consult = advisor ? parseAdvisorRequest(capturedText) : undefined;
          if (!advisor || !consult) break;
          if (advisorReplies.length >= maxAdvisorCalls) {
            throw new LoopError({
              code: 'BUDGET',
              phase: 'body',
              message: `${label} exceeded advisor consult cap (${maxAdvisorCalls})`,
            });
          }
          const call = advisorReplies.length + 1;
          const { reply } = await runAdvisorConsult(
            ctx,
            label,
            advisor,
            call,
            consult,
            { maxTokens: config.maxTokens, timeoutMs, timeoutGraceMs },
            env,
          );
          advisorReplies.push(advisorFollowup(call, consult, reply));
        }
        break;
      } catch (e) {
        const error = LoopError.from(e, {
          code: ctx.signal.aborted ? 'ABORTED' : 'ENGINE',
          phase: 'body',
          path: ctx.path,
          iteration: ctx.iteration,
        });
        if (
          i < routes.length - 1 &&
          !ctx.signal.aborted &&
          fallbackOn.has(error.code)
        ) {
          ctx.log(
            `${label} primary route hit ${error.code}; trying fallback route ${i + 2}`,
            'warn',
          );
          continue;
        }
        ctx.emit({
          kind: 'error',
          ts: Date.now(),
          path,
          message: error.message,
          code: error.code,
        });
        const outcome: Outcome = {
          status: ctx.signal.aborted ? 'aborted' : 'fail',
          summary: error.message,
          error,
        };
        ctx.emit({
          kind: 'job:end',
          ts: Date.now(),
          path,
          label,
          outcome,
        });
        return outcome;
      }
    }
    if (!result)
      throw new LoopError({
        code: 'ENGINE',
        phase: 'body',
        message: `${label} produced no engine result`,
      });

    // The reply enters events and status records. Scrub it before any consumer
    // can persist an injected environment value.
    const text = scrubCapture(requireFinalResultText(result), env);

    const outcome = config.outcome
      ? await config.outcome(text, ctx)
      : TERMINAL(text);
    const finalOutcome =
      result.transportFailure?.kind === 'timeout' && outcome.late !== true
      ? { ...outcome, late: true }
      : outcome;
    ctx.emit({
      kind: 'job:end',
      ts: Date.now(),
      path,
      label,
      outcome: finalOutcome,
    });
    return finalOutcome;
  };

  return setMeta(job, {
    kind: 'agent',
    name: config.label ?? config.agent?.name ?? 'agent',
    contract: agentContract(config.agent),
  });
}

export { kickback, revisionRequest };

/** A deterministic step from a plain function — for glue, checks, side effects. */
export function fnJob(
  label: string,
  fn: (ctx: JobContext) => Outcome | Promise<Outcome>,
): Job {
  const job: Job = async (ctx) => {
    const path = [...ctx.path];
    ctx.emit({
      kind: 'job:start',
      ts: Date.now(),
      path,
      label,
      timeoutMs: ctx.timeoutMs,
    });
    let outcome: Outcome;
    try {
      outcome = await fn(ctx);
    } catch (e) {
      const error = LoopError.from(e, {
        code: 'BODY',
        phase: 'body',
        path: ctx.path,
        iteration: ctx.iteration,
      });
      outcome = { status: 'fail', summary: error.message, error };
      ctx.emit({
        kind: 'error',
        ts: Date.now(),
        path,
        message: error.message,
        code: error.code,
      });
    }
    ctx.emit({ kind: 'job:end', ts: Date.now(), path, label, outcome });
    return outcome;
  };

  return setMeta(job, { kind: 'fn', name: label });
}

function validateProofArtifact(name: string, artifact: ProofArtifact): void {
  if (!artifact || typeof artifact !== 'object') {
    throw new LoopError({
      code: 'VALIDATION',
      message: `prove "${name}" returned no artifact descriptor`,
    });
  }
  if (!['html', 'image', 'markdown', 'table', 'json'].includes(artifact.kind)) {
    throw new LoopError({
      code: 'VALIDATION',
      message: `prove "${name}" returned unsupported kind "${String(artifact.kind)}"`,
    });
  }
  const hasPath = typeof artifact.path === 'string' && artifact.path.trim() !== '';
  const hasData = artifact.data !== undefined;
  if (hasPath === hasData) {
    throw new LoopError({
      code: 'VALIDATION',
      message: `prove "${name}" must return exactly one of path or data`,
    });
  }
  if (artifact.data !== undefined && !isJsonValue(artifact.data)) {
    throw new LoopError({
      code: 'VALIDATION',
      message: `prove "${name}" data must be JSON-serializable`,
    });
  }
  if (artifact.meta !== undefined && !isJsonValue(artifact.meta)) {
    throw new LoopError({
      code: 'VALIDATION',
      message: `prove "${name}" meta must be JSON-serializable`,
    });
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  try {
    cloneFrozenJson(value as JsonValue);
    return true;
  } catch {
    return false;
  }
}

export function prove(name: string, producer: ProofProducer): Job {
  const job: Job = async (ctx) => {
    const path = [...ctx.path];
    ctx.emit({
      kind: 'job:start',
      ts: Date.now(),
      path,
      label: name,
      timeoutMs: ctx.timeoutMs,
    });
    let outcome: Outcome;
    try {
      const artifact = await producer(ctx);
      validateProofArtifact(name, artifact);
      if (artifact.path) {
        const artifactPath = isAbsolute(artifact.path)
          ? artifact.path
          : resolve(ctx.workspace.dir, artifact.path);
        if (!existsSync(artifactPath)) {
          throw new LoopError({
            code: 'VALIDATION',
            message: `prove "${name}" path does not exist: ${artifact.path}`,
          });
        }
      }
      ctx.emit({ kind: 'proof', ts: Date.now(), path, name, artifact });
      outcome = {
        status: 'pass',
        summary: `proof registered: ${artifact.title ?? name}`,
        data: { proof: artifact },
      };
    } catch (e) {
      const error = LoopError.from(e, {
        code: 'VALIDATION',
        phase: 'body',
        path,
        iteration: ctx.iteration,
      });
      outcome = { status: 'fail', summary: error.message, error };
      ctx.emit({
        kind: 'error',
        ts: Date.now(),
        path,
        message: error.message,
        code: error.code,
      });
    }
    ctx.emit({ kind: 'job:end', ts: Date.now(), path, label: name, outcome });
    return outcome;
  };

  return setMeta(job, { kind: 'prove', name });
}
