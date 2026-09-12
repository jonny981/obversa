import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { stageBranches } from './stage-merge.mjs';

const root = process.cwd();
const docs = path.join(root, 'docs/public');
const sources = [
  path.join(root, 'packages/runtime/src/api.ts'),
  path.join(root, 'packages/runner/src/index.ts'),
  path.join(root, 'packages/runtime/src/runtime/graph-executor.ts'),
  path.join(root, 'packages/runner/src/supervised-run.ts'),
];
const text = sources.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
const names = [...text.matchAll(/export\s+(?:async\s+)?(?:function|const|class|type|interface)\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]);
const codes = [...text.matchAll(/['"]([A-Z][A-Z0-9_]{2,})['"]/g)].map((m) => m[1]);
const pageText = fs.readdirSync(docs, { recursive: true }).filter((f) => f.endsWith('.mdx')).map((f) => fs.readFileSync(path.join(docs, f), 'utf8')).join('\n');
const KNOWN_DEBT = [
  ...['GraphExecutionErrorCode','GraphEngineBinding','GraphExecutorOptions','GraphExecutorResult','validateStandardEvent',
    'SupervisedRunBindings','SupervisedHostContext','SupervisedRunResult','SupervisedWorkerInput']
    .map((name) => ({ name, owner: 'D35', why: 'existing package-page debt' })),
  ...['DUPLICATE_POSITION','EMPTY_DECISION','INVALID_EVENT','MISSING_ENGINE_BINDING','MISSING_MEMORY','MISSING_NODE_BINDING',
    'STORAGE_LIMIT_EXCEEDED','ACTION_POLICY','INVALID_OPTIONS','INVALID_EXECUTABLE','MEMORY_LIMIT','WORKSPACE_CAPTURE',
    'WORKSPACE_ROOT','EEXIST','RUN_NOT_PAUSED','RESUME_POSITION','WORKSPACE_LEASE','WORKSPACE_RELEASE','BUDGET_STOP',
    'RESTART_EXHAUSTED','WATCHDOG_ERROR']
    .map((name) => ({ name, owner: 'D47', why: 'existing mechanism-page debt' })),
];

function defaultRun(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function landedStages(root, run = defaultRun) {
  const main = run(['rev-parse', '--verify', 'main'], root).trim();
  const landed = new Set();
  for (const [stage, branch] of Object.entries(stageBranches)) {
    try {
      run(['merge-base', '--is-ancestor', branch, main], root);
      landed.add(stage);
    } catch {
      // An absent or unmerged branch is still open work.
    }
  }
  return landed;
}

export function buildDebtIndex(entries = KNOWN_DEBT, { landed } = {}) {
  const index = new Map();
  for (const entry of entries) {
    if (!entry.owner) throw new Error(`the debt entry for ${entry.name} names no stage that owns the fix`);
    if (!entry.why) throw new Error(`the debt entry for ${entry.name} does not say what it hides`);
    if (landed?.has(entry.owner)) {
      throw new Error(`the debt entry for ${entry.name} names ${entry.owner}, which has landed, so nobody owns this gap any more`);
    }
    index.set(entry.name, entry);
  }
  return index;
}

export function checkPublicSurface({ root = process.cwd(), names: requestedNames, codes: requestedCodes, pageText: requestedPageText, debt } = {}) {
  const surfaceNames = requestedNames ?? names;
  const surfaceCodes = requestedCodes ?? codes;
  const docsText = requestedPageText ?? pageText;
  const debtIndex = debt ?? buildDebtIndex(KNOWN_DEBT, { landed: landedStages(root) });
  const missing = [...new Set([...surfaceNames, ...surfaceCodes])].filter((name) => !docsText.includes(name) && !debtIndex.has(name));
  return { missing, count: new Set([...surfaceNames, ...surfaceCodes]).size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = checkPublicSurface();
  if (result.missing.length) { console.error(`Public surface missing from docs: ${result.missing.join(', ')}`); process.exit(1); }
  console.log(`Public surface check passed (${result.count} names).`);
}
