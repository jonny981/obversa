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
  'preflight-executor.ts',
  'preflight-supervised-run.ts',
  'preflight-host.mjs',
  'safe-change.ts',
  'safe-change-recipe.ts',
  'safe-change-file-adapter.ts',
  'run-child.ts',
  'write-and-review.ts',
  'one-agent-job.ts',
  'command-kickback.ts',
  'tournament.ts',
  'teams/scripted-engine.ts',
  'teams/writer-reviewer-pair.ts',
  'teams/writer-reviewer-pair.proof.ts',
  'teams/threshold-panel.ts',
  'teams/threshold-panel.proof.ts',
  'teams/feature-delivery.ts',
  'teams/feature-delivery.proof.ts',
]);

/**
 * Example files that run real engine plugins. The chain compiles them (they
 * are on the list above) but never runs them, because a run needs signed-in
 * model CLIs; each was run for real once by the stage that wrote it, and the
 * page that quotes it carries that run's output. The page-shape check counts
 * a file here as run for that reason, and each entry says so.
 */
export const REAL_ENGINE_EXAMPLES = Object.freeze([
  { file: 'teams/writer-reviewer-pair.ts', why: 'a Claude seat writes and a Codex seat reviews; the page carries one real run' },
  { file: 'teams/threshold-panel.ts', why: 'Claude implements, Codex and OpenCode review; the page carries one real run' },
  { file: 'teams/feature-delivery.ts', why: 'Claude analyses and approves, Codex implements, Claude reviews; the page carries one real run' },
]);
