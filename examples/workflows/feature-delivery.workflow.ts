import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  commandSucceeds,
  compileGraph,
  createCallbackGate,
  createStoredCallbackClient,
  dagGraphType,
  defineJob,
  fnJob,
  gateJob,
  persistRunDefinition,
  pipeline,
  resolveGraphPlan,
  reviewPanel,
  revisionRequest,
  run,
  type JobContext,
  type Sha256Digest,
} from '@obversa/runtime';
import { defineGraphDefinition } from '@obversa/runtime/testing';
import { createLocalRunStorage } from '@obversa/runtime/storage/local';

// The request this line delivers. A host reads it from an issue tracker; the
// stages below see it only through the criteria the analyse stage accepts.
const ISSUE =
  'The checkout client must retry a failed request, must cap how many ' +
  'times it retries, and must stop retrying when the caller aborts.';

interface Criterion {
  readonly id: string;
  readonly need: string;
  readonly match: string;
}

const CATALOG: readonly Criterion[] = [
  { id: 'retry', need: 'retries a failing request until it succeeds', match: 'retry' },
  { id: 'cap', need: 'caps the retry attempts', match: 'cap' },
  { id: 'abort', need: 'stops when the caller aborts', match: 'abort' },
];

function acceptedCriteria(ctx: JobContext): readonly Criterion[] {
  const value = ctx.state['criteria'];
  return Array.isArray(value) ? (value as readonly Criterion[]) : [];
}

// The approval record: the request, the claim, the answer and the digest are
// durable events in their own store beside the run record, so a refused
// approval is on the record, not in memory.
const APPROVAL_RUN_ID = 'feature-delivery-approval';
const APPROVAL_STORAGE_POLICY = {
  schemaVersion: 1,
  maxEventPayloadBytes: 64_000,
  maxAppendBatchBytes: 128_000,
  maxArtifactBytes: 1_000_000,
  maxTotalArtifactBytesPerRun: 4_000_000,
  retention: 'until-run-delete',
  sensitiveContent: {
    marked: 'reject',
    exact: 'reject',
    freeText: 'redact-before-hash',
  },
} as const;
const APPROVAL_PACKAGE = {
  source: 'npm:@example/feature-delivery',
  version: '1.0.0',
  digest: `sha256:${'f'.repeat(64)}` as Sha256Digest,
};
const approvalGraph = compileGraph(
  dagGraphType,
  defineGraphDefinition({
    id: 'feature-delivery-approval',
    definitionVersion: 1,
    data: {
      globalConcurrency: 1,
      keyedConcurrency: {},
      stopOnError: true,
      retryCapPerNode: 0,
    },
    nodes: [{ id: 'approve', data: { kind: 'required', key: null } }],
    edges: [],
  }),
);
const approvalPlan = resolveGraphPlan(approvalGraph.describe(), {
  package: APPROVAL_PACKAGE,
  admission: { package: APPROVAL_PACKAGE, permissions: [] },
  executionLanes: [],
});

// The first draft covers retry and cap but not abort — green on its own tests,
// which is exactly the gap a review panel exists to catch.
const DRAFT_SOURCE = [
  'export const MAX_ATTEMPTS = 3;',
  '',
  'export async function retry(fn, options = {}) {',
  '  const attempts = options.attempts ?? MAX_ATTEMPTS;',
  '  const delayMs = options.delayMs ?? 10;',
  '  let lastError;',
  '  for (let used = 0; used < attempts; used += 1) {',
  '    try {',
  '      return await fn();',
  '    } catch (error) {',
  '      lastError = error;',
  '      if (used + 1 < attempts) {',
  '        await new Promise((resolve) => setTimeout(resolve, delayMs));',
  '      }',
  '    }',
  '  }',
  '  throw lastError;',
  '}',
  '',
].join('\n');

const REPAIRED_SOURCE = [
  'export const MAX_ATTEMPTS = 3;',
  '',
  'export async function retry(fn, options = {}) {',
  '  const attempts = options.attempts ?? MAX_ATTEMPTS;',
  '  const delayMs = options.delayMs ?? 10;',
  '  const signal = options.signal;',
  '  let lastError;',
  '  for (let used = 0; used < attempts; used += 1) {',
  "    if (signal && signal.aborted) {",
  "      throw new Error('aborted');",
  '    }',
  '    try {',
  '      return await fn();',
  '    } catch (error) {',
  '      lastError = error;',
  '      if (used + 1 < attempts) {',
  '        await new Promise((resolve) => setTimeout(resolve, delayMs));',
  '      }',
  '    }',
  '  }',
  '  throw lastError;',
  '}',
  '',
].join('\n');

const DRAFT_TESTS = [
  "import assert from 'node:assert/strict';",
  "import test from 'node:test';",
  "import { retry } from '../src/retry.js';",
  '',
  "test('retry: a failing request is retried until it succeeds', async () => {",
  '  let calls = 0;',
  '  const value = await retry(async () => {',
  '    calls += 1;',
  "    if (calls < 3) throw new Error('flaky');",
  "    return 'ok';",
  '  });',
  "  assert.equal(value, 'ok');",
  '  assert.equal(calls, 3);',
  '});',
  '',
  "test('cap: the retry attempts are capped', async () => {",
  '  let calls = 0;',
  '  await assert.rejects(',
  '    retry(async () => {',
  '      calls += 1;',
  "      throw new Error('down');",
  '    }),',
  '    /down/,',
  '  );',
  '  assert.equal(calls, 3);',
  '});',
  '',
].join('\n');

const REPAIRED_TESTS = [
  DRAFT_TESTS,
  "test('abort: retrying stops when the caller aborts', async () => {",
  '  const controller = new AbortController();',
  '  controller.abort();',
  '  let calls = 0;',
  '  await assert.rejects(',
  '    retry(',
  '      async () => {',
  '        calls += 1;',
  "        return 'ok';",
  '      },',
  '      { signal: controller.signal },',
  '    ),',
  '    /aborted/,',
  '  );',
  '  assert.equal(calls, 0);',
  '});',
  '',
].join('\n');

// 1. Analyse: the issue becomes typed, accepted criteria before any code runs.
const analyse = fnJob('analyse', (ctx) => {
  const text = ISSUE.toLowerCase();
  const criteria = CATALOG.filter((criterion) => text.includes(criterion.match));
  if (!criteria.length) {
    return { status: 'fail', summary: 'the issue names no deliverable work' };
  }
  ctx.state['criteria'] = criteria;
  return {
    status: 'pass',
    summary: `accepted: ${criteria.map((criterion) => criterion.id).join(', ')}`,
  };
});

// 2. Implement: writes the change as real files. The first run writes the
// draft; a kickback re-run reads the review findings and repairs. In a real
// line this stage is an agentJob with an engine — the plumbing around it is
// identical.
const implement = fnJob('implement', async (ctx) => {
  const criteria = acceptedCriteria(ctx);
  if (!criteria.length) {
    return { status: 'fail', summary: 'no accepted criteria to implement' };
  }
  const findings = ctx.lastReview?.revision?.findings ?? [];
  const fixes = new Set(
    findings
      .map((finding) => finding.scope)
      .filter((scope): scope is string => typeof scope === 'string'),
  );
  const unsupported = [...fixes].filter((scope) => scope !== 'abort');
  if (unsupported.length) {
    return {
      status: 'fail',
      summary: `no repair for findings outside the abort criterion: ${unsupported.join(', ')}`,
    };
  }
  const repaired = fixes.size > 0;
  const root = ctx.workspace.dir;
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'test'), { recursive: true });
  await writeFile(
    join(root, 'src/retry.js'),
    repaired ? REPAIRED_SOURCE : DRAFT_SOURCE,
  );
  await writeFile(
    join(root, 'test/retry.test.js'),
    repaired ? REPAIRED_TESTS : DRAFT_TESTS,
  );
  return {
    status: 'pass',
    summary: repaired
      ? `repaired from review findings: ${[...fixes].join(', ')}`
      : 'wrote the first draft',
  };
});

// 3. Test: a real command gate. The line advances only when the tests exit 0,
// never on a worker's or a reviewer's self-report.
const testStage = gateJob(
  'test',
  commandSucceeds('node', ['--test', 'test/retry.test.js'], {
    timeoutMs: 30_000,
    captureOutput: true,
  }),
);

// 4. Review: a panel of three reviewers, two votes required. A failing panel
// sends its findings back to the implement stage as a kickback.
function coverageReviewer(
  name: string,
  read: (root: string) => Promise<string>,
  covers: (content: string, criterion: Criterion) => boolean,
) {
  return fnJob(name, async (ctx) => {
    const criteria = acceptedCriteria(ctx);
    const content = await read(ctx.workspace.dir);
    const missing = criteria.filter((criterion) => !covers(content, criterion));
    if (!missing.length) {
      return {
        status: 'pass',
        summary: `${name}: every accepted criterion is covered`,
      };
    }
    return revisionRequest({
      reason: `${name}: ${missing.length} accepted criterion not covered`,
      findings: missing.map((criterion) => ({
        reviewer: name,
        scope: criterion.id,
        evidence: `${name} sees no coverage for "${criterion.need}".`,
      })),
    });
  });
}

const review = reviewPanel({
  label: 'review-panel',
  reviewers: [
    {
      name: 'correctness',
      job: coverageReviewer(
        'correctness',
        (root) => readFile(join(root, 'src/retry.js'), 'utf8'),
        (source, criterion) =>
          criterion.id === 'retry'
            ? source.includes('async function retry')
            : criterion.id === 'cap'
              ? source.includes('attempts')
              : source.includes('signal'),
      ),
    },
    {
      name: 'tests',
      job: coverageReviewer(
        'tests',
        (root) => readFile(join(root, 'test/retry.test.js'), 'utf8'),
        (tests, criterion) => tests.includes(`test('${criterion.id}:`),
      ),
    },
    {
      name: 'api',
      job: fnJob('api', async (ctx) => {
        const source = await readFile(join(ctx.workspace.dir, 'src/retry.js'), 'utf8');
        const shaped =
          source.includes('export async function retry') &&
          source.includes('export const MAX_ATTEMPTS');
        return shaped
          ? { status: 'pass', summary: 'api: exports retry and MAX_ATTEMPTS' }
          : revisionRequest({
              reason: 'api: module shape is wrong',
              findings: [
                {
                  reviewer: 'api',
                  scope: 'shape',
                  evidence: 'src/retry.js must export retry and MAX_ATTEMPTS.',
                },
              ],
            });
      }),
    },
  ],
  pass: 2,
  target: 'implement',
});

// 5. Approve: the change ships only when the responder answers yes. The
// request carries the sha256 of the final source, so approving anything else
// would be a different request. The request, the claim, the answer and the
// digest are durable events in the approval record beside the run record.
// The stage reads the answer: a no fails the line with the reason. A host
// swaps the scripted submit for a human responder; the request, digest and
// claim protocol are the same.
const approve = fnJob('approve', async (ctx) => {
  const bytes = await readFile(join(ctx.workspace.dir, 'src/retry.js'));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const storage = createLocalRunStorage({
    directory: join(ctx.workspace.dir, 'approval-record'),
    namespace: 'feature-delivery-example',
    policy: APPROVAL_STORAGE_POLICY,
  });
  await persistRunDefinition(storage, {
    runId: APPROVAL_RUN_ID,
    eventId: 'feature-delivery-approval-started',
    timestamp: '2026-01-01T00:00:00.000Z',
    graphDefinition: approvalGraph.definition,
    resolvedPlan: approvalPlan,
    resolvedInputs: {},
    workspaceBinding: null,
    hostBinding: null,
  });
  const request = createCallbackGate({
    gateId: 'ship-change',
    gateVersion: 1,
    decisionText: 'Approve shipping this exact change?',
    responseSchema: {
      type: 'object',
      properties: { approved: { type: 'boolean' } },
      required: ['approved'],
    },
    input: { file: 'src/retry.js', sha256 },
  });
  const client = await createStoredCallbackClient(storage, APPROVAL_RUN_ID);
  await client.post(request);
  const claim = await client.claim(request.requestId, 'release-owner');
  if (!claim.ok) {
    return { status: 'fail', summary: `the approval could not be claimed: ${claim.kind}` };
  }
  const submitted = await client.submit(
    request.requestId,
    claim.claimToken,
    'release-owner',
    request.digest,
    { approved: true },
    { id: 'release-owner', kind: 'human' },
  );
  if (!submitted.ok) {
    return { status: 'fail', summary: `the approval was not submitted: ${submitted.reason}` };
  }
  const answer = submitted.response as { approved?: unknown };
  if (answer.approved !== true) {
    return {
      status: 'fail',
      summary: 'the approver answered no, so the change does not ship',
    };
  }
  return {
    status: 'pass',
    summary: `approved src/retry.js (${sha256.slice(0, 12)})`,
  };
});

const productionLine = defineJob(
  pipeline(
    'feature-delivery',
    [
      { name: 'analyse', job: analyse },
      { name: 'implement', job: implement },
      { name: 'test', job: testStage },
      { name: 'review', job: review },
      { name: 'approve', job: approve },
    ],
    { maxKickbacks: 2 },
  ),
);

interface RecordedEvent {
  kind?: string;
  label?: string;
  accepted?: boolean;
}

async function main(): Promise<void> {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'feature-delivery-')));
  try {
    const result = await run(productionLine, {
      cwd: workspace,
      runId: 'feature-delivery-example',
      recordTo: 'auto',
    });
    const events: RecordedEvent[] = result.recordPath
      ? (await readFile(result.recordPath, 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as RecordedEvent)
      : [];
    console.log(
      JSON.stringify(
        {
          status: result.outcome.status,
          implementRuns: events.filter(
            (event) => event.kind === 'job:end' && event.label === 'implement',
          ).length,
          reviewRounds: events.filter(
            (event) => event.kind === 'job:end' && event.label === 'review-panel',
          ).length,
          acceptedKickbacks: events.filter(
            (event) => event.kind === 'dag:kickback' && event.accepted === true,
          ).length,
        },
        null,
        2,
      ),
    );
    if (result.outcome.status !== 'pass') process.exitCode = 1;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

void main();
