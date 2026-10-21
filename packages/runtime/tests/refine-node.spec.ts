/**
 * A `dag()` node with `agent` and `refine`: one node owns the seat that does
 * the work, the checks and goal that gate it, the reviewers and judge, the
 * fixer that repairs it, and the round policy that governs its own reviews
 * and the send-backs later nodes declare to it. `pipeline()` stages carry
 * the same fields to the dag they compile to.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { assertGraph, dag, EngineError, fnJob, goalCheck, jobMeta, judge, pipeline, review, revisionRequest, run, stage, workflow } from '../src/api.ts';
import type { AgentRequest, LoopEvent, TeamSeat } from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';
import { cleanupRepos, tmpRepo } from './git-helpers.ts';

const dirs: string[] = [];
afterEach(async () => {
  cleanupRepos();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const workDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'refine-node-'));
  dirs.push(dir);
  return dir;
};

const BRIEF = 'Use case: a reader gets a clear, short page.';

/** A seat whose declared family is the one `modelIdentity` derives from its model. */
const seat = (model: string, responder: (req: AgentRequest) => string, tools: readonly string[] = ['Read']): TeamSeat => ({
  engine: new MockEngine(responder),
  identity: { adapter: 'mock', provider: 'mock', modelFamily: model.split('-', 1)[0]!, model, tools },
});

const PASS = { status: 'pass', summary: 'nothing to add' };
const FINDING = { severity: 'should-fix', evidence: 'the title is vague' } as const;
const REVISE = { status: 'revise', summary: 'one finding', findings: [FINDING] };

/** A complete reply to the round questions: no product decision, a confident route. */
const round = (choice: string): Record<string, unknown> => ({
  product_decision: { noul: 0.05 },
  stop_reason: { choice, confidence: 0.95 },
});

/** Scripted replies, one per call; the last one repeats. Every prompt is kept. */
const scripted = (replies: readonly unknown[], calls: string[], write?: (req: AgentRequest, call: number) => void) =>
  new MockEngine((req: AgentRequest) => {
    calls.push(req.prompt);
    write?.(req, calls.length);
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    return JSON.stringify(typeof reply === 'function' ? (reply as (prompt: string) => unknown)(req.prompt) : reply);
  });

/** A writer seat that writes page.md, one draft per call. */
const writerOf = (calls: string[], text: (call: number) => string) => seat('alpha-one', (req) => {
  calls.push(req.prompt);
  writeFileSync(join(req.cwd!, 'page.md'), text(calls.length));
  return JSON.stringify({ status: 'pass', summary: `wrote draft ${calls.length}` });
}, ['Write']);

/** Keep the record up to and including the first event that matches, as if the worker died there. */
async function cutAfter(path: string, matches: (event: LoopEvent) => boolean): Promise<void> {
  const lines = (await readFile(path, 'utf8')).trim().split('\n');
  const cut = lines.findIndex((line) => matches(JSON.parse(line) as LoopEvent));
  expect(cut).toBeGreaterThanOrEqual(0);
  await writeFile(path, `${lines.slice(0, cut + 1).join('\n')}\n`);
}

describe('a dag node with agent and refine', () => {
  it('runs the checks first, and a red check sends the work straight back with no review that round', async () => {
    const cwd = workDir();
    const builderPrompts: string[] = [];
    const reviewerPrompts: string[] = [];
    const builder = seat('alpha-one', (req) => {
      builderPrompts.push(req.prompt);
      writeFileSync(join(req.cwd!, 'page.md'), builderPrompts.length === 1 ? 'no heading' : '# Title\n');
      return '{"status":"pass","summary":"wrote the page"}';
    }, ['Write']);
    const reviewer = seat('beta-one', (req) => {
      reviewerPrompts.push(req.prompt);
      return JSON.stringify(PASS);
    });
    const { outcome } = await run(dag({
      name: 'page',
      nodes: {
        build: {
          desc: 'Write the page.',
          agent: builder,
          writes: ['page.md'],
          refine: review({
            checks: [
              [
                'node', '-e',
                'const t=require("node:fs").readFileSync("page.md","utf8");'
                  + ' if (!t.startsWith("#")) { console.error("page has no title"); process.exit(1); }',
              ],
              // Runs only once check 1 passes: a red check ends the round's checks.
              ['node', '-e', 'require("node:fs").appendFileSync("check2.log", "x")'],
            ],
            reviewers: [reviewer],
            rounds: 3,
          }),
        },
      },
    }), { cwd });

    expect(outcome.status).toBe('pass');
    expect(builderPrompts).toHaveLength(2);
    // The red check ended round 1 before check 2 and before the panel ran.
    expect(reviewerPrompts).toHaveLength(1);
    expect(readFileSync(join(cwd, 'check2.log'), 'utf8')).toHaveLength(1);
    // The check's output reaches the builder as the previous review.
    expect(builderPrompts[1]).toContain('page has no title');
  });

  it('stops when a red check has sent the work back checkRounds times, and the reviewers never ran', async () => {
    const cwd = workDir();
    const builderPrompts: string[] = [];
    const reviewerPrompts: string[] = [];
    const builder = seat('alpha-one', (req) => {
      builderPrompts.push(req.prompt);
      writeFileSync(join(req.cwd!, 'page.md'), `no heading ${builderPrompts.length}`);
      return '{"status":"pass","summary":"wrote the page"}';
    }, ['Write']);
    const reviewer = seat('beta-one', (req) => {
      reviewerPrompts.push(req.prompt);
      return JSON.stringify(PASS);
    });
    const { outcome } = await run(dag({
      name: 'page',
      nodes: {
        build: {
          agent: builder,
          writes: ['page.md'],
          refine: review({
            checks: [['node', '-e', 'console.error("page has no title"); process.exit(1)']],
            reviewers: [reviewer],
            rounds: 5,
            checkRounds: 1,
          }),
        },
      },
    }), { cwd });

    expect(outcome.status).toBe('fail');
    // checkRounds 1 allows the one send-back the first red check caused.
    expect(builderPrompts).toHaveLength(2);
    expect(reviewerPrompts).toHaveLength(0);
    expect(outcome.summary).toContain('the checks sent the work back 1 times');
  });

  it('does not spend a review round on a red check', async () => {
    const cwd = workDir();
    const builderPrompts: string[] = [];
    const reviewerPrompts: string[] = [];
    const builder = seat('alpha-one', (req) => {
      builderPrompts.push(req.prompt);
      writeFileSync(join(req.cwd!, 'page.md'), builderPrompts.length === 1 ? 'no heading' : `# Title ${builderPrompts.length}\n`);
      return '{"status":"pass","summary":"wrote the page"}';
    }, ['Write']);
    const reviewer = seat('beta-one', (req) => {
      reviewerPrompts.push(req.prompt);
      return JSON.stringify(reviewerPrompts.length === 1 ? REVISE : PASS);
    });
    const { outcome } = await run(dag({
      name: 'page',
      nodes: {
        build: {
          agent: builder,
          writes: ['page.md'],
          refine: review({
            checks: [['node', '-e', 'const t=require("node:fs").readFileSync("page.md","utf8"); if (!t.startsWith("#")) process.exit(1)']],
            reviewers: [reviewer],
            rounds: 1,
            checkRounds: 2,
          }),
        },
      },
    }), { cwd });

    // rounds 1 allows one review send-back. The red check on round 1 draws
    // on checkRounds, so the reviewer's send-back still has the one round.
    expect(outcome.status).toBe('pass');
    expect(builderPrompts).toHaveLength(3);
    expect(reviewerPrompts).toHaveLength(2);
  });

  it('fails when the reviewers still reject after the refine rounds are spent', async () => {
    const cwd = workDir();
    const builderPrompts: string[] = [];
    const reviewerPrompts: string[] = [];
    const builder = seat('alpha-one', (req) => {
      builderPrompts.push(req.prompt);
      writeFileSync(join(req.cwd!, 'page.md'), `# draft ${builderPrompts.length}\n`);
      return '{"status":"pass","summary":"wrote the page"}';
    }, ['Write']);
    const reviewer = seat('beta-one', (req) => {
      reviewerPrompts.push(req.prompt);
      return JSON.stringify(REVISE);
    });
    const { outcome } = await run(dag({
      name: 'page',
      nodes: {
        build: {
          agent: builder,
          writes: ['page.md'],
          refine: review({
            checks: [['node', '-e', 'process.exit(0)']],
            reviewers: [reviewer],
            rounds: 1,
          }),
        },
      },
    }), { cwd });

    // rounds 1 pays for exactly one send-back: the second rejection stands
    // and no third build runs. The green check never spends a review round.
    expect(outcome.status).toBe('fail');
    expect(JSON.stringify(outcome)).toContain('no refinements left');
    expect(builderPrompts).toHaveLength(2);
    expect(reviewerPrompts).toHaveLength(2);
  });

  it('asks once more when a build reply is no team decision, then fails it', async () => {
    const cwd = workDir();
    const builderPrompts: string[] = [];
    const builder = seat('alpha-one', (req) => {
      builderPrompts.push(req.prompt);
      writeFileSync(join(req.cwd!, 'page.md'), '# Title\n');
      return 'wrote the page';
    }, ['Write']);
    let judgeCalls = 0;
    const judgeSeat = seat('judge-one', () => {
      judgeCalls += 1;
      return '{}';
    });
    const { outcome } = await run(dag({
      name: 'page',
      nodes: {
        build: {
          agent: builder,
          writes: ['page.md'],
          // An uncapped judge has no round budget to stop a retry: a failed
          // build must end the rounds itself, or the loop builds forever
          // with no feedback reaching it.
          refine: review({ reviewers: [seat('beta-one', () => JSON.stringify(PASS))], judge: judge(judgeSeat) }),
        },
      },
    }), { cwd });

    expect(outcome.status).toBe('fail');
    expect(outcome.summary).toContain('not a valid team decision JSON');
    // The seat is asked twice in all: the first reply and one retry, the
    // same as a reviewer that answers in prose gets.
    expect(builderPrompts).toHaveLength(2);
    expect(builderPrompts[1]).toContain('previous response was not a valid decision');
    expect(judgeCalls).toBe(0);
  });

  it('stops retrying a builder whose engine keeps failing, past the check budget', async () => {
    const cwd = workDir();
    // An uncapped judge sets no bound of its own on the rounds, so a build
    // that fails before its review can run — a retryable engine failure the
    // review never sees — counts on the same budget a failed check draws
    // on, three by default.
    let builderCalls = 0;
    const builder = seat('alpha-one', () => {
      builderCalls += 1;
      throw new Error('provider down');
    });
    let judgeCalls = 0;
    const judgeSeat = seat('judge-one', () => {
      judgeCalls += 1;
      return '{}';
    });
    const recordPath = join(cwd, 'record.jsonl');
    const { outcome } = await run(dag({
      name: 'page',
      nodes: {
        build: {
          agent: builder,
          writes: ['page.md'],
          refine: review({ reviewers: [seat('beta-one', () => JSON.stringify(PASS))], judge: judge(judgeSeat) }),
        },
      },
    }), { cwd, recordTo: recordPath });

    expect(outcome.status).toBe('fail');
    expect(builderCalls).toBe(4);
    // The node's own outcome in the record says why it stopped.
    expect(readFileSync(recordPath, 'utf8')).toContain('the build\'s failures sent the work back 3 times before its review could run');
    // No review of a failed build ever ran, so the judge was never asked.
    expect(judgeCalls).toBe(0);
  });

  it('counts only a run of unreviewed failures: a review that ran resets the count', async () => {
    const cwd = workDir();
    // One engine failure, a build whose review sends the work back, then
    // three more failures and a passing build: the count that ends the
    // rounds is the run of failures no gate or review saw, so a review
    // between them starts it over.
    let builderCalls = 0;
    const builder = seat('alpha-one', () => {
      builderCalls += 1;
      if (builderCalls === 1 || (builderCalls >= 3 && builderCalls <= 5)) throw new Error('provider down');
      return '{"status":"pass","summary":"wrote the page"}';
    });
    let reviewerCalls = 0;
    const reviewer = seat('beta-one', () => JSON.stringify((reviewerCalls += 1) === 1 ? REVISE : PASS));
    const judgeSeat = seat('judge-one', () => JSON.stringify(round('continue')));
    const { outcome } = await run(dag({
      name: 'page',
      nodes: {
        build: {
          agent: builder,
          refine: review({ reviewers: [reviewer], judge: judge(judgeSeat, { perFinding: false }) }),
        },
      },
    }), { cwd });

    expect(outcome.status).toBe('pass');
    expect(builderCalls).toBe(6);
  });

  it('spends a `rounds` node\'s failed builds from its own budget, not the unreviewed count', async () => {
    const cwd = workDir();
    // `rounds: 5` allows six builds in all; a builder that keeps failing
    // retryably runs them all out, the same as a plain rounds budget always
    // has — the count of unreviewed failures bounds a judged node, whose
    // rounds have no bound of their own.
    let builderCalls = 0;
    const builder = seat('alpha-one', () => {
      builderCalls += 1;
      throw new Error('provider down');
    });
    const { outcome } = await run(dag({
      name: 'page',
      nodes: {
        build: {
          agent: builder,
          refine: review({ reviewers: [seat('beta-one', () => JSON.stringify(PASS))], rounds: 5 }),
        },
      },
    }), { cwd });

    expect(outcome.status).toBe('fail');
    expect(outcome.summary).toContain('ran out of rounds');
    expect(builderCalls).toBe(6);
  });

  it('passes a build that deletes a file inside its declared writes', async () => {
    const cwd = workDir();
    writeFileSync(join(cwd, 'obsolete.md'), 'old content');
    const builder = seat('alpha-one', (req) => {
      writeFileSync(join(req.cwd!, 'page.md'), '# Title\n');
      rmSync(join(req.cwd!, 'obsolete.md'));
      return '{"status":"pass","summary":"wrote the page, removed the old one"}';
    }, ['Write']);
    const reviewer = seat('beta-one', () => JSON.stringify(PASS));
    const { outcome } = await run(dag({
      name: 'page',
      nodes: {
        build: {
          agent: builder,
          writes: ['page.md', 'obsolete.md'],
          refine: review({ reviewers: [reviewer], rounds: 1 }),
        },
      },
    }), { cwd });

    expect(outcome.status).toBe('pass');
    expect(() => readFileSync(join(cwd, 'obsolete.md'))).toThrow();
  });

  it('reuses a finished node whose deleted file was only in its writes scope', async () => {
    const cwd = workDir();
    const recordPath = join(cwd, 'record.jsonl');
    writeFileSync(join(cwd, 'obsolete.md'), 'old content');
    const builderPrompts: string[] = [];
    const builder = seat('alpha-one', (req) => {
      builderPrompts.push(req.prompt);
      writeFileSync(join(req.cwd!, 'page.md'), '# Title\n');
      rmSync(join(req.cwd!, 'obsolete.md'));
      return '{"status":"pass","summary":"wrote the page, removed the old one"}';
    }, ['Write']);
    const reviewer = seat('beta-one', () => JSON.stringify(PASS));
    const build = (shipFails: boolean) => dag({
      name: 'page',
      nodes: {
        write: {
          agent: builder,
          writes: ['page.md', 'obsolete.md'],
          refine: review({ reviewers: [reviewer], rounds: 1 }),
        },
        ship: {
          needs: 'write',
          job: fnJob('ship', () => shipFails
            ? { status: 'fail', summary: 'the registry is offline' }
            : { status: 'pass', summary: 'shipped' }),
        },
      },
    });
    const first = await run(build(true), { cwd, recordTo: recordPath });
    expect(first.outcome.status).toBe('fail');
    // The deleted file was write scope, not a required artifact: the
    // finished node is reused, not rebuilt or asked about.
    const resumed = await run(build(false), { cwd, recordTo: recordPath, resume: true });
    expect(resumed.outcome.status).toBe('pass');
    expect(builderPrompts).toHaveLength(1);
  });

  it('reads an empty file the node names as written, not as missing', async () => {
    const cwd = workDir();
    const builderPrompts: string[] = [];
    const builder = seat('alpha-one', (req) => {
      builderPrompts.push(req.prompt);
      writeFileSync(join(req.cwd!, 'page.md'), '');
      return '{"status":"pass","summary":"wrote an empty page"}';
    }, ['Write']);
    const reviewer = seat('beta-one', () => JSON.stringify(PASS));
    const { outcome } = await run(dag({
      name: 'page',
      nodes: {
        build: {
          agent: builder,
          writes: 'page.md',
          file: 'page.md',
          refine: review({ reviewers: [reviewer], rounds: 1 }),
        },
      },
    }), { cwd });

    expect(outcome.status).toBe('pass');
    expect(builderPrompts).toHaveLength(1);
  });

  it('runs the checks before it looks for the declared file, so a check that builds it counts', async () => {
    const cwd = workDir();
    const builderPrompts: string[] = [];
    const reviewerPrompts: string[] = [];
    const judgeDrafts: (string | undefined)[] = [];
    const builder = seat('alpha-one', (req) => {
      builderPrompts.push(req.prompt);
      writeFileSync(join(req.cwd!, 'page.src'), 'the source');
      return '{"status":"pass","summary":"wrote the source"}';
    }, ['Write']);
    const reviewer = seat('beta-one', (req) => {
      reviewerPrompts.push(req.prompt);
      return JSON.stringify(REVISE);
    });
    const judgeSeat = seat('judge-one', (req) => {
      const { state } = JSON.parse(req.prompt) as { state: { what: { draft?: string } } };
      judgeDrafts.push(state.what.draft);
      return JSON.stringify(round('holds'));
    });
    const { outcome } = await run(dag({
      name: 'page',
      nodes: {
        build: {
          agent: builder,
          writes: 'workspace',
          file: 'dist/page.md',
          refine: review({
            // The declared file is build output the first check makes, the
            // way `pnpm build` produces it: it cannot be looked for first.
            checks: [['node', '-e', 'require("node:fs").mkdirSync("dist"); require("node:fs").writeFileSync("dist/page.md", "# built\\n")']],
            reviewers: [reviewer],
            judge: judge(judgeSeat, { perFinding: false }),
          }),
        },
      },
    }), { cwd });

    expect(outcome.status).toBe('pass');
    expect(builderPrompts).toHaveLength(1);
    expect(reviewerPrompts).toHaveLength(1);
    // The reviewer rejected, so the judge is asked: it reads the file the
    // check left, not the absence that stood when the round began.
    expect(judgeDrafts).toEqual(['# built\n']);
    expect(readFileSync(join(cwd, 'dist', 'page.md'), 'utf8')).toBe('# built\n');
  });

  it('reads each finding once in the next build\'s prompt', async () => {
    const cwd = workDir();
    const builderPrompts: string[] = [];
    const builder = seat('alpha-one', (req) => {
      builderPrompts.push(req.prompt);
      writeFileSync(join(req.cwd!, 'page.md'), `draft ${builderPrompts.length}`);
      return '{"status":"pass","summary":"wrote the page"}';
    }, ['Write']);
    const reviewer = seat('beta-one', () => JSON.stringify(builderPrompts.length === 1 ? REVISE : PASS));
    const { outcome } = await run(dag({
      name: 'page',
      nodes: {
        build: {
          agent: builder,
          writes: 'page.md',
          refine: review({ reviewers: [reviewer], rounds: 2 }),
        },
      },
    }), { cwd });

    expect(outcome.status).toBe('pass');
    expect(builderPrompts).toHaveLength(2);
    expect(builderPrompts[1]!.split('the title is vague').length - 1).toBe(1);
  });

  it('sends the kept findings to the fixer seat when one is declared', async () => {
    const cwd = workDir();
    const builderPrompts: string[] = [];
    const fixerPrompts: string[] = [];
    const reviewerPrompts: string[] = [];
    const builder = seat('alpha-one', (req) => {
      builderPrompts.push(req.prompt);
      writeFileSync(join(req.cwd!, 'page.md'), 'no heading');
      return '{"status":"pass","summary":"wrote the page"}';
    }, ['Write']);
    const fixer = seat('alpha-two', (req) => {
      fixerPrompts.push(req.prompt);
      writeFileSync(join(req.cwd!, 'page.md'), '# Title\n');
      return '{"status":"pass","summary":"added the title"}';
    }, ['Write']);
    const reviewer = seat('beta-one', (req) => {
      reviewerPrompts.push(req.prompt);
      return JSON.stringify(reviewerPrompts.length === 1 ? REVISE : PASS);
    });
    const { outcome } = await run(dag({
      name: 'page',
      nodes: {
        build: {
          agent: builder,
          writes: ['page.md'],
          refine: review({ reviewers: [reviewer], fixer, rounds: 1 }),
        },
      },
    }), { cwd });

    expect(outcome.status).toBe('pass');
    expect(builderPrompts).toHaveLength(1);
    // Round 2 belongs to the fixer, with the review's finding in its prompt.
    expect(fixerPrompts).toHaveLength(1);
    expect(fixerPrompts[0]).toContain('the title is vague');
    expect(reviewerPrompts).toHaveLength(2);
  });

  it.each([
    ['a crashed engine', () => { throw new Error('review cli is not installed'); }],
    ['an engine that refused to start', () => { throw new EngineError({ kind: 'invalid-config', message: 'review cli version is unsupported' }); }],
  ] as const)('pauses the run when a reviewer fails (%s): an operational error, not a finding', async (_label, fail) => {
    const cwd = workDir();
    const builderPrompts: string[] = [];
    const builder = seat('alpha-one', (req) => {
      builderPrompts.push(req.prompt);
      writeFileSync(join(req.cwd!, 'page.md'), '# Title\n');
      return '{"status":"pass","summary":"wrote the page"}';
    }, ['Write']);
    const reviewer = seat('beta-one', fail);
    const { outcome } = await run(dag({
      name: 'page',
      nodes: {
        build: {
          agent: builder,
          writes: ['page.md'],
          refine: review({ reviewers: [reviewer], rounds: 3 }),
        },
      },
    }), { cwd });

    // A reviewer that never answered is not a refusal and sends nothing back.
    expect(outcome.status).toBe('paused');
    expect(builderPrompts).toHaveLength(1);
  });

  it('refuses a reviewer seat in the builder model family when the graph is built', () => {
    const builder = seat('shared-one', () => '{"status":"pass","summary":"wrote the page"}', ['Write']);
    const reviewer = seat('shared-two', () => JSON.stringify(PASS));
    expect(() => dag({
      name: 'page',
      nodes: {
        build: {
          agent: builder,
          writes: ['page.md'],
          refine: review({ reviewers: [reviewer], rounds: 1 }),
        },
      },
    })).toThrow('same model family shared');
    // The fixer is a writer of the node too: it answers to the same rule.
    expect(() => dag({
      name: 'page',
      nodes: {
        build: {
          agent: seat('alpha-one', () => '{"status":"pass","summary":"wrote the page"}', ['Write']),
          writes: ['page.md'],
          refine: review({ reviewers: [reviewer], fixer: seat('shared-three', () => '{"status":"pass","summary":"fixed"}', ['Write']), rounds: 1 }),
        },
      },
    })).toThrow('same model family shared');
  });

  it('fails work the builder returns unchanged after a send-back', async () => {
    const cwd = workDir();
    const builderPrompts: string[] = [];
    const builder = seat('alpha-one', (req) => {
      builderPrompts.push(req.prompt);
      writeFileSync(join(req.cwd!, 'page.md'), 'the same draft');
      return '{"status":"pass","summary":"wrote the page"}';
    }, ['Write']);
    const reviewer = seat('beta-one', () => JSON.stringify(REVISE));
    const { outcome } = await run(dag({
      name: 'page',
      nodes: {
        build: {
          agent: builder,
          writes: ['page.md'],
          refine: review({ reviewers: [reviewer], rounds: 1 }),
        },
      },
    }), { cwd });

    expect(outcome.status).toBe('fail');
    expect(builderPrompts).toHaveLength(2);
    expect(outcome.summary).toContain('returned the reviewed work unchanged');
  });

  it('measures a send-back\'s repair against the files before the first ask, not between the two asks', async () => {
    const cwd = workDir();
    const builderPrompts: string[] = [];
    const reviewerPrompts: string[] = [];
    const builder = seat('alpha-one', (req) => {
      builderPrompts.push(req.prompt);
      if (builderPrompts.length === 1) writeFileSync(join(req.cwd!, 'page.md'), '# draft\n');
      if (builderPrompts.length === 2) {
        // The repair lands, but the reply is prose: the decision retry that
        // follows changes nothing more — it must still see the changed work.
        writeFileSync(join(req.cwd!, 'page.md'), '# repaired\n');
        return 'repaired the page';
      }
      return '{"status":"pass","summary":"wrote the page"}';
    }, ['Write']);
    const reviewer = seat('beta-one', (req) => {
      reviewerPrompts.push(req.prompt);
      return JSON.stringify(reviewerPrompts.length === 1 ? REVISE : PASS);
    });
    const { outcome } = await run(dag({
      name: 'page',
      nodes: {
        build: {
          agent: builder,
          writes: ['page.md'],
          refine: review({ reviewers: [reviewer], rounds: 1 }),
        },
      },
    }), { cwd });

    expect(outcome.status).toBe('pass');
    expect(builderPrompts).toHaveLength(3);
    expect(builderPrompts[2]).toContain('previous response was not a valid decision');
    expect(reviewerPrompts).toHaveLength(2);
  });

  it('asks the judge about each finding and sends back only the ones it calls impactful', async () => {
    const cwd = workDir();
    const builderPrompts: string[] = [];
    let judgeCalls = 0;
    const builder = seat('alpha-one', (req) => {
      builderPrompts.push(req.prompt);
      writeFileSync(join(req.cwd!, 'page.md'), `draft ${builderPrompts.length}`);
      return '{"status":"pass","summary":"wrote the page"}';
    }, ['Write']);
    let reviewRound = 0;
    const reviewer = seat('beta-one', () => {
      reviewRound += 1;
      return JSON.stringify({
        status: 'revise',
        summary: 'two findings',
        findings: [
          ...(reviewRound === 1
            ? [{ severity: 'block' as const, evidence: 'REAL: the page never says who it is for' }]
            : []),
          { severity: 'nice-to-have' as const, evidence: 'taste: prefer a warmer tone' },
        ],
      });
    });
    const judgeSeat = seat('judge-one', (req) => {
      judgeCalls += 1;
      const { questions } = JSON.parse(req.prompt) as { questions: Record<string, { type: string; instructions: string }> };
      return JSON.stringify({
        ...round('continue'),
        ...Object.fromEntries(Object.entries(questions)
          .filter(([id]) => id.startsWith('finding-'))
          .map(([id, question]) => [id, question.instructions.includes('REAL')
            ? { score: 2, confidence: 0.95, reason: 'a reader cannot tell who the page is for' }
            : { score: 0, confidence: 0.95, reason: 'a matter of taste' }])),
      });
    });
    const { outcome } = await run(dag({
      name: 'page',
      brief: BRIEF,
      nodes: {
        build: {
          desc: 'Write the page.',
          gate: 'A reader can tell who the page is for.',
          agent: builder,
          writes: ['page.md'],
          refine: review({ reviewers: [reviewer], judge: judge(judgeSeat, { cap: 2 }) }),
        },
      },
    }), { cwd });

    // Round 1's block is called impactful; the finding the judge calls
    // minor stays held back in both rounds, and round 2's ships the work.
    expect(outcome.status).toBe('pass');
    // Two consultations of two calls each: the finding scores, then the
    // round questions.
    expect(judgeCalls).toBe(4);
    expect(builderPrompts).toHaveLength(2);
    // The builder sees only the finding the judge called impactful, with its reason.
    expect(builderPrompts[1]).toContain('REAL: the page never says who it is for');
    expect(builderPrompts[1]).not.toContain('prefer a warmer tone');
  });

  it('lets an agent reply of revise send the work back on a declared route', async () => {
    const cwd = workDir();
    let plans = 0;
    const planPrompts: string[] = [];
    const planner = seat('alpha-one', (req) => {
      planPrompts.push(req.prompt);
      plans += 1;
      return '{"status":"pass","summary":"planned"}';
    });
    const reviewer = seat('beta-one', () => '{"status":"pass","summary":"ok"}');
    const implementerCalls: string[] = [];
    const implementer = seat('gamma-one', (req) => {
      implementerCalls.push(req.prompt);
      return JSON.stringify(implementerCalls.length === 1
        ? { status: 'revise', summary: 'the plan misses the edge case' }
        : { status: 'pass', summary: 'done' });
    });
    const { outcome } = await run(dag({
      name: 'page',
      nodes: {
        plan: {
          agent: planner,
          refine: review({ reviewers: [reviewer], rounds: 2 }),
        },
        implement: {
          needs: 'plan',
          agent: implementer,
          sendsBackTo: 'plan',
        },
      },
    }), { cwd });

    expect(outcome.status).toBe('pass');
    expect(plans).toBe(2);
    // The send-back's reason reaches the planner as the previous review.
    expect(planPrompts[1]).toContain('the plan misses the edge case');
    expect(implementerCalls).toHaveLength(2);
  });

  it('fails an agent reply that sends work to a route it does not declare', async () => {
    const cwd = workDir();
    const events: LoopEvent[] = [];
    let plans = 0;
    const planner = seat('alpha-one', () => {
      plans += 1;
      return '{"status":"pass","summary":"planned"}';
    });
    const implementer = seat('beta-one', () => JSON.stringify({
      status: 'revise', summary: 'wrong target', target: 'plan',
    }));
    const { outcome } = await run(dag({
      name: 'page',
      nodes: {
        plan: {
          agent: planner,
          refine: review({ rounds: 2 }),
        },
        implement: {
          needs: 'plan',
          agent: implementer,
        },
      },
    }), { cwd, onEvent: (event) => events.push(event) });

    // A node with no sendsBackTo never reads the reply's target: the revise
    // stands as an ordinary rejection of its own work, so plan ran once and
    // nothing was sent back to it.
    expect(outcome.status).toBe('fail');
    expect(JSON.stringify(outcome.data)).toContain('wrong target');
    expect(plans).toBe(1);
    expect(events.filter((event) => event.kind === 'dag:kickback')).toHaveLength(0);
  });

  it('lets an agent choose between the routes it declares, and refuses a target outside them', async () => {
    const cwd = workDir();
    let research = 0;
    const researcher = seat('alpha-one', () => {
      research += 1;
      return '{"status":"pass","summary":"researched"}';
    });
    const planner = seat('alpha-two', () => '{"status":"pass","summary":"planned"}');
    const implementerCalls: string[] = [];
    const implementer = seat('gamma-one', (req) => {
      implementerCalls.push(req.prompt);
      return JSON.stringify(implementerCalls.length === 1
        ? { status: 'revise', summary: 'needs the research first', target: 'research' }
        : { status: 'pass', summary: 'done' });
    });
    const { outcome } = await run(dag({
      name: 'page',
      nodes: {
        research: {
          agent: researcher,
          refine: review({ rounds: 2 }),
        },
        plan: {
          needs: 'research',
          agent: planner,
          refine: review({ rounds: 2 }),
        },
        implement: {
          needs: ['research', 'plan'],
          agent: implementer,
          sendsBackTo: ['research', 'plan'],
        },
      },
    }), { cwd });

    expect(outcome.status).toBe('pass');
    expect(research).toBe(2);
    expect(implementerCalls).toHaveLength(2);

    const offRoute = seat('delta-one', () => JSON.stringify({
      status: 'revise', summary: 'send it to qa', target: 'qa',
    }));
    const refused = await run(dag({
      name: 'page',
      nodes: {
        research: {
          agent: seat('alpha-one', () => '{"status":"pass","summary":"researched"}'),
          refine: review({ rounds: 2 }),
        },
        plan: {
          needs: 'research',
          agent: seat('alpha-two', () => '{"status":"pass","summary":"planned"}'),
          refine: review({ rounds: 2 }),
        },
        implement: {
          needs: ['research', 'plan'],
          agent: offRoute,
          sendsBackTo: ['research', 'plan'],
        },
      },
    }), { cwd: workDir() });

    expect(refused.outcome.status).toBe('fail');
    expect(JSON.stringify(refused.outcome)).toContain('not a valid team decision');
  });

  it('sends a refined sender\'s targeted revise back before its own checks and reviews see it', async () => {
    const cwd = workDir();
    let plans = 0;
    const planner = seat('alpha-one', () => {
      plans += 1;
      return '{"status":"pass","summary":"planned"}';
    });
    const reviewer = seat('beta-one', () => '{"status":"pass","summary":"ok"}');
    const implementerCalls: string[] = [];
    const implementer = seat('gamma-one', (req) => {
      implementerCalls.push(req.prompt);
      return JSON.stringify(implementerCalls.length === 1
        ? { status: 'revise', summary: 'the plan misses the edge case', target: 'plan' }
        : { status: 'pass', summary: 'done' });
    });
    const { outcome } = await run(dag({
      name: 'page',
      nodes: {
        plan: {
          agent: planner,
          refine: review({ rounds: 2 }),
        },
        implement: {
          needs: 'plan',
          agent: implementer,
          sendsBackTo: 'plan',
          refine: review({ reviewers: [reviewer], rounds: 2 }),
        },
      },
    }), { cwd });

    // The revise to 'plan' routed out of implement's own rounds: the plan
    // was built again even though implement's reviewer would have passed.
    expect(outcome.status).toBe('pass');
    expect(plans).toBe(2);
    expect(implementerCalls).toHaveLength(2);
  });

  it('shares one round count between the node\'s own reviews and a send-back to it', async () => {
    const cwd = workDir();
    const events: LoopEvent[] = [];
    const builderPrompts: string[] = [];
    let reviews = 0;
    let accepts = 0;
    const builder = seat('alpha-one', (req) => {
      builderPrompts.push(req.prompt);
      return '{"status":"pass","summary":"draft"}';
    });
    const reviewer = seat('beta-one', () => {
      reviews += 1;
      return JSON.stringify(reviews === 1 ? REVISE : PASS);
    });
    const { outcome } = await run(dag({
      name: 'page',
      nodes: {
        write: {
          agent: builder,
          refine: review({ reviewers: [reviewer], rounds: 1 }),
        },
        accept: {
          needs: 'write',
          sendsBackTo: 'write',
          job: fnJob('accept', () => {
            accepts += 1;
            return revisionRequest({ target: 'write', reason: 'outside review says no' });
          }),
        },
      },
    }), { cwd, onEvent: (event) => events.push(event) });

    // The node's own reviewer used the one send-back `rounds: 1` allows, so
    // `accept` asking for another is refused and the dag fails.
    expect(outcome.status).toBe('fail');
    expect(accepts).toBe(1);
    expect(builderPrompts).toHaveLength(2);
    expect(reviews).toBe(2);
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'dag:kickback',
      from: 'accept',
      to: 'write',
      accepted: false,
      note: 'send-back budget for "write" (1) exhausted',
    }));
  });

  it('lets the judge read the rounds the node ran on its own reviews when a send-back arrives', async () => {
    const cwd = workDir();
    const whens: { round: number; rounds: { round: number }[] }[] = [];
    let accepts = 0;
    const builder = seat('alpha-one', () => '{"status":"pass","summary":"draft"}');
    let reviews = 0;
    const reviewer = seat('beta-one', () => {
      reviews += 1;
      return JSON.stringify(reviews === 1 || reviews === 3 ? REVISE : PASS);
    });
    const judgeSeat = seat('judge-one', (req) => {
      whens.push((JSON.parse(req.prompt) as { state: { when: { round: number; rounds: { round: number }[] } } }).state.when);
      return JSON.stringify(round('continue'));
    });
    const { outcome } = await run(dag({
      name: 'page',
      nodes: {
        write: {
          agent: builder,
          refine: review({ reviewers: [reviewer], judge: judge(judgeSeat, { cap: 3, perFinding: false }) }),
        },
        accept: {
          needs: 'write',
          sendsBackTo: 'write',
          job: fnJob('accept', () => {
            accepts += 1;
            return accepts === 1
              ? revisionRequest({ target: 'write', reason: 'outside review says no' })
              : { status: 'pass' };
          }),
        },
      },
    }), { cwd });

    expect(outcome.status).toBe('pass');
    // The judge's second question — the send-back it allowed — already reads
    // round 1, the node's own review. Its third — the send-back round's own
    // review — reads both earlier rounds.
    expect(whens).toHaveLength(3);
    expect(whens[1]!.rounds.map((entry) => entry.round)).toEqual([1]);
    expect(whens[2]!.round).toBe(3);
    expect(whens[2]!.rounds.map((entry) => entry.round)).toEqual([1, 2]);
  });

  it('sends a build that leaves its file missing back, bounded by checkRounds, under an uncapped judge', async () => {
    const cwd = workDir();
    const builderPrompts: string[] = [];
    let reviews = 0;
    let judgeCalls = 0;
    const builder = seat('alpha-one', (req) => {
      builderPrompts.push(req.prompt);
      writeFileSync(join(req.cwd!, 'notes.md'), `draft ${builderPrompts.length}`);
      return '{"status":"pass","summary":"wrote the page"}';
    }, ['Write']);
    const { outcome } = await run(dag({
      name: 'page',
      nodes: {
        build: {
          agent: builder,
          writes: ['notes.md'],
          file: 'page.md',
          // With no cap on the judge there is no round budget to stop the
          // retry: the missing artifact sends back through checkRounds alone.
          refine: review({ reviewers: [seat('beta-one', () => { reviews += 1; return JSON.stringify(PASS); })], judge: judge(seat('judge-one', () => { judgeCalls += 1; return '{}'; })) }),
        },
      },
    }), { cwd });

    expect(outcome.status).toBe('fail');
    expect(outcome.summary).toContain('the checks sent the work back 3 times');
    // One first build and the three send-backs checkRounds allows; the
    // missing file kept the reviewers and the judge from ever running.
    expect(builderPrompts).toHaveLength(4);
    expect(reviews).toBe(0);
    expect(judgeCalls).toBe(0);
    // The send-back names the missing file for the builder that follows it.
    expect(builderPrompts[1]).toContain('page.md');
  });

  it('bounds a workflow() stage that leaves its write missing by the same checkRounds', async () => {
    const cwd = workDir();
    const builderPrompts: string[] = [];
    let reviews = 0;
    let judgeCalls = 0;
    const builder = seat('alpha-one', (req) => {
      builderPrompts.push(req.prompt);
      writeFileSync(join(req.cwd!, 'notes.md'), `draft ${builderPrompts.length}`);
      return '{"status":"pass","summary":"wrote the page"}';
    }, ['Write']);
    const { outcome } = await run(workflow('page', {
      brief: BRIEF,
      roles: { writer: builder, reviewer: [seat('beta-one', () => { reviews += 1; return JSON.stringify(PASS); })] },
      stages: [stage('write', {
        agent: 'writer',
        // notes.md changes each round so the unchanged-work guard stays out of
        // the way; page.md never lands and draws on the check budget alone.
        writes: ['page.md', 'notes.md'],
        reviewedBy: 'reviewer',
        // With no cap on the judge there is no round budget to stop the
        // retry: the missing write sends back through the check budget alone.
        refine: judge(seat('judge-one', () => { judgeCalls += 1; return '{}'; })),
      })],
    }), { cwd });

    expect(outcome.status).toBe('fail');
    expect(outcome.summary).toContain('the checks sent the work back 3 times');
    // One first build and the three send-backs the check budget allows; the
    // missing write kept the reviewers and the judge from ever running.
    expect(builderPrompts).toHaveLength(4);
    expect(reviews).toBe(0);
    expect(judgeCalls).toBe(0);
    expect(builderPrompts[1]).toContain('page.md');
  });

  it('lets a workspace write repair a file outside the judge\'s artifact', async () => {
    const cwd = workDir();
    const builderPrompts: string[] = [];
    const reviewerPrompts: string[] = [];
    const builder = seat('alpha-one', (req) => {
      builderPrompts.push(req.prompt);
      writeFileSync(join(req.cwd!, 'page.md'), 'the draft');
      if (builderPrompts.length > 1) writeFileSync(join(req.cwd!, 'helper.md'), `fix ${builderPrompts.length}`);
      return '{"status":"pass","summary":"wrote the page"}';
    }, ['Write']);
    const reviewer = seat('beta-one', (req) => {
      reviewerPrompts.push(req.prompt);
      return JSON.stringify(reviewerPrompts.length === 1 ? REVISE : PASS);
    });
    const { outcome } = await run(dag({
      name: 'page',
      nodes: {
        build: {
          agent: builder,
          writes: 'workspace',
          file: 'page.md',
          refine: review({ reviewers: [reviewer], rounds: 2 }),
        },
      },
    }), { cwd });

    // The fix landed in helper.md: 'workspace' scopes the whole run
    // workspace, so the repair counts as a change even though page.md did
    // not move.
    expect(outcome.status).toBe('pass');
    expect(builderPrompts).toHaveLength(2);
    expect(reviewerPrompts).toHaveLength(2);
  });

  it('tells the reviewers of a workspace write to judge the work, not only its declared file', async () => {
    const cwd = workDir();
    const reviewerPrompts: string[] = [];
    const builder = seat('alpha-one', (req) => {
      writeFileSync(join(req.cwd!, 'report.md'), '# report\n');
      writeFileSync(join(req.cwd!, 'page.src'), 'the source');
      return '{"status":"pass","summary":"wrote the report and the source"}';
    }, ['Write']);
    const reviewer = seat('beta-one', (req) => {
      reviewerPrompts.push(req.prompt);
      return JSON.stringify(PASS);
    });
    const { outcome } = await run(dag({
      name: 'page',
      nodes: {
        build: {
          agent: builder,
          writes: 'workspace',
          file: 'report.md',
          refine: review({ reviewers: [reviewer], rounds: 1 }),
        },
      },
    }), { cwd });

    expect(outcome.status).toBe('pass');
    // 'workspace' scopes the whole run workspace: the review reads the
    // node's work, not only the file the judge and a resume read.
    expect(reviewerPrompts[0]).toContain('Review target: the work the node did.');
    expect(reviewerPrompts[0]).not.toContain('Review target: report.md');
  });

  it('counts a repair to a Git-ignored declared file when writes is the workspace', async () => {
    const cwd = await tmpRepo();
    writeFileSync(join(cwd, '.gitignore'), 'report.md\n');
    execFileSync('git', ['add', '.gitignore'], { cwd });
    execFileSync('git', ['commit', '-m', 'chore: ignore the report'], { cwd });
    const builderPrompts: string[] = [];
    const reviewerPrompts: string[] = [];
    const builder = seat('alpha-one', (req) => {
      builderPrompts.push(req.prompt);
      writeFileSync(join(req.cwd!, 'report.md'), `draft ${builderPrompts.length}`);
      return '{"status":"pass","summary":"wrote the report"}';
    }, ['Write']);
    const reviewer = seat('beta-one', (req) => {
      reviewerPrompts.push(req.prompt);
      return JSON.stringify(reviewerPrompts.length === 1 ? REVISE : PASS);
    });
    const { outcome } = await run(dag({
      name: 'page',
      nodes: {
        build: {
          agent: builder,
          writes: 'workspace',
          file: 'report.md',
          refine: review({ reviewers: [reviewer], rounds: 1 }),
        },
      },
    }), { cwd });

    // The repair touched only report.md, which Git ignores: 'workspace'
    // scope still counts the declared file, so the work is not "unchanged".
    expect(outcome.status).toBe('pass');
    expect(builderPrompts).toHaveLength(2);
    expect(reviewerPrompts).toHaveLength(2);
  });

  it('resumes after an unmet-goal round with its feedback', async () => {
    const cwd = workDir();
    const recordPath = join(cwd, 'record.jsonl');
    const MET_REQ = { requirement: 'The page names who it is for', verdict: 'met', evidence: 'page.md:1' };
    const UNMET_REQ = { requirement: 'The page lists the opening hours', verdict: 'unmet', evidence: 'MISSING: page.md has no opening hours' };
    // The first goal check finds the requirement unmet; the round's next two
    // goal calls come back unreadable, which pauses the run mid-round — after
    // the send-back, before the next round's review.
    let goalCalls = 0;
    const firstGoal = seat('goal-one', () => {
      goalCalls += 1;
      return goalCalls === 1
        ? JSON.stringify({ requirements: [MET_REQ, UNMET_REQ] })
        : 'no list here';
    });
    const builderPrompts: string[] = [];
    const firstBuilder = seat('alpha-one', (req) => {
      builderPrompts.push(req.prompt);
      writeFileSync(join(req.cwd!, 'page.md'), `draft ${builderPrompts.length}`);
      return '{"status":"pass","summary":"wrote the page"}';
    }, ['Write']);
    const build = (goalSeat: TeamSeat, agent: TeamSeat) => dag({
      name: 'page',
      brief: BRIEF,
      nodes: {
        write: {
          agent,
          writes: 'page.md',
          file: 'page.md',
          refine: review({
            goal: goalCheck(goalSeat, { target: 'write', text: BRIEF }),
            reviewers: [seat('beta-one', () => JSON.stringify(PASS))],
            rounds: 2,
          }),
        },
      },
    });

    // Round 1's goal check finds a requirement unmet and sends the work back;
    // the pause lands in round 2's goal check, before that round's review.
    const events: LoopEvent[] = [];
    const first = await run(build(firstGoal, firstBuilder), { cwd, recordTo: recordPath, onEvent: (event) => events.push(event) });
    expect(first.outcome.status).toBe('paused');
    expect(builderPrompts).toHaveLength(2);
    // The unmet-goal round saved its feedback for the build that follows:
    // a crash or pause resumes with it instead of losing the round.
    const kickbacks = events.flatMap((event) => event.kind === 'interaction:checkpoint'
      ? Object.keys((event.data as { kickbacks?: Record<string, unknown> } | undefined)?.kickbacks ?? {})
      : []);
    expect(kickbacks).toContain('write');
    // The send-back reached the next build's prompt: the unmet requirement,
    // once, with the evidence the goal seat gave.
    expect(builderPrompts[1]!.split('The page lists the opening hours').length - 1).toBe(1);

    // A fresh worker resumes in the paused round's review: the build it
    // already finished is not repeated, and the goal's unreadable replies
    // re-run against the new seat.
    const resumedBuilder = seat('alpha-one', (req) => {
      builderPrompts.push(req.prompt);
      writeFileSync(join(req.cwd!, 'page.md'), 'the repaired page');
      return '{"status":"pass","summary":"wrote the page"}';
    }, ['Write']);
    const resumed = await run(
      build(seat('goal-one', () => JSON.stringify({ requirements: [MET_REQ] })), resumedBuilder),
      { cwd, recordTo: recordPath, resume: true },
    );
    expect(resumed.outcome.status).toBe('pass');
    expect(builderPrompts).toHaveLength(2);
  });

  it('resumes a crashed round with the judge history it recorded', async () => {
    const cwd = workDir();
    const recordPath = join(cwd, 'record.jsonl');
    const builderPrompts: string[] = [];
    const reviewerPrompts: string[] = [];
    const judgePrompts: string[] = [];
    const builder = seat('alpha-one', (req) => {
      builderPrompts.push(req.prompt);
      writeFileSync(join(req.cwd!, 'page.md'), `draft ${builderPrompts.length}`);
      return '{"status":"pass","summary":"wrote the page"}';
    }, ['Write']);
    const reviewer = seat('beta-one', (req) => {
      reviewerPrompts.push(req.prompt);
      return JSON.stringify(REVISE);
    });
    const judgeSeat = seat('judge-one', (req) => {
      judgePrompts.push(req.prompt);
      return JSON.stringify(round('continue'));
    });
    const build = () => dag({
      name: 'page',
      nodes: {
        write: {
          agent: builder,
          writes: ['page.md'],
          // The worker's death leaves the node mid-round: only a node
          // declared safe to retry continues without asking a person.
          retrySafe: true,
          refine: review({ reviewers: [reviewer], judge: judge(judgeSeat, { cap: 1, perFinding: false }) }),
        },
      },
    });

    // Round 1 builds, reviews and is judged; the send-back is saved and the
    // second round is about to build when the worker dies: the record ends
    // right after the checkpoint that saved it.
    const first = await run(build(), { cwd, recordTo: recordPath });
    expect(first.outcome.status).toBe('fail');
    await cutAfter(recordPath, (event) =>
      event.kind === 'interaction:checkpoint'
      && event.path.at(-1) === '@interaction-loop'
      && (event.data as { phase?: unknown; iteration?: unknown } | undefined)?.phase === 'body'
      && (event.data as { phase?: unknown; iteration?: unknown } | undefined)?.iteration === 2);

    // The resume continues in round 2: its build and its review run again,
    // and the judge sees round 2 with round 1 in its history.
    const resumed = await run(build(), { cwd, recordTo: recordPath, resume: true });
    expect(resumed.outcome.status).toBe('fail');
    expect(builderPrompts).toHaveLength(3);
    expect(reviewerPrompts).toHaveLength(3);
    expect(judgePrompts).toHaveLength(3);
    const seen = judgePrompts.map((prompt) => (JSON.parse(prompt) as { state: { when: { round: number; rounds: unknown[] } } }).state.when);
    expect(seen.at(-1)).toMatchObject({ round: 2 });
    expect(seen.at(-1)!.rounds).toHaveLength(1);
  });

  it('gives the same scripted seats the same outcome and record through workflow() and dag()', async () => {
    const runForm = async (form: 'workflow' | 'dag', goalReplies?: readonly unknown[], cap = 2) => {
      const cwd = workDir();
      const events: LoopEvent[] = [];
      const calls = { writer: [] as string[], reviewer: [] as string[], judge: [] as string[], goal: [] as string[] };
      const writer = seat('writer-mock', (req) => {
        calls.writer.push(req.prompt);
        writeFileSync(join(req.cwd!, 'page.md'), `draft ${calls.writer.length}`);
        return JSON.stringify({ status: 'pass', summary: `wrote draft ${calls.writer.length}` });
      }, ['Write']);
      const reviewer = seat('reviewer-mock', (req) => {
        calls.reviewer.push(req.prompt);
        return JSON.stringify(calls.reviewer.length === 1 ? REVISE : PASS);
      });
      const judgeSeat = seat('judge-mock', (req) => {
        calls.judge.push(req.prompt);
        return JSON.stringify(round('continue'));
      });
      const goalSeat = goalReplies === undefined ? undefined : seat('goal-mock', (req) => {
        calls.goal.push(req.prompt);
        return JSON.stringify(goalReplies[Math.min(calls.goal.length - 1, goalReplies.length - 1)]);
      });
      const job = form === 'workflow'
        ? workflow('page', {
          brief: BRIEF,
          roles: { writer, reviewer: [reviewer] },
          stages: [stage('write', {
            agent: 'writer',
            writes: 'page.md',
            ...(goalSeat === undefined ? {} : { goal: goalSeat }),
            reviewedBy: 'reviewer',
            refine: judge(judgeSeat, { cap, perFinding: false }),
          })],
        })
        : dag({
          name: 'page',
          brief: BRIEF,
          nodes: {
            write: {
              agent: writer,
              writes: 'page.md',
              // What the workflow stage becomes: a node whose first write is
              // the artifact the judge reads.
              file: 'page.md',
              refine: review({
                reviewers: [reviewer],
                ...(goalSeat === undefined ? {} : { goal: goalCheck(goalSeat, { target: 'write', text: BRIEF }) }),
                judge: judge(judgeSeat, { cap, perFinding: false }),
              }),
            },
          },
        });
      const result = await run(job, { cwd, onEvent: (event) => events.push(event) });
      const verdict = (result.outcome.data as Record<string, { status: string; summary?: string }> | undefined)?.write;
      return { result, verdict, calls, events, cwd };
    };

    // Every event both forms emit for the same work, with only what a second
    // run cannot reproduce left out: the timestamps, the event paths, the
    // run's own record and interaction ids, its workspace dir, and the
    // durations it timed. The loop's bound matches too: the node's `file`
    // and the stage's declared write each pay the same `checkRounds`
    // send-back budget on top of the review rounds.
    const recordOf = (ran: { events: LoopEvent[]; cwd: string }) =>
      ran.events.map((event) => {
        const parsed = JSON.parse(JSON.stringify(event).replaceAll(ran.cwd, '<cwd>'), (key, value) =>
          key === 'ts' || key === 'path' || key === 'recordId' || key === 'identity' || key === 'durationMs' ? undefined : value);
        return parsed;
      });

    const wf = await runForm('workflow');
    const dg = await runForm('dag');
    for (const ran of [wf, dg]) {
      expect(ran.result.outcome.status).toBe('pass');
      expect(ran.verdict?.status).toBe('pass');
      expect(ran.calls.writer).toHaveLength(2);
      expect(ran.calls.reviewer).toHaveLength(2);
      expect(ran.calls.judge).toHaveLength(1);
    }
    expect(recordOf(dg)).toEqual(recordOf(wf));
    // The judge read the same state in both forms: the brief, the findings it
    // was asked about, and every round's record.
    const judgeStateOf = (prompt: string) => (JSON.parse(prompt) as { state: unknown }).state;
    expect(judgeStateOf(dg.calls.judge[0]!)).toEqual(judgeStateOf(wf.calls.judge[0]!));
    // Both forms thread the finding into the second build the same way, once.
    for (const ran of [wf, dg]) {
      expect(ran.calls.writer[1]!.split('the title is vague').length - 1).toBe(1);
    }

    // The same goal check in both forms records the round it ran in, not the
    // node's run of the graph: an unmet round one and a met round two.
    const goalRounds = (ran: { events: LoopEvent[] }) => ran.events
      .filter((event): event is Extract<LoopEvent, { kind: 'goal:check' }> => event.kind === 'goal:check')
      .map((event) => event.round);
    const goalReplies = [
      { requirements: [
        { requirement: 'The page names who it is for', verdict: 'met', evidence: 'page.md:1' },
        { requirement: 'The page lists the opening hours', verdict: 'unmet', evidence: 'MISSING: page.md has no opening hours' },
      ] },
      { requirements: [{ requirement: 'The page names who it is for', verdict: 'met', evidence: 'page.md:1' }] },
    ];
    const goalRepliesRan = [];
    for (const form of ['workflow', 'dag'] as const) {
      const ran = await runForm(form, goalReplies);
      expect(ran.result.outcome.status).toBe('pass');
      expect(goalRounds(ran)).toEqual([1, 2, 3]);
      goalRepliesRan.push(ran);
    }

    // With cap 1 the unmet goal is the first review round — the same round
    // a standalone goal check's send-back counts as — so the reviewer's
    // rejection lands on the last round and the run fails in both forms,
    // with the same record. The goal job's label and send-back target
    // differ by construction: a dag() node runs the public `goalCheck()`
    // (label 'goal-check', its own `target`), a workflow() stage runs an
    // internal '<stage>-goal' with no route to name.
    const goalRecordOf = (ran: { events: LoopEvent[]; cwd: string }) =>
      ran.events.map((event) => {
        const parsed = JSON.parse(JSON.stringify(event).replaceAll(ran.cwd, '<cwd>'), (key, value) =>
          key === 'ts' || key === 'path' || key === 'recordId' || key === 'identity' || key === 'durationMs'
            || (key === 'target' && value === 'write') ? undefined : value);
        if (parsed.label === 'write-goal' || parsed.label === 'goal-check') parsed.label = 'goal';
        return parsed;
      });
    expect(goalRecordOf(goalRepliesRan[1]!)).toEqual(goalRecordOf(goalRepliesRan[0]!));
    const capped = [
      await runForm('workflow', [goalReplies[0]!, ...goalReplies.slice(1)], 1),
      await runForm('dag', [goalReplies[0]!, ...goalReplies.slice(1)], 1),
    ];
    for (const ran of capped) {
      expect(ran.result.outcome.status).toBe('fail');
      expect(ran.calls.writer).toHaveLength(2);
      expect(ran.calls.reviewer).toHaveLength(1);
      expect(ran.calls.judge).toHaveLength(1);
      expect(goalRounds(ran)).toEqual([1, 2]);
    }
    expect(goalRecordOf(capped[1]!)).toEqual(goalRecordOf(capped[0]!));
    expect(judgeStateOf(capped[1]!.calls.judge[0]!)).toEqual(judgeStateOf(capped[0]!.calls.judge[0]!));
  });

  it('describes the agent seat as agent work, in and out of the node\'s refine', () => {
    const builder = seat('alpha-one', () => '{"status":"pass","summary":"ok"}');
    // A prose-answer retry wraps the seat's job: its declared shape survives
    // the wrapper, or describe and assertGraph report the work as opaque.
    assertGraph(dag({
      name: 'page',
      nodes: { build: { agent: builder, writes: 'page.md' } },
    }), { nodes: [{ name: 'build', kind: 'agent' }] });
    const refined = dag({
      name: 'page',
      nodes: {
        build: {
          agent: builder,
          writes: 'page.md',
          refine: review({ reviewers: [seat('beta-one', () => JSON.stringify(PASS))], rounds: 1 }),
        },
      },
    });
    const node = (jobMeta(refined)!.nodes as { name: string; job?: { kind: string; body?: { kind: string } } }[])[0]!;
    assertGraph(node.job!, { kind: 'loop', body: { kind: 'agent' } });
  });
});

describe('the node shape refusals', () => {
  const builder = seat('alpha-one', () => '{"status":"pass","summary":"ok"}');

  it('refuses the old graph field, naming the new one', () => {
    expect(() => dag({
      name: 'd',
      maxKickbacks: 2,
      nodes: { a: { job: fnJob('a', () => undefined) } },
    } as never)).toThrow('takes no maxKickbacks: a node that may be sent work declares refine: review({ ... })');
  });

  it('refuses the old node field, naming the new one', () => {
    expect(() => dag({
      name: 'd',
      nodes: { a: { acceptsKickbackTo: true, job: fnJob('a', () => undefined) } },
    } as never)).toThrow('takes no acceptsKickbackTo: the send-backs it may make go in sendsBackTo');
  });

  it('refuses a node with both agent and job', () => {
    expect(() => dag({
      name: 'd',
      nodes: { a: { agent: builder, job: fnJob('a', () => undefined) } },
    })).toThrow('takes agent or job, not both');
  });

  it('refuses a node with neither agent nor job', () => {
    expect(() => dag({
      name: 'd',
      nodes: { a: {} as never },
    })).toThrow('takes agent or job: one does the work');
  });

  it('refuses a refine that is not the value review() returns', () => {
    expect(() => dag({
      name: 'd',
      nodes: { a: { job: fnJob('a', () => undefined), refine: 2 as never } },
    })).toThrow('refine takes the value review() returns');
  });

  it('refuses a review with no rounds and no judge', () => {
    expect(() => review({})).toThrow('needs rounds or a judge');
    expect(() => review({ rounds: 1, judge: judge(seat('judge-one', () => '{}')) }))
      .toThrow('takes rounds or judge, not both');
  });

  it('refuses a check string with shell syntax, naming the fix', () => {
    expect(() => dag({
      name: 'd',
      nodes: {
        a: {
          agent: builder,
          refine: review({ checks: ['pnpm build && pnpm test'], rounds: 1 }),
        },
      },
    })).toThrow('has shell syntax in it');
  });
});

describe('pipeline stages carry the same fields', () => {
  it('runs an agent stage with its own refine, and refuses a send-back its target did not allow', async () => {
    const cwd = workDir();
    const builderPrompts: string[] = [];
    const reviewerPrompts: string[] = [];
    const builder = seat('alpha-one', (req) => {
      builderPrompts.push(req.prompt);
      writeFileSync(join(req.cwd!, 'page.md'), `draft ${builderPrompts.length}`);
      return '{"status":"pass","summary":"wrote the page"}';
    }, ['Write']);
    const reviewer = seat('beta-one', (req) => {
      reviewerPrompts.push(req.prompt);
      return JSON.stringify(reviewerPrompts.length === 1 ? REVISE : PASS);
    });
    const { outcome } = await run(pipeline('page', [
      {
        name: 'write',
        desc: 'Write the page.',
        gate: 'The page has a title.',
        agent: builder,
        writes: 'page.md',
        refine: review({ reviewers: [reviewer], rounds: 2 }),
      },
    ]), { cwd });

    expect(outcome.status).toBe('pass');
    expect(builderPrompts).toHaveLength(2);
    expect(reviewerPrompts).toHaveLength(2);
    // desc and gate reach the agent's prompt.
    expect(builderPrompts[0]).toContain('Write the page.');
    expect(builderPrompts[0]).toContain('The page has a title.');
    expect(builderPrompts[1]).toContain('the title is vague');
  });

  it('forwards a stage sendsBackTo to the dag', async () => {
    const cwd = workDir();
    let plans = 0;
    const planner = seat('alpha-one', () => {
      plans += 1;
      return '{"status":"pass","summary":"planned"}';
    });
    const implementerCalls: string[] = [];
    const implementer = seat('beta-one', (req) => {
      implementerCalls.push(req.prompt);
      return JSON.stringify(implementerCalls.length === 1
        ? { status: 'revise', summary: 'the plan misses the edge case' }
        : { status: 'pass', summary: 'done' });
    });
    const { outcome } = await run(pipeline('page', [
      { name: 'plan', agent: planner, refine: review({ rounds: 2 }) },
      { name: 'implement', agent: implementer, sendsBackTo: 'plan' },
    ]), { cwd });

    expect(outcome.status).toBe('pass');
    expect(plans).toBe(2);
    expect(implementerCalls).toHaveLength(2);
  });

  it('refuses acceptsKickbackTo on a stage, naming the new field', () => {
    expect(() => pipeline('page', [
      { name: 'a', job: fnJob('a', () => undefined), acceptsKickbackTo: true } as never,
    ])).toThrow('takes no acceptsKickbackTo: the send-backs it may make go in sendsBackTo');
  });
});
