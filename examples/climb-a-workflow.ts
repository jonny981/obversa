/**
 * Keep a change to a workflow only when it scores better.
 *
 * A tiny workflow answers a sum and checks the answer. Its settings file
 * names the brief the answer step reads. A proposed change points it at
 * another brief. The climb runs the workflow as it is and with the change,
 * three times on each of two tuning tasks and one held-out task, each run
 * in its own worktree with its own record. The change wins on the tuning
 * tasks and loses nothing on the held-out one. It runs in automatic mode,
 * and the `auto` option allows this setting to take this value, so nobody
 * is asked and the change lands as one commit. It runs offline: the model
 * is a stand-in that follows the brief it is given.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { climbWorkflow, formatClimbReport, type ClimbReport } from '@obversa/builtin-workflows';
import { run, type Job } from '@obversa/runtime';
import { MockEngine } from '@obversa/runtime/testing';

/** The workflow file under test, as it is committed. */
const WORKFLOW = `import { readFile } from 'node:fs/promises';

import { agentJob, fnJob, pipeline, type Engine } from '@obversa/runtime';

/** Answer a sum with the brief the settings name, then check the answer is the number and nothing else. */
export async function sums(task: string, engine: Engine) {
  const settings = JSON.parse(await readFile(new URL('settings.json', import.meta.url), 'utf8'));
  const brief = (await readFile(new URL(settings.answer.brief, import.meta.url), 'utf8')).trim();
  const expected = String(task.split('+').reduce((total, part) => total + Number(part), 0));
  return pipeline('sums', [
    { name: 'answer', job: agentJob({ label: 'answer', engine, prompt: \`\${brief}\\n\\n\${task}\` }) },
    {
      name: 'check',
      job: fnJob('check', (ctx) => {
        const reply = String(ctx.needs?.answer?.data ?? '').trim();
        return reply === expected ? 'the answer is right' : { status: 'fail', summary: \`expected \${expected}, got "\${reply}"\` };
      }),
    },
  ]);
}
`;

/** The workflow's settings, and the two briefs its answer step can read. */
const SETTINGS = `{
  "answer": { "brief": "briefs/words.md" }
}
`;
const BRIEFS = { 'words.md': 'Work out the sum.\n', 'number.md': 'Reply with the number only.\n' };

/** The proposed change, as a unified diff against the committed files. */
const CHANGE = `diff --git a/settings.json b/settings.json
--- a/settings.json
+++ b/settings.json
@@ -1,3 +1,3 @@
 {
-  "answer": { "brief": "briefs/words.md" }
+  "answer": { "brief": "briefs/number.md" }
 }
`;

/** The stand-in model: it answers in words unless told to give the number only. */
const model = new MockEngine((request) => {
  const [instructions = '', task = ''] = request.prompt.split('\n\n');
  const total = task.split('+').reduce((sum, part) => sum + Number(part), 0);
  return instructions.includes('number only') ? String(total) : `The sum is ${total}.`;
});

// The workflow lives in a repository of its own. Its imports resolve through
// the node_modules this example runs with.
const here = dirname(fileURLToPath(import.meta.url));
let modules = here;
while (!existsSync(join(modules, 'node_modules', '@obversa', 'runtime'))) {
  if (dirname(modules) === modules) throw new Error('no node_modules with @obversa/runtime above this file');
  modules = dirname(modules);
}
const repo = await realpath(await mkdtemp(join(tmpdir(), 'obversa-climb-')));
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

try {
  await symlink(join(modules, 'node_modules'), join(repo, 'node_modules'));
  await writeFile(join(repo, '.gitignore'), 'node_modules\n');
  await writeFile(join(repo, 'package.json'), '{ "type": "module" }\n');
  await writeFile(join(repo, 'sums.ts'), WORKFLOW);
  await writeFile(join(repo, 'settings.json'), SETTINGS);
  await mkdir(join(repo, 'briefs'));
  for (const [name, text] of Object.entries(BRIEFS)) await writeFile(join(repo, 'briefs', name), text);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'climb@example.com');
  git('config', 'user.name', 'Climb example');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'Add the sums workflow');

  const questions: string[] = [];
  const climb = climbWorkflow({
    file: join(repo, 'sums.ts'),
    change: CHANGE,
    // The climb hands over each version's own copy of the file.
    load: async (file, task): Promise<Job> => {
      const workflow = await import(pathToFileURL(file).href) as { sums: (task: string, engine: MockEngine) => Promise<Job> };
      return workflow.sums(task, model);
    },
    tasks: { tuning: ['2 + 3', '4 + 4'], heldOut: ['10 + 7'] },
    mode: 'auto',
    // What automatic mode may change. Anything else goes to a person.
    auto: {
      files: ['briefs/*.md'],
      settings: {
        file: 'settings.json',
        may: { 'answer.brief': { oneOf: ['briefs/words.md', 'briefs/number.md'] } },
      },
    },
    // Only a change outside the auto option reaches a person.
    approve: (request) => {
      questions.push(request.decisionText);
      return { approved: false };
    },
  });
  const result = await run(climb);

  const stages = result.outcome.data as Record<string, { status: string; data?: unknown }>;
  const report = stages.measure!.data as ClimbReport;
  const committed = await readFile(join(repo, 'settings.json'), 'utf8');
  console.error(formatClimbReport(report));
  console.log(JSON.stringify({
    status: result.outcome.status,
    keep: report.keep,
    runs: report.runs.length,
    tuningPassRate: { baseline: report.tuning.baseline.passRate, candidate: report.tuning.candidate.passRate },
    heldOutPassRate: { baseline: report.heldOut.baseline.passRate, candidate: report.heldOut.candidate.passRate },
    needsPerson: report.needsPerson ?? [],
    questions,
    commit: git('log', '-1', '--format=%s').trim(),
  }, null, 2));

  /**
   * Part of the documentation proof: it must fail when the behaviour it
   * shows stops happening.
   */
  const faults: string[] = [];
  if (result.outcome.status !== 'pass') faults.push(`the climb ended ${result.outcome.status}`);
  if (!report.keep) faults.push(`the numbers said discard: ${report.reason}`);
  if (report.runs.length !== 18) faults.push(`${report.runs.length} runs, not 3 runs of 2 versions on 3 tasks`);
  if (report.runs.some((one) => !existsSync(one.record))) faults.push('a run has no record');
  if (report.needsPerson !== undefined) faults.push(`the change needs a person: ${report.needsPerson.join('; ')}`);
  if (questions.length !== 0) faults.push(`a person was asked ${questions.length} times, not never`);
  if (!committed.includes('briefs/number.md')) faults.push('the change is not in the settings file');
  if (git('rev-list', '--count', 'HEAD').trim() !== '2') faults.push('the change is not one commit on top of the workflow');
  if (git('show', '--name-only', '--format=', 'HEAD').trim() !== 'settings.json') faults.push('the commit touches more than the settings file');
  if (faults.length) {
    for (const fault of faults) console.error(fault);
    process.exitCode = 1;
  }
} finally {
  await rm(repo, { recursive: true, force: true });
}
