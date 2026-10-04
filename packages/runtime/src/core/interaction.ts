import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { createCallbackGate, validateCallbackResponse } from '../callback/gate.js';
import { cloneFrozenJson, type JsonObject, type JsonValue } from '../graph/value.js';
import { setMeta } from './describe.js';
import { LoopError } from './errors.js';
import type { InteractionBinding, InteractionResponse, Job, JobContext, Outcome, ResumedStageRecords } from './types.js';

export type { InteractionBinding, InteractionResponse } from './types.js';

const declarations = new WeakMap<Function, unknown>();
/** Keep declared job identity separate from an engine's mutable call state. */
export function interactionDeclaration<T extends Function>(job: T, declaration: unknown): T {
  declarations.set(job, declaration);
  return job;
}
function declared(value: unknown): unknown {
  if (typeof value === 'function') return declarations.has(value) ? declared(declarations.get(value)) : value.toString();
  if (Array.isArray(value)) return value.map(declared);
  if (value !== null && typeof value === 'object') {
    if ('run' in value && typeof value.run === 'function' && 'name' in value) return { engine: value.name };
    return Object.fromEntries(Object.keys(value).sort().filter((key) => key !== 'answer').map((key) => [key, declared((value as Record<string, unknown>)[key])]));
  }
  return value;
}
export function interactionIdentity(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(declared(value))).digest('hex');
}
function snapshotValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) throw new TypeError('interaction context must not contain a cycle');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => snapshotValue(item, seen));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return cloneFrozenJson(value as JsonValue);
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, snapshotValue(item, seen)]));
  } finally { seen.delete(value); }
}
export function jsonSnapshot(value: unknown): JsonObject {
  return cloneFrozenJson(snapshotValue(value) as JsonValue) as JsonObject;
}
/**
 * Save only JSON outcome fields; runtime Error objects are not continuation
 * data, at any depth: a passed nested graph's data holds its nodes' outcomes,
 * a failed optional node's error included. The rest is converted as the
 * record writes it, so a Date is saved as its ISO string.
 */
export function outcomeSnapshot(outcome: Outcome): JsonObject {
  return jsonSnapshot(JSON.parse(JSON.stringify(withoutErrors(outcome))));
}
function withoutErrors(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  const proto = Object.getPrototypeOf(value);
  if (seen.has(value) || (!Array.isArray(value) && proto !== Object.prototype && proto !== null)) return value;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => withoutErrors(item, seen));
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined && !(item instanceof Error))
      .map(([key, item]) => [key, withoutErrors(item, seen)]));
  } finally { seen.delete(value); }
}
export function savedInteraction(ctx: JobContext, path: readonly string[], identity: string): JsonObject | undefined {
  const saved = (ctx.state['obversa:resumed-stage-outcomes'] as ResumedStageRecords | undefined)?.interactions.get(path.join('/'));
  return saved?.identity === identity && saved.workspace === ctx.workspace.dir ? saved.data : undefined;
}
export function hasSavedInteraction(ctx: JobContext, path: readonly string[]): boolean {
  const prefix = `${path.join('/')}/`;
  return [...((ctx.state['obversa:resumed-stage-outcomes'] as ResumedStageRecords | undefined)?.interactions ?? [])]
    .some(([key, saved]) => key.startsWith(prefix) && saved.progress !== true);
}
/** `progress` marks a graph's rounds so far, saved as they advance: a resume
 * reads them back, but they do not make the steps around the graph continue
 * without the question an interrupted step asks. */
export function checkpointInteraction(ctx: JobContext, path: readonly string[], identity: string, data: JsonObject | null, progress = false): void {
  const restored = (ctx.state['obversa:resumed-stage-outcomes'] as ResumedStageRecords | undefined)?.interactions;
  if (restored instanceof Map) {
    if (data === null) restored.delete(path.join('/'));
    else restored.set(path.join('/'), { identity, workspace: ctx.workspace.dir, data: jsonSnapshot(data), ...(progress ? { progress } : {}) });
  }
  ctx.emit({ kind: 'interaction:checkpoint', ts: Date.now(), path: [...path], identity, workspace: ctx.workspace.dir, data: data === null ? null : jsonSnapshot(data), ...(progress ? { progress: true as const } : {}) });
}
export function interactionResponse(value: unknown): InteractionResponse {
  const response = cloneFrozenJson(value as JsonValue) as JsonObject;
  if (response === null || typeof response !== 'object' || Array.isArray(response)
      || !Object.hasOwn(response, 'feedback') || typeof response.prompt !== 'string' || (response.decision !== 'approved' && !response.prompt.trim())
      || (response.decision !== undefined && response.decision !== 'approved' && response.decision !== 'changes-requested')) {
    throw new LoopError({ code: 'VALIDATION', message: 'an interaction response needs feedback and a nonblank prompt; decision must be approved or changes-requested' });
  }
  return response as unknown as InteractionResponse;
}
export const DEFAULT_INTERACTION: InteractionBinding = { id: 'product-decision', responseSchema: {} };

export async function requestInteraction(
  binding: InteractionBinding,
  question: string,
  input: JsonObject,
  ctx: JobContext,
  humanApproval = false,
): Promise<{ response: InteractionResponse } | { paused: Outcome }> {
  if (!binding.id.trim()) throw new TypeError('interaction id must be non-empty');
  const client = ctx.callbacks;
  if (!client) throw new LoopError({ code: 'CONFIG', message: 'an interaction needs the run callbacks client' });
  const schema = binding.responseSchema;
  const properties = schema.properties as JsonObject | undefined;
  const request = createCallbackGate({
    gateId: `${binding.id}:${interactionIdentity({ path: ctx.path, workspace: ctx.workspace.dir })}`,
    gateVersion: 1,
    decisionText: question,
    responseSchema: {
      ...schema,
      allOf: [schema],
      type: 'object',
      properties: {
        ...properties, feedback: properties?.feedback ?? {},
        prompt: { type: 'string', ...(humanApproval ? {} : { pattern: '\\S' }) },
        ...(humanApproval ? { decision: { type: 'string', enum: ['approved', 'changes-requested'] } } : {}),
      },
      ...(humanApproval ? { anyOf: [
        { properties: { decision: { type: 'string', enum: ['approved'] } } },
        { properties: { decision: { type: 'string', enum: ['changes-requested'] }, prompt: { type: 'string', pattern: '\\S' } } },
      ] } : {}),
      required: [...new Set([...(Array.isArray(schema.required) ? schema.required as string[] : []), 'feedback', 'prompt', ...(humanApproval ? ['decision'] : [])])],
    },
    input,
  });
  const readAnswer = async () => {
    const history = await client.history(request.requestId);
    const submitted = history.findLast((event) => event.kind === 'callback-submitted');
    if (submitted?.kind !== 'callback-submitted') return undefined;
    const checked = validateCallbackResponse(submitted.response, request.responseSchema);
    if (!checked.ok) throw new LoopError({ code: 'VALIDATION', message: checked.reason });
    return interactionResponse(submitted.response);
  };
  let response = await readAnswer();
  const paused: Outcome = { status: 'paused', summary: `waiting for a person: ${question}`, data: request };
  if (response !== undefined) return { response };
  ctx.interactionCheckpoint?.();
  await client.post(request);
  response = await readAnswer();
  if (response !== undefined) return { response };
  if (binding.answer !== undefined && !ctx.signal.aborted) {
    const router = `interaction:${binding.id}`;
    const claim = await client.claim(request.requestId, router);
    if (claim.ok) {
      try {
        const answer = await binding.answer(request, ctx.signal);
        if (answer === undefined || ctx.signal.aborted) return { paused };
        const checked = interactionResponse(answer);
        const submitted = await client.submit(request.requestId, claim.claimToken, router, request.digest, jsonSnapshot(checked));
        if (!submitted.ok) throw new LoopError({ code: 'VALIDATION', message: submitted.reason });
        return { response: checked };
      } finally {
        await client.release(request.requestId, claim.claimToken);
      }
    }
  }
  while (ctx.onCallback === 'wait' && !ctx.signal.aborted) {
    try { await delay(1_000, undefined, { signal: ctx.signal }); }
    catch (error) { if (!ctx.signal.aborted) throw error; break; }
    response = await readAnswer();
    if (response !== undefined) return { response };
    const history = await client.history(request.requestId);
    if (history.at(-1)?.kind === 'callback-superseded') break;
  }
  return { paused };
}

export interface HumanReviewOptions {
  readonly question: string;
  readonly input: JsonValue | ((ctx: JobContext) => JsonValue | Promise<JsonValue>);
  readonly interaction: InteractionBinding;
}

/** A person's explicit approval is the only passing result of this review. */
export function humanReview(name: string, options: HumanReviewOptions): Job {
  const job: Job = async (ctx) => {
    const material = typeof options.input === 'function' ? await options.input(ctx) : options.input;
    const result = await requestInteraction(options.interaction, options.question, jsonSnapshot({
      requester: { path: ctx.path, identity: interactionIdentity({ name, options }), iteration: ctx.iteration },
      material,
    }), ctx, true);
    if ('paused' in result) return result.paused;
    const response = result.response;
    if (response.decision === 'approved') return { status: 'pass', summary: 'approved by a person', data: response };
    if (response.decision !== 'changes-requested') throw new LoopError({ code: 'VALIDATION', message: 'a human review requires an explicit approval or changes-requested decision' });
    return {
      status: 'fail', summary: response.prompt, data: response,
      revision: { reason: response.prompt, findings: [{ severity: 'block', evidence: response.prompt }] },
    };
  };
  return interactionDeclaration(setMeta(job, { kind: 'approval', name, question: options.question }), { name, options });
}
