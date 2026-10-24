/**
 * The built-in feature-delivery: seat check, brief check, build, report,
 * size check, checks, proof check, review and commit, with stub engines in
 * a temporary git repository.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { EngineError, jobMeta, run, type AgentRequest, type AgentResult, type Engine, type Outcome } from '@obversa/runtime';

import { featureDelivery } from '../src/index.js';
import type { FeatureDeliveryConfig, TeamSeat } from '../src/types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): { cwd: string; git: (...args: string[]) => string } {
  const cwd = mkdtempSync(join(tmpdir(), 'feature-delivery-'));
  dirs.push(cwd);
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(cwd, '.hooks'));
  git('config', 'core.hooksPath', join(cwd, '.hooks'));
  writeFileSync(join(cwd, '.gitignore'), 'records/\n.hooks/\n');
  for (const name of ['a', 'b', 'c']) writeFileSync(join(cwd, `${name}.mjs`), `export const ${name} = 1;\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { cwd, git };
}

type Reply = (request: AgentRequest) => string;

/** A stub engine: each reply is chosen by what the prompt asks. */
function engine(name: string, reply: Reply, inputLimit?: number): Engine & { prompts: string[] } {
  const prompts: string[] = [];
  const selection = { adapter: 'stub', adapterVersion: '1', provider: name, modelFamily: name, model: `${name}-model`, executable: null, capabilities: [] } as const;
  return {
    name,
    prompts,
    ...(inputLimit === undefined ? {} : { inputLimit: { characters: inputLimit } }),
    async run(request): Promise<AgentResult> {
      prompts.push(request.prompt);
      return { parts: [{ kind: 'assistant', text: reply(request), final: true }], usage: { kind: 'unknown' }, requested: selection, effective: selection };
    },
  };
}

const seatOf = (stub: Engine, family: string): TeamSeat => ({
  engine: stub,
  identity: { adapter: 'stub', provider: family, modelFamily: family, model: `${family}-model`, tools: ['read'] },
});

const asks = {
  brief: (prompt: string) => prompt.startsWith('Before anything is built'),
  proof: (prompt: string) => prompt.startsWith("The builder's report must answer"),
  review: (prompt: string) => prompt.startsWith('You review a change'),
  report: (prompt: string) => prompt.startsWith('Your report was sent back'),
};

const PASS = (summary = 'ok') => JSON.stringify({ status: 'pass', summary });
const REVISE = (...evidence: string[]) => JSON.stringify({ status: 'revise', summary: 'fix', findings: evidence.map((text) => ({ severity: 'block', evidence: text })) });
const REPORT = 'Built it.\n\nproof 1: pasted output\n\n```commit\nfeat(a): raise a\n\nThe brief asks for it.\n```\n';

function config(cwd: string, builder: Engine, reviewer: Engine, overrides: Partial<FeatureDeliveryConfig> = {}): FeatureDeliveryConfig {
  return {
    brief: 'Raise a to 2. Proof 1: paste the run of the a check.',
    workspace: cwd,
    implement: seatOf(builder, 'builder'),
    reviewers: [{ name: 'reviewer', seat: seatOf(reviewer, 'reviewer') }],
    checks: [[process.execPath, '-e', 'process.exit(0)']],
    base: 'HEAD',
    ...overrides,
  };
}

const outcomes = (outcome: Outcome) => outcome.data as Record<string, Outcome>;

describe('featureDelivery', () => {
  it('runs seat check, brief check, build, report, checks, proof, review and commit, with one proof send-back and one review round', async () => {
    const { cwd, git } = repo();
    let proofAsks = 0;
    let reviews = 0;
    const builder = engine('builder', (request) => {
      if (asks.report(request.prompt)) return REPORT;
      writeFileSync(join(request.cwd!, 'a.mjs'), `export const a = ${2 + reviews};\n`);
      return REPORT;
    });
    const reviewer = engine('reviewer', (request) => {
      if (asks.brief(request.prompt)) return PASS('the brief holds');
      if (asks.proof(request.prompt)) {
        proofAsks += 1;
        return proofAsks === 1
          ? REVISE('proof 1: paste the run of the a check')
          : JSON.stringify({ status: 'pass', summary: 'proven', accepted: [{ item: 'proof 1', files: ['a.mjs'] }] });
      }
      reviews += 1;
      return reviews === 1 ? REVISE('a.mjs:1 a must be exported as 3') : PASS('clean');
    });

    const job = featureDelivery(config(cwd, builder, reviewer, { commit: true }));
    expect((jobMeta(job)?.nodes as { name: string }[]).map((node) => node.name))
      .toEqual(['seats', 'brief', 'build', 'report', 'fit', 'checks', 'proof', 'review']);
    const { outcome } = await run(job, { cwd, recordTo: join(cwd, 'records', 'run.jsonl') });

    expect(outcome.status).toBe('pass');
    expect(proofAsks).toBe(3);
    expect(reviews).toBe(2);
    // The proof send-back went to the report, which asked the builder for output only.
    expect(builder.prompts.filter((prompt) => asks.report(prompt))).toHaveLength(1);
    expect(builder.prompts.filter((prompt) => !asks.report(prompt))).toHaveLength(2);
    expect(outcome.commit).toEqual({ sha: git('rev-parse', 'HEAD') });
    expect(git('log', '-1', '--format=%B')).toBe('feat(a): raise a\n\nThe brief asks for it.\n\nRun: run\nReview-rounds: 2\nReviewed-by: reviewer');
  });

  describe('the brief check', () => {
    it('asks for every finding in one pass, each with where it looked', async () => {
      const { cwd } = repo();
      const reviewer = engine('reviewer', () => REVISE('one'));
      await run(featureDelivery(config(cwd, engine('builder', () => REPORT), reviewer)), { cwd });

      expect(reviewer.prompts[0]).toContain('List every finding you can establish; do not stop at the first. Each finding says what is false or cannot be checked, and where you looked.');
      expect(reviewer.prompts[0]).toContain("Never block because the tree does not yet do what the brief asks the build to do: that is the build's work.");
    });

    it('keeps every finding, and pauses for the brief to be fixed instead of ending', async () => {
      const { cwd } = repo();
      const findings = ['the goal names no module', 'a.mjs has no default export', 'check 2 cannot fail', 'base is not main', 'proof 3 names no file'];
      const reviewer = engine('reviewer', () => REVISE(...findings));
      const { outcome } = await run(featureDelivery(config(cwd, engine('builder', () => REPORT), reviewer)), { cwd });

      expect(outcome.status).toBe('paused');
      const brief = outcomes(outcome).brief!;
      expect(brief.status).toBe('paused');
      expect((brief.data as { findings: { evidence: string }[] }).findings.map((finding) => finding.evidence)).toEqual(findings);
      for (const finding of findings) expect(brief.summary).toContain(finding);
    });

    it('reads the brief file again on resume, and passes once it is fixed', async () => {
      const { cwd } = repo();
      const briefPath = join(cwd, 'records', 'brief.md');
      mkdirSync(join(cwd, 'records'));
      writeFileSync(briefPath, 'Raise a to 2 in src/a.mjs.');
      const record = join(cwd, 'records', 'run.jsonl');
      const reviewer = engine('reviewer', (request) => {
        if (asks.brief(request.prompt)) return request.prompt.includes('in a.mjs') ? PASS() : REVISE('src/a.mjs does not exist; a.mjs does');
        if (asks.proof(request.prompt)) return PASS();
        return PASS();
      });
      // One workflow for both runs, so the resume cannot pass on a brief read when the workflow was made.
      const job = featureDelivery(config(cwd, engine('builder', (request) => {
        writeFileSync(join(request.cwd!, 'a.mjs'), 'export const a = 2;\n');
        return REPORT;
      }), reviewer, { brief: undefined, briefPath }));

      const first = await run(job, { cwd, recordTo: record });
      expect(first.outcome.status).toBe('paused');
      writeFileSync(briefPath, 'Raise a to 2 in a.mjs.');
      const resumed = await run(job, { cwd, recordTo: record, resume: true });

      expect(resumed.outcome.status).toBe('pass');
    });

    it('does not block on a warning: the builder sees it', async () => {
      const { cwd } = repo();
      const builder = engine('builder', () => REPORT);
      const reviewer = engine('reviewer', (request) => asks.brief(request.prompt)
        ? JSON.stringify({ status: 'revise', summary: 'one note', findings: [{ severity: 'warning', evidence: 'the brief says a.mjs holds 2; it holds 1, which the build changes' }] })
        : PASS());
      const { outcome } = await run(featureDelivery(config(cwd, builder, reviewer)), { cwd });

      expect(outcome.status).toBe('pass');
      expect(builder.prompts[0]).toContain('The brief check noted:\n- [nice-to-have] the brief says a.mjs holds 2; it holds 1, which the build changes');
    });
  });

  it("tells the first build and the brief check about the earlier run's work and how it ended", async () => {
    const { cwd } = repo();
    const record = join(cwd, 'records', 'run.jsonl');
    const failing = { checks: [[process.execPath, '-e', 'process.exit(1)']] as const, rounds: 0 };
    const earlierBuilder = engine('builder', (request) => {
      writeFileSync(join(request.cwd!, 'a.mjs'), 'export const a = 2;\n');
      return REPORT;
    });
    const first = await run(featureDelivery(config(cwd, earlierBuilder, engine('reviewer', () => PASS()), failing)), { cwd, recordTo: record });
    expect(first.outcome.status).toBe('fail');

    const builder = engine('builder', () => REPORT);
    const reviewer = engine('reviewer', () => PASS());
    await run(featureDelivery(config(cwd, builder, reviewer)), { cwd, recordTo: record, carryFrom: record });

    const note = 'An earlier run worked on this brief. The worktree may hold its uncommitted work.\nIt ended fail at step "checks":';
    expect(builder.prompts[0]).toContain(note);
    expect(reviewer.prompts.find((prompt) => asks.brief(prompt))).toContain(note);
  });

  it("does not block a relaunch on the worktree's state the earlier run left", async () => {
    const { cwd } = repo();
    const record = join(cwd, 'records', 'run.jsonl');
    const failing = { checks: [[process.execPath, '-e', 'process.exit(1)']] as const, rounds: 0 };
    const earlierBuilder = engine('builder', (request) => {
      writeFileSync(join(request.cwd!, 'a.mjs'), 'export const a = 2;\n');
      return REPORT;
    });
    expect((await run(featureDelivery(config(cwd, earlierBuilder, engine('reviewer', () => PASS()), failing)), { cwd, recordTo: record })).outcome.status).toBe('fail');

    // A reviewer that sees the earlier run's uncommitted work in the tree.
    // It reports that as a warning when its prompt says the tree's state is
    // not a claim of the brief, and blocks on it when it does not.
    const treeNote = `the worktree already holds uncommitted work: a.mjs reads "${readFileSync(join(cwd, 'a.mjs'), 'utf8').trim()}"`;
    const reviewer = engine('reviewer', (request) => {
      if (!asks.brief(request.prompt)) return PASS();
      const told = request.prompt.includes("The worktree's state and the earlier run's history are not claims of the brief.");
      return JSON.stringify({ status: 'revise', summary: 'the tree', findings: [{ severity: told ? 'warning' : 'block', evidence: treeNote }] });
    });
    const builder = engine('builder', () => REPORT);
    const { outcome } = await run(featureDelivery(config(cwd, builder, reviewer)), { cwd, recordTo: record, carryFrom: record });

    expect(outcomes(outcome).brief?.status).toBe('pass');
    expect(outcome.status).toBe('pass');
    expect(builder.prompts[0]).toContain(`The brief check noted:\n- [nice-to-have] ${treeNote}`);
  });

  describe('accepted proofs', () => {
    /** The proof check's answer from round 2: it asks for each proof its prompt does not list as standing. Nothing is pasted again. */
    const askFor = (prompt: string) => {
      const standing = prompt.split('=== proofs accepted earlier that still stand; do not ask for them ===\n')[1]?.split('\n===')[0] ?? '';
      const missing = ['proof A', 'proof B', 'proof C'].filter((item) => !standing.split('\n').includes(`- ${item}`));
      return missing.length === 0 ? JSON.stringify({ status: 'pass', summary: 'proven', accepted: [] }) : REVISE(...missing.map((item) => `${item}: paste it`));
    };

    /** Three proofs accepted in round 1, each naming its file; round 2's build changes b.mjs and pastes nothing. */
    async function twoRounds(resume: boolean) {
      const { cwd } = repo();
      const record = join(cwd, 'records', 'run.jsonl');
      const proofPrompts: string[] = [];
      const builderPrompts: string[] = [];
      const builder = () => engine('builder', (request) => {
        builderPrompts.push(request.prompt);
        if (builderPrompts.length > 1) writeFileSync(join(request.cwd!, 'b.mjs'), 'export const b = 2;\n');
        return builderPrompts.length === 1 ? `proof A, proof B and proof C pasted\n${REPORT}` : REPORT;
      });
      let reviewed = 0;
      const reviewer = (reviewerDies: boolean) => engine('reviewer', (request) => {
        if (asks.brief(request.prompt)) return PASS();
        if (asks.proof(request.prompt)) {
          proofPrompts.push(request.prompt);
          return proofPrompts.length === 1
            ? JSON.stringify({ status: 'pass', summary: 'proven', accepted: [{ item: 'proof A', files: ['a.mjs'] }, { item: 'proof B', files: ['b.mjs'] }, { item: 'proof C', files: ['c.mjs'] }] })
            : askFor(request.prompt);
        }
        if (reviewerDies) throw new Error('the reviewer process died');
        reviewed += 1;
        return reviewed === 1 ? REVISE('b.mjs:1 b must be 2') : PASS();
      });
      const job = (reviewerDies: boolean) => featureDelivery(config(cwd, builder(), reviewer(reviewerDies), { rounds: 3 }));
      if (resume) {
        // The run pauses between the rounds, after round 1's proofs were accepted.
        expect((await run(job(true), { cwd, recordTo: record })).outcome.status).toBe('paused');
        await run(job(false), { cwd, recordTo: record, resume: true });
      } else {
        await run(job(false), { cwd, recordTo: record });
      }
      return { proofPrompts, builderPrompts };
    }

    it.each([['in one run', false], ['across a resume', true]])('asks %s only for the proof whose file changed', async (_label, resume) => {
      const { proofPrompts, builderPrompts } = await twoRounds(resume);
      // What the proof check sent back to the builder in round 2: only the proof whose file changed.
      const sentBack = builderPrompts.find((prompt) => asks.report(prompt)) ?? '';
      expect(sentBack.match(/proof [ABC]: paste it/g)).toEqual(['proof B: paste it']);
      expect(builderPrompts[1]).toContain('These proofs were accepted and still stand, because the files they cover have not changed; do not run or paste them again:\n- proof A\n- proof B\n- proof C');
      const round2 = proofPrompts[1]!;
      expect(round2).toContain('=== proofs accepted earlier that still stand; do not ask for them ===\n- proof A\n- proof C');
      expect(round2).toContain('=== proofs accepted earlier whose files changed since; ask for them again unless the report pastes them ===\n- proof B');
    });

    it('asks a fresh launch with carryFrom only for the carried proof whose file changed', async () => {
      const { cwd } = repo();
      const record = join(cwd, 'records', 'run.jsonl');
      const accepted = JSON.stringify({ status: 'pass', summary: 'proven', accepted: [{ item: 'proof A', files: ['a.mjs'] }, { item: 'proof B', files: ['b.mjs'] }, { item: 'proof C', files: ['c.mjs'] }] });
      // The earlier launch: all three proofs accepted, then the review blocks and the run fails.
      const earlierReviewer = engine('reviewer', (request) => asks.brief(request.prompt) ? PASS() : asks.proof(request.prompt) ? accepted : REVISE('a.mjs:1 still wrong'));
      const first = await run(featureDelivery(config(cwd, engine('builder', () => REPORT), earlierReviewer, { rounds: 0 })), { cwd, recordTo: record });
      expect(first.outcome.status).toBe('fail');

      // The relaunch changes only c.mjs.
      const builder = engine('builder', (request) => {
        writeFileSync(join(request.cwd!, 'c.mjs'), 'export const c = 2;\n');
        return REPORT;
      });
      const reviewer = engine('reviewer', (request) => asks.proof(request.prompt) ? JSON.stringify({ status: 'pass', summary: 'ok', accepted: [] }) : PASS());
      await run(featureDelivery(config(cwd, builder, reviewer)), { cwd, recordTo: record, carryFrom: record });

      const proofPrompt = reviewer.prompts.find((prompt) => asks.proof(prompt))!;
      expect(proofPrompt).toContain('=== proofs accepted earlier that still stand; do not ask for them ===\n- proof A\n- proof B');
      expect(proofPrompt).toContain('=== proofs accepted earlier whose files changed since; ask for them again unless the report pastes them ===\n- proof C');
    });
  });

  it('sends a change too large for a reviewer back to the build before any check, proof check or reviewer runs', async () => {
    const { cwd } = repo();
    const marker = join(cwd, 'records', 'check-ran');
    mkdirSync(join(cwd, 'records'));
    let builds = 0;
    const builder = engine('builder', (request) => {
      builds += 1;
      writeFileSync(join(request.cwd!, 'fixture.json'), JSON.stringify({ rows: 'x'.repeat(2_000_000) }));
      // The first build also rewrites a tracked file by about 2 MB; the second leaves it alone.
      writeFileSync(join(request.cwd!, 'a.mjs'), builds === 1 ? `${'export const line = "some code";\n'.repeat(62_000)}` : 'export const a = 2;\n');
      return REPORT;
    });
    const reviewer = engine('reviewer', (request) => asks.proof(request.prompt) ? JSON.stringify({ status: 'pass', summary: 'ok', accepted: [] }) : PASS(), 1_000_000);
    const checks = [[process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(Date.now()))`]];
    const { outcome } = await run(featureDelivery(config(cwd, builder, reviewer, { checks })), { cwd });

    expect(outcome.status).toBe('pass');
    expect(builds).toBe(2);
    expect(builder.prompts[1]).toMatch(/the review input is \d+ characters with every data file listed, and reviewer takes at most 1000000; the largest files in the change: a\.mjs/);
    // Nothing after the build ran on the first build: one check run, one proof check and one review, all on the second.
    expect(existsSync(marker)).toBe(true);
    expect(reviewer.prompts.filter((prompt) => asks.proof(prompt))).toHaveLength(1);
    const reviews = reviewer.prompts.filter((prompt) => asks.review(prompt));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatch(/=== listed, not inlined: fixture\.json \(\d+ bytes, sha256 [0-9a-f]{64}\); read it from the worktree ===/);
    expect(readFileSync(marker, 'utf8')).not.toBe('');
  });

  describe('a seat that cannot answer', () => {
    /** A primary whose CLI is not installed: admission and every call fail. */
    function missingCli(name: string): Engine & { calls: number } {
      const missing = () => Object.assign(new Error(`spawn ${name} ENOENT`), { code: 'ENOENT' });
      const stub = {
        name,
        calls: 0,
        async admit(): Promise<never> { throw missing(); },
        async run(): Promise<AgentResult> {
          stub.calls += 1;
          throw missing();
        },
      };
      return stub;
    }

    it('starts every later step on the candidate the seat check admitted, tests-first and its review included', async () => {
      const { cwd } = repo();
      const builder = missingCli('builder-cli');
      const brief = missingCli('brief-cli');
      const candidate = engine('candidate', (request) => {
        if (request.prompt.startsWith('Obversa team role: tests-first')) {
          writeFileSync(join(request.cwd!, 'a.spec.mjs'), 'export const test = 1;\n');
          return PASS('tests written');
        }
        writeFileSync(join(request.cwd!, 'a.mjs'), 'export const a = 2;\n');
        return REPORT;
      });
      const reviewer = engine('reviewer', () => PASS());
      const { outcome } = await run(featureDelivery(config(cwd, builder, reviewer, {
        implement: { seat: seatOf(builder, 'builder'), candidates: [seatOf(candidate, 'candidate')] },
        reviewers: [{ name: 'reviewer', seat: { seat: seatOf(brief, 'brief'), candidates: [seatOf(reviewer, 'reviewer')] } }],
        files: ['a.mjs', 'a.spec.mjs'],
        testFiles: ['a.spec.mjs'],
      })), { cwd });

      expect(outcome.status).toBe('pass');
      expect(builder.calls).toBe(0);
      expect(brief.calls).toBe(0);
      expect(candidate.prompts.filter((prompt) => prompt.startsWith('Obversa team role: tests-first'))).toHaveLength(1);
      expect(reviewer.prompts.filter((prompt) => prompt.startsWith('Obversa team role: reviewer') && prompt.includes('Review target: a.spec.mjs'))).toHaveLength(1);
      expect(candidate.prompts).toHaveLength(2);
    });

    it("answers the report's proof send-back on the builder's candidate", async () => {
      const { cwd } = repo();
      let primaryCalls = 0;
      const primary: Engine = {
        name: 'primary',
        async run(): Promise<AgentResult> {
          primaryCalls += 1;
          throw new EngineError({ kind: 'auth', message: 'not logged in' });
        },
      };
      const candidate = engine('candidate', (request) => {
        if (!asks.report(request.prompt)) writeFileSync(join(request.cwd!, 'a.mjs'), 'export const a = 2;\n');
        return REPORT;
      });
      let proofAsks = 0;
      const reviewer = engine('reviewer', (request) => {
        if (asks.proof(request.prompt)) {
          proofAsks += 1;
          return proofAsks === 1 ? REVISE('proof 1: paste the run of the a check') : PASS();
        }
        return PASS();
      });
      const { outcome } = await run(featureDelivery(config(cwd, primary, reviewer, {
        implement: { seat: seatOf(primary, 'primary'), candidates: [seatOf(candidate, 'candidate')] },
      })), { cwd });

      expect(outcome.status).toBe('pass');
      expect(candidate.prompts.filter((prompt) => asks.report(prompt))).toHaveLength(1);
      // Each step tries the primary twice, then its candidate answers.
      expect(primaryCalls).toBe(4);
    });
  });

  it("gives a long failed check's output to the builder once, within the builder's whole input limit", async () => {
    const { cwd } = repo();
    const limit = 40_000;
    const fixed = join(cwd, 'fixed');
    const script = `if (require('node:fs').existsSync(${JSON.stringify(fixed)})) process.exit(0); process.stdout.write('ok line\\n'.repeat(20000)); process.stdout.write('FA' + 'IL tests/a.spec.ts > a is 2\\n'); process.exitCode = 1;`;
    let builds = 0;
    const builder = engine('builder', () => {
      builds += 1;
      if (builds === 2) writeFileSync(fixed, '');
      writeFileSync(join(cwd, 'a.mjs'), `export const a = ${builds + 1};\n`);
      return REPORT;
    }, limit);
    const { outcome } = await run(featureDelivery(config(cwd, builder, engine('reviewer', () => PASS()), {
      checks: [[process.execPath, '-e', script]],
      houseRules: 'rule '.repeat(2_000),
    })), { cwd });

    expect(outcome.status).toBe('pass');
    expect(builds).toBe(2);
    const sentBack = builder.prompts[1]!;
    expect(sentBack.length).toBeLessThanOrEqual(limit);
    // One copy of the output: its header once, and the failing test named in it.
    expect(sentBack.match(/exit: 1/g)).toHaveLength(1);
    expect(sentBack).toContain('failing tests: - tests/a.spec.ts > a is 2');
  });

  it('keeps a proof that covers the whole change across a relaunch when the record sits unignored in the worktree', async () => {
    const { cwd } = repo();
    const record = join(cwd, 'run.jsonl');
    const accepted = JSON.stringify({ status: 'pass', summary: 'proven', accepted: [{ item: 'proof A', files: [] }] });
    const earlier = engine('reviewer', (request) => asks.brief(request.prompt) ? PASS() : asks.proof(request.prompt) ? accepted : REVISE('a.mjs:1 still wrong'));
    expect((await run(featureDelivery(config(cwd, engine('builder', () => REPORT), earlier, { rounds: 0 })), { cwd, recordTo: record })).outcome.status).toBe('fail');

    // The relaunch changes no file.
    const reviewer = engine('reviewer', (request) => asks.proof(request.prompt) ? JSON.stringify({ status: 'pass', summary: 'ok', accepted: [] }) : PASS());
    await run(featureDelivery(config(cwd, engine('builder', () => REPORT), reviewer)), { cwd, recordTo: record, carryFrom: record });

    expect(reviewer.prompts.find((prompt) => asks.proof(prompt))).toContain('=== proofs accepted earlier that still stand; do not ask for them ===\n- proof A');
  });

  it("leaves a retried check's output out of the review when the record sits unignored in the worktree", async () => {
    const { cwd } = repo();
    const marker = join(mkdtempSync(join(tmpdir(), 'feature-delivery-flaky-')), 'ran');
    dirs.push(join(marker, '..'));
    // Fails on its first run and passes on its second.
    const flaky = `const fs = require('node:fs'); if (fs.existsSync(${JSON.stringify(marker)})) process.exit(0); fs.writeFileSync(${JSON.stringify(marker)}, ''); console.log('FLAKY' + ' OUTPUT'); process.exit(1);`;
    const reviewer = engine('reviewer', () => PASS());
    const { outcome } = await run(featureDelivery(config(cwd, engine('builder', () => {
      writeFileSync(join(cwd, 'a.mjs'), 'export const a = 2;\n');
      return REPORT;
    }), reviewer, { checks: [[process.execPath, '-e', flaky]] })), { cwd, recordTo: join(cwd, 'run.jsonl') });

    expect(outcome.status).toBe('pass');
    // The first run's output is kept beside the record, inside the worktree.
    const kept = execFileSync('git', ['ls-files', '--others', '--exclude-standard', 'run.checks'], { cwd, encoding: 'utf8' }).trim();
    expect(kept).toMatch(/^run\.checks\//);
    const review = reviewer.prompts.find((prompt) => asks.review(prompt))!;
    expect(review).toContain('a.mjs');
    expect(review).not.toContain('run.checks');
    expect(review).not.toContain('FLAKY OUTPUT');
  });

  it('never lets the judge pass a tree whose checks failed', async () => {
    const { cwd } = repo();
    let builds = 0;
    const builder = engine('builder', () => {
      builds += 1;
      writeFileSync(join(cwd, 'a.mjs'), `export const a = ${builds + 1};\n`);
      return REPORT;
    });
    const judgeEngine = engine('judge', () => JSON.stringify({ product_decision: { noul: 0.05 }, stop_reason: { choice: 'holds', confidence: 0.95 } }));
    const { outcome } = await run(featureDelivery(config(cwd, builder, engine('reviewer', () => PASS()), {
      checks: [[process.execPath, '-e', 'process.exit(1)']],
      judge: seatOf(judgeEngine, 'judge'),
      cap: 2,
    })), { cwd });

    expect(outcome.status).not.toBe('pass');
    expect(outcome.commit).toBeUndefined();
    expect(judgeEngine.prompts).toHaveLength(0);
  });

  it('keeps the free proof send-back spent, and the report it read, across a resume', async () => {
    const { cwd } = repo();
    const record = join(cwd, 'records', 'run.jsonl');
    let builds = 0;
    const builder = () => engine('builder', (request) => {
      if (asks.report(request.prompt)) return `first report, corrected\n${REPORT}`;
      builds += 1;
      writeFileSync(join(request.cwd!, 'a.mjs'), `export const a = ${builds + 1};\n`);
      return `report of build ${builds}\n${REPORT}`;
    });
    let proofAsks = 0;
    let reviews = 0;
    const reviewer = (dies: boolean) => engine('reviewer', (request) => {
      if (asks.brief(request.prompt)) return PASS();
      if (asks.proof(request.prompt)) {
        proofAsks += 1;
        return proofAsks === 2 || proofAsks === 4 ? PASS() : REVISE(`proof 1: paste it (ask ${proofAsks})`);
      }
      if (dies) throw new Error('the reviewer process died');
      reviews += 1;
      return reviews === 1 ? REVISE('a.mjs:1 a must be 3') : PASS();
    });
    const job = (dies: boolean, seat: Engine) => featureDelivery(config(cwd, seat, reviewer(dies), { rounds: 3 }));

    const first = builder();
    expect((await run(job(true, first), { cwd, recordTo: record })).outcome.status).toBe('paused');
    const second = builder();
    const { outcome } = await run(job(false, second), { cwd, recordTo: record, resume: true });

    expect(outcome.status).toBe('pass');
    // The one free send-back went to the report before the pause; the later miss went to the build.
    const prompts = [...first.prompts, ...second.prompts];
    expect(prompts.filter((prompt) => asks.report(prompt))).toHaveLength(1);
    const laterMiss = second.prompts.find((prompt) => prompt.includes('proof 1: paste it (ask 3)'))!;
    expect(laterMiss).toContain('=== your report so far ===\nreport of build 2');
  });
});
