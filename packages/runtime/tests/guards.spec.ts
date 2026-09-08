import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { globToRegExp, ratchet, sampled, writeScope } from '../src/core/guards.ts';
import { all, loop, run } from '../src/api.ts';
import type { JobContext } from '../src/core/types.ts';

// Real work: these tests create temporary Git repositories and write files
// to disk, so this file declares its own time limit; the suite default is a
// hang guard, not a speed bar.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let workspace: string;
let baselineDir: string;

beforeAll(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'guards-ws-')));
  baselineDir = realpathSync(mkdtempSync(join(tmpdir(), 'guards-base-')));
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(baselineDir, { recursive: true, force: true });
});

/** The minimal context slice the guards touch. */
function ctx(): JobContext {
  return {
    signal: new AbortController().signal,
    workspace: { dir: workspace },
    path: ['suite', 'node'],
    iteration: 1,
  } as unknown as JobContext;
}

function ctxAt(iteration: number): JobContext {
  return { ...ctx(), iteration } as JobContext;
}

function makeTrackedFileDirty(repo: string): void {
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, 'notes.md'), 'clean\n');
  execFileSync('git', ['add', 'notes.md'], { cwd: repo });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test User',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-qm',
      'init',
    ],
    { cwd: repo },
  );
  writeFileSync(join(repo, 'notes.md'), 'pre-existing\n');
}

/** A metric emitter: prints noise, then `{"metrics":{"errors":N}}`. */
function emitter(value: number): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [
      '-e',
      `console.log('scanning...'); console.log(JSON.stringify({ metrics: { errors: ${value} } }))`,
    ],
  };
}

describe('ratchet', () => {
  it.each(['signal termination', 'handled exit zero'] as const)('names a timeout after %s without seeding or changing its baseline', async (mode) => {
    const dir = mkdtempSync(join(workspace, 'timeout-'));
    const stored = join(dir, 'baselines');
    const script = join(dir, 'metric.cjs');
    writeFileSync(script, `
      const fs = require('node:fs');
      const mode = fs.readFileSync('mode', 'utf8');
      if (mode !== 'success' && ${JSON.stringify(mode)} === 'handled exit zero') {
        process.on('SIGTERM', () => {
          fs.writeFileSync('stopped', 'exit zero');
          process.exit(0);
        });
      }
      console.log(JSON.stringify({ score: mode === 'success' ? 10 : 1 }));
      fs.writeFileSync('ready', 'ready');
      if (mode !== 'success') setTimeout(() => process.exit(0), 1500);
    `);
    const gate = ratchet(process.execPath, [script], {
      metric: 'score', cwd: dir, baselineDir: stored, timeoutMs: 500,
    });
    writeFileSync(join(dir, 'mode'), 'timeout');
    const first = await gate(ctx(), undefined);
    expect(readFileSync(join(dir, 'ready'), 'utf8')).toBe('ready');
    if (mode === 'handled exit zero') expect(readFileSync(join(dir, 'stopped'), 'utf8')).toBe('exit zero');
    expect.soft(first.met).toBe(false);
    expect.soft(first.reason).toBe(`ratchet command \`${process.execPath}\` timed out after 500 ms`);
    expect.soft(existsSync(stored)).toBe(false);

    writeFileSync(join(dir, 'mode'), 'success');
    expect((await gate(ctx(), undefined)).met).toBe(true);
    const files = readdirSync(stored);
    expect(files).toHaveLength(1);
    const before = readFileSync(join(stored, files[0]!), 'utf8');
    writeFileSync(join(dir, 'mode'), 'timeout');
    const second = await gate(ctx(), undefined);
    expect.soft(second.met).toBe(false);
    expect.soft(second.reason).toBe(`ratchet command \`${process.execPath}\` timed out after 500 ms`);
    expect.soft(readFileSync(join(stored, files[0]!), 'utf8')).toBe(before);
  });

  it('reads the metric after two prose lines before the JSON', async () => {
    const result = await ratchet(
      process.execPath,
      ['-e', "console.log('Scanning files'); console.log('Analysis complete'); console.log(JSON.stringify({ metrics: { errors: 17 } }))"],
      { metric: 'errors', baselineDir },
    )(ctx(), undefined);

    expect(result.met).toBe(true);
    expect(result.reason).toContain('seeded at 17');
  });

  it('seeds the baseline, then blocks a regression and accepts an improvement', async () => {
    const opts = { metric: 'errors', baselineDir } as const;

    const seed = emitter(10);
    const seeded = await ratchet(seed.command, seed.args, opts)(ctx(), undefined);
    expect(seeded.met).toBe(true);
    expect(seeded.reason).toContain('seeded at 10');

    // Drive one command file so the baseline key is stable across values
    // (the baseline is keyed on workspace + argv + metric).
    const script = join(workspace, 'metric.mjs');
    writeFileSync(
      script,
      "import { readFileSync } from 'node:fs';\nconst v = Number(readFileSync(new URL('./value.txt', import.meta.url), 'utf8'));\nconsole.log(JSON.stringify({ metrics: { errors: v } }));\n",
    );
    const setValue = (v: number) =>
      writeFileSync(join(workspace, 'value.txt'), String(v));
    const gate = ratchet(process.execPath, [script], opts);

    setValue(10);
    expect((await gate(ctx(), undefined)).met).toBe(true); // seeds at 10
    setValue(12);
    const blocked = await gate(ctx(), undefined);
    expect(blocked.met).toBe(false);
    expect(blocked.reason).toContain('regressed: 12 vs baseline 10');
    setValue(7);
    const improved = await gate(ctx(), undefined);
    expect(improved.met).toBe(true);
    expect(improved.reason).toContain('improved to 7');
    // The bar only moves in the improving direction: 9 > 7 now fails.
    setValue(9);
    expect((await gate(ctx(), undefined)).met).toBe(false);
  });

  it('fails closed on a missing metric and a failing command', async () => {
    const noMetric = await ratchet(
      process.execPath,
      ['-e', "console.log('{}')"],
      { metric: 'coverage', baselineDir },
    )(ctx(), undefined);
    expect(noMetric.met).toBe(false);
    expect(noMetric.reason).toContain('fail-closed');

    const crashed = await ratchet(process.execPath, ['-e', 'process.exit(3)'], {
      metric: 'coverage',
      baselineDir,
    })(ctx(), undefined);
    expect(crashed.met).toBe(false);
    expect(crashed.reason).toContain('exited 3');
  });

  it('supports direction: up (coverage must not fall)', async () => {
    const script = join(workspace, 'coverage.mjs');
    writeFileSync(
      script,
      "import { readFileSync } from 'node:fs';\nconst v = Number(readFileSync(new URL('./cov.txt', import.meta.url), 'utf8'));\nconsole.log(JSON.stringify({ metrics: { coverage: v } }));\n",
    );
    const setValue = (v: number) =>
      writeFileSync(join(workspace, 'cov.txt'), String(v));
    const gate = ratchet(process.execPath, [script], {
      metric: 'coverage',
      direction: 'up',
      baselineDir,
    });
    setValue(80);
    expect((await gate(ctx(), undefined)).met).toBe(true);
    setValue(75);
    expect((await gate(ctx(), undefined)).met).toBe(false);
    setValue(85);
    expect((await gate(ctx(), undefined)).met).toBe(true);
  });
});

describe('globToRegExp', () => {
  it('matches the declared shapes', () => {
    expect(globToRegExp('src/**/*.ts').test('src/core/loop.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/loop.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('tests/loop.ts')).toBe(false);
    expect(globToRegExp('*.md').test('README.md')).toBe(true);
    expect(globToRegExp('*.md').test('docs/helm.md')).toBe(false);
    expect(globToRegExp('docs/*.md').test('docs/helm.md')).toBe(true);
    expect(globToRegExp('a?c.txt').test('abc.txt')).toBe(true);
    expect(globToRegExp('a?c.txt').test('abbc.txt')).toBe(false);
  });
});

describe('writeScope', () => {
  it('fails closed outside a git repository', async () => {
    const result = await writeScope(['src/**'])(ctx(), undefined);
    expect(result.met).toBe(false);
    expect(result.reason).toContain('not a git repository');
  });

  it('passes a clean tree, catches an out-of-scope edit, names it', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'guards-repo-')));
    try {
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: repo });
      git('init', '-q');
      const repoCtx = {
        ...ctx(),
        workspace: { dir: repo },
      } as unknown as JobContext;

      const clean = await writeScope(['src/**'])(repoCtx, undefined);
      expect(clean.met).toBe(true);
      expect(clean.reason).toBe('clean tree');

      writeFileSync(join(repo, 'notes.md'), 'stray\n');
      const stray = await writeScope(['src/**'])(repoCtx, undefined);
      expect(stray.met).toBe(false);
      expect(stray.output).toContain('notes.md');

      const covered = await writeScope(['src/**', '*.md'])(repoCtx, undefined);
      expect(covered.met).toBe(true);
      expect(covered.reason).toContain('inside scope');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('ignores untouched pre-existing dirt at loop entry', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'guards-repo-')));
    try {
      makeTrackedFileDirty(repo);

      const { outcome } = await run(
        loop({
          name: 'scoped-fix',
          max: 1,
          body: async () => {
            mkdirSync(join(repo, 'src'), { recursive: true });
            writeFileSync(join(repo, 'src', 'fix.ts'), 'export {};\n');
            return { status: 'pass', summary: 'fixed' };
          },
          until: [all(writeScope(['src/**']))],
        }),
        { cwd: repo },
      );

      expect(outcome.status).toBe('pass');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('catches a body changing a file that was already dirty at loop entry', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'guards-repo-')));
    let finalReason = '';
    try {
      makeTrackedFileDirty(repo);

      const { outcome } = await run(
        loop({
          name: 'scoped-fix',
          max: 1,
          body: async () => {
            writeFileSync(join(repo, 'notes.md'), 'changed by body\n');
            writeFileSync(join(repo, 'stray.txt'), 'new stray\n');
            return { status: 'pass', summary: 'fixed' };
          },
          until: writeScope(['src/**']),
          onComplete: (_outcome, context) => {
            finalReason = context.lastGate?.reason ?? '';
          },
        }),
        { cwd: repo },
      );

      expect(outcome.status).toBe('exhausted');
      expect(finalReason).toContain('notes.md');
      expect(finalReason).toContain('stray.txt');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('keeps absolute workspace checking as an explicit mode', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'guards-repo-')));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      writeFileSync(join(repo, 'notes.md'), 'pre-existing\n');

      const { outcome } = await run(
        loop({
          name: 'strict-scope',
          max: 1,
          body: async () => ({ status: 'pass', summary: 'no changes' }),
          until: writeScope(['src/**'], { mode: 'absolute' }),
        }),
        { cwd: repo },
      );

      expect(outcome.status).toBe('exhausted');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('batches content probes for a large dirty set', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'guards-repo-')));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      mkdirSync(join(repo, 'src'));
      for (let index = 0; index < 205; index += 1) {
        writeFileSync(join(repo, 'src', `${index}.ts`), `export const n = ${index};\n`);
      }
      const repoContext = {
        ...ctx(),
        workspace: { dir: repo },
      } as unknown as JobContext;

      const result = await writeScope(['src/**'], { mode: 'absolute' })(
        repoContext,
        undefined,
      );

      expect(result.met).toBe(true);
      expect(result.reason).toContain('205 changed file(s)');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('sampled', () => {
  it('is deterministic per key and hits roughly the declared rate', async () => {
    let ran = 0;
    const counting = sampled(0.5, async () => {
      ran += 1;
      return { met: true, reason: 'inner ran' };
    });
    const first: boolean[] = [];
    for (let i = 1; i <= 100; i++) {
      const r = await counting(ctxAt(i), undefined);
      first.push(r.reason.startsWith('sampled in'));
    }
    const ranFirst = ran;
    expect(ranFirst).toBeGreaterThan(25);
    expect(ranFirst).toBeLessThan(75);

    // Re-running the same iterations lands on exactly the same side.
    ran = 0;
    for (let i = 1; i <= 100; i++) {
      const r = await counting(ctxAt(i), undefined);
      expect(r.reason.startsWith('sampled in')).toBe(first[i - 1]);
    }
    expect(ran).toBe(ranFirst);
  });

  it('treats a sampled-out evaluation as met', async () => {
    const gate = sampled(0, async () => ({ met: false, reason: 'never runs' }));
    const result = await gate(ctxAt(1), undefined);
    expect(result.met).toBe(true);
    expect(result.reason).toContain('sampled out');
  });

  it('always runs the inner condition at rate 1', async () => {
    const gate = sampled(1, async () => ({ met: false, reason: 'strict judge' }));
    const result = await gate(ctxAt(1), undefined);
    expect(result.met).toBe(false);
    expect(result.reason).toContain('sampled in');
  });

  it('rejects an out-of-range rate', () => {
    expect(() => sampled(1.5, async () => ({ met: true, reason: 'x' }))).toThrow(
      RangeError,
    );
  });
});
