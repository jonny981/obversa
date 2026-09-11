/**
 * A small team in DAG form. Each stage says what it does and what done means.
 * It runs offline, so the example needs no model or network.
 */
import {
  dag,
  fnJob,
  jobMeta,
  renderPlan,
  run,
  type Outcome,
} from '@obversa/runtime';

function stage(name: string, summary: string) {
  return fnJob(name, async (): Promise<Outcome> => ({
    status: 'pass',
    summary,
  }));
}

const describedTeam = dag({
  name: 'described-team',
  nodes: {
    brief: {
      desc: 'Turn the request into a short delivery brief.',
      gate: 'The brief names the user, outcome, and constraints.',
      job: stage('brief', 'brief ready'),
    },
    build: {
      needs: 'brief',
      desc: 'Build the smallest useful change from the brief.',
      gate: 'The change meets the brief and its checks pass.',
      job: stage('build', 'change built'),
    },
    review: {
      needs: 'build',
      desc: 'Check the change before it reaches the user.',
      gate: 'The change is safe to release and easy to explain.',
      job: stage('review', 'review complete'),
    },
  },
});

const result = await run(describedTeam);
const report = {
  plan: renderPlan(jobMeta(describedTeam)).join('\n'),
  status: result.outcome.status,
};
console.log(JSON.stringify(report, null, 2));

if (result.outcome.status !== 'pass') process.exitCode = 1;
