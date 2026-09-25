import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveCommandExecutable } from '@obversa/core/command';
import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex-cli';
import { JevApiEngine } from '@obversa/engine-jev-api';
import { opencode } from '@obversa/engine-opencode-cli';
import {
  agentJob,
  approval,
  briefFromFile,
  dag,
  fnJob,
  formatEvent,
  predicate,
  run,
  stage,
  workflow,
  type ApprovalAnswer,
  type DagNode,
  type Engine,
  type JobContext,
  type LoopEvent,
  type Outcome,
  type TeamSeat,
} from '@obversa/runtime';
import { MockEngine } from '@obversa/runtime/testing';

/**
 * One Shape Up cycle, composed of workflows. Shaping is a writer and a
 * reviewer over the raw requests. The betting table is three seats from
 * different model families, each view checked by a typed Jev assessment,
 * and a person makes each bet. Every bet is built inside its appetite by a
 * writer, a scope step that writes down what was cut, a reviewer against
 * the pitch's no-gos, and a check. Cool-down writes what shipped, what was
 * cut and what goes back to the pile. One graph runs them in order and
 * keeps one record; the record's stage descriptions say whether the team
 * was uphill or downhill at each step.
 */

interface Request {
  readonly id: string;
  readonly appetite: string;
  readonly appetiteTimeout: string;
}

interface Policy {
  readonly minConfidence: number;
}

interface Check {
  readonly stance: { readonly choice: string; readonly confidence: number };
}

interface View {
  readonly seat: string;
  readonly stance: string;
  readonly confidence: number | null;
}

/** The request's front matter: id, appetite, and the appetite as a stage limit. */
function frontMatter(text: string): Request {
  const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  const fields = Object.fromEntries(block.split('\n').map((line) => line.split(/:\s*/, 2) as [string, string]));
  return { id: fields.id!, appetite: fields.appetite!, appetiteTimeout: fields.appetiteTimeout! };
}

const requests: Request[] = [];
for (const file of (await readdir('requests')).filter((name) => name.endsWith('.md')).sort()) {
  requests.push(frontMatter(await readFile(join('requests', file), 'utf8')));
}
const policy = JSON.parse(await readFile('policy.json', 'utf8')) as Policy;
const bets = JSON.parse(await readFile('bets.json', 'utf8')) as Record<string, ApprovalAnswer | string>;
const buildBrief = await readFile('briefs/build.md', 'utf8');

const seats: Record<string, TeamSeat> = {
  claude: claude('claude-sonnet-4-5'),
  codex: codex('gpt-5.6-luna'),
  opencode: opencode('opencode/big-pickle', { executable: resolveCommandExecutable('opencode') }),
};

// The check on each view is Jev when configured, and otherwise a replay of
// the assessment recorded for that seat's view, so the cycle runs offline.
let jev: Engine;
if (process.env.SHAPE_UP_JEV === '1') {
  const endpoint = process.env.TYPESAFE_ENDPOINT;
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!endpoint || !apiKey) throw new Error('SHAPE_UP_JEV=1 needs TYPESAFE_ENDPOINT and TYPESAFE_API_KEY');
  jev = new JevApiEngine({ endpoint, apiKey });
} else {
  const recorded = JSON.parse(await readFile('checks.json', 'utf8')) as Record<string, Check>;
  jev = new MockEngine((request) => {
    const { state } = JSON.parse(request.prompt) as { state: { pitch: string; seat: string } };
    return JSON.stringify(recorded[`${state.pitch}/${state.seat}`] ?? null);
  });
}

// 1. Shaping: a writer turns each request into a pitch; a reviewer from
// another family checks the five parts and the writer goes again.
const shaping = workflow('shaping', {
  brief: briefFromFile('briefs/shaping.md'),
  options: { timeout: '10m' },
  roles: { write: seats.claude!, review: [seats.codex!] },
  stages: [
    stage('pitch', {
      agent: 'write',
      writes: requests.map((request) => `pitches/${request.id}.md`),
      desc: 'Uphill: shape each request into a pitch with its five parts.',
      gate: 'Every pitch has a problem, the request\'s appetite, a solution, rabbit holes and no-gos.',
      reviewedBy: 'review',
      retry: 2,
    }),
  ],
});

// 2. The betting table: three seats from different families write a view
// on each pitch, a typed check reads each view, an uncertain table sends
// the pitch to research, and the person makes the bet.
function tableFor(request: Request): Record<string, DagNode> {
  const pitch = request.id;
  const nodes: Record<string, DagNode> = {};
  for (const seat of Object.keys(seats)) {
    const view = `table/${pitch}/${seat}.md`;
    nodes[`view-${pitch}-${seat}`] = {
      desc: `Uphill: the ${seat} seat's view on ${pitch}.`,
      job: agentJob({
        label: `view-${seat}`,
        engine: seat,
        model: seats[seat]!.identity.model,
        prompt: `Read pitches/${pitch}.md and write your view to ${view} as briefs/table.md says.`,
      }),
    };
    nodes[`check-${pitch}-${seat}`] = {
      needs: `view-${pitch}-${seat}`,
      desc: `Uphill: a typed check on the ${seat} seat's view.`,
      job: agentJob({
        label: `check-${seat}`,
        engine: 'jev',
        workspaceMode: 'none',
        tools: [],
        leaf: true,
        prompt: async () => JSON.stringify({
          state: { pitch, seat, view: await readFile(view, 'utf8') },
          questions: {
            stance: {
              type: 'choice',
              instructions: 'Does this view rest on the pitch, and what does it call for?',
              criteria: {
                bet: 'The view rests on the pitch and calls for a bet',
                pass: 'The view rests on the pitch and calls for a pass',
                'needs-research': 'The view rests on something the pitch does not settle',
              },
            },
          },
        }),
      }),
    };
  }
  nodes[`route-${pitch}`] = {
    needs: Object.keys(seats).map((seat) => `check-${pitch}-${seat}`),
    desc: `Uphill: read the checks on ${pitch} and decide whether the table needs research.`,
    job: fnJob(`route-${pitch}`, (ctx): Outcome => {
      const views: View[] = Object.keys(seats).map((seat) => {
        const answers = JSON.parse(String(ctx.needs?.[`check-${pitch}-${seat}`]?.data ?? 'null')) as Check | null;
        const confidence = answers?.stance?.confidence;
        return {
          seat,
          stance: answers?.stance?.choice ?? 'unreadable',
          confidence: typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : null,
        };
      });
      const uncertain = views.some((view) => view.confidence === null || view.confidence < policy.minConfidence || view.stance === 'needs-research');
      return { status: 'pass', summary: uncertain ? 'the table needs research' : 'the table is clear', data: { views, uncertain } };
    }),
  };
  nodes[`research-${pitch}`] = {
    needs: `route-${pitch}`,
    when: predicate((ctx) => (ctx.needs?.[`route-${pitch}`]?.data as { uncertain: boolean }).uncertain, 'a check was uncertain'),
    desc: `Uphill: research what the table should know about ${pitch}.`,
    job: agentJob({
      label: `research-${pitch}`,
      engine: 'claude',
      model: seats.claude!.identity.model,
      prompt: `The table was not sure about pitches/${pitch}.md. Read the pitch and the views in table/${pitch}/ and write table/${pitch}/research.md: what the table should know, from the pitch's own material, in under 120 words.`,
    }),
  };
  const decision = bets[pitch];
  const question = `Bet on ${pitch} this cycle? The views, their checks and any research are in table/${pitch}/.`;
  nodes[`bet-${pitch}`] = {
    needs: [`route-${pitch}`, `research-${pitch}`],
    optional: true,
    desc: `Uphill: the person's bet on ${pitch}.`,
    job: typeof decision === 'object'
      ? approval(`bet-${pitch}`, { question, input: { pitch, views: `table/${pitch}/` }, answer: () => decision })
      : approval(`bet-${pitch}`, { question, input: { pitch, views: `table/${pitch}/` } }),
  };
  return nodes;
}

const table = dag({
  name: 'betting-table',
  concurrency: 1,
  nodes: Object.assign({}, ...requests.map(tableFor)) as Record<string, DagNode>,
});

// 3. The build, inside the appetite: the pitch is the brief, the appetite
// is the stage's time limit, retry is the rounds, scope is written down,
// and a check fails a change that names a no-go.
function buildFor(request: Request) {
  const pitch = request.id;
  return workflow(`build-${pitch}`, {
    brief: `${buildBrief}\nThe pitch is pitches/${pitch}.md. Its appetite is ${request.appetite}.`,
    options: { timeout: request.appetiteTimeout },
    roles: { build: seats.claude!, review: [seats.codex!] },
    stages: [
      stage('build', {
        agent: 'build',
        writes: `build/${pitch}/change.md`,
        desc: `Uphill, then downhill: build ${pitch} inside its appetite.`,
        gate: 'The change stays inside the pitch\'s no-gos and clear of its rabbit holes.',
        reviewedBy: 'review',
        retry: 2,
      }),
      stage('scope', {
        agent: 'build',
        writes: `build/${pitch}/scope.md`,
        desc: 'Downhill: write down what was cut to fit the appetite.',
        gate: 'Every cut is named with what it costs the user.',
      }),
      stage('check', {
        run: [process.execPath, 'tools/check-build.mjs', pitch],
        desc: 'Downhill: fail a change that names a no-go or a scope file that is empty.',
        gate: 'The check exits 0.',
        sendsBackTo: 'build',
      }),
    ],
  });
}

// 4. Cool-down: what shipped, what was cut, what goes back to the pile.
const cooldown = workflow('cooldown', {
  brief: briefFromFile('briefs/cooldown.md'),
  options: { timeout: '10m' },
  roles: { write: seats.claude! },
  stages: [
    stage('summary', {
      agent: 'write',
      writes: 'cooldown/summary.md',
      desc: 'Downhill: write the cool-down summary from the cycle\'s files.',
      gate: 'The summary has what shipped, what was cut, and what goes back to the pile.',
    }),
  ],
});

// The cycle: one graph whose nodes are the workflows, in order, with one
// record. A build runs only for a pitch the person bet on.
const betOn = (pitch: string) => (ctx: JobContext): boolean =>
  ((ctx.needs?.table?.data as Record<string, Outcome | undefined> | undefined)?.[`bet-${pitch}`]?.status === 'pass');
const builds: Record<string, DagNode> = Object.fromEntries(requests.map((request) => [`build-${request.id}`, {
  needs: 'table',
  when: predicate(betOn(request.id), `the person bet on ${request.id}`),
  job: buildFor(request),
}]));
const cycle = dag({
  name: 'shape-up-cycle',
  concurrency: 1,
  nodes: {
    shaping,
    table: { needs: 'shaping', job: table },
    ...builds,
    cooldown: { needs: Object.keys(builds), job: cooldown },
  },
});

// The hill chart, read from the record: each stage's description says
// whether the team was uphill or downhill when it ran.
const hill: string[] = [];
const onEvent = (event: LoopEvent): void => {
  console.log(formatEvent(event));
  if (event.kind === 'dag:node' && event.phase === 'done' && event.desc !== undefined) {
    const side = /^(Uphill, then downhill|Uphill|Downhill)/.exec(event.desc)?.[1] ?? 'unmarked';
    hill.push(`${side}: ${[...event.path.slice(1), event.node].join('/')} (${event.outcome?.status ?? 'unknown'})`);
  }
};

const result = await run(cycle, {
  engines: { ...Object.fromEntries(Object.entries(seats).map(([name, seat]) => [name, seat.engine])), jev },
  recordTo: 'records/shape-up-cycle.jsonl',
  runId: 'shape-up-cycle',
  onEvent,
});

const nodes = (result.outcome.data ?? {}) as Record<string, Outcome | undefined>;
const tableNodes = (nodes.table?.data ?? {}) as Record<string, Outcome | undefined>;
console.log(JSON.stringify({
  status: result.outcome.status,
  pitches: requests.map((request) => request.id),
  table: Object.fromEntries(requests.map((request) => [request.id, {
    views: (tableNodes[`route-${request.id}`]?.data as { views: View[] } | undefined)?.views ?? [],
    researched: tableNodes[`research-${request.id}`]?.status === 'pass' && !(tableNodes[`research-${request.id}`]?.data as { skipped?: boolean } | undefined)?.skipped,
    bet: tableNodes[`bet-${request.id}`]?.status === 'pass' ? 'bet' : tableNodes[`bet-${request.id}`]?.status === 'fail' ? 'pass' : 'waiting',
    why: tableNodes[`bet-${request.id}`]?.status === 'fail' ? tableNodes[`bet-${request.id}`]?.summary ?? null : null,
  }])),
  built: requests.filter((request) => nodes[`build-${request.id}`]?.status === 'pass' && !(nodes[`build-${request.id}`]?.data as { skipped?: boolean } | undefined)?.skipped).map((request) => request.id),
  cooldown: nodes.cooldown?.status ?? null,
  hill,
}, null, 2));
