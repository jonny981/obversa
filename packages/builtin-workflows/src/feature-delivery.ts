import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  acceptedProofs,
  acceptProofs,
  agentJob,
  changeTooLarge,
  changeUnderReview,
  commandJob,
  dag,
  fnJob,
  inputLimitCharacters,
  judge,
  LoopError,
  loop,
  noteProofSendBack,
  predicate,
  proofSendBacks,
  review,
  reviewPanel,
  revisionRequest,
  seatsOf,
  standingProofs,
  workspaceTree,
  type AcceptedProof,
  type DagNode,
  type FeedbackFinding,
  type Job,
  type JobContext,
  type Outcome,
  type RevisionRequest,
  type SeatChoice,
  type TeamSeat,
} from '@obversa/runtime';
import { feedbackBlock, objectAt, outcomeFromAgentText } from '@obversa/runtime/workflow-support';

import {
  assertDistinctChoices,
  assertRefineBudget,
  assertReviewers,
  expectedFilesPrompt,
  nodeRefine,
  panelReviewers,
  requireNoFiles,
  requireNonEmptyFiles,
  teamAgent,
} from './team-utils.js';
import type { FeatureDeliveryConfig, TeamInput } from './types.js';

export const RESEARCH_CONTEXT_NOTE = 'team-output/research-context.md';
export const RESEARCH_REQUIREMENTS_NOTE = 'team-output/research-requirements.md';
export const PLAN_NOTE = 'team-output/plan.md';

function relativeFiles(files: readonly string[], what: string): void {
  const names = new Set<string>();
  for (const file of files) {
    if (typeof file !== 'string' || !file.trim() || file.startsWith('/') || file.split('/').includes('..')) {
      throw new TypeError(`${what} must be a non-empty relative path: ${file}`);
    }
    if (names.has(file)) throw new TypeError(`${what} must be unique: ${file}`);
    names.add(file);
  }
}

function featureInput(config: FeatureDeliveryConfig): void {
  if ((config.brief === undefined) === (config.briefPath === undefined)) {
    throw new TypeError('give the brief as brief or as briefPath, not both');
  }
  if (!config.workspace?.trim()) throw new TypeError('workspace must not be empty');
  if (!Array.isArray(config.checks) || config.checks.length === 0) {
    throw new TypeError('checks must name at least one command the change must pass');
  }
  for (const [name, value] of [['buildMinutes', config.buildMinutes], ['reviewMinutes', config.reviewMinutes], ['stallMinutes', config.stallMinutes]] as const) {
    if (value !== undefined && !(Number.isFinite(value) && value > 0)) throw new TypeError(`${name} must be a positive number`);
  }
  if (config.analyse !== undefined || config.testFiles !== undefined) {
    if (!Array.isArray(config.files) || config.files.length === 0) {
      throw new TypeError('files must list the files the change writes when analyse or testFiles is given');
    }
    relativeFiles(config.files, 'file');
  }
  if (config.testFiles !== undefined) {
    if (config.testFiles.length === 0) throw new TypeError('testFiles must contain at least one expected test file');
    relativeFiles(config.testFiles, 'test file');
    const files = new Set(config.files);
    for (const file of config.testFiles) {
      if (!files.has(file)) throw new TypeError(`test file must also be listed in files: ${file}`);
    }
  }
}

async function nonEmptyFile(workspace: string, file: string): Promise<boolean> {
  try {
    const details = await stat(join(workspace, file));
    return details.isFile() && details.size > 0;
  } catch {
    return false;
  }
}

async function fileHash(workspace: string, file: string): Promise<string | undefined> {
  try {
    const contents = await readFile(join(workspace, file));
    return createHash('sha256').update(contents).digest('hex');
  } catch {
    return undefined;
  }
}

function rewriteInstruction(note: string, ctx: JobContext): string | undefined {
  return ctx.lastReview
    ? `A reviewer rejected the previous note. Rewrite ${note} and resolve every finding in the feedback in the rewritten file.`
    : undefined;
}

function outputWriter(
  label: string,
  seat: SeatChoice,
  config: TeamInput,
  output: string,
  instructions: string,
  target: string,
): Job {
  return requireNoFiles(
    label,
    requireNonEmptyFiles(
      label,
      teamAgent(
        label,
        seat,
        config,
        (ctx) => [
          instructions,
          rewriteInstruction(output, ctx),
          `Write only ${output}.`,
        ].filter(Boolean).join('\n'),
        target,
      ),
      config.workspace,
      [output],
    ),
    config.workspace,
    config.files,
    'body',
  );
}

function failOnUnchangedNote(
  label: string,
  job: Job,
  workspace: string,
  note: string,
  requireRewriteOnReentry = false,
): Job {
  const previousHashKey = `featureDeliveryPreviousHash:${label}`;
  return async (ctx) => {
    const outcome = await job(ctx);
    if (outcome.status !== 'pass') return outcome;
    const currentHash = await fileHash(workspace, note);
    const previousHash = ctx.state[previousHashKey];
    if (
      (ctx.lastReview || requireRewriteOnReentry)
      && typeof previousHash === 'string'
      && currentHash === previousHash
    ) {
      const summary = `${label} returned the rejected note unchanged`;
      return {
        status: 'fail',
        summary,
        error: new LoopError({ code: 'VALIDATION', phase: 'body', message: summary }),
      };
    }
    ctx.state[previousHashKey] = currentHash;
    return outcome;
  };
}

const REQUIREMENT_ID = /\bREQ-\d+\b/g;

function idsInText(text: string): string[] {
  return [...text.matchAll(REQUIREMENT_ID)].map(([id]) => id!);
}

function requireRequirementIds(workspace: string): Job {
  return async () => {
    try {
      const requirements = await readFile(join(workspace, RESEARCH_REQUIREMENTS_NOTE), 'utf8');
      if (idsInText(requirements).length > 0) return { status: 'pass', summary: 'requirements carry REQ-n ids' };
    } catch {
      // Return the same targeted repair below: the research note is the missing input.
    }
    return revisionRequest({
      target: 'research-requirements',
      source: 'plan-requirement-id-check',
      reason: 'requirements note contains no REQ-n ids',
      findings: [{ severity: 'block', evidence: 'Add a REQ-n id to every requirement.' }],
    });
  };
}

function planRequirementsReview(workspace: string): Job {
  return async () => {
    try {
      const requirements = await readFile(join(workspace, RESEARCH_REQUIREMENTS_NOTE), 'utf8');
      const plan = await readFile(join(workspace, PLAN_NOTE), 'utf8');
      const required = [...new Set(idsInText(requirements))];
      const planned = new Set(idsInText(plan));
      if (required.length === 0) {
        return revisionRequest({
          target: 'research-requirements',
          source: 'plan-requirement-id-check',
          reason: 'requirements note contains no REQ-n ids',
          findings: [{ severity: 'block', evidence: 'Add a REQ-n id to every requirement.' }],
        });
      }
      const missing = required.filter((id) => !planned.has(id));
      const extra = [...planned].filter((id) => !required.includes(id));
      if (missing.length || extra.length) {
        const findings = [
          ...missing.map((id) => ({
            severity: 'block' as const,
            evidence: `Add an acceptance check named ${id}.`,
          })),
          ...extra.map((id) => ({
            severity: 'block' as const,
            evidence: `Remove the acceptance check for unknown requirement ${id}.`,
          })),
        ];
        const parts = [
          missing.length ? `is missing acceptance checks for ${missing.join(', ')}` : undefined,
          extra.length ? `has unknown requirement ids ${extra.join(', ')}` : undefined,
        ].filter(Boolean);
        return revisionRequest({
          source: 'plan-requirement-id-check',
          reason: `plan ${parts.join('; ')}`,
          findings,
        });
      }
      return { status: 'pass', summary: `plan covers ${required.join(', ')}` };
    } catch {
      return revisionRequest({
        source: 'plan-requirement-id-check',
        reason: 'plan or requirements note could not be read',
        findings: [{ severity: 'block', evidence: 'Write both notes before the plan review.' }],
      });
    }
  };
}

function scopedPanel(
  label: string,
  config: FeatureDeliveryConfig,
  input: TeamInput,
  target?: string,
  reviewTarget?: string,
): Job {
  return reviewPanel({
    label,
    reviewers: panelReviewers(config.reviewers, input, reviewTarget),
    concurrency: config.reviewers.length,
    pass: config.reviewThreshold ?? config.reviewers.length,
    target,
  });
}

function noteExists(workspace: string, file: string) {
  return predicate(
    async () => nonEmptyFile(workspace, file),
    `${file} is non-empty`,
  );
}

function researchLoop(
  name: string,
  writer: Job,
  workspace: string,
  note: string,
  review: Job,
): Job {
  let inheritedReview: Outcome | undefined;
  const research = loop({
    name,
    body: failOnUnchangedNote(
      name.replace(/-loop$/, ''),
      async (ctx) => writer({ ...ctx, lastReview: ctx.lastReview ?? inheritedReview }),
      workspace,
      note,
      true,
    ),
    until: noteExists(workspace, note),
    review,
    max: 3,
    maxReviewRestarts: 3,
    noProgress: { window: 2, gate: true },
  });
  return async (parent) => {
    inheritedReview = parent.lastReview;
    return research(parent);
  };
}


const MINUTE = 60_000;

/** The last object in a reply with a `status` of pass or revise, parsed; the same rule `outcomeFromAgentText` reads by. */
function lastDecision(text: string): Record<string, unknown> | undefined {
  let last: Record<string, unknown> | undefined;
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const object = objectAt(text, start);
    if (object === undefined) continue;
    try {
      const value: unknown = JSON.parse(object);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)
        && ((value as { status?: unknown }).status === 'pass' || (value as { status?: unknown }).status === 'revise')) {
        last = value as Record<string, unknown>;
      }
      start += object.length - 1;
    } catch {
      continue;
    }
  }
  return last;
}

function findingsIn(decision: Record<string, unknown> | undefined): FeedbackFinding[] {
  const list = Array.isArray(decision?.findings) ? decision.findings : [];
  return list.flatMap((item) => {
    const finding = item as { evidence?: unknown; severity?: unknown };
    if (typeof finding?.evidence !== 'string' || !finding.evidence.trim()) return [];
    const severity = finding.severity === 'warning' ? 'nice-to-have' : finding.severity;
    return [{
      evidence: finding.evidence,
      ...(severity === 'block' || severity === 'should-fix' || severity === 'nice-to-have' ? { severity } : {}),
    } as FeedbackFinding];
  });
}

function bulletList(findings: readonly FeedbackFinding[]): string {
  return findings.map((finding) => `- [${finding.severity ?? 'block'}] ${finding.evidence}`).join('\n');
}

/** What a relaunch tells the builder and the brief check about the earlier run's work in the worktree. */
function carriedNote(ctx: JobContext): string | undefined {
  const carried = ctx.carried;
  if (carried === undefined) return undefined;
  const ended = carried.ended;
  return [
    'An earlier run worked on this brief. The worktree may hold its uncommitted work.',
    ended === undefined
      ? 'Its record does not say how it ended.'
      : `It ended ${ended.status}${ended.node === undefined ? '' : ` at step "${ended.node}"`}: ${ended.reason}`,
    'Read that work against the brief and keep what is right. The worktree\'s state and the earlier run\'s history are not claims of the brief.',
  ].join('\n');
}

/** A proof send-back: the proof check's own, and nothing else. */
function proofSendBack(ctx: JobContext): RevisionRequest | undefined {
  const revision = ctx.lastReview?.revision;
  return revision?.source === 'proof' ? revision : undefined;
}

function proofSendBackPrompt(sentBack: RevisionRequest, report: string): string {
  const missing = (sentBack.findings ?? []).map((finding) => `- ${finding.evidence}`);
  return [
    `Your report was sent back: ${sentBack.reason}.`,
    `It is missing the proof each of these asks for:\n${missing.length > 0 ? missing.join('\n') : '- (no list was given)'}`,
    'Run what each asks, then reply with the whole corrected report, the raw output pasted in, and the commit message block at its end.',
    ...(report ? [`=== your report so far ===\n${report}`] : []),
  ].join('\n\n');
}

/**
 * A send-back no judge decides: a failed check, a change too large to
 * review, or missing proof goes straight back to its target. Only the
 * review panel's verdicts go through the judge.
 */
function outsideTheJudge(outcome: Outcome): Outcome {
  return outcome.revision === undefined ? outcome : { ...outcome, revision: { ...outcome.revision, skipJudge: true } };
}

/** One check the run ran on the tree, and how it ended. */
interface RunCheck {
  readonly command: string;
  readonly status: 'passed' | 'failed';
}

function commandText(command: string | readonly string[]): string {
  return typeof command === 'string' ? command : command.join(' ');
}

/**
 * One feature, delivered by a team. A seat check, then a brief check, then
 * the build in the workspace; the builder's report; the given checks on the
 * tree; a proof check of the report against the brief; and the review panel,
 * with the judge between its verdict and each send-back. The research, plan
 * and tests stages run before the build when `analyse` and `testFiles` are
 * given.
 */
export function featureDelivery(config: FeatureDeliveryConfig): Job {
  featureInput(config);
  assertReviewers(config.reviewers, config.reviewThreshold ?? config.reviewers.length);
  const configuredRefine = config.refine ?? 1;
  const refineBudget = typeof configuredRefine === 'number'
    ? configuredRefine
    : { 'research-requirements': 1, ...configuredRefine };
  assertRefineBudget(refineBudget, ['research-requirements', 'plan', 'tests-first']);
  assertDistinctChoices([config.implement, ...config.reviewers.map(({ seat }) => seat)]);
  const briefText = () => config.briefPath === undefined ? config.brief! : readFileSync(config.briefPath, 'utf8');
  const brief = briefText();
  const base = config.base ?? 'origin/main';
  const buildMs = (config.buildMinutes ?? 120) * MINUTE;
  const reviewMs = (config.reviewMinutes ?? 40) * MINUTE;
  const stall = config.stallMinutes === undefined ? {} : { stallMs: config.stallMinutes * MINUTE };
  const houseRules = config.houseRules ? [`=== the house rules ===\n${config.houseRules}`] : [];
  const checkList = config.checks.map(commandText);
  // Each seat by its position: the builder, each reviewer by name, and the reader.
  const reviewerPosition = (name: string) => `reviewer:${name}`;
  const firstReviewer = reviewerPosition(config.reviewers[0]!.name);
  const reader: [string, SeatChoice] = config.reader === undefined ? [firstReviewer, config.reviewers[0]!.seat] : ['reader', config.reader];
  const briefChecker: [string, SeatChoice] = [firstReviewer, config.reviewers[0]!.seat];
  // The seats a position runs on: the one the seat check admitted, then the candidates after it.
  const admitted = (ctx: JobContext, position: string, choice: SeatChoice): readonly TeamSeat[] => {
    const seats = seatsOf(choice);
    const index = (ctx.needs?.seats?.data as { admitted?: Record<string, number> } | undefined)?.admitted?.[position] ?? 0;
    return seats.slice(Math.min(index, seats.length - 1));
  };
  // The stages before the build run on the same seats: each position as the seat check admitted it.
  const admittedChoice = (ctx: JobContext, position: string, choice: SeatChoice): SeatChoice => {
    const [seat, ...candidates] = admitted(ctx, position, choice);
    return candidates.length > 0 ? { seat: seat!, candidates } : seat!;
  };
  const onAdmittedSeats = (make: (implement: SeatChoice, team: FeatureDeliveryConfig) => Job): Job => (ctx) => make(
    admittedChoice(ctx, 'builder', config.implement),
    { ...config, reviewers: config.reviewers.map((reviewer) => ({ ...reviewer, seat: admittedChoice(ctx, reviewerPosition(reviewer.name), reviewer.seat) })) },
  )(ctx);
  const seatJob = (seats: readonly TeamSeat[], options: Omit<Parameters<typeof agentJob>[0], 'engine' | 'model' | 'identity' | 'candidates' | 'tools' | 'allowedTools'>) => {
    const [primary, ...candidates] = seats;
    return agentJob({
      engine: primary!.engine,
      model: primary!.identity.model,
      identity: primary!.identity,
      ...(candidates.length > 0 ? { candidates } : {}),
      tools: [...primary!.identity.tools],
      allowedTools: [...primary!.identity.tools],
      ...options,
    });
  };
  const readOnly = ([position, choice]: [string, SeatChoice], label: string, prompt: (ctx: JobContext) => string | Promise<string>, outcome: (text: string, ctx: JobContext) => Outcome): Job =>
    (ctx) => seatJob(admitted(ctx, position, choice), {
      label,
      workspaceMode: 'read',
      leaf: true,
      cwd: config.workspace,
      timeoutMs: reviewMs,
      ...stall,
      prompt,
      outcome,
    })(ctx);

  // Before any build spend, each seat that answers admission starts its CLI and reports its version.
  // A seat that cannot start is replaced by its next candidate; with none left, the run pauses.
  const seatsCheck = fnJob('seats', async (ctx): Promise<Outcome> => {
    const started: string[] = [];
    const unchecked: string[] = [];
    const replaced: string[] = [];
    const missing: string[] = [];
    // Which of each position's seats answered, so every later step starts on it.
    const chosen: Record<string, number> = {};
    const positions: [string, string, SeatChoice][] = [
      ['builder', 'builder', config.implement],
      ...config.reviewers.map((reviewer) => [reviewerPosition(reviewer.name), reviewer.name, reviewer.seat] as [string, string, SeatChoice]),
      ...(config.reader === undefined ? [] : [['reader', 'reader', config.reader] as [string, string, SeatChoice]]),
    ];
    for (const [position, name, choice] of positions) {
      const failures: string[] = [];
      let answered = false;
      for (const [index, seat] of seatsOf(choice).entries()) {
        if (typeof seat.engine.admit !== 'function') {
          unchecked.push(`${name} (${seat.identity.model})`);
          chosen[position] = index;
          answered = true;
          break;
        }
        try {
          const selection = await seat.engine.admit({
            model: seat.identity.model,
            cwd: config.workspace,
            workspaceMode: name === 'builder' ? 'write' : 'read',
            tools: [...seat.identity.tools],
            allowedTools: [...seat.identity.tools],
            timeoutMs: name === 'builder' ? buildMs : reviewMs,
          }, ctx.signal);
          started.push(`${name} ${seat.identity.model} ${selection?.adapterVersion ?? ''}`.trim());
          if (failures.length > 0) replaced.push(`${name}: ${failures.join('; ')}; ${seat.identity.model} answers instead`);
          chosen[position] = index;
          answered = true;
          break;
        } catch (error) {
          failures.push(`${seat.identity.model} cannot start: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (!answered) missing.push(`${name}: ${failures.join('; ')}`);
    }
    if (missing.length > 0) {
      return { status: 'paused', summary: `a seat has no candidate that can start: ${missing.join('; ')}` };
    }
    return {
      status: 'pass',
      summary: [
        started.length > 0 ? `started: ${started.join(', ')}` : undefined,
        replaced.length > 0 ? `replaced: ${replaced.join('; ')}` : undefined,
        unchecked.length > 0 ? `not checked, the engine has no admission check: ${unchecked.join(', ')}` : undefined,
      ].filter(Boolean).join('; '),
      data: { admitted: chosen },
    };
  });

  // The brief is read against the repository before any build. Every
  // finding comes back in one pass; a block pauses the run for the brief to
  // be fixed, and a resume reads the brief again from its file.
  const briefCheck = readOnly(briefChecker, 'brief', (ctx) => [
    'Before anything is built, check the brief below against this repository. The brief makes claims about the code; say whether they hold. Change nothing.',
    `=== the brief ===\n${briefText()}`,
    ...(carriedNote(ctx) === undefined ? [] : [`=== the earlier run ===\n${carriedNote(ctx)}`]),
    [
      'List every finding you can establish; do not stop at the first. Each finding says what is false or cannot be checked, and where you looked.',
      'Block only on: a wrong goal; a false claim about the repository or its base; a check the brief requires that cannot fail.',
      'Never block because the tree does not yet do what the brief asks the build to do: that is the build\'s work.',
      'A note about the worktree\'s state that has gone stale, on a resumed or relaunched run, is a warning the builder sees, not a block.',
    ].join('\n'),
    'Reply as one JSON object and nothing after it: {"status":"pass"|"revise","summary":"...","findings":[{"severity":"block"|"warning","evidence":"what is false or cannot be checked, and where you looked"}]}. Pass when nothing blocks.',
  ].join('\n\n'), (text) => {
    const decision = lastDecision(text);
    if (decision === undefined) return outcomeFromAgentText(text);
    const findings = findingsIn(decision);
    const blocks = findings.filter((finding) => (finding.severity ?? 'block') === 'block');
    const summary = typeof decision.summary === 'string' ? decision.summary : '';
    if (decision.status === 'revise' && blocks.length === 0 && findings.length === 0) {
      return { status: 'paused', summary: `the brief check asked for a revision and named no finding: ${summary}`, data: { findings } };
    }
    if (decision.status === 'pass' || blocks.length === 0) {
      return { status: 'pass', summary: summary || 'the brief holds', data: { findings } };
    }
    return {
      status: 'paused',
      summary: `the brief check found ${blocks.length} problem(s); fix the brief and resume:\n${bulletList(findings)}`,
      data: { findings },
    };
  });

  // The proof the builder still owes: what the proof check sent back. A
  // send-back for proof asks for output, not new work, so it rides the
  // prompt and the unchanged-work rule never reads it.
  const builderSeats = (ctx: JobContext) => admitted(ctx, 'builder', config.implement);
  // The run's own files (its record, the records kept beside it, its check output) are never part of a proof's tree.
  const snapshot = (ctx: JobContext) => workspaceTree({ cwd: config.workspace, signal: ctx.signal, ...(ctx.fingerprintExcludePaths === undefined ? {} : { excludePaths: ctx.fingerprintExcludePaths }) });
  const buildPrompt = async (ctx: JobContext, sentBack: RevisionRequest | undefined): Promise<string> => {
    const proofs = acceptedProofs(ctx);
    const tree = proofs.length > 0 ? await snapshot(ctx) : undefined;
    const standing = tree === undefined ? [] : (await standingProofs(proofs, tree, { cwd: config.workspace, signal: ctx.signal })).standing;
    const briefWarnings = ((ctx.needs?.brief?.data as { findings?: FeedbackFinding[] } | undefined)?.findings ?? []);
    const firstBuild = (ctx.graph?.attempt ?? 1) === 1;
    const open = firstBuild ? ctx.carried?.openFindings ?? [] : [];
    return [
      briefText(),
      ...houseRules,
      `Before you finish, run each of these from the repo root and make them pass:\n${checkList.map((command) => `- ${command}`).join('\n')}`,
      'Paste the raw output for each item the brief asks proof for that is not already accepted. A check in the list above is the exception: the run runs it on this tree itself, so when it passes there it is proven and needs no paste. Anything the run cannot produce itself, like a mutation check, needs its output pasted.',
      ...(standing.length > 0 ? [`These proofs were accepted and still stand, because the files they cover have not changed; do not run or paste them again:\n${standing.map((proof) => `- ${proof.item}`).join('\n')}`] : []),
      ...(briefWarnings.length > 0 ? [`The brief check noted:\n${bulletList(briefWarnings)}`] : []),
      ...(firstBuild && carriedNote(ctx) !== undefined ? [`=== the earlier run ===\n${carriedNote(ctx)}`] : []),
      ...(open.length > 0 ? [`The last review of an earlier run on this brief ended with these findings still open. Answer them in this build:\n${bulletList(open)}`] : []),
      sentBack === undefined
        ? 'On a retry, the review findings are appended below. Fix what they name and leave every other line alone. A failed check you find the change does not cause may be answered with no change: say why, with your evidence.'
        : proofSendBackPrompt(sentBack, proofSendBacks(ctx).report),
      'End your reply with the commit message for the change in a fenced block marked commit: a Conventional Commits subject line, a blank line, then a body that says why.',
    ].join('\n\n');
  };
  const build: Job = (ctx) => {
    const sentBack = proofSendBack(ctx);
    return seatJob(builderSeats(ctx), {
      label: 'build',
      workspaceMode: 'write',
      cwd: config.workspace,
      consumeFeedback: true,
      timeoutMs: buildMs,
      ...stall,
      prompt: (inner) => buildPrompt(inner, sentBack),
    })(sentBack === undefined ? ctx : { ...ctx, lastReview: undefined });
  };

  // The report the team reads. A proof send-back asks the builder again, for output only.
  const report: Job = async (ctx) => {
    const built = ctx.needs?.build;
    const text = String(built?.data ?? built?.summary ?? '(none)');
    const sentBack = proofSendBack(ctx);
    if (sentBack === undefined) return { status: 'pass', summary: "the builder's report", data: text };
    return seatJob(builderSeats(ctx), {
      label: 'report',
      workspaceMode: 'write',
      cwd: config.workspace,
      timeoutMs: buildMs,
      ...stall,
      prompt: proofSendBackPrompt(sentBack, text),
    })({ ...ctx, lastReview: undefined });
  };

  const reviewerPrompt = (ctx: JobContext) => [
    'You review a change to this repo. You did not write it. The brief it answers and the house rules follow, then the builder\'s report; the change comes after your instructions. You may read any file in the repo for context. Change nothing.',
    `=== the brief ===\n${briefText()}`,
    ...houseRules,
    `These checks already passed on this tree:\n${checkList.join('\n')}`,
    `=== the builder's report (its own claims; check them against the change and the repo) ===\n${String(ctx.needs?.report?.data ?? ctx.needs?.report?.summary ?? '(none)')}`,
    'Report only real problems, worst first: behaviour that is wrong under normal use; a requirement of the brief that is not met; a test that cannot fail; a comment or doc sentence the code does not back; a house rule broken. Not taste, not style, not an edge case nobody will hit.',
    'Severity: block means wrong, broken, a requirement unmet, or a rule broken; should-fix means a reader would be misled or a check is weaker than it looks; nice-to-have is everything else.',
    'Reply as one JSON object and nothing after it: {"status":"pass"|"revise","summary":"...","findings":[{"severity":"block"|"should-fix"|"nice-to-have","evidence":"file:line, what is wrong, the fix"}]}',
  ].join('\n\n');

  // Right after each build, the review input is measured for every
  // reviewer seat: a change too large for one goes back to the build before
  // any check, proof check or reviewer spends anything.
  const fit: Job = async (ctx) => {
    const fixed = reviewerPrompt(ctx).length;
    for (const reviewer of config.reviewers) {
      const seats = seatsOf(reviewer.seat);
      const limits = seats.flatMap((seat) => {
        const limit = inputLimitCharacters(seat.engine);
        return limit === undefined ? [] : [{ limit, name: seat.engine.name }];
      }).sort((a, b) => a.limit - b.limit);
      const smallest = limits[0];
      if (smallest === undefined) continue;
      const change = await changeUnderReview(ctx, { cwd: config.workspace, base, budget: Math.max(0, smallest.limit - fixed) });
      if (!change.fits) {
        const reason = changeTooLarge(change, fixed + change.text.length, smallest.name, smallest.limit);
        return outsideTheJudge(revisionRequest({
          target: 'build',
          source: 'fit',
          reason: `the change is too large for reviewer ${reviewer.name}`,
          findings: [{ severity: 'block', evidence: `${reason}. Make the change smaller: move data out of the change, or split it.` }],
        }));
      }
    }
    return { status: 'pass', summary: 'the change fits every reviewer' };
  };

  // Each check runs on the tree; a failure runs once more before it counts,
  // and its output is kept beside the record. Each result is kept for the proof check.
  // A failed check's send-back fits the builder's whole next prompt: the
  // retry's own text, then the feedback block around the check's reason and output.
  const checkOutputLimit = async (ctx: JobContext): Promise<number | undefined> => {
    const limit = Math.min(...builderSeats(ctx).map((seat) => inputLimitCharacters(seat.engine) ?? Infinity));
    if (!Number.isFinite(limit)) return undefined;
    const retry = await buildPrompt({ ...ctx, ...(ctx.graph === undefined ? {} : { graph: { ...ctx.graph, attempt: 2 } }) }, undefined);
    // A one-character stand-in reason keeps the reason's line in the block; the check's own reason replaces it.
    const around = feedbackBlock({ status: 'fail', revision: { target: 'build', source: 'checks', reason: '-', findings: [{ severity: 'block', evidence: '' }] } });
    return Math.max(0, limit - retry.length - '\n\n---\n\n'.length - (around.length - 1));
  };
  const checks: Job = async (ctx) => {
    const ran: RunCheck[] = [];
    const outputLimit = await checkOutputLimit(ctx);
    for (const [index, command] of config.checks.entries()) {
      const outcome = await commandJob(`check-${index + 1}`, command, {
        cwd: config.workspace,
        target: 'build',
        timeoutMs: 45 * MINUTE,
        ...(outputLimit === undefined ? {} : { outputLimit }),
      })(ctx);
      ran.push({ command: checkList[index]!, status: outcome.status === 'pass' ? 'passed' : 'failed' });
      if (outcome.status !== 'pass') return outsideTheJudge({ ...outcome, data: { checks: ran, output: outcome.data } });
    }
    return { status: 'pass', summary: `${ran.length} check(s) passed`, data: { checks: ran } };
  };

  // The proof check asks only for proof the run cannot produce itself. A
  // proof it accepts stays accepted until a file it covers changes.
  const proofTree: { tree?: string } = {};
  const proofStanding: { standing: readonly AcceptedProof[]; changed: readonly AcceptedProof[] } = { standing: [], changed: [] };
  const proofAsk = readOnly(reader, 'proof', (ctx) => [
    "The builder's report must answer each item in the brief that asks for proof, one of three ways: pasted raw output; a check the run itself passed on this tree; or a proof accepted earlier that still stands. Read the brief, then the report, and name each item that has none. What the run cannot produce itself (a mutation check, an offline measure, a reproduction) always needs its output pasted; a claim that something ran is not its output.",
    `=== the checks the run already ran on this tree ===\n${((ctx.needs?.checks?.data as { checks?: readonly RunCheck[] } | undefined)?.checks ?? []).map((check) => `\`${check.command}\`: ${check.status}`).join('\n') || '(none)'}\nA brief item that names one of these commands is proven when its line reads passed. A check that failed proves nothing.`,
    `=== proofs accepted earlier that still stand; do not ask for them ===\n${proofStanding.standing.map((proof) => `- ${proof.item}`).join('\n') || '(none)'}`,
    ...(proofStanding.changed.length > 0 ? [`=== proofs accepted earlier whose files changed since; ask for them again unless the report pastes them ===\n${proofStanding.changed.map((proof) => `- ${proof.item}`).join('\n')}`] : []),
    `=== the brief ===\n${briefText()}`,
    `=== the builder's report ===\n${String(ctx.needs?.report?.data ?? ctx.needs?.report?.summary ?? '(none)')}`,
    'For each proof the report pastes that you accept, name the brief item it answers and the files it exercises: the code it tests or measures, its test file, and the script it ran.',
    'Reply as one JSON object and nothing after it: {"status":"pass"|"revise","summary":"...","accepted":[{"item":"the brief item, quoted","files":["path"]}],"findings":[{"severity":"block","evidence":"the item, quoted, and the proof it wants"}]}. Pass when every proof is pasted, proven by a run check, or accepted and still standing; revise with one finding per missing proof.',
  ].join('\n\n'), (text, ctx) => {
    const decision = lastDecision(text);
    if (decision === undefined) return outcomeFromAgentText(text);
    const accepted = (Array.isArray(decision.accepted) ? decision.accepted : []).flatMap((entry) => {
      const item = (entry as { item?: unknown })?.item;
      const files = (entry as { files?: unknown })?.files;
      return typeof item === 'string' && item.trim() && proofTree.tree !== undefined
        ? [{ item, tree: proofTree.tree, files: Array.isArray(files) ? files.filter((file): file is string => typeof file === 'string') : [] }]
        : [];
    });
    const list = accepted.length > 0 ? acceptProofs(ctx, accepted) : acceptedProofs(ctx);
    const findings = findingsIn(decision);
    const summary = typeof decision.summary === 'string' ? decision.summary : '';
    if (decision.status === 'pass') return { status: 'pass', summary, data: { acceptedProofs: [...list] } };
    // The first miss in a run goes back to the report and costs no round; a
    // later one goes to the build, with the report it read. Both ride the
    // record, so a resume keeps them.
    const target = proofSendBacks(ctx).count === 0 ? 'report' : 'build';
    const sent = noteProofSendBack(ctx, String(ctx.needs?.report?.data ?? ctx.needs?.report?.summary ?? ''));
    return outsideTheJudge(revisionRequest({ target, source: 'proof', reason: summary || 'proof is missing', findings }, { data: { acceptedProofs: [...list], proofSendBacks: sent } }));
  });
  const proof: Job = async (ctx) => {
    proofTree.tree = await snapshot(ctx);
    const split = proofTree.tree === undefined
      ? { standing: [], changed: acceptedProofs(ctx) }
      : await standingProofs(acceptedProofs(ctx), proofTree.tree, { cwd: config.workspace, signal: ctx.signal });
    proofStanding.standing = split.standing;
    proofStanding.changed = split.changed;
    return proofAsk(ctx);
  };

  const panel = reviewPanel({
    label: 'review',
    target: 'build',
    base,
    pass: config.reviewThreshold ?? 'all',
    concurrency: config.reviewers.length,
    reviewers: config.reviewers.map((reviewer) => ({
      name: reviewer.name,
      job: readOnly([reviewerPosition(reviewer.name), reviewer.seat], `review-${reviewer.name}`, reviewerPrompt, (text) => outcomeFromAgentText(text, 'build')),
    })),
  });

  // The stages before the build, when their seats and files are given.
  const input: TeamInput = { brief, workspace: config.workspace, files: config.files ?? [], test: { command: process.execPath, args: [] } };
  const before: Record<string, DagNode> = {};
  let last = 'brief';
  if (config.analyse !== undefined) {
    const analyse = config.analyse;
    before['research-context'] = {
      job: onAdmittedSeats((_, team) => researchLoop('research-context-loop', outputWriter('research-context', analyse, input, RESEARCH_CONTEXT_NOTE, 'Read the workspace and brief, then record the small set of facts needed to plan the change. Do not write implementation or test files.', 'research-context'), config.workspace, RESEARCH_CONTEXT_NOTE, scopedPanel('research-context-review', team, input, 'research-context', RESEARCH_CONTEXT_NOTE))),
      desc: 'Read the workspace and write down what the change touches, until a reviewer accepts the note.',
      gate: 'The context note is in the workspace and a reviewer has accepted it.',
      needs: [last, 'seats'],
    };
    before['research-requirements'] = {
      job: onAdmittedSeats((_, team) => researchLoop('research-requirements-loop', outputWriter('research-requirements', analyse, input, RESEARCH_REQUIREMENTS_NOTE, `Read ${RESEARCH_CONTEXT_NOTE} and turn it into small testable requirements. Give every requirement an id in the form REQ-n. Do not write implementation or test files.`, 'research-requirements'), config.workspace, RESEARCH_REQUIREMENTS_NOTE, scopedPanel('research-requirements-review', team, input, 'research-requirements', RESEARCH_REQUIREMENTS_NOTE))),
      desc: 'Turn the brief and the context note into requirements, one REQ-n per line, each testable and traced to the brief.',
      gate: 'Every requirement is testable, traces to the brief, and asks for nothing the brief does not.',
      needs: ['research-context', 'seats'],
      refine: nodeRefine(refineBudget, 'research-requirements'),
    };
    const planWriter = outputWriter('plan', analyse, input, PLAN_NOTE, `Read ${RESEARCH_REQUIREMENTS_NOTE} and write a short executable plan. Every acceptance check must name the REQ-n it covers. Do not write implementation or test files.`, 'plan');
    let planParentReview: Outcome | undefined;
    const planLoop = loop({
      name: 'plan-loop',
      body: failOnUnchangedNote('plan', async (ctx) => planWriter({ ...ctx, lastReview: ctx.lastReview ?? planParentReview }), config.workspace, PLAN_NOTE, true),
      until: noteExists(config.workspace, PLAN_NOTE),
      review: planRequirementsReview(config.workspace),
      max: 3,
      maxReviewRestarts: 3,
      noProgress: { window: 2, gate: true },
    });
    before.plan = {
      job: async (parent) => {
        const requirementsCheck = await requireRequirementIds(config.workspace)(parent);
        if (requirementsCheck.status !== 'pass') return requirementsCheck;
        planParentReview = parent.lastReview;
        return planLoop(parent);
      },
      desc: 'Write an executable plan from the requirements, one acceptance check per job.',
      gate: 'Every requirement has a check in the plan and no check asks for more than its requirement.',
      needs: ['research-requirements'],
      sendsBackTo: ['research-requirements'],
      refine: nodeRefine(refineBudget, 'plan'),
    };
    before['plan-review'] = {
      job: onAdmittedSeats((_, team) => scopedPanel('plan-review', team, input, 'plan', `${RESEARCH_REQUIREMENTS_NOTE} and ${PLAN_NOTE}`)),
      desc: 'Have the reviewers read the plan against the requirements and send it back if it falls short.',
      gate: 'Enough reviewers have accepted the plan.',
      needs: ['plan', 'seats'],
      sendsBackTo: ['plan'],
    };
    last = 'plan-review';
  }
  if (config.testFiles !== undefined) {
    const testFileList = config.testFiles;
    const testFiles = new Set(testFileList);
    before['tests-first'] = {
      job: onAdmittedSeats((implement) => requireNoFiles('tests-first', requireNonEmptyFiles('tests-first', teamAgent('tests-first', implement, input,
        `${config.analyse === undefined ? '' : `Read ${PLAN_NOTE} and write`}${config.analyse === undefined ? 'Write' : ''} the declared tests first. ${expectedFilesPrompt(testFileList)} The tests may be red because the implementation does not exist yet. Do not write implementation files.`,
        'tests-first'), config.workspace, testFileList), config.workspace, (config.files ?? []).filter((file) => !testFiles.has(file)), 'body')),
      desc: 'Write the declared test files before any implementation exists.',
      gate: 'Every declared test file exists and is not empty.',
      needs: [last, 'seats'],
      refine: nodeRefine(refineBudget, 'tests-first'),
    };
    before['tests-review'] = {
      job: onAdmittedSeats((_, team) => scopedPanel('tests-review', team, input, 'tests-first', testFileList.join(', '))),
      desc: 'Have the reviewers check that the tests cover the brief and that any red test is red for a stated reason.',
      gate: 'Enough reviewers have accepted the tests.',
      needs: ['tests-first', 'seats'],
      sendsBackTo: ['tests-first'],
    };
    last = 'tests-review';
  }

  const rounds = config.judge === undefined
    ? review({ rounds: config.rounds ?? 3 })
    : review({ judge: judge(config.judge, config.cap === undefined ? {} : { cap: config.cap }) });
  return dag({
    name: 'feature-delivery',
    brief,
    concurrency: 1,
    ...(config.commit === true ? { commit: { from: 'report' } } : {}),
    nodes: {
      seats: {
        job: seatsCheck,
        desc: 'Each seat whose engine has an admission check starts its CLI and reports its version; a seat that cannot start is replaced by its next candidate.',
        gate: 'Every seat, or its candidate, starts.',
      },
      brief: {
        needs: ['seats'],
        job: briefCheck,
        desc: 'A read-only reviewer checks the brief against the repository before any build, and lists every finding in one pass.',
        gate: 'The goal is right, the claims about the repository hold, and every required check can fail; a block pauses the run for the brief to be fixed.',
      },
      ...before,
      build: {
        needs: [...new Set([last, 'seats'])],
        job: build,
        desc: 'Build the change the brief asks for, with its tests and docs.',
        gate: 'The brief is met and the given checks pass.',
        refine: rounds,
      },
      report: {
        needs: ['build', 'seats'],
        job: report,
        desc: "The builder's report, carried to the team; a send-back for missing proof asks the builder again.",
        gate: 'A report is present.',
        refine: review({ rounds: 1 }),
      },
      fit: {
        needs: ['report'],
        sendsBackTo: ['build'],
        job: fit,
        desc: 'Measure the review input for every reviewer seat.',
        gate: 'The change fits every reviewer, with data files listed.',
      },
      checks: {
        needs: ['fit', 'build', 'seats', 'brief'],
        sendsBackTo: ['build'],
        job: checks,
        desc: 'Run the given checks on the tree; a failure runs once more before it counts.',
        gate: 'Every check exits 0.',
      },
      proof: {
        needs: ['checks', 'report', 'seats'],
        sendsBackTo: ['report', 'build'],
        job: proof,
        desc: 'Check the report answers the proof the brief asks for: pasted, proven by a run check, or accepted earlier and still standing.',
        gate: 'Every required proof is answered; a first miss goes back to the report without a review round.',
      },
      review: {
        needs: ['proof', 'report', 'build', 'seats'],
        sendsBackTo: ['build'],
        job: panel,
        desc: 'The reviewers, read-only, read the change against the brief; from round 2 each reads its open findings and the diff since its last round.',
        gate: 'The reviewers pass it, or the judge says another round is not worth it.',
      },
    },
  });
}
