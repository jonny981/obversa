import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex-cli';
import {
  agentJob,
  approval,
  fnJob,
  formatEvent,
  pipeline,
  run,
  tournament,
  type JobContext,
  type Outcome,
} from '@obversa/runtime';

/**
 * A shortlist with verifiable gates first and a person last. A script
 * applies the filters to every application and records who was excluded
 * and by which rule, so the gates are checkable and nobody is excluded by
 * a model's impression. Two rankers from different model families then
 * rank the eligible applicants against the brief, each in its own
 * worktree; a judge function scores each ranking against the brief, and
 * only the better one lands. A person reads that ranking and decides who
 * is shortlisted. The run never contacts an applicant.
 */

interface Application {
  readonly id: string;
  readonly name: string;
  readonly yearsInSupport: number;
  readonly skills: readonly string[];
  readonly workRegion: string;
  readonly notes: string;
}

interface Filters {
  readonly minYearsInSupport: number;
  readonly requiredSkill: string;
  readonly workRegions: readonly string[];
}

/** The gates. Each returns the rule an application fails, or null. */
function failedRule(application: Application, filters: Filters): string | null {
  if (application.yearsInSupport < filters.minYearsInSupport) return `fewer than ${filters.minYearsInSupport} years in support`;
  if (!application.skills.includes(filters.requiredSkill)) return `no ${filters.requiredSkill} skill`;
  if (!filters.workRegions.includes(application.workRegion)) return `work region ${application.workRegion} is not one of ${filters.workRegions.join(', ')}`;
  return null;
}

/** Score a ranking against the brief: every eligible applicant once, each with a reason, nobody else. */
function scoreRanking(text: string, eligible: readonly string[], excluded: readonly string[]): number {
  const lines = text.split('\n').map((line) => /^\d+\.\s+(\S+):\s*(.*)$/.exec(line)).filter((match) => match !== null);
  const ranked = lines.map((match) => match![1]!);
  let score = 0;
  for (const id of eligible) if (ranked.includes(id)) score += 1;
  if (eligible.every((id) => ranked.includes(id))) score += 2;
  for (const id of excluded) if (ranked.includes(id)) score -= 3;
  if (lines.every((match) => match![2]!.trim().length > 0)) score += 1;
  return score;
}

// The tournament forks each ranker's worktree from the last commit and
// lands the winner's ranking on a branch, so the folder is a Git
// repository and the gates' result is committed before the rankers start.
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=shortlist', '-c', 'user.email=shortlist@example.invalid', ...args], { stdio: 'ignore' });
if (!existsSync('.git')) {
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'applications as received');
}

const filters = JSON.parse(await readFile('filters.json', 'utf8')) as Filters;
const applications: Application[] = [];
for (const file of (await readdir('applications')).filter((name) => name.endsWith('.json')).sort()) {
  applications.push(JSON.parse(await readFile(join('applications', file), 'utf8')) as Application);
}
const rankers = { claude: claude('claude-sonnet-4-5'), codex: codex('gpt-5.6-luna') };
const engineNames = ['claude', 'codex'] as const;

const shortlist = pipeline('shortlist', [
  {
    name: 'filter',
    job: fnJob('filter', async (): Promise<Outcome> => {
      const eligible = applications.filter((application) => failedRule(application, filters) === null);
      const excluded = applications
        .filter((application) => failedRule(application, filters) !== null)
        .map((application) => ({ id: application.id, rule: failedRule(application, filters) }));
      await mkdir('shortlist', { recursive: true });
      await writeFile('shortlist/eligible.json', `${JSON.stringify(eligible, null, 2)}\n`);
      await writeFile('shortlist/excluded.json', `${JSON.stringify(excluded, null, 2)}\n`);
      git('add', 'shortlist');
      git('commit', '-q', '-m', 'the gates: who is eligible and who was excluded by which rule');
      return {
        status: 'pass',
        summary: `${eligible.length} eligible, ${excluded.length} excluded by a rule`,
        data: { eligible: eligible.map((application) => application.id), excluded: excluded.map((entry) => entry.id) },
      };
    }),
  },
  {
    name: 'rank',
    job: tournament({
      name: 'ranking',
      n: engineNames.length,
      concurrency: 1,
      candidate: (i) => agentJob({
        label: `ranker-${engineNames[i]}`,
        engine: engineNames[i]!,
        prompt: 'Rank the applicants in shortlist/eligible.json as briefs/role.md says, and write shortlist/ranking.md.',
      }),
      judge: async (outcome: Outcome, ctx: JobContext) => {
        if (outcome.status !== 'pass') return -1;
        const read = async (path: string) => readFile(join(ctx.workspace.dir, 'shortlist', path), 'utf8');
        const eligible = (JSON.parse(await read('eligible.json')) as Application[]).map((application) => application.id);
        const excluded = (JSON.parse(await read('excluded.json')) as { id: string }[]).map((entry) => entry.id);
        return scoreRanking(await read('ranking.md'), eligible, excluded);
      },
    }),
  },
  {
    name: 'choose',
    job: approval('choose', {
      question: 'Who is shortlisted? The ranking that held against the brief is in shortlist/ranking.md.',
      input: { ranking: 'shortlist/ranking.md', excluded: 'shortlist/excluded.json' },
    }),
  },
]);

const result = await run(shortlist, {
  engines: { claude: rankers.claude.engine, codex: rankers.codex.engine },
  recordTo: 'records/shortlist.jsonl',
  runId: 'shortlist',
  onEvent: (event) => console.log(formatEvent(event)),
});

const nodes = (result.outcome.data ?? {}) as Record<string, Outcome | undefined>;
console.log(JSON.stringify({
  status: result.outcome.status,
  filter: nodes.filter?.data ?? null,
  rank: nodes.rank?.summary ?? null,
  choose: nodes.choose?.status ?? null,
}, null, 2));
