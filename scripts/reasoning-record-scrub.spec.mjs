import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { openReasoningRecord } from '@obversa/memory-git';
import { agentJob, fnJob, isolated, run } from '@obversa/runtime';
import { MockEngine } from '@obversa/runtime/testing';

const token = `sk-${'a'.repeat(32)}`;
const chunks = [
  'Chose three retries for sk-aaaa',
  `${'a'.repeat(28)} because upstream calls fail in bursts of two.`,
];

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trimEnd();
}

async function recordedChange(t, { compose, summary } = {}) {
  const repositoryPath = realpathSync(await mkdtemp(join(tmpdir(), 'obversa-reasoning-scrub-')));
  let workspacePath;
  t.after(async () => {
    try {
      // isolated() removes its worktree; this also covers a failed removal.
      if (workspacePath) await rm(workspacePath, { recursive: true, force: true });
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  git(repositoryPath, 'init', '--quiet', '-b', 'main');
  git(repositoryPath, 'config', '--local', 'user.name', 'Reasoning record test');
  git(repositoryPath, 'config', '--local', 'user.email', 'reasoning-record@example.test');
  git(repositoryPath, 'config', '--local', 'commit.gpgsign', 'false');
  git(repositoryPath, 'config', '--local', 'core.hooksPath', join(repositoryPath, '.git', 'no-hooks'));
  writeFileSync(join(repositoryPath, 'README.md'), 'A fixture for recorded changes.\n');
  git(repositoryPath, 'add', 'README.md');
  git(repositoryPath, 'commit', '--quiet', '-m', 'chore: seed fixture');

  const offline = new MockEngine((request) => {
    assert.ok(request.cwd, 'The agent must receive its isolated workspace.');
    const directory = realpathSync(request.cwd);
    assert.notEqual(directory, repositoryPath, 'The agent must write in a separate worktree.');
    const common = git(directory, 'rev-parse', '--git-common-dir');
    assert.equal(realpathSync(resolve(directory, common)), join(repositoryPath, '.git'));
    // Only retain a cleanup path after proving it belongs to this fixture.
    workspacePath = directory;
    writeFileSync(join(directory, 'feature.ts'), 'export const retries = 3;\n');
    return chunks.join('');
  });
  // MockEngine emits one text event. Split it at the engine boundary so the
  // real agent job emits separate text and thinking events to the recorder.
  const engine = {
    name: offline.name,
    run(request, onEvent, signal) {
      return offline.run(request, (event) => {
        if (event.type === 'text') {
          onEvent({ type: 'text', delta: chunks[0] });
          onEvent({ type: 'thinking', delta: chunks[1] });
        } else {
          onEvent(event);
        }
      }, signal);
    },
  };
  const record = openReasoningRecord({ stage: 'implement', compose });
  const author = agentJob({ label: 'author', prompt: 'Set the retry count.' });
  const work = fnJob('write-and-summarise', async (ctx) => {
    const outcome = await author(ctx);
    // The agent's final summary is already scrubbed by the runtime. A plain
    // job supplies this summary after the real write to exercise the fallback.
    return outcome.status === 'pass' && summary !== undefined
      ? { ...outcome, summary }
      : outcome;
  });
  const { outcome } = await run(isolated(work, { label: 'implement', record }), {
    engine,
    cwd: repositoryPath,
    onEvent: (event) => record.observe(event),
  });
  assert.equal(outcome.status, 'pass', outcome.summary);

  const blamed = git(repositoryPath, 'blame', '--porcelain', '-L', '1,1', 'feature.ts')
    .split('\n')[0].split(' ')[0];
  assert.notEqual(blamed, git(repositoryPath, 'rev-parse', 'HEAD'), 'Read the changed-file commit, not the merge tip.');
  assert.equal(git(repositoryPath, 'show', `${blamed}:feature.ts`), 'export const retries = 3;');
  return {
    outcome,
    subject: git(repositoryPath, 'log', '-1', '--format=%s', blamed),
    body: git(repositoryPath, 'log', '-1', '--format=%b', blamed),
  };
}

test('the changed-file commit scrubs the composed subject and joined stream', async (t) => {
  const seen = [];
  const message = await recordedChange(t, {
    compose: ({ captured }) => {
      seen.push(...captured);
      return {
        subject: `feat(implement): tune retries for ${token}`,
        body: `## Why\n\n${captured.map((turn) => turn.text).join('')}`,
      };
    },
  });

  assert.deepEqual(seen, chunks.map((text) => ({ node: 'implement', text })));
  assert.equal(message.subject, 'feat(implement): tune retries for [redacted]');
  assert.equal(message.body, '## Why\n\nChose three retries for [redacted] because upstream calls fail in bursts of two.');
});

test('the changed-file commit scrubs the fallback summary from an ordinary job', async (t) => {
  const summary = `Configured ${token} for three retries because calls fail in bursts of two.`;
  const message = await recordedChange(t, { summary });

  assert.equal(message.outcome.summary, summary, 'The fallback must receive the unsanitised job summary.');
  assert.equal(message.subject, 'record(implement): Configured [redacted] for three retries because calls fail in bursts of two.');
  assert.equal(message.body, [
    '## Why',
    '',
    'Composition left no message, so this is the deterministic floor: the',
    'stage ended pass with 2 captured turns. The reasoning for this',
    'change was not composed, and the outcome above is what the record can',
    'state.',
  ].join('\n'));
});
