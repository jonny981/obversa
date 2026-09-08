import { describe, it, expect, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';

import {
  run,
  fnJob,
} from '../src/api.ts';
import type { RunOptions, AgentRequest } from '../src/api.ts';
import { commit, stageAll } from '../src/core/git.ts';
import {
  mergeSynthesis,
  type MergeSynthesisResult,
} from '../src/core/merge.ts';
import { MockEngine } from '../src/testing.ts';
import { tmpRepo, write, cleanupRepos } from './git-helpers.ts';

// Real work: these tests create temporary Git repositories and write files
// to disk, so this file declares its own time limit; the suite default is a
// hang guard, not a speed bar.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

afterAll(cleanupRepos);

const synthMock = () =>
  new MockEngine((req: AgentRequest) => {
    if (/Resolve this git merge conflict/i.test(req.prompt))
      return 'RESOLVED MERGED CONTENT\n';
    if (/MERGE SYNTHESIS/i.test(req.prompt))
      return 'Reconciled the cand and main approaches into one coherent path.';
    return '';
  });

async function headMessage(repo: string): Promise<{ subject: string; body: string }> {
  const { stdout: subject } = await execa('git', ['show', '-s', '--format=%s', 'HEAD'], {
    cwd: repo,
  });
  const { stdout: body } = await execa('git', ['show', '-s', '--format=%b', 'HEAD'], {
    cwd: repo,
  });
  return { subject, body };
}

/** Run mergeSynthesis inside a job so it gets a real JobContext + engine. */
async function landSynthesis(repo: string, branch: string) {
  let result: MergeSynthesisResult | undefined;
  const opts: RunOptions = {
    engine: 'mock',
    engines: { mock: synthMock() },
    cwd: repo,
  };
  await run(
    fnJob('land', async (ctx) => {
      result = await mergeSynthesis(ctx, { branch });
      return { status: 'pass' };
    }),
    opts,
  );
  return result!;
}

describe('mergeSynthesis', () => {
  it.each([
    ['the original conflict', null, 7],
    ['a configured 32-character conflict', null, 32],
    ['a wider literal opener inside a real conflict', null, 7, '<<<<<<<< documentation\nMAIN VERSION\n', 'CAND VERSION\n'],
    ['a same-width literal opener after the separator', null, 7, 'MAIN VERSION\n', '<<<<<<< documentation\nCAND VERSION\n'],
    ['the opening marker', '<<<<<<< HEAD\n', 7],
    ['the base marker', '||||||| base\n', 7],
    ['the separator marker', '=======\n', 7],
    ['the closing marker', '>>>>>>> cand\n', 7],
    ['a Markdown setext heading', 'Heading\n=======\n', 7],
    ['an RST setext heading', 'Heading\n-------\n', 7],
    ['markers out of order', '>>>>>>> cand\n=======\n<<<<<<< HEAD\n', 7],
    ['a block without a separator', '<<<<<<< HEAD\ncontent\n>>>>>>> cand\n', 7],
    ['a mismatched closing width', '<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>>> cand\n', 7],
    ['inline marker text', 'const markers = "<<<<<<< ||||||| ======= >>>>>>>";\n', 7],
  ] as const)('checks %s before staging or committing the resolution', async (_label, resolved, markerSize, mainContent = 'MAIN VERSION\n', candidateContent = 'CAND VERSION\n') => {
    const repo = await tmpRepo();
    write(repo, 'shared.ts', 'base\n');
    if (markerSize === 32) {
      write(repo, '.gitattributes', 'shared.ts conflict-marker-size=32\n');
      await execa('git', ['config', 'merge.conflictStyle', 'diff3'], { cwd: repo });
    }
    await stageAll({ cwd: repo });
    await commit({ subject: 'chore: base' }, { cwd: repo });
    await execa('git', ['checkout', '-b', 'cand'], { cwd: repo });
    write(repo, 'shared.ts', candidateContent);
    await stageAll({ cwd: repo });
    await commit({ subject: 'feat: candidate' }, { cwd: repo });
    await execa('git', ['checkout', 'main'], { cwd: repo });
    write(repo, 'shared.ts', mainContent);
    await stageAll({ cwd: repo });
    await commit({ subject: 'feat: main' }, { cwd: repo });
    const before = (await execa('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout;
    let bodyCalls = 0;
    let conflicted = '';
    const resolution = new MockEngine((request) => {
      if (/Resolve this git merge conflict/.test(request.prompt)) {
        conflicted = readFileSync(join(repo, 'shared.ts'), 'utf8');
        return resolved ?? conflicted;
      }
      bodyCalls += 1;
      return 'Merged the resolved file.';
    });

    const { outcome } = await run(fnJob('land', async (ctx) => {
      await mergeSynthesis(ctx, { branch: 'cand' });
      return { status: 'pass' };
    }), { cwd: repo, engine: 'mock', engines: { mock: resolution } });

    if (markerSize === 32) {
      const lines = conflicted.split('\n');
      for (const marker of ['<', '|', '=', '>']) {
        expect(lines.some((line) => line.startsWith(marker.repeat(32)))).toBe(true);
      }
    }
    if (resolved === null && markerSize === 7) {
      expect(conflicted).toContain(`<<<<<<< HEAD\n${mainContent}`);
      expect(conflicted).toContain(`=======\n${candidateContent}>>>>>>> cand\n`);
    }
    if (resolved !== null) {
      expect(outcome.status).toBe('pass');
      expect(readFileSync(join(repo, 'shared.ts'), 'utf8')).toBe(resolved);
      expect(bodyCalls).toBe(1);
    } else {
      expect.soft(outcome.status).toBe('fail');
      expect.soft(outcome.error).toMatchObject({
        name: 'LoopError', code: 'BODY', message: expect.stringContaining('shared.ts'),
      });
      expect.soft((await execa('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout).toBe(before);
      expect.soft(readFileSync(join(repo, 'shared.ts'), 'utf8')).toBe(mainContent);
      expect.soft(bodyCalls).toBe(0);
    }
    expect((await execa('git', ['status', '--porcelain'], { cwd: repo })).stdout).toBe('');
    expect((await execa('git', ['rev-parse', '--verify', 'MERGE_HEAD'], { cwd: repo, reject: false })).exitCode).not.toBe(0);
  });

  it('resolves a real conflict and writes a synthesised body', async () => {
    const repo = await tmpRepo();
    write(repo, 'shared.ts', 'base\n');
    await stageAll({ cwd: repo });
    await commit({ subject: 'chore: base' }, { cwd: repo });

    await execa('git', ['checkout', '-b', 'cand'], { cwd: repo });
    write(repo, 'shared.ts', 'CAND VERSION\n');
    await stageAll({ cwd: repo });
    await commit({ subject: 'feat: cand change', body: '## Why\n\ncand approach' }, { cwd: repo });

    await execa('git', ['checkout', 'main'], { cwd: repo });
    write(repo, 'shared.ts', 'MAIN VERSION\n');
    await stageAll({ cwd: repo });
    await commit({ subject: 'feat: main change', body: '## Why\n\nmain approach' }, { cwd: repo });

    const result = await landSynthesis(repo, 'cand');
    expect(result.ok).toBe(true);
    expect(result.conflict).toBe(true);

    // the conflict was resolved (no markers), with the agent's content
    const content = readFileSync(join(repo, 'shared.ts'), 'utf8');
    expect(content).toContain('RESOLVED MERGED CONTENT');
    expect(content).not.toContain('<<<<<<<');

    // the merge commit carries the synthesised body, not "merge branch X"
    const top = await headMessage(repo);
    expect(top.subject).toContain('synthesis');
    expect(top.body).toContain('Reconciled the cand and main approaches');
  });

  it('handles a clean (non-conflicting) merge with a synthesised body too', async () => {
    const repo = await tmpRepo();
    await execa('git', ['checkout', '-b', 'feature'], { cwd: repo });
    write(repo, 'new.ts', 'x\n');
    await stageAll({ cwd: repo });
    await commit({ subject: 'feat: new file', body: '## Why\n\nadded a file' }, { cwd: repo });
    await execa('git', ['checkout', 'main'], { cwd: repo });

    const result = await landSynthesis(repo, 'feature');
    expect(result.ok).toBe(true);
    expect(result.conflict).toBe(false);
    const top = await headMessage(repo);
    expect(top.body).toContain('Reconciled');
  });
});
