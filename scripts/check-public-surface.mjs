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
const pageText = fs.readdirSync(docs, { recursive: true }).filter((f) => f.endsWith('.mdx')).map((f) => fs.readFileSync(path.join(docs, f), 'utf8')).join('\n');
function debtEntries(names, owner, page) {
  return names.map((name) => ({
    name,
    owner,
    why: `${name} is not named on ${page}; ${owner} owns that page's public-surface entry.`,
  }));
}

const KNOWN_DEBT = [
  ...debtEntries([
    'GraphEngineBinding', 'GraphExecutorOptions', 'SupervisedRunBindings', 'SupervisedHostContext',
    'SupervisedRunResult', 'SupervisedWorkerInput', 'ReadSupervisedRunStatusOptions',
    'callbackRequestDigest', 'validateCallbackRequest', 'validateCallbackResponse', 'validateCallbackEvent',
    'validateApprovalRecord', 'validateAcceptedResultRecord', 'validateNewDomainEvent',
    'validateDomainEventEnvelope', 'validateDomainEventBatch', 'validateEventStreamRef',
    'validateArtifactScope', 'validateNewArtifact', 'validateRunDefinition', 'validateRunStartRecord',
    'validateRunStoragePolicy', 'validateRunStorageRecord', 'reviewContext', 'defineSkill', 'fromFile',
    'LoopError', 'EngineIncompleteResultError', 'finalResultText', 'exitCodeFor', 'EXIT_PAUSED',
  ], 'D35', 'docs/public/packages/runtime.mdx'),
  ...debtEntries([
    'GraphExecutionErrorCode', 'validateStandardEvent', 'describeConditions', 'assertGraph',
    'confidenceCondition', 'confidenceFromText', 'lastDecisionLine', 'lastGateBrief', 'toCondition',
    'bodyPassed', 'minConfidence', 'classifyEngineFailure', 'LANE_DEAD_FAILURES', 'fallbackEngine',
    'preflightEngine', 'formatPreflight', 'costReport', 'formatCostReport', 'ratchet', 'writeScope',
    'sampled',
  ], 'D47', 'docs/public/graphs/contract.mdx'),
  ...debtEntries([
    'DUPLICATE_POSITION', 'EMPTY_DECISION', 'INVALID_EVENT', 'MISSING_ENGINE_BINDING', 'MISSING_MEMORY',
    'MISSING_NODE_BINDING', 'STORAGE_LIMIT_EXCEEDED', 'ACTION_POLICY', 'INVALID_OPTIONS',
    'INVALID_EXECUTABLE', 'MEMORY_LIMIT', 'WORKSPACE_CAPTURE', 'WORKSPACE_ROOT', 'EEXIST',
    'RUN_NOT_PAUSED', 'RESUME_POSITION', 'WORKSPACE_LEASE', 'WORKSPACE_RELEASE', 'BUDGET_STOP',
    'RESTART_EXHAUSTED', 'WATCHDOG_ERROR',
  ], 'D47', 'docs/public/graphs/executor.mdx'),
];

const TRACKED_TYPE_EXPORTS = new Set([
  'GraphExecutionErrorCode', 'GraphExecutorResult', 'RunPreflightPolicy', 'RunPreflightState',
  'PreflightPauseResult', 'PreflightFailureResult',
  'SupervisedRunOptions', 'ResumeSupervisedRunOptions', 'ResumePreflightSupervisedRunOptions',
  'SupervisedRunStatus', 'SupervisedRunUsage', 'ReadSupervisedRunStatusOptions',
]);
const MINIMUM_VALUE_EXPORTS = 100;
const REQUIRED_VALUE_EXPORTS = ['run', 'createGraphExecutor', 'startSupervisedRun'];

export function exportListNames(list) {
  return list.split(',').flatMap((raw) => {
    const item = raw.trim().replace(/\s+/g, ' ');
    if (!item || item.startsWith('type ')) return [];
    return [item.split(/\s+as\s+/u).at(-1)];
  });
}

function resolveExportFile(file, specifier) {
  const base = path.resolve(path.dirname(file), specifier.replace(/\.(?:[cm]?js|tsx?)$/u, ''));
  for (const candidate of [base, base + '.ts', base + '.tsx', base + '.js', path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function exportedValues(file, source, { followStar = true } = {}) {
  const values = [];
  for (const match of source.matchAll(/export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_]+)/gu)) {
    values.push(match[1]);
  }
  for (const match of source.matchAll(/export\s+(?!type\b)\{([\s\S]*?)\}(?:\s+from\s+['"]([^'"]+)['"])?/gu)) {
    values.push(...exportListNames(match[1]));
  }
  if (followStar) {
    for (const match of source.matchAll(/export\s+\*\s+from\s+['"]([^'"]+)['"]/gu)) {
      const target = resolveExportFile(file, match[1]);
      if (target !== undefined) values.push(...exportedValues(target, fs.readFileSync(target, 'utf8'), { followStar: false }));
    }
  }
  return [...new Set(values)];
}

export function exportedTypes(source) {
  const names = [];
  for (const match of source.matchAll(/export\s+(type\s+)?\{([\s\S]*?)\}(?:\s+from\s+['"][^'"]+['"])?/gu)) {
    const typeOnly = match[1] !== undefined;
    names.push(...match[2].split(',').flatMap((item) => {
      const normalized = item.trim().replace(/\s+/g, ' ');
      if (!typeOnly && !normalized.startsWith('type ')) return [];
      const typeName = typeOnly ? normalized : normalized.slice('type '.length);
      return [typeName.split(/\s+as\s+/u).at(-1)];
    }).filter(Boolean));
  }
  for (const match of source.matchAll(/export\s+type\s+([A-Za-z0-9_]+)/gu)) names.push(match[1]);
  return names.filter((name) => TRACKED_TYPE_EXPORTS.has(name));
}

function unionCodes(source, name) {
  const pattern = '(?:export\\s+)?type\\s+' + name
    + '\\s*=([\\s\\S]*?)(?=\\n\\n(?:export\\s+)?(?:type|interface|class|const|function)\\b|$)';
  const match = source.match(new RegExp(pattern, 'u'));
  return match === null ? [] : [...match[1].matchAll(/['"]([A-Z][A-Z0-9_]{2,})['"]/gu)].map((item) => item[1]);
}

function surfaceFromSources(files = sources) {
  const contents = files.map((file) => ({ file, source: fs.readFileSync(file, 'utf8') }));
  const values = contents.flatMap(({ file, source }) => exportedValues(file, source));
  const types = contents.flatMap(({ source }) => exportedTypes(source));
  const graph = contents.find(({ file }) => file.endsWith('graph-executor.ts'))?.source ?? '';
  const supervised = contents.find(({ file }) => file.endsWith('supervised-run.ts'))?.source ?? '';
  const codes = [
    ...unionCodes(graph, 'GraphExecutionErrorCode'),
    ...unionCodes(graph, 'GraphExecutorResult'),
    ...unionCodes(supervised, 'SupervisedRunResult'),
  ];
  return {
    values: [...new Set(values)],
    types: [...new Set(types)],
    codes: [...new Set(codes)],
  };
}

export function assertSurfaceShape({ values }) {
  if (values.length < MINIMUM_VALUE_EXPORTS) {
    throw new Error('public surface parser found ' + values.length + ' value exports; expected at least ' + MINIMUM_VALUE_EXPORTS);
  }
  for (const name of REQUIRED_VALUE_EXPORTS) {
    if (!values.includes(name)) throw new Error('public surface parser did not find required value export ' + name);
  }
}

export const { values: names, types, codes } = surfaceFromSources();
assertSurfaceShape({ values: names });

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

export function checkPublicSurface({
  root = process.cwd(), names: requestedNames, types: requestedTypes, codes: requestedCodes,
  pageText: requestedPageText, debt,
} = {}) {
  const surfaceNames = requestedNames ?? names;
  const surfaceTypes = requestedTypes ?? types;
  const surfaceCodes = requestedCodes ?? codes;
  const docsText = requestedPageText ?? pageText;
  const debtIndex = debt ?? buildDebtIndex(KNOWN_DEBT, { landed: landedStages(root) });
  const missing = [...new Set([...surfaceNames, ...surfaceTypes, ...surfaceCodes])]
    .filter((name) => !docsText.includes(name) && !debtIndex.has(name));
  return { missing, count: new Set([...surfaceNames, ...surfaceTypes, ...surfaceCodes]).size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = checkPublicSurface();
  if (result.missing.length) { console.error(`Public surface missing from docs: ${result.missing.join(', ')}`); process.exit(1); }
  console.log(`Public surface check passed (${result.count} names).`);
}
