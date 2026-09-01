import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from '@typescript/typescript6';

const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts']);
const allowedNodeImports = new Map([
  ['node:crypto', 'createHash'],
  ['node:util', 'isDeepStrictEqual'],
]);
const allowedEngineImports = new Map([
  ['JsonObject', 'type'],
  ['JsonPrimitive', 'type'],
  ['JsonValue', 'type'],
  ['Sha256Digest', 'type'],
  ['JsonValueError', 'value'],
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
const scanRoot = resolve(process.argv[2] ?? resolve(repositoryRoot, 'packages/runtime/src/graph'));

const violations = [];
const files = await sourceFiles(scanRoot);
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
    if (ts.isStringLiteralLike(node.moduleSpecifier) && node.moduleSpecifier.text === '@obversa/engine') {
      checkEngineExport(node, sourceFile);
    } else {
      checkSpecifier(node.moduleSpecifier, sourceFile, false);
    }
  } else if (
    ts.isImportEqualsDeclaration(node)
    && ts.isExternalModuleReference(node.moduleReference)
  ) {
    checkSpecifier(node.moduleReference.expression, sourceFile, false);
  } else if (ts.isImportTypeNode(node)) {
    const argument = node.argument;
    if (ts.isLiteralTypeNode(argument)) {
      checkSpecifier(argument.literal, sourceFile, true);
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

  if (node.text === '@obversa/engine') {
    const clause = declaration.importClause;
    const elements = clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
      ? clause.namedBindings.elements
      : [];
    if (!clause || clause.name || elements.length === 0) {
      report(
        sourceFile,
        node.getStart(sourceFile),
        "'@obversa/engine': only reviewed named JSON imports are allowed",
      );
      return;
    }
    checkEngineElements(elements, clause.isTypeOnly, node, sourceFile);
    return;
  }

  checkSpecifier(node, sourceFile, isTypeOnlyMemoryImport(declaration));
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
      "'@obversa/engine': only reviewed named JSON exports are allowed",
    );
    return;
  }
  checkEngineElements(elements, declaration.isTypeOnly, node, sourceFile);
}

function checkEngineElements(elements, declarationIsTypeOnly, node, sourceFile) {
  for (const element of elements) {
    const importedName = element.propertyName?.text ?? element.name.text;
    const kind = allowedEngineImports.get(importedName);
    if (!kind) {
      report(
        sourceFile,
        node.getStart(sourceFile),
        `'@obversa/engine': ${importedName} is not a reviewed graph JSON import`,
      );
      continue;
    }
    if (kind === 'type' && !declarationIsTypeOnly && !element.isTypeOnly) {
      report(
        sourceFile,
        node.getStart(sourceFile),
        `'@obversa/engine': ${importedName} must be imported or exported as a type`,
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

  checkSpecifier(argument, sourceFile, false);
}

function checkSpecifier(node, sourceFile, allowMemoryPortType) {
  if (!node || !ts.isStringLiteralLike(node)) {
    report(sourceFile, node?.getStart(sourceFile) ?? 0, 'module specifier must be a string literal');
    return;
  }

  const specifier = node.text;
  const reason = forbiddenReason(specifier, sourceFile, allowMemoryPortType);
  if (reason) {
    report(sourceFile, node.getStart(sourceFile), `'${specifier}': ${reason}`);
  }
}

function isTypeOnlyMemoryImport(declaration) {
  if (declaration.moduleSpecifier.text !== '@obversa/memory') {
    return false;
  }

  const clause = declaration.importClause;
  if (!clause) {
    return false;
  }
  if (clause.isTypeOnly) {
    return true;
  }
  if (clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
    return false;
  }

  const elements = clause.namedBindings.elements;
  return elements.length > 0 && elements.every((element) => element.isTypeOnly);
}

function forbiddenReason(specifier, sourceFile, allowMemoryPortType) {
  if (specifier === '@obversa/engine') {
    return 'only reviewed named JSON imports are allowed';
  }
  if (specifier === '@obversa/memory') {
    return allowMemoryPortType ? undefined : 'only type imports from the memory port are allowed';
  }
  if (specifier.startsWith('@obversa/memory')) {
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
    const pathFromRoot = relative(scanRoot, target);
    if (
      pathFromRoot === '..'
      || pathFromRoot.startsWith(`..${sep}`)
      || isAbsolute(pathFromRoot)
    ) {
      return 'local imports must stay inside the graph root';
    }
    if (!localSourceCandidates(target).some((candidate) => scannedFiles.has(candidate))) {
      return 'local runtime imports must resolve to a scanned source file (.ts, .tsx, .mts, or .cts)';
    }
    return undefined;
  }

  return 'runtime imports must be local graph modules';
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
  const path = relative(scanRoot, sourceFile.fileName).split(sep).join('/');
  violations.push(`${path}:${location.line + 1}:${location.character + 1}: ${message}`);
}
