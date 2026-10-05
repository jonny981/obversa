/**
 * A workflow proposes one change to itself from the record of its own run.
 *
 * The release notes workflow runs once, and its check sends the first draft
 * back: the writer's brief never asks for upgrade steps. `improveWorkflow`
 * reads that run's record. A proposing seat suggests one change to the
 * workflow file, a seat from another model family checks it, and a person
 * says yes before the file changes. This runs offline: both seats and the
 * person answer from this file. It works on a copy of the workflow file, so
 * the example leaves its own files as they were.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { improveWorkflow } from '@obversa/builtin-workflows';
import { createCallbackClient, directRouter, run, type AgentRequest } from '@obversa/runtime';
import { MockEngine } from '@obversa/runtime/testing';

import { releaseNotes } from './improve-a-workflow/release-notes.js';

const dir = await mkdtemp(join(tmpdir(), 'obversa-improve-'));
try {
  const workflow = join(dir, 'release-notes.ts');
  await copyFile(fileURLToPath(new URL('./improve-a-workflow/release-notes.ts', import.meta.url)), workflow);
  const record = join(dir, 'release-notes.jsonl');

  // 1. Run the workflow. The record keeps every event, and the path and
  //    SHA-256 of the file the run came from.
  const notes = await run(releaseNotes(), { recordTo: record, source: workflow });

  // 2. The proposing seat. Its recorded reply cites the send-back by its line
  //    in the record, and changes one line of the writer's brief.
  let cited = 0;
  const proposer = new MockEngine((request: AgentRequest) => {
    cited = Number(/^(\d+): .*"kind":"dag:kickback"/m.exec(request.prompt)?.[1]);
    return JSON.stringify({
      diff: [
        '--- a/release-notes.ts',
        '+++ b/release-notes.ts',
        '@@ -9,1 +9,1 @@',
        "-const brief = 'Write the release notes for version 2.0, one line per change.';",
        "+const brief = 'Write the release notes for version 2.0, one line per change, then the upgrade steps.';",
        '',
      ].join('\n'),
      reason: 'The check sent the first draft back because it had no upgrade steps, so the writer ran twice. The brief never asks for them.',
      evidence: [{ line: cited, note: 'the check sends the first draft back: the notes have no upgrade steps' }],
    });
  });

  // 3. The reviewing seat, from another model family. Its recorded reply
  //    passes the change: it adds to the brief and keeps the check.
  const reviewer = new MockEngine(() => JSON.stringify({
    status: 'pass',
    summary: 'The change adds to the brief and keeps the check, and the cited line shows the send-back.',
  }));

  const improve = improveWorkflow({
    record,
    workflow,
    proposer: {
      engine: proposer,
      identity: { adapter: 'mock', provider: 'local', modelFamily: 'proposer', model: 'proposer-offline', tools: [] },
    },
    reviewer: {
      engine: reviewer,
      identity: { adapter: 'mock', provider: 'local', modelFamily: 'reviewer', model: 'reviewer-offline', tools: [] },
    },
  });

  // 4. The run asks a person, and pauses until they answer. Their recorded
  //    answer is yes; the run carries on from its record and applies the diff.
  const callbacks = createCallbackClient();
  const improveRecord = join(dir, 'improve.jsonl');
  const asked = await run(improve, { callbacks, recordTo: improveRecord });
  const unchanged = await readFile(workflow, 'utf8');
  const [question] = callbacks.listPending();
  if (question) await directRouter(callbacks, question, 'person', () => ({ approved: true }));
  const done = await run(improve, { callbacks, recordTo: improveRecord, resume: true });

  const proposal = question?.input as { reason?: string; evidence?: { line: number; note: string }[] } | undefined;
  const improved = await readFile(workflow, 'utf8');
  console.log(JSON.stringify({
    workflowRun: notes.outcome.status,
    question: question?.decisionText.replace(`${dir}/`, ''),
    reason: proposal?.reason,
    evidence: proposal?.evidence?.map(({ line, note }) => `line ${line}: ${note}`),
    beforeTheAnswer: asked.outcome.status,
    afterTheYes: done.outcome.status,
    brief: improved.split('\n').find((line) => line.startsWith('const brief')),
  }, null, 2));

  /**
   * Part of the documentation proof: it must fail when the behaviour it shows
   * stops happening. A change applied before the yes, a proposal that cites
   * no send-back, or a decision recorded without its hashes is the tell.
   */
  const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
  const decision = (await readFile(improveRecord, 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as { kind: string; node?: string; phase?: string; outcome?: { data?: Record<string, unknown> } })
    .filter((event) => event.kind === 'dag:node' && event.node === 'approve' && event.phase === 'done')
    .at(-1)?.outcome?.data;
  const faults: string[] = [];
  if (notes.outcome.status !== 'pass') faults.push(`the release notes run ended ${notes.outcome.status}`);
  if (asked.outcome.status !== 'paused') faults.push(`the first improve run ended ${asked.outcome.status}, not paused at the question`);
  if (unchanged !== improved.replace(', then the upgrade steps', '')) faults.push('the workflow file changed before the person answered');
  if (!cited || !proposal?.evidence?.some(({ line }) => line === cited)) faults.push('the proposal does not cite the send-back in the record');
  if (done.outcome.status !== 'pass') faults.push(`the run after the yes ended ${done.outcome.status}`);
  if (!improved.includes('then the upgrade steps')) faults.push('the yes did not apply the diff');
  if (decision?.decision !== 'applied' || decision.sha256Before !== sha256(unchanged) || decision.sha256After !== sha256(improved)) {
    faults.push(`the record does not show the applied change with the hashes before and after: ${JSON.stringify(decision)}`);
  }
  if (faults.length) {
    for (const fault of faults) console.error(fault);
    process.exitCode = 1;
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
