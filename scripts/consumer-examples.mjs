/**
 * The example files the clean consumer compiles against the packed packages.
 *
 * One list, read by two checks. The clean-consumer proof compiles every file
 * on it in a fresh project with only the tarballs installed. The page-shape
 * check reads it so that a documentation page may only quote a file that is
 * here: "it compiles" is then something the chain proves on every run rather
 * than a claim in prose. Add a file here when a page quotes it.
 */
export const CONSUMER_EXAMPLES = Object.freeze([
  'offline-review.ts',
  'feature-delivery.ts',
  'feature-team.ts',
  'described-team.ts',
  'forge-helper.ts',
  'custom-graph.ts',
  'pipeline.ts',
  'team-conversation.ts',
  'review-loop.ts',
  'callback-gate.ts',
  'proof-bound-approval.ts',
  'proof-cache.ts',
  'durable-storage.ts',
  'safe-node-attempt.ts',
  'turn-taking.ts',
  'workspace.ts',
  'supervised-run.ts',
  'safe-change.ts',
  'safe-change-recipe.ts',
  'safe-change-file-adapter.ts',
  'run-child.ts',
  'write-and-review.ts',
  'one-agent-job.ts',
]);
