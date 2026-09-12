import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  commandSucceeds,
  dag,
  fnJob,
  LoopError,
  loop,
  predicate,
  reviewPanel,
  revisionRequest,
  type Job,
  type JobContext,
  type Outcome,
} from '@obversa/runtime';

import {
  assertDistinctSeats,
  assertKickbacks,
  assertReviewers,
  assertTeamInput,
  APPROVAL_NOTE,
  expectedFilesPrompt,
  panelReviewers,
  requireFilesUnchanged,
  requireNoFiles,
  requireNonEmptyFiles,
  teamAgent,
  teamTest,
} from './team-utils.js';
import type { FeatureDeliveryConfig } from './types.js';

export const RESEARCH_CONTEXT_NOTE = 'team-output/research-context.md';
export const RESEARCH_REQUIREMENTS_NOTE = 'team-output/research-requirements.md';
export const PLAN_NOTE = 'team-output/plan.md';
export const EVIDENCE_NOTE = 'team-output/evidence.md';
export const LEARNING_NOTE = 'team-output/learning.md';

const RUN_MARKER = 'featureDeliveryRunMarker';
const RUN_STARTED_AT = 'featureDeliveryRunStartedAt';

function featureInput(config: FeatureDeliveryConfig): void {
  if (!Array.isArray(config.testFiles) || config.testFiles.length === 0) {
    throw new TypeError('testFiles must contain at least one expected test file');
  }
  const files = new Set(config.files);
  const names = new Set<string>();
  for (const file of config.testFiles) {
    if (typeof file !== 'string' || !file.trim() || file.startsWith('/') || file.split('/').includes('..')) {
      throw new TypeError(`test file must be a non-empty relative path: ${file}`);
    }
    if (!files.has(file)) {
      throw new TypeError(`test file must also be listed in files: ${file}`);
    }
    if (names.has(file)) throw new TypeError(`test file must be unique: ${file}`);
    names.add(file);
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

async function fileExists(workspace: string, file: string): Promise<boolean> {
  try {
    return (await stat(join(workspace, file))).isFile();
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
  seat: FeatureDeliveryConfig['analyse'],
  config: FeatureDeliveryConfig,
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
  );
}

function failOnUnchangedNote(
  label: string,
  job: Job,
  workspace: string,
  note: string,
  requireRewriteOnReentry = false,
): Job {
  let previousHash: string | undefined;
  return async (ctx) => {
    const outcome = await job(ctx);
    if (outcome.status !== 'pass') return outcome;
    const currentHash = await fileHash(workspace, note);
    if (
      (ctx.lastReview || requireRewriteOnReentry)
      && previousHash !== undefined
      && currentHash === previousHash
    ) {
      const summary = `${label} returned the rejected note unchanged`;
      return {
        status: 'fail',
        summary,
        error: new LoopError({ code: 'VALIDATION', phase: 'body', message: summary }),
      };
    }
    previousHash = currentHash;
    return outcome;
  };
}

const REQUIREMENT_ID = /\bREQ-\d+\b/g;
const REQUIREMENT_LINE = /^\s*(REQ-\d+)\s*:/;

function idsInPlan(text: string): string[] {
  return [...text.matchAll(REQUIREMENT_ID)].map(([id]) => id!);
}

function idsInRequirements(text: string): string[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const id = REQUIREMENT_LINE.exec(line)?.[1];
    return id ? [id] : [];
  });
}

function planRequirementsReview(workspace: string): Job {
  return async () => {
    try {
      const requirements = await readFile(join(workspace, RESEARCH_REQUIREMENTS_NOTE), 'utf8');
      const plan = await readFile(join(workspace, PLAN_NOTE), 'utf8');
      const required = [...new Set(idsInRequirements(requirements))];
      const planned = new Set(idsInPlan(plan));
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
      if (required.length === 0) {
        return revisionRequest({
          source: 'plan-requirement-id-check',
          reason: 'requirements note contains no REQ-n ids',
          findings: [{ severity: 'block', evidence: 'Start every requirement line with an id such as REQ-1.' }],
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
  target?: string,
  reviewTarget?: string,
): Job {
  return reviewPanel({
    label,
    reviewers: panelReviewers(config.reviewers, config, reviewTarget),
    concurrency: config.reviewers.length,
    pass: config.reviewThreshold,
    target,
  });
}

function approvalWithMarker(job: Job, workspace: string): Job {
  return async (ctx) => {
    const outcome = await job(ctx);
    if (outcome.status !== 'pass') return outcome;
    const marker = ctx.state[RUN_MARKER];
    if (typeof marker !== 'string' || !marker) {
      return { status: 'fail', summary: 'approve has no run marker' };
    }
    try {
      const approvalPath = join(workspace, APPROVAL_NOTE);
      const note = await readFile(approvalPath, 'utf8');
      if (!note.includes(marker)) {
        return { status: 'fail', summary: 'approval note does not belong to this run' };
      }
    } catch {
      return { status: 'fail', summary: 'approval note could not be read' };
    }
    return outcome;
  };
}

function prepareRun(workspace: string): Job {
  return fnJob('prepare-run', async (ctx): Promise<Outcome> => {
    const approvalPath = join(workspace, APPROVAL_NOTE);
    try {
      await rm(approvalPath, { force: true });
      if (await fileExists(workspace, APPROVAL_NOTE)) {
        return { status: 'fail', summary: 'prepare could not remove the previous approval note' };
      }
    } catch (error) {
      return { status: 'fail', summary: `prepare could not remove the previous approval note: ${String(error)}` };
    }
    const startedAt = new Date().toISOString();
    const marker = `${ctx.runId ?? 'unassigned'}:${startedAt}`;
    ctx.state[RUN_MARKER] = marker;
    ctx.state[RUN_STARTED_AT] = startedAt;
    return { status: 'pass', summary: `prepared run ${marker}` };
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
  return loop({
    name,
    body: failOnUnchangedNote(name.replace(/-loop$/, ''), writer, workspace, note),
    until: noteExists(workspace, note),
    review,
    max: 3,
    maxReviewRestarts: 3,
    noProgress: { window: 2, gate: true },
  });
}

export function featureDelivery(config: FeatureDeliveryConfig) {
  assertTeamInput(config);
  featureInput(config);
  assertReviewers(config.reviewers, config.reviewThreshold);
  assertDistinctSeats([
    config.implement,
    ...config.reviewers.map(({ seat }) => seat),
  ]);
  const maxKickbacks = config.maxKickbacks ?? 1;
  assertKickbacks(maxKickbacks);

  const contextWriter = outputWriter(
    'research-context',
    config.analyse,
    config,
    RESEARCH_CONTEXT_NOTE,
    'Read the workspace and brief, then record the small set of facts needed to plan the change. Do not write implementation or test files.',
    'research-context',
  );
  const contextReview = scopedPanel(
    'research-context-review',
    config,
    'research-context',
    RESEARCH_CONTEXT_NOTE,
  );
  const requirementsWriter = outputWriter(
    'research-requirements',
    config.analyse,
    config,
    RESEARCH_REQUIREMENTS_NOTE,
    `Read ${RESEARCH_CONTEXT_NOTE} and turn it into small testable requirements. Every requirement line must start with an id in the exact form REQ-n. Do not write implementation or test files.`,
    'research-requirements',
  );
  const requirementsReview = scopedPanel(
    'research-requirements-review',
    config,
    'research-requirements',
    RESEARCH_REQUIREMENTS_NOTE,
  );
  const plan = loop({
    name: 'plan-loop',
    body: failOnUnchangedNote(
      'plan',
      outputWriter(
        'plan',
        config.analyse,
        config,
        PLAN_NOTE,
        `Read ${RESEARCH_REQUIREMENTS_NOTE} and write a short executable plan. Every acceptance check must name the REQ-n it covers. Do not write implementation or test files.`,
        'plan',
      ),
      config.workspace,
      PLAN_NOTE,
      true,
    ),
    until: noteExists(config.workspace, PLAN_NOTE),
    review: planRequirementsReview(config.workspace),
    max: 3,
    maxReviewRestarts: 3,
    noProgress: { window: 2, gate: true },
  });
  const planReview = scopedPanel(
    'plan-review',
    config,
    'plan',
    `${RESEARCH_REQUIREMENTS_NOTE} and ${PLAN_NOTE}`,
  );

  const testFiles = new Set(config.testFiles);
  const nonTestFiles = config.files.filter((file) => !testFiles.has(file));
  const testsFirst = requireNoFiles(
    'tests-first',
    requireNonEmptyFiles(
      'tests-first',
      teamAgent(
        'tests-first',
        config.implement,
        config,
        `Read ${PLAN_NOTE} and write the declared tests first. ${expectedFilesPrompt(config.testFiles)} The tests may be red because the implementation does not exist yet. Do not write implementation files.`,
        'tests-first',
      ),
      config.workspace,
      config.testFiles,
    ),
    config.workspace,
    nonTestFiles,
  );
  const testsReview = scopedPanel(
    'tests-review',
    config,
    'tests-first',
    config.testFiles.join(', '),
  );

  const implementation = requireFilesUnchanged(
    'implement',
    requireNonEmptyFiles(
      'implement',
      teamAgent(
        'implement',
        config.implement,
        config,
        (ctx) => [
          `Read ${PLAN_NOTE} and the tests in ${config.testFiles.join(', ')}. Write the implementation files only.`,
          expectedFilesPrompt(config.files.filter((file) => !testFiles.has(file))),
          ctx.lastGate?.output ? `The latest test command output is:\n${ctx.lastGate.output}` : undefined,
          'On a retry, apply every complete review finding before writing again.',
        ].filter(Boolean).join('\n'),
        'implement',
      ),
      config.workspace,
      config.files,
    ),
    config.workspace,
    config.testFiles,
  );
  const implementationLoop = loop({
    name: 'implementation-loop',
    body: implementation,
    until: commandSucceeds(config.test.command, [...config.test.args], {
      cwd: config.workspace,
      timeoutMs: config.test.timeoutMs,
      captureOutput: true,
    }),
    review: scopedPanel(
      'implementation-review',
      config,
      'implement',
      config.files.join(', '),
    ),
    max: 3,
    maxReviewRestarts: 3,
    noProgress: { window: 2, gate: true },
  });

  const approval = approvalWithMarker(
    requireNonEmptyFiles(
      'approve',
      teamAgent(
        'approve',
        config.approve,
        config,
        (ctx) => `Read the brief, plan, implementation, tests, verification result, and review evidence. Write ${APPROVAL_NOTE} with an approval and include the exact marker value ${String(ctx.state[RUN_MARKER] ?? '')} anywhere in the note.`,
      ),
      config.workspace,
      [APPROVAL_NOTE],
    ),
    config.workspace,
  );
  const close = requireNonEmptyFiles('close', fnJob('close-run', async (ctx): Promise<Outcome> => {
    const marker = String(ctx.state[RUN_MARKER] ?? '');
    const startedAt = String(ctx.state[RUN_STARTED_AT] ?? '');
    await mkdir(join(config.workspace, 'team-output'), { recursive: true });
    await writeFile(
      join(config.workspace, EVIDENCE_NOTE),
      [`Run marker: ${marker}`, `Started: ${startedAt}`, 'Verification: passed', `Files: ${config.files.join(', ')}`, ''].join('\n'),
    );
    await writeFile(
      join(config.workspace, LEARNING_NOTE),
      'Keep research, tests, implementation, verification, approval, and evidence as separate stages.\n',
    );
    return { status: 'pass', summary: 'evidence and learning records written' };
  }), config.workspace, [EVIDENCE_NOTE, LEARNING_NOTE]);

  return dag({
    name: 'feature-delivery',
    stopOnError: true,
    maxKickbacks,
    nodes: {
      prepare: {
        job: prepareRun(config.workspace),
        desc: 'Clear any approval left by an earlier run and mark the start of this one.',
        gate: 'No approval note exists and the run marker is recorded.',
        needs: [],
      },
      'research-context': {
        job: researchLoop('research-context-loop', contextWriter, config.workspace, RESEARCH_CONTEXT_NOTE, contextReview),
        desc: 'Read the workspace and write down what the change touches, until a reviewer accepts the note.',
        gate: 'The context note is in the workspace and a reviewer has accepted it.',
        needs: ['prepare'],
      },
      'research-requirements': {
        job: researchLoop('research-requirements-loop', requirementsWriter, config.workspace, RESEARCH_REQUIREMENTS_NOTE, requirementsReview),
        desc: 'Turn the brief and the context note into a numbered list of requirements, until a reviewer accepts it.',
        gate: 'The requirements note is in the workspace and a reviewer has accepted it.',
        needs: ['research-context'],
      },
      plan: {
        job: plan,
        desc: 'Write an executable plan from the requirements, one acceptance check per job.',
        gate: 'The plan is in the workspace and every requirement has a check.',
        needs: ['research-requirements'],
      },
      'plan-review': {
        job: planReview,
        desc: 'Have the reviewers read the plan against the requirements and send it back if it falls short.',
        gate: 'At least the threshold number of reviewers have accepted the plan.',
        needs: ['plan'],
      },
      'tests-first': {
        job: testsFirst,
        desc: 'Write the declared test files from the accepted plan before any implementation exists.',
        gate: 'Every declared test file exists and is not empty.',
        needs: ['plan-review'],
      },
      'tests-review': {
        job: testsReview,
        desc: 'Have the reviewers check that the tests cover the plan and that any red test is red for a stated reason.',
        gate: 'At least the threshold number of reviewers have accepted the tests.',
        needs: ['tests-first'],
      },
      implement: {
        job: implementationLoop,
        desc: "Write the code to the plan and the tests, run the test command, and repeat with the reviewers' findings until it passes.",
        gate: 'The test command exits 0 and the reviewers have accepted the change, within three cycles.',
        needs: ['tests-review'],
      },
      verify: {
        job: teamTest(config),
        desc: 'Run the test command once more on the final files.',
        gate: 'The final test command exits 0.',
        needs: ['implement'],
      },
      approve: {
        job: approval,
        desc: 'Record that the verified change is ready to ship.',
        gate: "An approval note carrying this run's marker is in the workspace.",
        needs: ['verify'],
      },
      close: {
        job: close,
        desc: 'Write the evidence of the run and what was learned, from the record alone.',
        gate: 'The evidence note and the learning note are in the workspace.',
        needs: ['approve'],
      },
    },
  });
}
