/**
 * Check the brief was met before the reviews.
 *
 * A writer writes a welcome page. A goal seat reads the brief and the page and
 * marks each requirement met or unmet. The reviewer reads the page only once
 * every requirement is met. The same check then sits as one node in a dag().
 * It runs offline: each seat is a scripted stand-in, and the writer leaves the
 * opening hours out of its first draft, so the goal check has something to
 * send back.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dag, fnJob, goalCheck, run, stage, workflow, type LoopEvent, type TeamSeat } from '@obversa/runtime';
import { MockEngine } from '@obversa/runtime/testing';

const brief = 'Write a welcome page for new staff. It must say who it is for and list the opening hours.';

function standIn(model: string, tools: readonly string[], reply: (cwd: string) => unknown): TeamSeat {
  return {
    engine: new MockEngine((request) => JSON.stringify(reply(request.cwd!))),
    identity: { adapter: 'mock', provider: 'mock', modelFamily: model, model, tools },
  };
}

/** The writer leaves the opening hours out of its first draft. */
let drafts = 0;
const writer = standIn('writer', ['Write'], (cwd) => {
  drafts += 1;
  const hours = drafts > 1 ? '\nOpen 9:00 to 17:00, Monday to Friday.' : '';
  writeFileSync(join(cwd, 'welcome.md'), `# Welcome\nThis page is for new staff.${hours}\n`);
  return { status: 'pass', summary: `wrote draft ${drafts}` };
});

/** The goal seat reads the page and marks each requirement in the brief. */
const checker = standIn('checker', ['Read'], (cwd) => {
  const page = readFileSync(join(cwd, 'welcome.md'), 'utf8');
  return {
    requirements: [
      { requirement: 'Says who it is for', verdict: 'met', evidence: 'welcome.md:2 says it is for new staff' },
      page.includes('Open')
        ? { requirement: 'Lists the opening hours', verdict: 'met', evidence: 'welcome.md:3 lists them' }
        : { requirement: 'Lists the opening hours', verdict: 'unmet', evidence: 'welcome.md has no opening hours' },
    ],
  };
});

let reviews = 0;
const reviewer = standIn('reviewer', ['Read'], () => {
  reviews += 1;
  return { status: 'pass', summary: 'reads well' };
});

const welcome = workflow('welcome-page', {
  brief,
  roles: { write: writer, review: [reviewer] },
  stages: [
    stage('write', {
      agent: 'write',
      writes: 'welcome.md',
      desc: 'Write the welcome page.',
      goal: checker,
      reviewedBy: 'review',
      refine: 3,
    }),
  ],
});

/** Each round's goal:check event, one line per requirement. */
const rounds: string[][] = [];
const record = (event: LoopEvent) => {
  if (event.kind === 'goal:check') rounds.push(event.requirements.map((item) => `${item.verdict}: ${item.requirement} (${item.evidence})`));
};

const staged = await run(welcome, { cwd: mkdtempSync(join(tmpdir(), 'goal-check-')), onEvent: record });

let builds = 0;
const graph = dag({
  name: 'welcome-page-dag',
  maxKickbacks: 1,
  nodes: {
    build: {
      job: fnJob('build', (ctx) => {
        builds += 1;
        const hours = builds > 1 ? '\nOpen 9:00 to 17:00, Monday to Friday.' : '';
        writeFileSync(join(ctx.workspace.dir, 'welcome.md'), `# Welcome\nThis page is for new staff.${hours}\n`);
        return `wrote draft ${builds}`;
      }),
    },
    goal: { needs: 'build', job: goalCheck(checker, { target: 'build', text: brief }) },
    review: { needs: 'goal', job: fnJob('review', () => 'reads well') },
  },
});

const graphed = await run(graph, { cwd: mkdtempSync(join(tmpdir(), 'goal-check-dag-')) });

console.log(JSON.stringify({
  workflow: { status: staged.outcome.status, drafts, reviews, rounds },
  dag: { status: graphed.outcome.status, builds },
}, null, 2));

if (staged.outcome.status !== 'pass' || graphed.outcome.status !== 'pass' || reviews !== 1 || builds !== 2) process.exitCode = 1;
