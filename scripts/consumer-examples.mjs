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
  'builtin-workflows.ts',
  'surface-diff.ts',
  'memory-git.ts',
  'memory-markdown.ts',
  'memory-simple.ts',
  'memory.ts',
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
  'reasoning-record.ts',
  'run-child.ts',
  'write-and-review.ts',
  'one-agent-job.ts',
  'command-kickback.ts',
  'notify-webhook.ts',
  'engine-anthropic-api-binding.ts',
  'engine-claude-agent-sdk-binding.ts',
  'engine-jev-api-binding.ts',
  'approval.ts',
  'monitor.ts',
  'tournament.ts',
  'teams/writer-reviewer-pair.ts',
  'teams/writer-reviewer-pair.proof.ts',
  'teams/threshold-panel.ts',
  'teams/threshold-panel.proof.ts',
  'teams/feature-delivery.ts',
  'teams/feature-delivery.proof.ts',
  'use-cases/proof-host.ts',
  'use-cases/engineering/backlog-groom-then-rank.ts',
  'use-cases/engineering/backlog-groom-then-rank.proof.ts',
  'use-cases/business/contract-playbook.ts',
  'use-cases/business/contract-playbook.proof.ts',
  'use-cases/markets/market-session-advice.ts',
  'use-cases/markets/market-session-advice.proof.ts',
  'use-cases/sales/draft-then-send.ts',
  'use-cases/sales/draft-then-send.proof.ts',
  'use-cases/support/triage-with-escalation.ts',
  'use-cases/support/triage-with-escalation.proof.ts',
  'use-cases/research/literature-watch.ts',
  'use-cases/research/literature-watch.proof.ts',
  'use-cases/finance/invoice-chase.ts',
  'use-cases/finance/invoice-chase.proof.ts',
  'use-cases/editorial/writer-grader-cap.ts',
  'use-cases/editorial/writer-grader-cap.proof.ts',
  'use-cases/hiring/shortlist.ts',
  'use-cases/hiring/shortlist.proof.ts',
  'use-cases/knowledge/vault-curator.ts',
  'use-cases/knowledge/vault-curator.proof.ts',
  'use-cases/ops/approve-the-exact-payload.ts',
  'use-cases/ops/approve-the-exact-payload.proof.ts',
  'use-cases/ops/handoff-that-resumes.ts',
  'use-cases/ops/handoff-that-resumes.proof.ts',
  'use-cases/product/shape-up-cycle.ts',
  'use-cases/product/shape-up-cycle.proof.ts',
  'use-cases/other/translate-reflect.ts',
  'use-cases/other/translate-reflect.proof.ts',
]);

/**
 * Example files that run real engine plugins. The chain compiles them (they
 * are on the list above) but never runs them, because a run needs signed-in
 * model CLIs; each was run for real once by the stage that wrote it, and the
 * page that quotes it carries that run's output. The page-shape check counts
 * a file here as run for that reason, and each entry says so.
 */
export const REAL_ENGINE_EXAMPLES = Object.freeze([
  { file: 'feature-delivery.ts', why: 'Claude and Codex run the analysis, implementation and review jobs; the page carries one real run' },
  { file: 'teams/writer-reviewer-pair.ts', why: 'a Claude seat writes and a Codex seat reviews; the page carries one real run' },
  { file: 'teams/threshold-panel.ts', why: 'Claude implements, Codex and OpenCode review; the page carries one real run' },
  { file: 'teams/feature-delivery.ts', why: 'Claude analyses and approves, Codex implements, Claude reviews; the page carries one real run' },
  { file: 'use-cases/engineering/backlog-groom-then-rank.ts', why: 'a Claude seat splits and clarifies, a Codex seat reviews; the page carries one real run' },
  { file: 'use-cases/business/contract-playbook.ts', why: 'a Claude seat maps, redlines and positions, a Codex seat checks; the page carries one real run' },
  { file: 'use-cases/markets/market-session-advice.ts', why: 'a Claude seat researches uncertain observations and the assessment seat is Jev or a recorded replay; the page carries the proof run' },
  { file: 'use-cases/sales/draft-then-send.ts', why: 'a Claude seat drafts each note and a person decides; the page carries the proof run' },
  { file: 'use-cases/support/triage-with-escalation.ts', why: 'a Claude seat classifies and drafts, a person takes everything that is not routine; the page carries the proof run' },
  { file: 'use-cases/research/literature-watch.ts', why: 'a Claude seat summarises and answers, a person decides what enters memory; the page carries the proof run' },
  { file: 'use-cases/finance/invoice-chase.ts', why: 'a command reads the ledger, a Claude seat drafts each chaser, a person takes every dispute; the page carries the proof run' },
  { file: 'use-cases/editorial/writer-grader-cap.ts', why: 'a Claude seat writes and a Codex seat grades against the house style, an editor publishes; the page carries the proof run' },
  { file: 'use-cases/hiring/shortlist.ts', why: 'a Claude seat and a Codex seat each rank in a tournament judged against the brief, a person shortlists; the page carries the proof run' },
  { file: 'use-cases/knowledge/vault-curator.ts', why: 'a Claude seat proposes the filing and answers from the vault, a person decides what is filed and where; the page carries the proof run' },
  { file: 'use-cases/ops/handoff-that-resumes.ts', why: 'a Claude seat gathers and drafts across two workers that share one record; the page carries the proof run' },
  { file: 'use-cases/product/shape-up-cycle.ts', why: 'Claude, Codex and OpenCode seats shape, sit at the table and build, with Jev or a recorded replay checking each view; the page carries the proof run' },
  { file: 'use-cases/other/translate-reflect.ts', why: 'a Claude seat translates, a Codex seat reflects; the page carries one real run' },
]);

/**
 * Example files that run no engine and are run by their proof against a
 * stand-in for a command they call, so no `example:*` script runs the file
 * itself. The page-shape check counts a file here as run, and each entry
 * says which proof runs it and what stands in.
 */
export const PROOF_RUN_EXAMPLES = Object.freeze([
  { file: 'use-cases/ops/approve-the-exact-payload.ts', why: 'runs no engine; approve-the-exact-payload.proof.ts runs it offline with a stand-in for curl' },
]);
