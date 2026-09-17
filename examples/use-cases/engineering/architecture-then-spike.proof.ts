import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pass, revise, sourceDir, withExample } from '../proof-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const samples = sourceDir(here);
const brief = await readFile(join(samples, 'briefs/idea.md'), 'utf8');

const research = '# Research\n\nWhat exists: invoices in Postgres, a nightly job, no bank feed.\n\nWays: (a) match on exact amount only; (b) match on amount and the invoice number in the reference; (c) a learned matcher. (b) is the one four weeks affords and the one that never matches twice by accident.\n';
const spec = '# Spec\n\nUpload a bank CSV; for each credit, match an open invoice when the amount is equal and the reference contains the invoice number; otherwise leave it for a person. The spike must prove that the rule never matches one transaction to two invoices on real-shaped data.\n';
const readme = '# Spike\n\nRuns `node poc/index.mjs`. Prints each transaction with the invoice it matches and why; exits 1 if any transaction matches two invoices.\n';
const ambiguousSpike = [
  "const invoices = [{ number: 'LL-1041', amount: 120 }, { number: 'LL-1042', amount: 120 }];",
  "const transactions = [{ reference: 'payment', amount: 120 }];",
  'for (const tx of transactions) {',
  '  const matches = invoices.filter((inv) => inv.amount === tx.amount);',
  "  console.log(tx.reference, '->', matches.map((inv) => inv.number).join(', '));",
  '  if (matches.length > 1) process.exit(1);',
  '}',
  '',
].join('\n');
const spike = [
  "const invoices = [{ number: 'LL-1041', amount: 120 }, { number: 'LL-1042', amount: 120 }];",
  "const transactions = [{ reference: 'LL-1042 payment', amount: 120 }, { reference: 'rent', amount: 120 }];",
  'for (const tx of transactions) {',
  '  const matches = invoices.filter((inv) => inv.amount === tx.amount && tx.reference.includes(inv.number));',
  "  console.log(tx.reference, '->', matches.length ? `${matches[0].number} (amount and reference)` : 'no match, left for a person');",
  '  if (matches.length > 1) process.exit(1);',
  '}',
  '',
].join('\n');

// The first spike matches on amount alone and exits 1 on two invoices of
// the same amount; the red run sends it back with the output; the second
// spike applies the spec's rule and runs green. The team accepts and the
// run stops at the person.
await withExample({
  here,
  example: 'architecture-then-spike',
  files: { 'briefs/idea.md': brief },
  seats: {
    claude: [
      { writes: { 'design/research.md': research }, reply: pass('three ways written with their costs') },
      { writes: { 'design/spec.md': spec }, reply: pass('spec written; the spike must prove the rule never matches twice') },
      { writes: { 'poc/index.mjs': ambiguousSpike, 'poc/README.md': readme }, reply: pass('spike written') },
      { writes: { 'poc/index.mjs': spike, 'poc/README.md': readme }, reply: pass('spike now matches on amount and reference; ambiguous credits are left for a person') },
    ],
    codex: [
      { reply: pass('research covers what exists and the ways') },
      { reply: pass('the spec names what the spike must prove') },
      { reply: pass('the spike proves the rule the spec names') },
    ],
    opencode: [
      { reply: pass('a wrong match is impossible under this rule; agreed') },
    ],
  },
}, async (run) => {
  assert.equal(run.printed.status, 'paused', `the run stops at the person: ${run.stdout}`);
  assert.equal(run.printed.data?.decide?.status, 'paused');
  assert.match(run.printed.summary ?? '', /Build this for real/);
  assert.equal(run.printed.data?.['spike-runs']?.status, 'pass');
  assert.equal(run.printed.data?.['team-review']?.status, 'pass');
  assert.equal(run.seatCalls.filter((call) => call.role === 'claude').length, 4, 'research, design, spike, and the spike again after the red run');
  assert.equal(run.seatCalls.filter((call) => call.role === 'opencode').length, 1, 'the second family on the panel reads once');
  assert.match(run.stdout, /kickback accepted spike-runs -> spike/, 'the red run went back to the spike');
  assert.match(await run.read('poc/index.mjs'), /tx\.reference\.includes/, 'the repaired spike is the one on disk');
  assert.match(run.stdout, /tok/, 'the run prints its usage lines');

  console.log(JSON.stringify({
    status: 'pass',
    stages: 6,
    spikeRuns: 2,
    kickbacks: 1,
    panel: { reviewers: 2, agreed: 2 },
    pausedAt: 'decide',
    mode: run.mode,
  }, null, 2));
});
