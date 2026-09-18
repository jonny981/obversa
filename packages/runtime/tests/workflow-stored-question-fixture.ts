import { createStoredCallbackClient, person, run, stage, workflow } from '../src/api.js';
import { openStoredRunFixtureStorage } from './stored-run-fixture.js';

export function storedQuestionJob() {
  return workflow('one-question', {
    brief: 'Ask before proceeding.',
    roles: { approve: person('Proceed?') },
    stages: [stage('approve', { input: 'approve' })],
  });
}

if (process.argv[2] === '--resume-stored-question') {
  const [directory, runId, cwd, recordPath] = process.argv.slice(3);
  if (!directory || !runId || !cwd || !recordPath) throw new Error('missing stored question fixture input');
  const storage = openStoredRunFixtureStorage('f42-stored-question', directory);
  const callbacks = await createStoredCallbackClient(storage, runId);
  const result = await run(storedQuestionJob(), { cwd, recordTo: recordPath, resume: true, callbacks });
  if (result.outcome.status !== 'paused') throw new Error(`expected paused, got ${result.outcome.status}`);
}
