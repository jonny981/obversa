import fs from 'node:fs';
import path from 'node:path';

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
const debt = new Set([
  'GraphExecutionErrorCode','GraphEngineBinding','GraphExecutorOptions','GraphExecutorResult','validateStandardEvent',
  'SupervisedRunBindings','SupervisedHostContext','SupervisedRunResult','SupervisedWorkerInput',
  'DUPLICATE_POSITION','EMPTY_DECISION','INVALID_EVENT','MISSING_ENGINE_BINDING','MISSING_MEMORY','MISSING_NODE_BINDING',
  'STORAGE_LIMIT_EXCEEDED','ACTION_POLICY','INVALID_OPTIONS','INVALID_EXECUTABLE','MEMORY_LIMIT','WORKSPACE_CAPTURE',
  'WORKSPACE_ROOT','EEXIST','RUN_NOT_PAUSED','RESUME_POSITION','WORKSPACE_LEASE','WORKSPACE_RELEASE','BUDGET_STOP',
  'RESTART_EXHAUSTED','WATCHDOG_ERROR','readRunPreflight','validateDomainEventId',
]);
const missing = [...new Set([...names, ...codes])].filter((name) => !pageText.includes(name) && !debt.has(name));
if (missing.length) { console.error(`Public surface missing from docs: ${missing.join(', ')}`); process.exit(1); }
console.log(`Public surface check passed (${new Set([...names, ...codes]).size} names).`);
