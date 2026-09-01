import type { AgentRequest } from '../contracts.js';

/** Merge caller env with the stable Obversa attempt markers. */
export function attemptEnvironment(
  request: AgentRequest,
): Record<string, string> | undefined {
  if (!request.env && !request.attempt) return undefined;
  const attempt = request.attempt
    ? {
        OBVERSA_LEAF: request.attempt.leaf ? '1' : '0',
        OBVERSA_LEAF_ID: request.attempt.leafId,
        OBVERSA_LEAF_LABEL: request.attempt.label,
        OBVERSA_LEAF_PATH: request.attempt.path.join('/'),
        OBVERSA_LEAF_ITERATION: String(request.attempt.iteration),
        ...(request.attempt.runId
          ? { OBVERSA_RUN_ID: request.attempt.runId }
          : {}),
      }
    : {};
  return { ...request.env, ...attempt };
}
