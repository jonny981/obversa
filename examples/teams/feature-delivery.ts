import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex';
import { run } from '@obversa/runtime';
import { fromFile, person, stage, workflow } from '@obversa/teams';

/**
 * A feature, delivered the way a team delivers one. The roles are named once;
 * every stage is a small block of nouns: who does it, what it writes, who
 * reads it, where a red result goes back to. Inference happens only where a
 * role is named; every other stage is a command or a person.
 */
const team = workflow('feature-delivery', {
  brief: fromFile('briefs/triple.md'),
  options: { timeout: '10m' },

  roles: {
    analyse: claude('claude-sonnet-4-5'),
    implement: codex('gpt-5.6-luna'),
    'research-review': [codex('gpt-5.6-luna')],
    'code-review': [claude('claude-sonnet-4-5')],
    approve: person('Ship this change?'),
  },

  stages: [
    stage('research-context', {
      agent: 'analyse',
      writes: 'team-output/research-context.md',
      desc: 'Read the workspace and write down what the change touches.',
      gate: 'The context note is in the workspace and a reviewer has accepted it.',
      reviewedBy: 'research-review',
      retry: 3,
    }),

    stage('research-requirements', {
      agent: 'analyse',
      writes: 'team-output/research-requirements.md',
      desc: 'Turn the brief and the context note into requirements, one REQ-n per line.',
      gate: 'The requirements note is in the workspace and a reviewer has accepted it.',
      reviewedBy: 'research-review',
      retry: 3,
    }),

    stage('plan', {
      agent: 'analyse',
      writes: 'team-output/plan.md',
      desc: 'Write an executable plan from the requirements, one check per REQ-n.',
      gate: 'Every requirement has a check in the plan.',
      reviewedBy: 'research-review',
      retry: 3,
    }),

    stage('tests-first', {
      agent: 'implement',
      writes: 'test/triple.test.mjs',
      desc: 'Write the declared test files from the accepted plan before any implementation exists.',
      gate: 'Every declared test file exists and covers the plan.',
      reviewedBy: 'code-review',
      retry: 3,
    }),

    stage('implement', {
      agent: 'implement',
      writes: 'src/triple.mjs',
      desc: 'Write the code to the plan and the tests.',
      gate: 'The source file exists.',
      retry: 3,
    }),

    stage('test', {
      run: ['node', '--test', 'test/triple.test.mjs'],
      desc: 'Run the tests; a red run goes back to implement with the output.',
      gate: 'The test command exits 0.',
      sendsBackTo: 'implement',
    }),

    stage('review', {
      panel: 'code-review',
      agree: 1,
      desc: 'Read the change and the test result against the plan.',
      gate: 'At least one reviewer has accepted the change.',
      sendsBackTo: 'implement',
    }),

    stage('approve', {
      input: 'approve',
      desc: 'Put the verified change in front of a person.',
      gate: 'A person has said yes.',
    }),

    stage('close', {
      agent: 'analyse',
      writes: ['team-output/evidence.md', 'team-output/learning.md'],
      desc: 'Write the evidence of the run and what was learned, from the record alone.',
      gate: 'Both notes are in the workspace.',
    }),
  ],

});

const result = await run(team);
console.log(JSON.stringify(result.outcome, null, 2));
