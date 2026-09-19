import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { approval, dag, person, stage, withEnv, workflow } from '../src/api.ts';

export function publicGate(wrapped = false) {
  const gate = approval('approve', { question: 'Send the prepared result?' });
  return dag({
    name: 'public-gate',
    nodes: {
      approve: wrapped ? withEnv({ CALLBACK_TEST: 'gate' }, gate) : gate,
      send: {
        needs: 'approve',
        job: async (ctx) => {
          await writeFile(join(ctx.workspace.dir, 'sent.txt'), 'sent\n');
          return { status: 'pass' };
        },
      },
    },
  });
}

export function delivery() {
  return workflow('delivery', {
    brief: 'Prepare once and ask before sending.',
    roles: { reviewer: person('Send the prepared result?') },
    stages: [
      stage('prepare', {
        run: [process.execPath, '-e', "require('node:fs').appendFileSync('prepared.txt', 'prepared\\n')"],
        writes: 'prepared.txt',
      }),
      stage('approve', { input: 'reviewer' }),
      stage('send', {
        run: [process.execPath, '-e', "require('node:fs').writeFileSync('sent.txt', 'sent\\n')"],
        writes: 'sent.txt',
      }),
    ],
  });
}

export function deployment() {
  return workflow('deploy', {
    brief: 'Deploy the release.',
    roles: {},
    stages: [stage('deploy', {
      run: [process.execPath, '-e', "require('node:fs').appendFileSync('deployments.txt', 'deployed\\n')"],
    })],
  });
}
