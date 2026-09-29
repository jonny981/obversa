// pnpm ci:local exists so a local run matches CI exactly. This test is the
// guard against the two drifting apart: it reads the workflow file itself,
// not a copy of its steps, so a changed CI step fails here until ci:local
// changes with it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every `run:` step's command, in file order, from the CI workflow. */
function workflowRunSteps(yamlText) {
  return [...yamlText.matchAll(/^\s*run:\s*(.+)$/gm)].map((match) => match[1].trim());
}

test('pnpm ci:local runs exactly the pnpm commands the CI workflow runs, in the same order', () => {
  const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const workflowSteps = workflowRunSteps(workflow).filter((step) => step.startsWith('pnpm '));
  assert.ok(workflowSteps.length > 0, 'ci.yml named no pnpm steps; check the workflow path and shape');

  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const ciLocal = packageJson.scripts?.['ci:local'];
  assert.ok(typeof ciLocal === 'string', 'package.json has no scripts.ci:local');
  // ci:local also runs its own run lock first and writes its proof last;
  // neither is a `pnpm` step, so filtering the same way as the workflow
  // compares only the steps that are actually meant to match it.
  const ciLocalSteps = ciLocal.split('&&').map((step) => step.trim()).filter((step) => step.startsWith('pnpm '));

  assert.deepEqual(
    ciLocalSteps,
    workflowSteps,
    'pnpm ci:local\'s steps no longer match .github/workflows/ci.yml',
  );
});
