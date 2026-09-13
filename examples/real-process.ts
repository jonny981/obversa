import { ClaudeCliEngine } from '@obversa/engine-claude-cli';
import { CodexEngine } from '@obversa/engine-codex';
import {
  agentJob,
  commandSucceeds,
  createCallbackGate,
  dag,
  fnJob,
  gateJob,
  loop,
  predicate,
  reviewPanel,
  run,
  team,
  type Job,
  type Engine,
  type TeamAgent,
} from '@obversa/runtime';
import { outcomeFromAgentText } from '@obversa/teams';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const workspace = process.cwd();
const BRIEF = 'Deliver src/result.mjs exporting result = 23 with a Node test that proves it.';
const output = join(workspace, 'team-output', 'real-process');
const CONTEXT_NOTE = join(output, 'research-context.md');
const REQUIREMENTS_NOTE = join(output, 'research-requirements.md');
const PLAN_NOTE = join(output, 'plan.md');
const TEST_FILE = join(output, 'tests', 'acceptance.test.mjs');
const SOURCE_FILE = join(output, 'src', 'result.mjs');
const LEARNING_NOTE = join(output, 'learning.md');
const SOURCE_LOAD_ARGS = [
  '--import',
  'tsx',
  '--input-type=module',
  '--eval',
  `import(${JSON.stringify(SOURCE_FILE)})`,
];

function depthValue(value: string | undefined): number {
  const depth = Number.parseInt(value ?? '1', 10);
  return Number.isInteger(depth) && depth >= 1 && depth <= 4 ? depth : 1;
}

const frozen = Object.freeze({
  depth: depthValue(process.env.OBVERSA_PROCESS_DEPTH),
  credentialNames: ['OBVERSA_API_KEY', 'OBVERSA_DEPLOY_TOKEN']
    .filter((name) => Boolean(process.env[name])),
  actionEnabled: process.env.OBVERSA_TARGET_ACTION === '1',
  deploymentTarget: process.env.OBVERSA_DEPLOYMENT_TARGET?.trim() || null,
  ciSource: process.env.OBVERSA_CI_CHECK_SOURCE?.trim() || null,
  decisionSource: process.env.OBVERSA_DECISION_SOURCE_NAME?.trim() || null,
});

const skipReasons = Object.freeze({
  research: frozen.depth < 2 ? 'process depth is below 2' : null,
  target: !frozen.actionEnabled || !frozen.deploymentTarget ? 'target action is not enabled or has no target' : null,
  ci: !frozen.ciSource ? 'no CI check source is named' : null,
  planReview: !frozen.decisionSource ? 'no plan decision source is named' : null,
  promotion: !frozen.decisionSource ? 'no promotion decision source is named' : null,
});

const claude = new ClaudeCliEngine({ defaultModel: 'claude-sonnet-4-5', permissionMode: 'bypassPermissions' });
const codex = new CodexEngine({ defaultModel: 'gpt-5.6-luna', permissionMode: 'bypassPermissions' });

export interface ReportPanelEngines {
  readonly architecture: Engine;
  readonly correctness: Engine;
  readonly adversary: Engine;
  readonly conformance: Engine;
}

const reportPanelEngines: ReportPanelEngines = {
  architecture: claude,
  correctness: codex,
  adversary: codex,
  conformance: claude,
};

function writeRecord(label: string, text: string): Job {
  return fnJob(label, async () => {
    await mkdir(output, { recursive: true });
    await writeFile(join(output, `${label}.md`), `${text}\n`);
    return { status: 'pass', summary: `${label} recorded` };
  });
}

function agentLeaf(label: string, engine: Engine, instruction: string): Job {
  return agentJob({
    label,
    engine,
    cwd: workspace,
    prompt: `${BRIEF}\n\n${instruction}\nReturn a short completion report.`,
  });
}

function agentFile(label: string, engine: Engine, instruction: string, file: string): Job {
  const job = agentLeaf(label, engine, `${instruction}\nWrite the complete non-empty output to ${relative(workspace, file)}.`);
  return async (ctx) => {
    const outcome = await job(ctx);
    if (outcome.status !== 'pass') return outcome;
    try {
      const details = await stat(file);
      if (!details.isFile() || details.size === 0) {
        return { status: 'fail', summary: `${label} did not write a non-empty ${file}` };
      }
    } catch {
      return { status: 'fail', summary: `${label} did not write ${file}` };
    }
    return outcome;
  };
}

function commandStage(label: string, args: string[], text: string): Job {
  const command = gateJob(label, commandSucceeds('node', args, {
    cwd: workspace,
    captureOutput: true,
  }));
  return async (ctx) => {
    const outcome = await command(ctx);
    if (outcome.status !== 'pass') return outcome;
    await mkdir(output, { recursive: true });
    await writeFile(join(output, `${label}.md`), `${text}\n`);
    return outcome;
  };
}

export function reportPanel(
  label: string,
  target?: string,
  lensCount: 2 | 4 = 2,
  engines: ReportPanelEngines = reportPanelEngines,
): Job {
  const reviewPrompt = 'Return one JSON object: {"status":"pass"|"revise","summary":"...","findings":[{"evidence":"..."}]}';
  const reviewer = (reviewerLabel: string, engine: Engine, instruction: string): Job => agentJob({
    label: reviewerLabel,
    engine,
    cwd: workspace,
    prompt: `${BRIEF}\n\n${instruction}\n${reviewPrompt}`,
    outcome: (text) => outcomeFromAgentText(text, target),
  });
  const reviewers = [
    {
      name: 'architecture',
      scope: 'process shape',
      job: reviewer(`${label}-architecture`, engines.architecture, 'Check the process shape and its stage boundaries.'),
    },
    {
      name: 'correctness',
      scope: 'evidence',
      job: reviewer(`${label}-correctness`, engines.correctness, 'Check that the evidence supports the stage gate.'),
    },
  ];
  if (lensCount === 4) {
    reviewers.push(
      {
        name: 'adversary',
        scope: 'failure paths',
        job: reviewer(`${label}-adversary`, engines.adversary, 'Try to find a concrete failure path the process does not cover.'),
      },
      {
        name: 'conformance',
        scope: 'public contract',
        job: reviewer(`${label}-conformance`, engines.conformance, 'Check the result against the public contract and its promised evidence.'),
      },
    );
  }
  return reviewPanel({
    label,
    reviewers,
    concurrency: lensCount,
    pass: lensCount === 4 ? 3 : 2,
    target,
  });
}

function optional(condition: boolean, reason: string) {
  return predicate(() => condition, reason);
}

function callbackStage(label: string, decisionText: string): Job {
  const source = frozen.decisionSource;
  if (!source) return fnJob(label, async () => ({ status: 'pass', summary: `skipped: ${label}: ${skipReasons[label === 'plan-review' ? 'planReview' : 'promotion']}` }));
  const request = createCallbackGate({
    gateId: `real-process-${label}`,
    gateVersion: 1,
    decisionText,
    responseSchema: {
      type: 'object',
      properties: { approved: { type: 'boolean' } },
      required: ['approved'],
    },
    input: { decisionSource: source, processDepth: frozen.depth },
  });
  const decisionAgent: TeamAgent = {
    name: `${label}-context`,
    role: 'Prepare the callback question without deciding it.',
    brief: decisionText,
    engine: claude,
  };
  return team({
    task: decisionText,
    agents: [decisionAgent],
    review: { kind: 'callback', definition: {
      gateId: request.gateId,
      gateVersion: request.gateVersion,
      decisionText: request.decisionText,
      responseSchema: request.responseSchema,
      input: request.input,
    } },
  });
}

const implementation = loop({
  name: 'implementation-loop',
  body: agentFile('implementation', codex, `Implement the accepted plan in the supplied workspace. The source file is ${relative(workspace, SOURCE_FILE)}.`, SOURCE_FILE),
  until: commandSucceeds('node', ['--test', TEST_FILE], { cwd: workspace, captureOutput: true }),
  review: reportPanel('implementation-review', 'implementation', 4),
  max: 3,
  maxReviewRestarts: 3,
  noProgress: { window: 2, gate: true },
});

const ciFix = loop({
  name: 'ci-fix-loop',
  body: agentLeaf('ci-fix-worker', codex, 'Repair the named failing CI check without changing unrelated work.'),
  until: commandSucceeds('node', ['--test', TEST_FILE], { cwd: workspace, captureOutput: true }),
  review: reportPanel('ci-fix-review', 'ci-fix'),
  max: 3,
  maxReviewRestarts: 3,
  noProgress: { window: 2, gate: true },
});

const graph = dag({
  name: 'real-process',
  stopOnError: true,
  nodes: {
    preconditions: { job: commandStage('preconditions', ['--version'], `Node ${process.version} is available.`), desc: 'Check the local tools and files the process needs before anything runs.', gate: 'Every precondition holds.', needs: [] },
    'credential-scan': { job: writeRecord('credential-scan', `Depth: ${frozen.depth}\nCredential names present: ${frozen.credentialNames.join(', ') || 'none'}.`), desc: 'Read which credentials exist by name, never by value, and set how deep the run may go.', gate: 'The depth of the run is recorded.', needs: ['preconditions'] },
    'research-context': { job: agentFile('research-context', claude, 'Read the workspace and write down what the change touches.', CONTEXT_NOTE), desc: 'Read the workspace and write down what the change touches.', gate: 'The context note is in the workspace.', when: optional(frozen.depth >= 2, 'research requires process depth 2'), needs: ['credential-scan'] },
    'research-requirements': { job: agentFile('research-requirements', claude, 'Turn the brief and the context note into a numbered list of requirements.', REQUIREMENTS_NOTE), desc: 'Turn the brief and the context note into a numbered list of requirements.', gate: 'The requirements note is in the workspace.', when: optional(frozen.depth >= 2, 'requirements require process depth 2'), needs: ['research-context'] },
    'research-review': { job: reportPanel('research-review'), desc: 'Have two reviewers read the research notes against the brief.', gate: 'Both reviewers have accepted the research.', when: optional(frozen.depth >= 2, 'research review requires process depth 2'), needs: ['research-requirements'] },
    plan: { job: agentFile('plan', claude, 'Write an executable plan from the requirements, one acceptance check per job.', PLAN_NOTE), desc: 'Write an executable plan from the requirements, one acceptance check per job.', gate: 'The plan is in the workspace and every requirement has a check.', needs: ['research-review'] },
    'plan-review': { job: callbackStage('plan-review', 'Approve the executable process plan?'), desc: 'Put the plan in front of a person when one is configured; otherwise record that no person was asked.', gate: 'A person has accepted the plan, or the skip is recorded with its reason.', when: optional(Boolean(frozen.decisionSource), skipReasons.planReview ?? 'plan decision source is named'), needs: ['plan'] },
    'tests-first': { job: agentFile('tests-first', codex, `Write the tests from the accepted plan before any implementation exists. The test file must import ${relative(workspace, SOURCE_FILE)} and assert the declared result.`, TEST_FILE), desc: 'Write the tests from the accepted plan before any implementation exists.', gate: 'Every declared test file exists and is not empty.', needs: ['plan-review'] },
    'tests-review': { job: reportPanel('tests-review'), desc: 'Have two reviewers check that every test names the acceptance it proves.', gate: 'Both reviewers have accepted the tests.', needs: ['tests-first'] },
    implementation: { job: implementation, desc: 'Write the code, run the tests, and repeat with the reviewers\' findings until it passes.', gate: 'The test command exits 0 and the reviewers have accepted, within three cycles.', needs: ['tests-review'] },
    conformance: { job: commandStage('conformance', ['--test', TEST_FILE], 'The declared process contract was checked.'), desc: 'Run the checks that prove the change keeps its declared contract.', gate: 'Every conformance check exits 0.', needs: ['implementation'] },
    boundary: { job: commandStage('boundary', ['--check', SOURCE_FILE], 'The source parse check completed.'), desc: 'Run a source parse check as the example stand-in for dependency and formatting checks.', gate: 'The source parse check exits 0.', needs: ['conformance'] },
    build: { job: commandStage('build', SOURCE_LOAD_ARGS, 'The source load check completed.'), desc: 'Run a source load check as the example stand-in for the build.', gate: 'The source load check exits 0.', needs: ['boundary'] },
    'candidate-review': { job: reportPanel('candidate-review', undefined, 4), desc: 'Have the reviewers read the built change, each through its own lens.', gate: 'At least the threshold number of reviewers have accepted the candidate.', needs: ['build'] },
    'promotion-gate': { job: callbackStage('promotion-gate', 'Promote the accepted result to the named target?'), desc: 'Put the candidate in front of a person before any action on a target; otherwise record that no person was asked.', gate: 'A person has approved the promotion, or the skip is recorded with its reason.', when: optional(Boolean(frozen.decisionSource), skipReasons.promotion ?? 'promotion decision source is named'), needs: ['candidate-review'] },
    'observe-action': { job: writeRecord('observe-action', `Observed target: ${frozen.deploymentTarget ?? 'none'}.`), desc: 'Take the one configured action against the target and record what was observed.', gate: 'The action ran and its observation is recorded, or the stage is skipped for lack of a target.', when: optional(Boolean(frozen.actionEnabled && frozen.deploymentTarget), skipReasons.target ?? 'target action is configured'), needs: ['promotion-gate'] },
    'revert-action': { job: writeRecord('revert-action', 'Reverted the observed action.'), desc: 'Undo the observed action at once.', gate: 'The target is back in its prior state, or the stage is skipped with the action.', when: optional(Boolean(frozen.actionEnabled && frozen.deploymentTarget), skipReasons.target ?? 'target action is configured'), needs: ['observe-action'] },
    'deployed-conformance': { job: commandStage('deployed-conformance', ['--test', TEST_FILE], 'The observed target matched the declared contract.'), desc: 'Run the conformance checks against the target.', gate: 'Every check exits 0, or the stage is skipped for lack of a target.', when: optional(Boolean(frozen.deploymentTarget), 'deployed conformance needs a target'), needs: ['revert-action'] },
    'ci-watch': { job: fnJob('ci-watch', async (ctx) => { const source = frozen.ciSource; if (!source) return { status: 'pass', summary: 'skipped: no CI check source' }; try { const report = await readFile(source, 'utf8'); const failed = /failed|failure|red/i.test(report); ctx.state.ciFailed = failed; await mkdir(output, { recursive: true }); await writeFile(join(output, 'ci-watch.md'), report); return { status: 'pass', summary: failed ? 'CI failure recorded for repair' : 'CI checks are green' }; } catch (error) { return { status: 'fail', summary: `CI check source could not be read: ${String(error)}` }; } }), desc: 'Read the configured check source for the change.', gate: 'The checks are green, a failure is recorded for repair, or the stage is skipped for lack of a source.', when: optional(Boolean(frozen.ciSource), skipReasons.ci ?? 'CI check source is named'), needs: ['deployed-conformance'] },
    'ci-fix': { job: ciFix, desc: 'Repair a real failing check, run it again, and repeat with the reviewers\' findings until it passes.', gate: 'The failing check is green within three cycles, or the stage is skipped because none failed.', when: predicate((ctx) => ctx.state.ciFailed === true, 'a failing CI check was recorded'), needs: ['ci-watch'] },
    evidence: { job: fnJob('evidence', async (ctx) => { await mkdir(output, { recursive: true }); await writeFile(join(output, 'evidence.json'), JSON.stringify({ frozen, skipped: skipReasons, commands: ['node --test acceptance.test.mjs', 'node --check result.mjs'], ciFailureWasRecorded: ctx.state.ciFailed === true }, null, 2)); return { status: 'pass', summary: 'evidence recorded' }; }), desc: 'Write the commands run, their results, and every skipped stage with its reason.', gate: 'The evidence record is in the workspace.', needs: ['ci-fix'] },
    learning: { job: agentFile('learning', claude, 'Write down what this run taught that the next one should know.', LEARNING_NOTE), desc: 'Write down what this run taught that the next one should know.', gate: 'The learning note is in the workspace.', needs: ['evidence'] },
    close: { job: fnJob('close', async () => { try { const evidence = await stat(join(output, 'evidence.json')); const learning = await stat(LEARNING_NOTE); return evidence.size > 0 && learning.size > 0 ? { status: 'pass', summary: 'evidence and learning are on disk' } : { status: 'fail', summary: 'evidence or learning is empty' }; } catch { return { status: 'fail', summary: 'evidence or learning is missing' }; } }), desc: 'Confirm the evidence and the learning are on disk.', gate: 'Both files exist and are not empty.', needs: ['learning'] },
  },
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run(graph, { cwd: workspace });
  console.log(JSON.stringify(result.outcome, null, 2));
  if (result.outcome.status !== 'pass') process.exitCode = 1;
}
