import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openReasoningRecord } from '@obversa/memory-git';
import { agentJob, isolated, loop, predicate, run } from '@obversa/runtime';
import { MockEngine } from '@obversa/runtime/testing';

const repositoryPath = await mkdtemp(join(tmpdir(), 'obversa-reasoning-record-'));

try {
  execFileSync('git', ['init', '--quiet', '-b', 'main', repositoryPath]);
  execFileSync('git', ['-C', repositoryPath, 'config', 'user.email', 'example@obversa.ai']);
  execFileSync('git', ['-C', repositoryPath, 'config', 'user.name', 'Obversa example']);
  // This repository is a scratch one made for the example. Signing is a
  // property of the machine that runs it, not of what is being shown, and a
  // signing prompt has nowhere to go here.
  execFileSync('git', ['-C', repositoryPath, 'config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repositoryPath, 'README.md'), 'A repository for the stage to work in.\n');
  execFileSync('git', ['-C', repositoryPath, 'add', 'README.md']);
  execFileSync('git', ['-C', repositoryPath, 'commit', '--quiet', '-m', 'chore: start the repository']);

  let wrote = false;
  // A real engine writes files and narrates while it works. The stand-in does
  // both, so the stage has a change for its reasoning to ride on.
  const engine = new MockEngine((request) => {
    writeFileSync(join(request.cwd ?? repositoryPath, 'feature.ts'), 'export const retries = 3;\n');
    wrote = true;
    return 'Chose three retries because the upstream call fails in bursts of two.';
  });

  const record = openReasoningRecord({
    stage: 'implement',
    compose: ({ captured }) => ({
      // The subject deliberately does not repeat the writer's words. If it
      // did, the check at the end of this file would be satisfied by the
      // subject line alone and would say nothing about whether the reasoning
      // was captured at all.
      subject: 'feat(implement): set the retry count',
      body: ['## Why', '', ...captured.map((turn) => turn.text)].join('\n'),
    }),
  });

  // The stage is a loop, which is the ordinary shape: the writer's turns
  // arrive one segment deeper than the stage that opted in.
  const stage = isolated(
    loop({
      name: 'write',
      max: 2,
      body: agentJob({ label: 'author', engine: 'offline', prompt: 'Set the retry count.' }),
      until: predicate(() => wrote, 'the feature file exists'),
    }),
    { label: 'implement', record },
  );

  const { outcome } = await run(stage, {
    engine: 'offline',
    engines: { offline: engine },
    cwd: repositoryPath,
    // The second wire: the record only sees what the run is told to show it.
    onEvent: (event) => record.observe(event),
  });

  if (outcome.status !== 'pass') {
    throw new Error(`The stage did not pass: ${outcome.summary ?? outcome.status}`);
  }

  // Ask the way a reader would: blame the changed line, then read the body of
  // the commit that line came from. The branch tip is the merge, so reading
  // the last commit would prove nothing.
  const blamed = execFileSync(
    'git', ['-C', repositoryPath, 'blame', '--porcelain', '-L', '1,1', 'feature.ts'],
    { encoding: 'utf8' },
  ).split('\n')[0]!.split(' ')[0]!;
  const body = execFileSync(
    'git', ['-C', repositoryPath, 'log', '-1', '--format=%B', blamed],
    { encoding: 'utf8' },
  );

  // Read below the subject line: the reasoning has to be in the body, put
  // there by what the record captured, not by anything the subject repeats.
  const reasoning = body.split('\n').slice(1).join('\n');
  if (!reasoning.includes('bursts of two')) {
    throw new Error(`The commit that carries the change has no reasoning on it:\n${body}`);
  }

  console.log(body.trim());
} finally {
  await rm(repositoryPath, { recursive: true, force: true });
}
