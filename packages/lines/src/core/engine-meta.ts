import type { AgentRequest, AgentResult } from '../engines/engine.js';
import { scrubCapture } from './redact.js';
import type { JobContext } from './types.js';

function leafId(ctx: JobContext, label: string): string {
  const raw = [...ctx.path, label, String(ctx.iteration)].join('/');
  return (
    raw.replace(/[^A-Za-z0-9._/-]+/g, '-').replace(/(^-+|-+$)/g, '') ||
    'leaf'
  );
}

export function linesRequestMeta(
  ctx: JobContext,
  label: string,
): AgentRequest['lines'] {
  return {
    leaf: true,
    runId: ctx.runId,
    leafId: leafId(ctx, label),
    path: [...ctx.path],
    label,
    iteration: ctx.iteration,
  };
}

/** Surface a completed result's later transport failure through run logs. */
export function logEngineTransportFailure(
  ctx: JobContext,
  result: Pick<AgentResult, 'transportFailure'>,
  env?: Record<string, string>,
): void {
  if (!result.transportFailure) return;
  ctx.log(scrubCapture(result.transportFailure.message, env, 1000), 'warn');
}
