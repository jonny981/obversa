import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from '@typescript/typescript6';

const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts']);
const allowedNodeImports = new Map([
  ['node:crypto', 'createHash'],
  ['node:util', 'isDeepStrictEqual'],
]);
const allowedApiImports = new Map([
  ['Memory', 'type'],
  ['MemoryCommand', 'type'],
  ['ExecutionTarget', 'type'],
  ['DispatchGraphCommand', 'type'],
  ['PauseGraphCommand', 'type'],
  ['CompleteGraphCommand', 'type'],
  ['FailGraphCommand', 'type'],
  ['GraphCommand', 'type'],
  ['GraphValidationIssue', 'type'],
  ['RunBrief', 'type'],
  ['GraphId', 'type'],
  ['NodeId', 'type'],
  ['EdgeId', 'type'],
  ['GraphNode', 'type'],
  ['GraphEdge', 'type'],
  ['GraphDefinition', 'type'],
  ['CompiledGraphDefinition', 'type'],
  ['GraphKernel', 'type'],
  ['GraphEvent', 'type'],
  ['GraphEngineIdentity', 'type'],
  ['EngineAttemptRecordedPayload', 'type'],
  ['GraphBindings', 'type'],
  ['GraphTypeCompilation', 'type'],
  ['CompiledGraphType', 'type'],
  ['GraphType', 'type'],
  ['PermissionDescriptor', 'type'],
  ['ExecutionLaneDescription', 'type'],
  ['GraphPhaseDescription', 'type'],
  ['GraphNodeDescription', 'type'],
  ['GraphEdgeDescription', 'type'],
  ['PlanBound', 'type'],
  ['GraphBounds', 'type'],
  ['GraphPolicyDescription', 'type'],
  ['GraphRequirements', 'type'],
  ['GraphDescriptionInput', 'type'],
  ['GraphDescription', 'type'],
  ['GraphPackageIdentity', 'type'],
  ['GraphPackageAdmission', 'type'],
  ['ExecutionLaneResolution', 'type'],
  ['RunPreflightPolicy', 'type'],
  ['PlanResolution', 'type'],
  ['ResolvedExecutionLane', 'type'],
  ['ResolvedPlan', 'type'],
  ['ResolvedPlanSnapshot', 'type'],
  ['JsonObject', 'type'],
  ['JsonPrimitive', 'type'],
  ['JsonValue', 'type'],
  ['Sha256Digest', 'type'],
  ['JsonValueError', 'value'],
  ['GraphValidationError', 'value'],
  ['compileGraphDefinition', 'value'],
  ['validateResolvedPlan', 'value'],
  ['validateGraphDescription', 'value'],
  ['resolveGraphPlan', 'value'],
  ['canonicalJson', 'value'],
  ['cloneFrozenJson', 'value'],
  ['digestJson', 'value'],
]);
const allowedMathMembers = new Set([
  'E',
  'LN10',
  'LN2',
  'LOG10E',
  'LOG2E',
  'PI',
  'SQRT1_2',
  'SQRT2',
  'abs',
  'acos',
  'acosh',
  'asin',
  'asinh',
  'atan',
  'atan2',
  'atanh',
  'cbrt',
  'ceil',
  'clz32',
  'cos',
  'cosh',
  'exp',
  'expm1',
  'floor',
  'fround',
  'hypot',
  'imul',
  'log',
  'log10',
  'log1p',
  'log2',
  'max',
  'min',
  'pow',
  'round',
  'sign',
  'sin',
  'sinh',
  'sqrt',
  'tan',
  'tanh',
  'trunc',
]);
const forbiddenGraphSegments = new Set([
  'runtime',
  'engine',
  'engines',
  'env',
  'workspace',
  'workspaces',
  'git',
  'process',
  'storage',
  'telemetry',
]);
const effectfulGlobals = new Map([
  ['Date', 'time'],
  ['performance', 'time'],
  ['crypto', 'randomness'],
  ['process', 'process access'],
  ['fetch', 'network access'],
  ['XMLHttpRequest', 'network access'],
  ['WebSocket', 'network access'],
  ['EventSource', 'network access'],
  ['setTimeout', 'timers'],
  ['setInterval', 'timers'],
  ['setImmediate', 'timers'],
  ['queueMicrotask', 'timers'],
  ['eval', 'dynamic evaluation'],
  ['Function', 'dynamic evaluation'],
  ['globalThis', 'global-object access'],
  ['global', 'global-object access'],
  ['window', 'global-object access'],
  ['self', 'global-object access'],
]);

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiGraphFiles = [
  'graph-kernel.ts', 'graph-plan.ts', 'graph-type.ts', 'graph-contract.ts',
  'graph-commands.ts', 'json.ts', 'contracts.ts', 'memory-types.ts',
];
const scanRoots = (process.argv.length > 2
  ? process.argv.slice(2)
  : [
      resolve(repositoryRoot, 'packages/runtime/src/graph'),
      resolve(repositoryRoot, 'packages/runtime/src/graph-types'),
      ...apiGraphFiles.map((file) => resolve(repositoryRoot, 'packages/api/src', file)),
    ])
  .map((root) => resolve(root));

const violations = [];
const files = (await Promise.all(scanRoots.map((root) => sourceFiles(root)))).flat();
const scannedFiles = new Set(files.map((file) => resolve(file)));

for (const file of files) {
  await checkFile(file);
}

if (violations.length > 0) {
  console.error(`Graph purity check failed (${violations.length} violations):`);
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Graph purity check passed (${files.length} files).`);
}

async function sourceFiles(directory) {
  if ((await stat(directory)).isFile()) {
    if (!sourceExtensions.has(extname(directory))) throw new Error(`not a graph source file: ${directory}`);
    return [directory];
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await sourceFiles(path)));
    } else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
      paths.push(path);
    }
  }

  return paths;
}

async function checkFile(file) {
  const sourceText = await readFile(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    extname(file) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  for (const diagnostic of sourceFile.parseDiagnostics) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
    report(sourceFile, diagnostic.start ?? 0, `cannot parse source: ${message}`);
  }

  visit(sourceFile, sourceFile);
}

function visit(node, sourceFile) {
  if (ts.isImportDeclaration(node)) {
    checkImportDeclaration(node, sourceFile);
  } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
    if (ts.isStringLiteralLike(node.moduleSpecifier) && node.moduleSpecifier.text === '@obversa/api') {
      checkEngineExport(node, sourceFile);
    } else {
      checkSpecifier(node.moduleSpecifier, sourceFile);
    }
  } else if (
    ts.isImportEqualsDeclaration(node)
    && ts.isExternalModuleReference(node.moduleReference)
  ) {
    checkSpecifier(node.moduleReference.expression, sourceFile);
  } else if (ts.isImportTypeNode(node)) {
    const argument = node.argument;
    if (ts.isLiteralTypeNode(argument)) {
      checkSpecifier(argument.literal, sourceFile);
    } else {
      report(sourceFile, argument.getStart(sourceFile), 'import type must use a string literal');
    }
  } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    checkCallSpecifier(node, sourceFile, 'import()');
  } else if (
    ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'require'
  ) {
    checkCallSpecifier(node, sourceFile, 'require()');
  }

  if (ts.isIdentifier(node) && isReferenceIdentifier(node)) {
    const effect = effectfulGlobals.get(node.text);
    if (effect) {
      report(sourceFile, node.getStart(sourceFile), `${node.text} is forbidden: ${effect}`);
    }
    if (node.text === 'Math') {
      const member = directMathMember(node);
      if (!member || !allowedMathMembers.has(member)) {
        report(
          sourceFile,
          node.getStart(sourceFile),
          'Math is allowed only for direct access to a reviewed deterministic member',
        );
      }
    }
  }

  ts.forEachChild(node, (child) => visit(child, sourceFile));
}

function checkImportDeclaration(declaration, sourceFile) {
  const node = declaration.moduleSpecifier;
  if (!ts.isStringLiteralLike(node)) {
    report(sourceFile, node.getStart(sourceFile), 'module specifier must be a string literal');
    return;
  }

  const expectedImport = allowedNodeImports.get(node.text);
  if (expectedImport) {
    const clause = declaration.importClause;
    const elements = clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
      ? clause.namedBindings.elements
      : [];
    const valid = Boolean(
      clause
      && !clause.isTypeOnly
      && !clause.name
      && elements.length === 1
      && !elements[0].isTypeOnly
      && (elements[0].propertyName?.text ?? elements[0].name.text) === expectedImport,
    );
    if (!valid) {
      report(
        sourceFile,
        node.getStart(sourceFile),
        `'${node.text}': only the named ${expectedImport} import is allowed`,
      );
    }
    return;
  }

  if (node.text === '@obversa/api') {
    const clause = declaration.importClause;
    const elements = clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
      ? clause.namedBindings.elements
      : [];
    if (!clause || clause.name || elements.length === 0) {
      report(
        sourceFile,
        node.getStart(sourceFile),
        "'@obversa/api': only reviewed named imports are allowed",
      );
      return;
    }
    checkEngineElements(elements, clause.isTypeOnly, node, sourceFile);
    return;
  }

  checkSpecifier(node, sourceFile);
}

function checkEngineExport(declaration, sourceFile) {
  const node = declaration.moduleSpecifier;
  const elements = declaration.exportClause && ts.isNamedExports(declaration.exportClause)
    ? declaration.exportClause.elements
    : [];
  if (elements.length === 0) {
    report(
      sourceFile,
      node.getStart(sourceFile),
      "'@obversa/api': only reviewed named JSON exports are allowed",
    );
    return;
  }
  checkEngineElements(elements, declaration.isTypeOnly, node, sourceFile);
}

function checkEngineElements(elements, declarationIsTypeOnly, node, sourceFile) {
  for (const element of elements) {
    const importedName = element.propertyName?.text ?? element.name.text;
    const kind = allowedApiImports.get(importedName);
    if (!kind) {
      report(
        sourceFile,
        node.getStart(sourceFile),
        `'@obversa/api': ${importedName} is not a reviewed graph JSON import`,
      );
      continue;
    }
    if (kind === 'type' && !declarationIsTypeOnly && !element.isTypeOnly) {
      report(
        sourceFile,
        node.getStart(sourceFile),
        `'@obversa/api': ${importedName} must be imported or exported as a type`,
      );
    }
  }
}

function checkCallSpecifier(call, sourceFile, label) {
  const [argument] = call.arguments;
  if (call.arguments.length !== 1 || !argument || !ts.isStringLiteralLike(argument)) {
    report(sourceFile, call.getStart(sourceFile), `${label} must use a string literal`);
    return;
  }

  checkSpecifier(argument, sourceFile);
}

function checkSpecifier(node, sourceFile) {
  if (!node || !ts.isStringLiteralLike(node)) {
    report(sourceFile, node?.getStart(sourceFile) ?? 0, 'module specifier must be a string literal');
    return;
  }

  const specifier = node.text;
  const reason = forbiddenReason(specifier, sourceFile);
  if (reason) {
    report(sourceFile, node.getStart(sourceFile), `'${specifier}': ${reason}`);
  }
}

function forbiddenReason(specifier, sourceFile) {
  if (specifier === 'toposort') return undefined;
  if (specifier === '@obversa/api') {
    return 'only reviewed named imports are allowed';
  }
  if (specifier.startsWith('@obversa/memory-')) {
    return 'memory adapters are outside the graph core';
  }

  const segments = specifier
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .map((segment) => segment.replace(/\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/, ''));
  const forbiddenSegment = segments.find(
    (segment) => forbiddenGraphSegments.has(segment) || segment.startsWith('process-'),
  );
  if (forbiddenSegment) {
    return `graph code cannot depend on ${forbiddenSegment}`;
  }

  if (specifier.startsWith('.')) {
    const target = resolve(dirname(sourceFile.fileName), specifier);
    if (!scanRoots.some((root) => isInside(sourceExtensions.has(extname(root)) ? dirname(root) : root, target))) {
      return 'local imports must stay inside the graph root';
    }
    if (!localSourceCandidates(target).some((candidate) => scannedFiles.has(candidate))) {
      return 'local runtime imports must resolve to a scanned source file (.ts, .tsx, .mts, or .cts)';
    }
    return undefined;
  }

  return 'runtime imports must be local graph modules';
}

function isInside(root, target) {
  const pathFromRoot = relative(root, target);
  return pathFromRoot !== '..'
    && !pathFromRoot.startsWith(`..${sep}`)
    && !isAbsolute(pathFromRoot);
}

function localSourceCandidates(target) {
  const extension = extname(target);
  if (sourceExtensions.has(extension)) {
    return [target];
  }

  const base = extension ? target.slice(0, -extension.length) : target;
  const replacements = new Map([
    ['.js', ['.ts', '.tsx']],
    ['.jsx', ['.tsx']],
    ['.mjs', ['.mts']],
    ['.cjs', ['.cts']],
  ]).get(extension);
  if (replacements) {
    return replacements.map((replacement) => `${base}${replacement}`);
  }
  if (extension) {
    return [];
  }

  return [
    ...sourceExtensions,
  ].flatMap((sourceExtension) => [
    `${target}${sourceExtension}`,
    resolve(target, `index${sourceExtension}`),
  ]);
}

function directMathMember(node) {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
    return parent.name.text;
  }
  if (
    ts.isElementAccessExpression(parent)
    && parent.expression === node
    && parent.argumentExpression
    && ts.isStringLiteralLike(parent.argumentExpression)
  ) {
    return parent.argumentExpression.text;
  }
  return undefined;
}

function isReferenceIdentifier(node) {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return false;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return false;
  if (ts.isPropertySignature(parent) && parent.name === node) return false;
  if (ts.isMethodSignature(parent) && parent.name === node) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if (ts.isParameter(parent) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && parent.name === node) return false;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return false;
  if (ts.isFunctionExpression(parent) && parent.name === node) return false;
  if (ts.isClassDeclaration(parent) && parent.name === node) return false;
  if (ts.isClassExpression(parent) && parent.name === node) return false;
  if (ts.isInterfaceDeclaration(parent) && parent.name === node) return false;
  if (ts.isTypeAliasDeclaration(parent) && parent.name === node) return false;
  if (ts.isEnumDeclaration(parent) && parent.name === node) return false;
  if (ts.isTypeParameterDeclaration(parent) && parent.name === node) return false;
  if (ts.isImportClause(parent)) return false;
  if (ts.isImportSpecifier(parent)) return false;
  if (ts.isNamespaceImport(parent)) return false;
  if (ts.isImportEqualsDeclaration(parent) && parent.name === node) return false;
  if (ts.isExportSpecifier(parent)) return false;
  if (ts.isLabeledStatement(parent) && parent.label === node) return false;
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) {
    return false;
  }
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  return true;
}

function report(sourceFile, position, message) {
  const location = sourceFile.getLineAndCharacterOfPosition(position);
  const root = scanRoots.find((candidate) => isInside(candidate, sourceFile.fileName));
  const path = (root === sourceFile.fileName
    ? basename(root)
    : `${scanRoots.length === 1 ? '' : `${basename(root)}/`}${relative(root, sourceFile.fileName)}`)
    .split(sep)
    .join('/');
  violations.push(`${path}:${location.line + 1}:${location.character + 1}: ${message}`);
}
