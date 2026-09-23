// Live Jev probe for Jonny — the only file in this package that may touch the
// real endpoint. It is an experiment, not a production routing example: it
// asks the three sanitized review questions and prints what the provider
// answers now. Run it with the credential already in your environment:
//
//   node plugins/engine-jev-api/scripts/probe.mjs
//
// It reads TYPESAFE_API_KEY from the environment your configuration already
// supplies. The three cases are sanitized review payloads. Every case runs
// even when one fails; the script exits nonzero if any case failed.

import { JevApiEngine } from '../dist/index.js';

const key = process.env.TYPESAFE_API_KEY;
if (!key) {
  console.error('TYPESAFE_API_KEY is not set in this environment.');
  process.exit(1);
}

const engine = new JevApiEngine({
  endpoint: process.env.JEV_ENDPOINT ?? 'https://api.typesafe.ai/v1/systemone',
  apiKey: key,
  adapterVersion: '0.1.0',
});

const questions = {
  send_back: {
    type: 'noul',
    instructions: 'Should this work be sent back to the stage that wrote it, rather than accepted?',
    criteria: { true: 'A finding describes incorrect behaviour a user would see', false: 'The findings are cosmetic or advisory only' },
  },
  which_stage: {
    type: 'choice',
    instructions: 'Which stage should the work go back to?',
    criteria: {
      implement: 'The defect is in the code itself',
      test: 'The code is right but the tests do not prove it',
      document: 'Only the written description is wrong',
      none: 'Nothing needs to go back',
    },
  },
  readiness: {
    type: 'score',
    instructions: 'How ready is this change to land on the main branch?',
    criteria: ['Unsafe to land', 'Needs another round', 'Lands with residuals recorded', 'Lands clean'],
  },
};

const cases = {
  'REJECTED': {
    stage: 'review',
    brief: 'Add a webhook notifier that posts one message per interesting run event.',
    diff: '27 files changed, +1456/-11. New package with 351 lines of source and 478 of tests.',
    findings: [
      'A loop iteration is mistaken for the run ending: a five-iteration loop posts "Run finished." after the first pass and the real failure is suppressed.',
      'The new package has no dependency-direction rule, so its claim to import nothing from the repository is enforced by nobody.',
    ],
    testsPassing: true,
    mutationsRed: '16 of 16',
  },
  'ACCEPTED': {
    stage: 'review',
    brief: 'Repair the notifier so the container owning a run decides what the run is.',
    diff: '2 files changed, +55/-21. One predicate replaces three separate depth conditions.',
    findings: [],
    notes: 'Both review seats accepted with zero blocking findings. 41 tests. 11 of 11 mutations fail the suite.',
    testsPassing: true,
    mutationsRed: '11 of 11',
  },
  'ADVISORIES ONLY': {
    stage: 'review',
    brief: 'Emit run-level start and end events so a consumer stops inferring the run from containers.',
    diff: '9 files changed. Two new event kinds, one pin, one page row, one changelog line.',
    findings: [
      'Advisory: the compile-time compatibility claim is broader than what the check actually proves.',
      'Advisory: one test never reaches the guard it is named for.',
      'Advisory: a documentation page repeats prose that appears elsewhere.',
    ],
    notes: 'No blocking findings from either seat. Every advisory is about wording or test reach, not behaviour.',
    testsPassing: true,
    mutationsRed: '10 of 10',
  },
};

let failures = 0;
for (const [label, state] of Object.entries(cases)) {
  const started = Date.now();
  let result;
  try {
    result = await engine.run(
      {
        prompt: JSON.stringify({ state, questions }),
        model: 'jev-latest',
        workspaceMode: 'none',
        timeoutMs: 30_000,
      },
      () => {},
      new AbortController().signal,
    );
  } catch (error) {
    failures += 1;
    console.error(`${label}  FAILED  ${error.kind ?? error.name}: ${error.message}`);
    continue;
  }
  const ms = Date.now() - started;
  const answers = result.parts.find((part) => part.kind === 'structured')?.value ?? {};
  const usage = result.usage.kind === 'reported'
    ? `in ${result.usage.inputTokens} / out ${result.usage.outputTokens} tok`
    : 'usage unreported';
  console.log(`\n${label}   ${ms}ms   ${usage}   effective model ${result.effective.model ?? '(none echoed)'}`);
  for (const [id, a] of Object.entries(answers)) {
    const value = a.type === 'noul' ? a.noul : a.type === 'choice' ? a.choice : a.score;
    console.log(`  ${id.padEnd(12)} ${String(a.type).padEnd(7)} ${String(value).padEnd(22)} confidence ${a.confidence ?? '-'}`);
    if (a.probabilities) console.log(`    ${JSON.stringify(a.probabilities)}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} of ${Object.keys(cases).length} cases failed`);
  process.exitCode = 1;
}
