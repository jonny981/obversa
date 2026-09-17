import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex';
import { resolveCommandExecutable } from '@obversa/engine/command';
import { opencode } from '@obversa/engine-opencode-cli';
import { formatEvent, run } from '@obversa/runtime';
import { fromFile, person, stage, workflow, type TeamSeat } from '@obversa/teams';

interface ArchitectureEngines {
  readonly claude: (model: string) => TeamSeat;
  readonly codex: (model: string) => TeamSeat;
  readonly opencode: (model: string) => TeamSeat;
}

const realEngines: ArchitectureEngines = {
  claude,
  codex,
  opencode: (model) => opencode(model, {
    executable: resolveCommandExecutable('opencode'),
  }),
};

/**
 * Architecture, then a spike, then the team decides. Coding begins after
 * the team agrees what is being built, not before. One model researches
 * and writes the spec, each note read by a model from another family; the
 * same seat writes the smallest program that proves the risky part, and
 * the program has to run. Then a panel of two other families reads the
 * spec, the spike and its result the way a design review would, and a
 * rejection goes back to the design, never to the code. A person says
 * build it.
 */
function createArchitectureThenSpike(engines: ArchitectureEngines = realEngines) {
  return workflow('architecture-then-spike', {
    brief: fromFile('briefs/idea.md'),
    options: { timeout: '15m' },

    roles: {
      architect: engines.claude('claude-sonnet-4-5'),
      'design-review': [engines.codex('gpt-5.6-luna')],
      team: [engines.codex('gpt-5.6-luna'), engines.opencode('opencode/big-pickle')],
      lead: person('Build this for real?'),
    },

    stages: [
      stage('research', {
        agent: 'architect',
        writes: 'design/research.md',
        desc: 'Read the brief; write what exists today, the constraints, and two or three ways this could be built with what each costs.',
        gate: 'A reviewer from another family has accepted the note.',
        reviewedBy: 'design-review',
        retry: 2,
      }),

      stage('design', {
        agent: 'architect',
        writes: 'design/spec.md',
        desc: 'Choose one way and write the spec: the shape, the data, the failure cases, and the one thing a spike must prove before the team commits.',
        gate: 'The spec names what the spike must prove and a reviewer has accepted it.',
        reviewedBy: 'design-review',
        retry: 3,
      }),

      stage('spike', {
        agent: 'architect',
        writes: ['poc/index.mjs', 'poc/README.md'],
        desc: 'Write the smallest program that proves what the spec says must be proved, and a README that says what it proves and how it is run.',
        gate: 'The program and its README exist.',
        retry: 2,
      }),

      stage('spike-runs', {
        run: ['node', 'poc/index.mjs'],
        desc: 'Run the spike; a red run goes back to the spike with its output.',
        gate: 'The spike exits 0.',
        sendsBackTo: 'spike',
      }),

      stage('team-review', {
        panel: 'team',
        agree: 2,
        desc: 'Read the spec, the spike and its result the way the team would in a design review.',
        gate: 'Both reviewers accept; a rejection goes back to the design, not to the code.',
        sendsBackTo: 'design',
      }),

      stage('decide', {
        input: 'lead',
        desc: 'Put the accepted design and the spike in front of the person who owns the roadmap.',
        gate: 'A person has said build it.',
      }),
    ],
  });
}

const result = await run(createArchitectureThenSpike(), {
  onEvent: (event) => console.log(formatEvent(event)),
});
console.log(JSON.stringify(result.outcome, null, 2));
