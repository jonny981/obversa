import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// (fileURLToPath also reads `file:` specifiers, below.)

// The TypeScript compiler's parser (the pinned TypeScript 6 build; the
// TypeScript 7 native build exposes no parser API). A real parser is the only
// honest way to find imports: strings, template literals, regex literals, and
// comments are decided by the language's grammar, so none of them can hide a
// specifier from this fail-closed guard or fake one. The same build's config
// reader and module resolver answer what a project config means and where a
// specifier lands, so the scan never recreates the compiler's path rules.
import ts from '@typescript/typescript6';
// The range parser pnpm uses, at the pinned version, so a dependency value
// is a range exactly when pnpm would install a version rather than a tag.
import { validRange } from 'semver';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ignoredDirectories = new Set(['dist', 'node_modules']);

const scriptKinds = new Map([
  ['.ts', ts.ScriptKind.TS], ['.mts', ts.ScriptKind.TS], ['.cts', ts.ScriptKind.TS],
  ['.tsx', ts.ScriptKind.TSX],
  ['.js', ts.ScriptKind.JS], ['.mjs', ts.ScriptKind.JS], ['.cjs', ts.ScriptKind.JS],
  ['.jsx', ts.ScriptKind.JSX],
]);
export const parserExtensions = [...scriptKinds.keys()];

// Every module form the parser map accepts is scanned for imports; this set
// and the predicate are exported so the spec can hold them to that. A form
// the parser accepts but the scan skipped would let a forbidden import
// through unchecked.
export const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const sourcePattern = new RegExp(`(?:${sourceExtensions.map((ext) => ext.replace('.', '\\.')).join('|')})$`);
export function scansImports(path) {
  return path.startsWith('packages/') && sourcePattern.test(path);
}

// A host is a composition root: it may import any workspace package by its
// public name, and nothing by a path into packages/. Host JavaScript — a
// source file by extension, or an extensionless command whose first line is
// a node shebang — is held to that, with the loader-hatch rules of shipped
// source. Returns the failures for one file.
export function isHostScript(path, text) {
  if (!path.startsWith('hosts/')) return false;
  if (sourcePattern.test(path)) return true;
  return extname(path) === '' && /^#!.*\bnode\b/.test(text.split('\n')[0] ?? '');
}
// The `hosts/<name>` root an absolute path lies in, or undefined.
function hostRootOf(absolute, repoRoot) {
  const match = /^hosts\/([^/]+)(?:\/|$)/.exec(placedUnder(absolute, repoRoot));
  return match ? `hosts/${match[1]}/` : undefined;
}
// A path relative to the root with both read by real path (realPathOf), so
// a root or a file handed over through a symlink places the same as its
// real spelling, and a path whose tail does not exist yet places under the
// real path of its deepest existing ancestor.
function placedUnder(absolute, repoRoot) {
  return relative(realPathOf(repoRoot), realPathOf(absolute)).split('\\').join('/');
}
// A path by its real spelling. The components that do not exist — one, or
// a whole missing tail such as generated/nested/entry.mjs — are kept as
// spelled under the real path of the deepest ancestor that does exist, so a
// path into a sibling package still places there when the file is yet to
// be built. A path with no existing ancestor at all keeps its spelling.
function realPathOf(path) {
  const missing = [];
  let current = path;
  while (!ts.sys.fileExists(current) && !ts.sys.directoryExists(current)) {
    const parent = dirname(current);
    if (parent === current) return path;
    missing.unshift(basename(current));
    current = parent;
  }
  return join(realpathOf(current, ts.sys), ...missing);
}
// The one refusal for a symlink met under packages/ or hosts/, by the main
// walk or by the per-package and per-host walks that enter dist. Declared
// before the check runs, which any function the check calls must be.
const symlinkRefusal = (path) => `${path}: a symlink is refused wherever the scan walks; it can reach a file the scan never read while the path that names it looks local, or stand as an entry or a command the scan never read`;
// The membership proof over recorded host edges: each target must be in
// the set of files the walk import-scanned. Exported so the spec holds it to
// that directly, beside the live full-check mutant.
export function hostEdgeFailures(edges, scanned) {
  const failures = [];

  for (const { from, specifier, target } of edges) {
    if (!scanned.has(target)) failures.push(`${from}: imports ${specifier}, which resolves to ${target}, a file this scan did not import-scan`);
  }
  return failures;
}
// `dependencies` is what the host's manifest declares: each name to the set
// of subpaths its exports map lists (a workspace package), or null (a
// registry package). Nothing declared is the default, so a shipped bare
// specifier fails closed when the caller has no manifest to hand over.
export function hostImportFindings(text, { file, root: repoRoot, edges = [], selfName, dependencies = new Map() } = {}) {
  const findings = [];
  const parsedAs = sourcePattern.test(file) ? file : `${file}.mjs`;
  // A host's proofs reach a package's internals by path today (the browser
  // proof drives the highlighter and the models directly); the public-name
  // rule binds shipped host code, and the proofs move to a public testing
  // subpath in F2b. A test file is still refused a computed or schemed
  // specifier.
  const shipped = !isTestPath(file);
  for (const raw of moduleSpecifiers(text, parsedAs)) {
    if (raw === null) {
      findings.push('a computed module reference cannot be checked; use a plain string');
      continue;
    }
    const { text: specifier, refused } = readSpecifier(raw);
    if (refused) {
      findings.push(refused);
      continue;
    }
    // Package indirection is not a path the scan can follow: a `#alias` goes
    // through the host manifest's imports map, and the host's own name (or a
    // subpath of it) through its exports map. Neither exists in a host, and
    // both are refused so no module can reach a file the edge set never saw.
    if (shipped && specifier.startsWith('#')) {
      findings.push(`a host imports through a package-imports alias (${specifier}); hosts carry no imports map and import by path or public name only`);
      continue;
    }
    if (shipped && selfName && (specifier === selfName || specifier.startsWith(`${selfName}/`))) {
      findings.push(`a host imports itself by package name (${specifier}); hosts carry no exports map and import their own files by path`);
      continue;
    }
    // A bare specifier is a builtin under its node: prefix or a dependency
    // the host's manifest declares, and a subpath into a dependency only
    // one its exports map lists: without that entry Node serves any file
    // under the package, scanned or not.
    if (shipped && !/^\.\.?\//.test(specifier) && !isAbsolute(specifier)) {
      if (specifier.startsWith('node:')) {
        if (!isBuiltin(specifier)) findings.push(`a host imports ${specifier}, which is not a Node builtin`);
        continue;
      }
      if (isBuiltin(specifier)) {
        findings.push(`a host imports the builtin ${specifier} without its node: prefix; name it node:${specifier}`);
        continue;
      }
      const parts = /^((?:@[^/]+\/)?[^/]+)(?:\/(.*))?$/.exec(specifier);
      const name = parts?.[1];
      if (!name || !dependencies.has(name)) {
        findings.push(`a host imports ${specifier}, which its manifest does not declare; a host takes only the dependencies its manifest declares`);
        continue;
      }
      if (parts[2] !== undefined && !dependencies.get(name)?.has(`./${parts[2]}`))
        findings.push(`a host imports ${specifier}, a subpath its dependency's exports map does not list; without that entry Node serves any file under the package`);
      continue;
    }
    if (shipped && (/^\.\.?\//.test(specifier) || isAbsolute(specifier))) {
      const target = resolve(dirname(file), specifier);
      const real = realpathOf(target, ts.sys);
      const dir = packageDirOf(real, repoRoot) ?? packageDirOf(target, repoRoot);
      if (dir !== undefined) findings.push(`a host reaches packages/${dir} by path (${specifier}); hosts import packages by their public names only`);
      // A test path is exempt from the loader-hatch rules, so shipped host
      // code may not reach one — the same edge the package scan refuses.
      if (namesTestPath(specifier, file) || namesTestPath(real, file)) findings.push(`shipped host code imports a test path, which is exempt from the loader-hatch rules: ${specifier}`);
      // A shipped host's local module must be a file the walk import-scans:
      // inside the importing file's own hosts/<name>/ root by real path (not
      // the repository root, not scripts/, not another host) and carrying a
      // source extension. Membership is proved by position, never inferred
      // from a suffix alone.
      const hostRoot = hostRootOf(file, repoRoot);
      const targetRoot = hostRootOf(real, repoRoot);
      if (!hostRoot || targetRoot !== hostRoot) findings.push(`a host imports a local module outside its own host root (${specifier}); a host's local modules live under ${hostRoot ?? 'hosts/<name>/'}`);
      else if (!sourcePattern.test(real)) findings.push(`a host imports a local module the scan would not read (${specifier}); a local module carries a source extension`);
      // The early reasons above are clear but not the proof: the walk skips
      // dist and node_modules, so a shape that passes them can still name a
      // file no scan read. Every resolved edge is recorded, and after the
      // walk each target must be a file that was actually import-scanned.
      edges.push({ specifier, target: relative(repoRoot, real).split('\\').join('/') });
    }
  }
  return findings;
}
export const textExtensions = new Set([
  ...sourceExtensions,
  '.css',
  '.html',
  '.json',
  '.jsonl',
  '.md',
  '.mdx',
  '.sh',
  '.yaml',
  '.yml',
]);

// A guard that cannot read something must fail rather than assume. Such a
// finding is reported in the dependency list as `@obversa/<reason>` — never a
// package name — and the scan prints the reason as a failure.
export const refusal = (reason) => `@obversa/<${reason}>`;
export const isRefusal = (dependency) => dependency.startsWith('@obversa/<');
const refusalReason = (dependency) => dependency.slice('@obversa/<'.length, -1);

// Every module specifier a file names, in source order: static imports and
// re-exports, side-effect and dynamic `import(...)`, the phase forms
// `import.defer(...)` / `import.source(...)`, CommonJS `require(...)` and
// `module.require(...)`, the resolvers `require.resolve(...)` and
// `import.meta.resolve(...)`, `import x = require(...)`, type-position
// `import("x").T` / `typeof import("x")` (a distinct ImportTypeNode — a
// type-only import is still a dependency, an internal note), the JSDoc forms
// `@type {import("x").T}` and `@import`, and a `declare module "x"`
// augmentation. A loader — `require`, `module.require`, `require.resolve`,
// `import.meta.resolve` — is read only as the direct callee of a call
// (wrappers that change nothing at runtime stripped); used any other way —
// passed as a value, called through `.call` / `.apply` / `.bind`, reached by
// a computed key — it is reported as `null`, as is a specifier that is not
// a plain string, because a guard that cannot follow it must fail rather
// than assume. A member of `require` or `module` that is not a loader
// (`require.main`, `module.exports`) is not a use of one. Exported so the
// spec can pin each form.
// Test files are held to the arrow rules — what they import — but not to the
// loader-hatch rules: a test may build a Proxy with Reflect or read a
// constructor's name without shipping anything. That exemption is sound only
// while no shipped entry can reach a test file, so a shipped file that
// imports a test path, and a manifest entry that points at one, are refused
// (namesTestPath, below): the hatch inside a test-named file then has no
// route into the shipped graph.
export function isTestPath(path) {
  return /(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[^/]+$/.test(path);
}

// The members of the global object (`globalThis`, and `global`, the same
// object under Node's other name) that hold data or plain behaviour and
// cannot hand a root, a loader, or an evaluator back. `eval` and `Function`
// are not here: `global.eval("...")` runs generated code exactly as bare
// `eval` does.
const globalDataMembers = new Set([
  'process', 'structuredClone', 'fetch', 'WebSocket', 'crypto', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'queueMicrotask', 'URL', 'TextEncoder', 'TextDecoder', 'AbortController', 'Buffer',
  'console', 'performance', 'navigator',
]);

// The workspace file is pinned verbatim: the workspace is the packages and
// the hosts, and any other glob would bring code under the arrow rules that
// the package table does not know. Exported so the spec proves the pin
// refuses a missing or an extra glob, not only accepts the exact text.
export const PINNED_WORKSPACE_FILE = 'packages:\n  - packages/*\n  - hosts/*\n';
export function isPinnedWorkspaceFile(text) {
  return text === PINNED_WORKSPACE_FILE;
}

// Whether a specifier or manifest path, read from `file`, names a test path:
// a relative or absolute one by where it resolves (with or without an
// extension, so `./a.test` counts as `./a.test.mjs` does), a bare one by its
// own text.
function namesTestPath(specifier, file) {
  const target = file && (/^\.\.?\//.test(specifier) || isAbsolute(specifier)) ? resolve(dirname(file), specifier) : specifier;
  return isTestPath(target) || /\.(?:test|spec)$/.test(target);
}

export function moduleSpecifiers(text, fileName = 'module.ts', { hatches = !isTestPath(fileName) } = {}) {
  const kind = scriptKinds.get(extname(fileName)) ?? ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const specifiers = [];
  const literal = (node) =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
  // Loader references handled as a callee, so their later visit is not a
  // stray use.
  const handled = new Set();
  const isImportMeta = (expression) => ts.isMetaProperty(expression) && expression.keywordToken === ts.SyntaxKind.ImportKeyword;
  // An identifier that names something (a declaration, a property, a label,
  // a type) rather than referring to a value.
  const isName = (node) => {
    const parent = node.parent;
    if (!parent) return false;
    if (ts.isShorthandPropertyAssignment(parent)) return false;
    return parent.name === node || parent.propertyName === node || parent.label === node
      || ts.isQualifiedName(parent) || ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent);
  };
  // The member name a property or element access reads: a string, or null
  // when the key is computed.
  const memberName = (node) => (ts.isPropertyAccessExpression(node) ? node.name.text : literal(node.argumentExpression));
  const isAccess = (node) => ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
  const accessOn = (node, matches) => isAccess(node) && matches(ts.skipOuterExpressions(node.expression));
  const named = (name) => (expression) => ts.isIdentifier(expression) && expression.text === name;
  const isRequire = named('require');
  // A loader reference: the identifier `require` (as a value, or as the
  // object of any member but `.resolve`), a `.require` member on ANY
  // object (every Module object carries the loader: `module`,
  // `require.main`, an entry of `require.cache`), `require.resolve`,
  // `import.meta.resolve`, and a computed member on any of `module`,
  // `require`, `import.meta`.
  // The Module class's own loaders, reached through `module.constructor`
  // or any Module object: refused as a member of anything.
  // (`register` is not in the set: it is an ordinary name in this
  // workspace, and every route to Module.register — the builtin factory,
  // a node:module import, module.constructor, process as a value — is
  // refused at its root.)
  const moduleClassLoaders = new Set([
    'registerHooks', '_load', '_resolveFilename', 'runMain', '_extensions', '_cache', '_pathCache', '_initPaths', '_nodeModulePaths',
    // and process's own ways to a module: the builtin factory, native
    // bindings, and the main Module.
    'getBuiltinModule', 'binding', '_linkedBinding', 'dlopen', 'mainModule',
  ]);
  const moduleDataMembers = new Set(['exports', 'id', 'filename', 'path', 'loaded']);
  const isEquality = (parent) => ts.isBinaryExpression(parent) && [
    ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
  ].includes(parent.operatorToken.kind);
  // The roots a loader can be acquired from: `module`, `import.meta`,
  // `process` (its builtin factory), `globalThis` and `global` (the same
  // object under two names; it holds `process`, `eval` and `Function`), and
  // `globalThis.process` itself.
  const isRoot = (node) => {
    if (ts.isIdentifier(node)) return ['module', 'process', 'globalThis', 'global'].includes(node.text) && !isName(node);
    if (isImportMeta(node)) return true;
    return isAccess(node) && memberName(node) === 'process' && isRoot(ts.skipOuterExpressions(node.expression));
  };
  // The members of each root that hold data or plain behaviour and cannot
  // hand the root, a Module, or a loader back. Anything else on a root —
  // `valueOf`, `constructor`, `__proto__`, a builtin factory, a binding — is
  // refused: `process.valueOf()` is `process` again, out of the root rule.
  const rootMembers = {
    process: new Set([
      'env', 'argv', 'execArgv', 'exit', 'exitCode', 'cwd', 'chdir', 'execPath', 'stdout', 'stderr', 'stdin',
      'platform', 'arch', 'pid', 'ppid', 'version', 'versions', 'release', 'title', 'umask',
      'on', 'once', 'off', 'emit', 'addListener', 'removeListener', 'removeAllListeners', 'listenerCount',
      'kill', 'hrtime', 'nextTick', 'uptime', 'memoryUsage', 'cpuUsage', 'resourceUsage', 'emitWarning', 'abort',
    ]),
    globalThis: globalDataMembers,
    global: globalDataMembers,
    module: moduleDataMembers,
    // `resolve` is the loader and is judged as the access node itself.
    'import.meta': new Set(['url', 'dirname', 'filename', 'resolve']),
  };
  const rootName = (node) => (ts.isIdentifier(node) ? node.text : isImportMeta(node) ? 'import.meta' : 'process');
  // Listed members that hand the root back (an EventEmitter's chaining
  // methods): their call may only stand as a statement, its result
  // discarded, or the root travels on as a value.
  const selfReturning = new Set(['on', 'once', 'off', 'addListener', 'removeListener', 'removeAllListeners', 'prependListener', 'prependOnceListener', 'setMaxListeners']);
  //
  // WHAT THIS GUARD PROMISES. A precise static-source promise, not a
  // sandbox: every module form the parser accepts is read, and the direct
  // ways to a loader listed here are refused. Out of its scope, and stated:
  // a specifier built from an expression, reflection (Reflect, a computed
  // key on anything but a root), constructor chains beyond `.constructor`
  // itself, a root handed on through a member not listed here, and code
  // generated at run time. The boundary tooling stage after F2 replaces
  // this file with dependency-cruiser and ESLint rules under the same
  // stated residual.
  const isLoader = (node) => {
    // A root holds a loader: as the object of a literal member in its list
    // the member decides (below); compared for identity it loads nothing;
    // reached by a computed key or an unlisted member, or used as a value —
    // destructured, assigned, passed, handed to Reflect — the loader goes
    // with it, so the use is refused.
    if (isRoot(node)) {
      const parent = node.parent;
      if (isAccess(parent) && ts.skipOuterExpressions(parent.expression) === node) {
        const member = memberName(parent);
        if (member === null || !rootMembers[rootName(node)].has(member)) return true;
        if (selfReturning.has(member)) {
          const call = parent.parent;
          return !(call && ts.isCallExpression(call) && call.expression === parent && call.parent && ts.isExpressionStatement(call.parent));
        }
        return false;
      }
      return !isEquality(parent);
    }
    // `.constructor` on anything reaches the Function constructor two steps
    // on (`({}).constructor.constructor` is Function): refused, except the
    // one read of a class's name (`value.constructor.name`).
    if (isAccess(node) && memberName(node) === 'constructor') {
      const parent = node.parent;
      return !(parent && isAccess(parent) && ts.skipOuterExpressions(parent.expression) === node && memberName(parent) === 'name');
    }
    // Text run as code, reflection, and the vm builtin reach every loader.
    if (ts.isIdentifier(node) && (node.text === 'eval' || node.text === 'Function' || node.text === 'Reflect') && !isName(node)) return true;
    if (ts.isIdentifier(node)) {
      if (node.text !== 'require' || isName(node)) return false;
      // As the object of a member: `.resolve` and a computed key make the
      // access itself the loader reference; any other member (`.main`,
      // `.cache`, `.call`, `.bind`) reaches the loader or another Module
      // through it, so the identifier is the loader use.
      const parent = node.parent;
      if (isAccess(parent) && ts.skipOuterExpressions(parent.expression) === node) {
        const member = memberName(parent);
        return member !== 'resolve' && member !== null;
      }
      return true;
    }
    if (!isAccess(node)) return false;
    const member = memberName(node);
    if (member === 'require' || moduleClassLoaders.has(member)) return true;
    if (accessOn(node, isRequire)) return member === 'resolve' || member === null;
    if (accessOn(node, isImportMeta)) return member === 'resolve';
    return false;
  };
  // `node:module` makes loaders: `createRequire` returns one, `register`
  // and `registerHooks` install resolution hooks, and the rest of it is
  // not followed. The module may be imported only by the unrenamed names
  // `createRequire`, `builtinModules`, and `isBuiltin`, never as a
  // namespace or default (a binding the scan does not follow); a dynamic
  // import or require of it is refused. A `createRequire(...)` result may
  // be bound only as `const require`, so the loader keeps the name the scan
  // tracks.
  // `node:vm` runs text as code in this context and reaches every loader:
  // refused in every form, alongside the module builtin's unlisted names.
  const isModuleModule = (node) => ['module', 'node:module', 'vm', 'node:vm'].includes(literal(node));
  const moduleModuleNames = new Set(['createRequire', 'builtinModules', 'isBuiltin']);
  const readsModuleModule = (node) => {
    if (['vm', 'node:vm'].includes(literal(node.moduleSpecifier))) return false;
    const clause = node.importClause;
    if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return false;
    return clause.namedBindings.elements.every((element) => !element.propertyName && moduleModuleNames.has(element.name.text));
  };
  const isCreateRequire = (node) =>
    (ts.isIdentifier(node) && node.text === 'createRequire' && !(node.parent && ts.isImportSpecifier(node.parent) && node.parent.name === node && !node.parent.propertyName))
    || (isAccess(node) && memberName(node) === 'createRequire');
  const bindsRequire = (call) => {
    const holder = call.parent && ts.skipOuterExpressions(call.parent) === call ? call.parent : call;
    const declaration = holder.parent;
    return !!declaration && ts.isVariableDeclaration(declaration) && declaration.initializer === holder
      && ts.isIdentifier(declaration.name) && declaration.name.text === 'require'
      && !!declaration.parent && (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
  };
  // `process.getBuiltinModule(...)` hands out any builtin — `node:module`
  // and its hooks included — without an import the scan could read, so any
  // reference to that name, as a member of anything or as a bare name, is
  // refused as an untracked module factory.
  const isBuiltinFactory = (node) =>
    (ts.isIdentifier(node) && node.text === 'getBuiltinModule' && !(node.parent && isAccess(node.parent) && node.parent.name === node))
    || (isAccess(node) && memberName(node) === 'getBuiltinModule');
  // A CommonJS module body runs inside Node's wrapper function, whose
  // `arguments` hold `require` and `module`: a top-level `arguments`
  // reference — one not inside a function of the file's own (an arrow does
  // not bind its own) — is refused, whatever it indexes.
  const isOwnFunction = (node) => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
    || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isAccessor(node);
  let functionDepth = 0;
  const visit = (node, inDoc) => {
    if (hatches && !inDoc && isLoader(node) && !handled.has(node)) specifiers.push(null);
    if (hatches && !inDoc && isBuiltinFactory(node)) specifiers.push(null);
    if (hatches && !inDoc && functionDepth === 0 && ts.isIdentifier(node) && node.text === 'arguments' && !isName(node)) specifiers.push(null);
    if (isOwnFunction(node)) functionDepth += 1;
    if (hatches && !inDoc && isCreateRequire(node) && !handled.has(node)) {
      // Only the callee of `const require = createRequire(...)`; the name
      // identifier under a member access is judged with the access.
      const underAccess = ts.isIdentifier(node) && node.parent && isAccess(node.parent) && node.parent.name === node;
      if (!underAccess) specifiers.push(null);
    }
    if (hatches && ts.isImportDeclaration(node) && isModuleModule(node.moduleSpecifier) && !readsModuleModule(node)) {
      specifiers.push(null);
    } else if (hatches && ts.isExportDeclaration(node) && node.moduleSpecifier && isModuleModule(node.moduleSpecifier)) {
      // A re-export of node:module hands its loaders to whoever imports
      // this module: refused in every form.
      specifiers.push(null);
    } else if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      specifiers.push(literal(node.moduleSpecifier));
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      // `import x = require("node:module")` binds the whole module.
      specifiers.push(hatches && isModuleModule(node.moduleReference.expression) ? null : literal(node.moduleReference.expression));
    } else if (ts.isImportTypeNode(node)) {
      const argument = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : node.argument;
      specifiers.push(literal(argument));
    } else if (ts.isJSDocImportTag?.(node) && node.moduleSpecifier) {
      // `/** @import { X } from "x" */` — a type-only import that lives in JSDoc.
      specifiers.push(literal(node.moduleSpecifier));
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      // `declare module "x" { … }` augments that module: a dependency on it.
      specifiers.push(node.name.text);
    } else if (ts.isCallExpression(node)) {
      // A wrapper that changes nothing at runtime — parentheses, a type
      // assertion, `as`, `satisfies`, a non-null `!` — is stripped from the
      // callee.
      const callee = ts.skipOuterExpressions(node.expression);
      // `import(...)`, and the phase forms `import.defer(...)` / `import.source(...)`
      // (a MetaProperty on the import keyword).
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword || isImportMeta(callee);
      // `const require = createRequire(import.meta.url)` and nothing else:
      // a `require` made from another base resolves its strings from that
      // base, not from this file, so `require.resolve('./src/x')` would be
      // placed against the wrong directory — a base inside a sibling
      // package moves every later resolution there unseen. Any other
      // argument leaves createRequire unhandled, and it is refused below as
      // a loader the scan does not follow.
      const fromOwnUrl = node.arguments.length === 1 && isAccess(node.arguments[0]) && memberName(node.arguments[0]) === 'url'
        && isImportMeta(ts.skipOuterExpressions(node.arguments[0].expression));
      if (isCreateRequire(callee) && bindsRequire(node) && fromOwnUrl) {
        handled.add(callee);
      } else if (isLoader(callee)) {
        handled.add(callee);
        if (isAccess(callee)) handled.add(ts.skipOuterExpressions(callee.expression));
        // A computed member may or may not be the loader; an unlisted member
        // of `module` and a Module-class loader are not loads the scan
        // reads; a load of the module that makes loaders is refused too.
        const member = isAccess(callee) ? memberName(callee) : undefined;
        // eval, Function, and any `.constructor` (Function two steps on) run
        // text; their argument is not a specifier the scan reads.
        const runsText = (ts.isIdentifier(callee) && (callee.text === 'eval' || callee.text === 'Function')) || member === 'constructor';
        const unreadable = member === null || (hatches && (runsText || moduleClassLoaders.has(member)
          || (accessOn(callee, named('module')) && member !== 'require') || isModuleModule(node.arguments[0])));
        specifiers.push(unreadable ? null : literal(node.arguments[0]));
      } else if (isImport && node.arguments.length > 0) {
        specifiers.push(hatches && isModuleModule(node.arguments[0]) ? null : literal(node.arguments[0]));
      }
    }
    // JSDoc is not part of the child walk; its type expressions can carry
    // import types too.
    for (const doc of node.jsDoc ?? []) ts.forEachChild(doc, (child) => visit(child, true));
    ts.forEachChild(node, (child) => visit(child, inDoc));
    if (isOwnFunction(node)) functionDepth -= 1;
  };
  visit(source, false);
  // TypeScript keeps several dependency forms outside the node tree: the
  // triple-slash directives `/// <reference path="…" />`, `/// <reference
  // types="…" />`, and `/// <amd-dependency path="…" />`, and the
  // `@jsxImportSource x` pragma, from which the compiler emits an import of
  // `x/jsx-runtime`. Each names a module this file depends on.
  for (const ref of source.referencedFiles ?? []) specifiers.push(ref.fileName);
  for (const ref of source.typeReferenceDirectives ?? []) specifiers.push(ref.fileName);
  for (const dep of source.amdDependencies ?? []) specifiers.push(dep.path);
  const jsxPragmas = source.pragmas?.get('jsximportsource');
  for (const pragma of [].concat(jsxPragmas ?? [])) {
    const factory = pragma?.arguments?.factory;
    const value = typeof factory === 'string' ? factory : factory?.value;
    if (typeof value === 'string' && value.length > 0) specifiers.push(value);
  }
  return specifiers;
}

// The JSON files under a package the compiler would read as a project: a
// tsconfig*.json or jsconfig*.json by name, and any other JSON whose object
// carries a project field — `tsc -p config/build.json` accepts any name, so
// the name alone cannot decide. The manifest is read separately.
const projectFields = ['compilerOptions', 'extends', 'references', 'files', 'include', 'typeAcquisition'];
export function isProjectConfig(path, text) {
  if (!/^packages\/[^/]+\/.+\.json$/.test(path) || basename(path) === 'package.json') return false;
  if (/^(?:tsconfig|jsconfig)[^/]*\.json$/.test(basename(path))) return true;
  const { config } = ts.readConfigFile(path, () => text);
  return !!config && typeof config === 'object' && !Array.isArray(config)
    && projectFields.some((field) => field in config);
}

const realpathOf = (path, host) => (typeof host.realpath === 'function' ? host.realpath(path) : path);

// A project config as the compiler reads it: the effective options after
// every `extends` is resolved the way the compiler resolves one (relative,
// absolute, extensionless, a package name through its exports, a `#alias`
// through the owner's imports, the owner's own name) and every `${configDir}`
// is expanded, with path options made absolute; the list of every inherited
// config, real paths; and the diagnostics. The only diagnostic ignored is
// "no inputs were found" (TS18003): a project that compiles nothing depends
// on nothing through its inputs. `host` is the filesystem the compiler reads
// (the real one; the spec injects a fake).
export function parseProjectConfig(text, { file, host = ts.sys } = {}) {
  const source = ts.parseJsonText(file, text);
  const parsed = ts.parseJsonSourceFileConfigFileContent(source, host, dirname(file), undefined, file);
  const message = (d) => `TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
  const diagnostics = [...source.parseDiagnostics, ...parsed.errors.filter((d) => d.code !== 18003)].map(message);
  const extended = (source.extendedSourceFiles ?? []).map((path) => realpathOf(path, host));
  return { parsed, diagnostics, extended };
}

// A package directory is "reached" by a path when the path is that directory
// or lies under it; a path that is `packages/` itself or above it reaches
// every package at once.
function reachesEveryPackage(absolute, repoRoot) {
  // Both by real path, so a root handed over through a symlink answers as
  // its real spelling does.
  const rel = relative(realPathOf(absolute), realPathOf(join(repoRoot, 'packages')));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// The packages a project config makes its package depend on, and the
// effective compiler options for resolving that package's imports. Every
// inherited base is a dependency when it lies in a sibling package. Names
// (`jsxImportSource`, `types`, `plugins[].name`, `typeAcquisition.include`)
// count by `@obversa/...` name or as a path; each `types` entry is also
// placed under every explicit `typeRoots` directory, as the compiler looks it
// up. `baseUrl`, each `paths` target (its literal prefix before the
// wildcard, from the directory the compiler substitutes it in), each
// `rootDirs` and `typeRoots` directory, each project reference, each input
// file, and each directory an `include` pattern walks are placed — by their
// real path, so a symlink outside every package that points into one is
// seen where it lands — by the package directory they lie in: the owner is
// nothing, a sibling is an arrow, and `packages/` or above is refused — such
// a value lets a bare specifier, a wildcard substitution, or a glob land in
// any package. A config with a diagnostic is refused whole.
export function projectConfig(text, { file, root: repoRoot, host = ts.sys } = {}) {
  const { parsed, diagnostics, extended } = parseProjectConfig(text, { file, host });
  if (diagnostics.length > 0)
    return { dependencies: [refusal(`the config cannot be read as the compiler reads it: ${diagnostics.join('; ')}`)], options: parsed.options };
  const configDir = dirname(file);
  const dependencies = [];
  const place = (named, what) => {
    const placed = placement(named, { file, root: repoRoot, host, what });
    if (placed) dependencies.push(placed);
  };
  const byName = (value, what) => {
    if (typeof value !== 'string' || value.length === 0) return;
    if (value.startsWith('@obversa/')) dependencies.push(value.split('/').slice(0, 2).join('/'));
    else if (/^\.\.?\//.test(value) || isAbsolute(value)) place(resolve(configDir, value), what);
  };
  const { options } = parsed;
  for (const base of extended) place(base, 'extends');
  byName(options.jsxImportSource, 'jsxImportSource');
  for (const name of options.types ?? []) {
    byName(name, 'types');
    for (const typeRoot of options.typeRoots ?? []) place(join(typeRoot, name), 'types');
  }
  for (const plugin of options.plugins ?? []) byName(plugin?.name, 'plugins');
  for (const name of parsed.typeAcquisition?.include ?? []) byName(name, 'typeAcquisition.include');
  if (options.baseUrl) place(options.baseUrl, 'baseUrl');
  // The compiler substitutes a `paths` target against `baseUrl` when it is
  // set, else against the directory of the config that declared `paths`.
  const pathsBase = options.baseUrl ?? options.pathsBasePath ?? configDir;
  for (const [alias, targets] of Object.entries(options.paths ?? {})) {
    for (const target of targets) place(resolve(pathsBase, target.split('*')[0]), `paths target ${target} for ${alias}`);
  }
  for (const dir of options.rootDirs ?? []) place(dir, 'rootDirs');
  for (const dir of options.typeRoots ?? []) place(dir, 'typeRoots');
  for (const ref of parsed.projectReferences ?? []) place(ref.path, 'references');
  for (const name of parsed.fileNames) place(name, 'files');
  for (const dir of Object.keys(parsed.wildcardDirectories ?? {})) place(dir, 'include');
  return { dependencies, options };
}

export function tsconfigDependencies(text, at) {
  return projectConfig(text, at).dependencies;
}

// A registry version range: pnpm hands a selector to node-semver's
// validRange in loose mode and treats a null answer as a tag, so the same
// call decides here, on semver 7.7.2 — the version pnpm 10.15.1 bundles,
// pinned directly, because other versions answer differently in both
// directions (7.8.5 accepts `0+a` and refuses `1.x.3`; 7.7.2 the reverse).
// An empty selector is refused outright — validRange reads it as `*`, pnpm
// as nothing. A tag, a URL, a Git spec, a path, or anything else the
// registry does not answer with a versioned package is not a range.
export function isVersionRange(value) {
  return value.trim().length > 0 && validRange(value, { loose: true }) !== null;
}

// What a dependency value installs. `name`: a workspace package, by key
// (`@obversa/x`) or by an alias whose value installs one under another name
// — `npm:@obversa/x@…`, `workspace:@obversa/x@…`, or `workspace:<path>`,
// which pnpm links to the workspace package at that path, placed by the
// package directory it lands in. `external`: a registry range, an
// `npm:<name>@<range>` alias of a registry package, or a `workspace:` range
// for the key's own name. Anything else — a path, a URL, a Git spec, a
// tag, a catalog entry — is a refusal: the scan cannot say what it installs.
// `file` is the manifest's absolute path and `root` the repository root.
export function dependencyTarget(key, spec, { file, root: repoRoot } = {}) {
  const value = String(spec);
  // An alias of a workspace package carries an explicit selector: a range
  // for `npm:`, a range or `^` / `~` / `*` for `workspace:`; `@latest` or
  // no selector is a tag.
  const alias = /^(npm|workspace):(@obversa\/[^@/]+)(?:@(.*))?$/.exec(value);
  if (alias) {
    const [, protocol, name, selector] = alias;
    const ok = selector !== undefined && (isVersionRange(selector) || (protocol === 'workspace' && ['^', '~', '*'].includes(selector)));
    return ok ? { name } : { refused: `${key} is ${value}, whose selector is not a version range` };
  }
  const linked = /^workspace:(\.{1,2}\/.*|\/.*)$/.exec(value);
  if (linked) {
    const dir = file && repoRoot ? packageDirOf(realpathOf(resolve(dirname(file), linked[1]), ts.sys), repoRoot) : undefined;
    return dir !== undefined ? { name: `@obversa/${dir}` } : { refused: `${key} links ${linked[1]}, which is not a workspace package the scan can place` };
  }
  if (key.startsWith('@obversa/')) {
    if (/^workspace:(?:[\^~*]|.+)$/.test(value) && (value === 'workspace:^' || value === 'workspace:~' || value === 'workspace:*' || isVersionRange(value.slice('workspace:'.length))))
      return { name: key };
    if (isVersionRange(value)) return { name: key };
    return { refused: `${key} is ${value}, which is not a workspace range the scan can read` };
  }
  if (isVersionRange(value)) return { external: true };
  // An alias without a version installs `latest`, a tag: refused.
  const npmAlias = /^npm:((?:@[^@/]+\/)?[^@/]+)@(.+)$/.exec(value);
  if (npmAlias && !npmAlias[1].startsWith('@obversa/') && isVersionRange(npmAlias[2])) return { external: true };
  return { refused: `${key} is ${value}, which is not a registry version the scan can read` };
}

// The workspace packages a manifest field names, sorted and unique; a value
// the scan cannot read is a refusal entry.
export function internalDependencies(manifest, field, at = {}) {
  const found = new Set();
  for (const [key, spec] of Object.entries(manifest?.[field] ?? {})) {
    const target = dependencyTarget(key, spec, at);
    if (target.name) found.add(target.name);
    else if (target.refused) found.add(refusal(`${field} ${target.refused}`));
  }
  return [...found].sort();
}

// Every path a manifest's own entry fields name: `main`, `module`,
// `browser` (a string or a map), `types` / `typings`, `typesVersions`
// (ranges of patterns of paths), `exports` leaves, `directories`, and
// `publishConfig.directory` — a loader, the compiler, or a bundler follows
// each, so each is placed by the package directory its real path lies in;
// a sibling is an arrow, and `packages/` or above is refused.
export function manifestPathTargets(manifest, { file, root: repoRoot, host = ts.sys } = {}) {
  const leaves = (value) => {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(leaves);
    if (value && typeof value === 'object') return Object.values(value).flatMap(leaves);
    return [];
  };
  const fields = ['main', 'module', 'browser', 'types', 'typings', 'typesVersions', 'exports', 'directories'];
  const values = fields.flatMap((field) => leaves(manifest?.[field]).map((value) => [field, value]));
  if (typeof manifest?.publishConfig?.directory === 'string') values.push(['publishConfig.directory', manifest.publishConfig.directory]);
  const found = [];
  // A typesVersions wildcard substitutes a consumer's subpath — `..`
  // segments included, the compiler does not refuse them there — so a
  // pattern with a wildcard can land anywhere; it is refused.
  const patterns = Object.values(manifest?.typesVersions ?? {}).flatMap((byRange) => [...Object.keys(byRange ?? {}), ...leaves(byRange)]);
  if (patterns.some((pattern) => pattern.includes('*'))) found.push(refusal('typesVersions uses a wildcard, which substitutes a consumer subpath the scan cannot bound'));
  for (const [field, value] of values) {
    if (value.startsWith('@obversa/')) {
      found.push(value.split('/').slice(0, 2).join('/'));
      continue;
    }
    // A bare package name (`browser: { fs: "browserify-fs" }`) is not a path.
    if (!/^(?:\.|\/|~)/.test(value) && !value.includes('/')) continue;
    // Only the pattern fields carry a wildcard, and only `*` is one; `?`
    // and `*` are ordinary characters in an entry path, so a plain field
    // is placed whole. An exports pattern exposes every file under its
    // prefix to any consumer — a test file included, with no shipped source
    // edge to catch — so it is refused: subpaths are listed explicitly.
    if (field === 'exports' && value.includes('*')) {
      found.push(refusal(`exports pattern ${value} exposes every file under its prefix, test files included; list the subpaths explicitly`));
      continue;
    }
    const literal = field === 'typesVersions' ? value.split('*')[0] : value;
    // A manifest entry is a shipped entry; one that names a test file would
    // ship the loader-hatch exemption.
    if (namesTestPath(literal, file)) {
      found.push(refusal(`${field} points at a test path, which is exempt from the loader-hatch rules: ${value}`));
      continue;
    }
    const placed = placement(resolve(dirname(file), literal), { file, root: repoRoot, host, what: field });
    if (placed) found.push(placed);
  }
  return found;
}

// Where an absolute path lies, relative to the package that owns `file`:
// undefined for the owner (or for a place that is no package at all), the
// sibling's name for a sibling, and a refusal for `packages/` or above —
// a place that holds every package. Real paths are compared, so a symlink
// outside every package that points into one is seen where it lands.
function placement(named, { file, root: repoRoot, host = ts.sys, what }) {
  const absolute = realpathOf(named, host);
  if (reachesEveryPackage(absolute, repoRoot))
    return refusal(`${what} reaches ${placedUnder(absolute, repoRoot) || '.'}, which holds every package`);
  const dir = packageDirOf(absolute, repoRoot);
  return dir !== undefined && dir !== packageDirOf(file, repoRoot) ? `@obversa/${dir}` : undefined;
}

// The packages a manifest's `imports` map (`#alias`) can reach. Node resolves
// such an alias to an external package or to a path, through nested
// conditional objects and arrays, so every string leaf counts — by name, or
// by a relative path into another package (a glob by its literal prefix).
export function manifestImportTargets(manifest, { file, root: repoRoot } = {}) {
  const leaves = (value) => {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(leaves);
    if (value && typeof value === 'object') return Object.values(value).flatMap(leaves);
    return [];
  };
  const found = [];
  for (const leaf of leaves(manifest?.imports ?? {})) {
    // An alias of the module builtin hands out its loaders under a name
    // the source scan does not know, and an alias of vm runs generated code
    // the same way: both refused, as the source scan refuses them by name.
    if (leaf === 'module' || leaf === 'node:module' || leaf === 'vm' || leaf === 'node:vm') {
      found.push(refusal(`package imports alias the ${leaf} builtin, which the source rules refuse in every form`));
      continue;
    }
    // `*` is the map's only wildcard; `?` is an ordinary character. A
    // pattern substitutes whatever the importer wrote after the alias, so
    // `"#*": "./src/*.mjs"` reaches src/escape.test.mjs from a shipped
    // import that shows no test text at its edge; the pattern shape is
    // refused, as an exports pattern is.
    if (leaf.includes('*')) {
      found.push(refusal(`package imports pattern ${leaf} substitutes an importer's text into a path, test files included; list the aliases explicitly`));
      continue;
    }
    if (namesTestPath(leaf, file)) {
      found.push(refusal(`package imports alias a test path, which is exempt from the loader-hatch rules: ${leaf}`));
      continue;
    }
    const crossing = crossingPackage(leaf, { file, root: repoRoot });
    if (crossing) found.push(crossing);
  }
  return found;
}

// A specifier as the loader reads it: a `file:` URL is the path it names, a
// percent-encoded specifier is decoded (`./%2e%2e/` is `./../`), and any
// other URL scheme but `node:` — `data:`, `http:`, `blob:` — is refused,
// since what it loads is not a file the scan can place. Returns `{ text }`
// or `{ refused }`.
export function readSpecifier(specifier) {
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(specifier)?.[1];
  if (scheme !== undefined && scheme !== 'node') {
    if (scheme === 'file') {
      try {
        return { text: fileURLToPath(specifier) };
      } catch {
        return { refused: `a file URL the loader cannot read: ${specifier}` };
      }
    }
    return { refused: `a ${scheme}: URL specifier loads something the scan cannot place` };
  }
  if (!specifier.includes('%')) return { text: specifier };
  try {
    return { text: decodeURIComponent(specifier) };
  } catch {
    return { refused: `a percent-encoded specifier that does not decode: ${specifier}` };
  }
}

// The package a specifier or path names when it crosses a package boundary:
// an `@obversa/...` name by name, a relative or absolute path by the package
// directory it resolves into, when that is not the importing file's own.
// Null otherwise.
function crossingPackage(specifier, { file, root: repoRoot } = {}) {
  if (specifier.startsWith('@obversa/')) return specifier.split('/').slice(0, 2).join('/');
  if (!file || !repoRoot || !(/^\.\.?\//.test(specifier) || isAbsolute(specifier))) return null;
  // Where the loader lands, by real path from the importing file's real
  // directory: on a case-insensitive disk `../PACKAGES/SURFACER/x` opens
  // packages/surfacer/x, so the crossing is judged where the path really
  // lands, and a spelling other than the disk's own (case, a symlink) is
  // refused outright. A target that does not exist keeps its spelling: the
  // compiler's own resolution places it, or reports it.
  // The root by its real path as well, so a root handed over through a
  // symlink still places a real target under it.
  const realRoot = realpathOf(repoRoot, ts.sys);
  const target = resolve(realpathOf(dirname(file), ts.sys), specifier);
  const real = realpathOf(target, ts.sys);
  if (real !== target) return refusal(`${specifier} names ${relative(realRoot, real).split('\\').join('/')} by another spelling; a specifier names its file as the disk does`);
  const placed = placedUnder(real, realRoot);
  // Build output is skipped by the walk, so what a file under dist imports
  // is never read: shipped source may not import into a dist directory.
  if (!isTestPath(file) && /(^|\/)dist\//.test(placed)) return refusal(`${specifier} imports build output under dist, which the scan does not read; import a source file`);
  const owner = packageDirOf(realpathOf(file, ts.sys), realRoot);
  // A package imports nothing from outside packages/: a host is the
  // composition root that takes packages by public name, and scripts/ and
  // the repository root are the guard's own ground. A package that bundled
  // any of them would reverse that direction unseen.
  if (owner !== undefined && !isTestPath(file) && !/^packages\//.test(placed)) return refusal(`${specifier} reaches ${placed || '.'}, outside packages/; a package imports nothing from hosts, scripts, or the repository root`);
  const dir = packageDirOf(real, realRoot);
  return dir && dir !== owner ? `@obversa/${dir}` : null;
}

// The package directory an absolute path lies in, or names outright (a bare
// `packages/memory`, as a project reference does), else undefined.
function packageDirOf(absolute, repoRoot) {
  return /^packages\/([^/]+)(?:\/|$)/.exec(placedUnder(absolute, repoRoot))?.[1];
}

// Every regular file under a directory, and every symlink met on the way. A
// symlink is reported rather than followed, and the callers under packages/
// and hosts/ refuse every one reported: under packages/ a link can reach a
// sibling package's code while the import that names it looks local, and
// under hosts/ it can also stand as a shipped command whose code the scan
// never opened. The list is every link met, wherever the walk ran.
export async function walkTree(directory, { ignored = ignoredDirectories } = {}) {
  const files = [];
  const symlinks = [];
  // Every directory met, the ignored ones included though not entered, so
  // a caller can refuse a directory by name whether or not it holds a file.
  const directories = [];
  const visit = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) symlinks.push(path);
      else if (entry.isDirectory()) {
        directories.push(path);
        if (!ignored.has(entry.name)) await visit(path);
      } else if (entry.isFile()) files.push(path);
    }
  };
  await visit(directory);
  return { files, symlinks, directories };
}

// Where the compiler lands a specifier from a file under one set of options:
// as a module and as a type reference directive, and under both module
// formats when the resolution kind tells them apart (Node16 / NodeNext).
function resolvedTargets(specifier, file, options, host) {
  const byFormat = options.moduleResolution === ts.ModuleResolutionKind.Node16
    || options.moduleResolution === ts.ModuleResolutionKind.NodeNext;
  const modes = byFormat ? [ts.ModuleKind.ESNext, ts.ModuleKind.CommonJS] : [undefined];
  const targets = [];
  for (const mode of modes) {
    const module = ts.resolveModuleName(specifier, file, options, host, undefined, undefined, mode).resolvedModule;
    if (module) targets.push(module.resolvedFileName);
    const directive = ts.resolveTypeReferenceDirective(specifier, file, options, host, undefined, undefined, mode).resolvedTypeReferenceDirective;
    if (directive?.resolvedFileName) targets.push(directive.resolvedFileName);
  }
  return targets;
}

// The workspace packages a file depends on: `@obversa/...` specifiers by name,
// relative paths that resolve into another `packages/<dir>/` (a path inside
// the importing package is not a crossing), and — under each project config
// the package carries (`configs`, their effective compiler options) — the
// file the compiler itself resolves the specifier to, by the package
// directory its real path lies in. That last answer is what closes every
// alias route: a `paths` wildcard whose substitution walks out of the
// package, a `baseUrl` that lands elsewhere, a mapping inherited from a base.
// A computed specifier is reported as a refusal so the caller fails closed.
// `file` is the importing file's absolute path and `root` the repository
// root; without them only package-name specifiers are reported. Package
// directory names equal the unscoped package names today; the plugin split
// maps directories through their manifests.
export function extractObversaImports(text, { file, root: repoRoot, configs = [], host = ts.sys } = {}) {
  const found = [];
  const owner = file && repoRoot ? packageDirOf(file, repoRoot) : undefined;
  for (const raw of moduleSpecifiers(text, file ?? 'module.ts')) {
    if (raw === null) {
      found.push(refusal('a computed module reference cannot be checked; use a plain string'));
      continue;
    }
    const { text: specifier, refused } = readSpecifier(raw);
    if (refused) {
      found.push(refusal(refused));
      continue;
    }
    // The shipped edge into a test file is refused here, so the loader-hatch
    // exemption a test file enjoys can never be reached from shipped source.
    if (!isTestPath(file ?? '') && namesTestPath(specifier, file)) {
      found.push(refusal(`shipped source imports a test path, which is exempt from the loader-hatch rules: ${specifier}`));
      continue;
    }
    const named = new Set();
    const crossing = crossingPackage(specifier, { file, root: repoRoot });
    if (crossing) {
      found.push(crossing);
      named.add(crossing);
    }
    if (!file || !repoRoot) continue;
    for (const options of configs) {
      for (const target of resolvedTargets(specifier, file, options, host)) {
        const real = realpathOf(target, host);
        // An alias (`paths`, `baseUrl`) can land a shipped import on a test
        // file inside its own package; that is the same shipped edge, refused
        // before the same-package skip below.
        if (!isTestPath(file) && isTestPath(real)) {
          found.push(refusal(`shipped source resolves to a test path, which is exempt from the loader-hatch rules: ${specifier} -> ${relative(repoRoot, real)}`));
          continue;
        }
        // An alias can land on build output the same way; dist is never
        // read by the scan, so a path-form edge into a workspace package's
        // dist is refused wherever it lands. A public name is the arrow
        // itself — the compiler lands it on the sibling's built types, and
        // that sibling's own scan covers its sources — and an installed
        // package under node_modules is not part of the tree at all.
        const placed = placedUnder(real, repoRoot);
        if (!isTestPath(file) && !specifier.startsWith('@obversa/') && /(^|\/)dist\//.test(placed) && !/(^|\/)node_modules\//.test(placed)) {
          found.push(refusal(`shipped source resolves to build output under dist, which the scan does not read: ${specifier} -> ${placed}`));
          continue;
        }
        // An alias can land outside packages/ too — on a host, on scripts/,
        // on the root — and a package imports nothing from there.
        if (!isTestPath(file) && !specifier.startsWith('@obversa/') && !/^packages\//.test(placed) && !/(^|\/)node_modules\//.test(placed) && !placed.startsWith('..')) {
          found.push(refusal(`shipped source resolves outside packages/: ${specifier} -> ${placed}; a package imports nothing from hosts, scripts, or the repository root`));
          continue;
        }
        const dir = packageDirOf(real, repoRoot);
        if (dir === undefined || dir === owner) continue;
        const name = `@obversa/${dir}`;
        if (named.has(name)) continue;
        named.add(name);
        found.push(name);
      }
    }
  }
  return found;
}

// Compare real paths: Node resolves symlinks for import.meta but keeps the
// invoked path in argv, so a symlinked invocation must still count as main.
const isMain = process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
if (isMain) await main();

async function main() {
// A package's scripts run whatever they say, from the package directory: a
// script can compile, load, or preload a sibling's files through the shell,
// the compiler, or Node without naming an import anywhere the scan reads.
// Rather than read the shell, each package's scripts are pinned here
// verbatim, and any change — a new script, a changed one, a removed one —
// fails until this rule is reviewed with it.
const runtimeScripts = {
  build: 'tsup && tsc -p tsconfig.build.json',
  test: 'vitest run',
  typecheck: 'tsc --noEmit -p tsconfig.json',
  'typecheck:ts6': 'tsc6 --noEmit -p tsconfig.json',
  prepack: 'pnpm run build',
  prepublishOnly: 'node ../../scripts/check-publish-allowlist.mjs',
};
// The configuration files those scripts read — tsup's entries and vitest's
// includes and aliases decide what is compiled and what a specifier maps
// to — are pinned by the SHA-256 of their content, for the same reason:
// a change to one is a change to the boundary rule. The vitest aliases in
// memory-git and memory-simple map @obversa/memory to its source, the
// arrow those packages are allowed.
const sharedVitestConfig = '47f97f641e5f61ceac97871e6920106d3589156d8a8c5082af7fa43f77f3af75';
const smallTsupConfig = '04bcd9ecce6085ba1fdb9793308e534aa8deca99bebd9556484e5caf13d3347f';
const packageRules = new Map([
  ['@obversa/lines', {
    version: '1.0.0',
    dependencies: [],
    peerDependencies: ['@obversa/memory'],
    peerDependencyVersions: { '@obversa/memory': '>=0.1.0 <0.2.0' },
    scripts: {
      build: 'tsup && tsc -p tsconfig.build.json',
      typecheck: 'tsc --noEmit',
      'typecheck:ts6': 'tsc6 --noEmit',
      test: 'vitest run',
      'test:watch': 'vitest',
      prepack: 'pnpm run build',
      prepublishOnly: 'node ../../scripts/check-publish-allowlist.mjs',
    },
    configFiles: {
      'tsup.config.ts': '4ad5acaefe92ed656068f2fc80e4ab7706fbf7bc5244e6823b836308aa92b7a0',
      'vitest.config.ts': sharedVitestConfig,
    },
  }],
  ['@obversa/memory', {
    version: '0.1.0',
    dependencies: [],
    peerDependencies: [],
    scripts: runtimeScripts,
    configFiles: {
      'tsup.config.ts': '492827498350f6fb7446c21bb116257fab839810b3957610c8698be6acaea4f7',
      'vitest.config.ts': sharedVitestConfig,
    },
  }],
  ['@obversa/memory-simple', {
    version: '0.1.0',
    dependencies: ['@obversa/memory'],
    peerDependencies: [],
    scripts: runtimeScripts,
    configFiles: {
      'tsup.config.ts': smallTsupConfig,
      'vitest.config.ts': '3c0fa3b9d4f29b00827685e48a9e21c7fb76406dc7d109d4a1eaffb8a479c493',
    },
  }],
  ['@obversa/memory-git', {
    version: '0.1.0',
    dependencies: ['@obversa/memory'],
    peerDependencies: [],
    scripts: runtimeScripts,
    configFiles: {
      'tsup.config.ts': smallTsupConfig,
      'vitest.config.ts': '1852703a25309cfea3a288634a46ea383873091b76f8ab9c1629f57163d451ad',
    },
  }],
  // Private workspace packages get a rule too, so a sibling import inside
  // them is caught the same way. Surfacer must never depend on the runtime or
  // another package; source must never import surfacer (it takes the surface
  // port by injection from the host composition root).
  ['@obversa/surfacer', { version: '0.1.0', private: true, dependencies: [], peerDependencies: [], scripts: { test: 'node --test test/*.test.mjs' }, configFiles: {} }],
  ['@obversa/source', { version: '0.1.0', private: true, dependencies: [], peerDependencies: [], scripts: { test: 'node --test test/*.test.mjs' }, configFiles: {} }],
]);
// The names a build or test tool reads its configuration from, wherever
// it runs: any such file that is not pinned is refused, in a package or
// at the root (vitest reads a workspace file there).
const toolConfigName = /^(?:tsup|vitest|vite)\.(?:config|workspace)\.[^/]+$|^tsup\.json$/;
const scanRoots = [
  '.changeset',
  'packages',
  'hosts',
  'docs/public',
  'examples',
  'scripts',
  '.github',
  '.githooks',
];
const requiredScanRoots = ['hosts'];
// The host JavaScript that must be import-scanned, by name, so a rename or a
// scan gap cannot leave the composition root unchecked.
const requiredImportScannedHostFiles = [
  'hosts/cmux/bin/obversa-review',
  'hosts/cmux/lib/review-args.mjs',
];
const importScannedHostFiles = new Set();
const hostEdges = [];
const requiredScannedFiles = [
  'hosts/cmux/bin/obversa-order-workspace',
  'hosts/cmux/bin/obversa-plannotator-browser',
  'hosts/cmux/bin/obversa-surface',
  'hosts/cmux/bin/obversa-review',
  'hosts/cmux/lib/review-args.mjs',
  'hosts/cmux/test/f0-proof.sh',
];
const scanFiles = [
  '.gitignore',
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  'SECURITY.md',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
];
const forbidden = [
  {
    name: 'retired package name',
    pattern: new RegExp(`@${'loo' + 'ps'}-adk`, 'i'),
  },
  {
    name: 'retired product name',
    pattern: new RegExp(`\\b${'loo' + 'ps'}\\b`, 'i'),
  },
  {
    name: 'retired environment prefix',
    pattern: new RegExp(`${'LOO' + 'PS'}_`),
  },
  {
    name: 'retired state directory',
    pattern: new RegExp(`\\.${'loo' + 'ps'}(?:/|\\b)`, 'i'),
  },
  {
    name: 'private company term',
    pattern: new RegExp(`\\b${'am' + 'ps'}\\b`, 'i'),
  },
  {
    name: 'private integration term',
    pattern: new RegExp(`\\b${'oe' + 'ms?'}\\b`, 'i'),
  },
  {
    name: 'AI attribution',
    pattern: new RegExp(
      `(?:${'gene' + 'rated'} (?:with|by) (?:claude|codex)|` +
        `${'co-' + 'authored-by'}:.*(?:claude|openai)|` +
        `claude\\.ai/code/${'sess' + 'ion'}_)`,
      'i',
    ),
  },
];

const failures = [];

// Host manifests, pinned to a shape with no indirection: a readable JSON
// object at hosts/<name>/package.json and none beneath it (a nested manifest
// makes itself the package scope of the files under it, whatever it is
// named), no imports map, no exports map, no entry field, no bin, scripts
// pinned verbatim (a script runs whatever it says, and can preload a
// package's internals without naming an import the scan reads), and
// dependencies that are registry ranges or workspace ranges on the ruled
// packages under packages/ (another host, an alias, a path, or a link would
// let a name stand for files the edge set never saw). Read before the walk
// so a host script knows its own name and what it may import by name.
// A shell host command runs whatever it says, and no text rule over shell
// closes: paths are assembled from expansions, globs, and cd. So each one is
// pinned here by the SHA-256 of its content, as the build and test
// configuration is: an unpinned shell command, or one whose content
// changed, fails until this rule is reviewed with it. The text rules on
// them are defence in depth, not the closure.
const hostRules = new Map([
  ['cmux', {
    scripts: { test: 'node --test test/*.test.mjs' },
    shell: {
      'bin/obversa-order-workspace': '4a8821485b2c1c67041ffd248075a42042674bddb3aebfb4f6915b007e7299f8',
      'bin/obversa-peer-send': '15e38b2a7d4d232122a1653df6dc2ca17085d03e78ad7d687192daa95ac78da8',
      'bin/obversa-plannotator-browser': 'ef180a43d479ad9c9ae2242bb7f24b74ab58f85781465ffd6eace1c45b9ef34a',
      'bin/obversa-surface': 'cb1d37f92787995b1d3ff892e0ee98d8ec273ce5a068def91da21a65f49dd4b4',
      'bin/obversa-whereis': 'e29448c5f6626b177b72b64d00fae4f9b5512f66049d1db31e7b4a4e5a2a8aa3',
    },
  }],
]);
const hostManifests = new Map();
for (const entry of await readdir(join(root, 'hosts'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const hostDir = join(root, 'hosts', entry.name);
  const relativeManifest = `hosts/${entry.name}/package.json`;
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(hostDir, 'package.json'), 'utf8'));
  } catch (error) {
    failures.push(`${relativeManifest}: ${error?.code === 'ENOENT' ? 'is missing' : 'cannot be read as JSON'}; every directory under hosts/ is a host with a readable root manifest, or the files under it take the root manifest as their package scope`);
    continue;
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    failures.push(`${relativeManifest}: is not a JSON object`);
    continue;
  }
  const rule = hostRules.get(entry.name);
  if (!rule) failures.push(`hosts/${entry.name}: has no host rule; add one to hostRules`);
  for (const field of ['imports', 'exports', 'main', 'module', 'browser', 'bin', 'types', 'typesVersions', 'publishConfig']) {
    if (manifest[field] !== undefined) failures.push(`${relativeManifest}: a host manifest carries no ${field}; a host has no package indirection and is never published`);
  }
  if (manifest.private !== true) failures.push(`${relativeManifest}: a host manifest is private`);
  const scripts = manifest.scripts ?? {};
  const pinnedScripts = rule?.scripts ?? {};
  for (const scriptName of new Set([...Object.keys(scripts), ...Object.keys(pinnedScripts)])) {
    if (scripts[scriptName] !== pinnedScripts[scriptName])
      failures.push(`${relativeManifest}: script ${scriptName} must be ${JSON.stringify(pinnedScripts[scriptName]) ?? 'absent'}; found ${JSON.stringify(scripts[scriptName]) ?? 'absent'}. A host's scripts are pinned in hostRules; review the boundary rule with any change`);
  }
  const dependencies = new Map();
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (typeof range === 'string' && /^workspace:(\*|\^|~|[\d.]+|[<>=^~ \d.|-]+)$/.test(range)) {
        if (!packageRules.has(name)) {
          failures.push(`${relativeManifest}: ${field} ${name} is "${range}", a workspace range on something other than a ruled package under packages/; a host takes only the ruled packages by workspace range`);
          continue;
        }
        // The subpaths the dependency's exports map lists; a string form
        // exports only its root, a conditions object at the top likewise.
        let exported;
        try {
          exported = JSON.parse(await readFile(join(root, 'packages', name.slice('@obversa/'.length), 'package.json'), 'utf8')).exports;
        } catch {
          exported = undefined;
        }
        const keys = typeof exported === 'string' ? ['.'] : exported && typeof exported === 'object' && !Array.isArray(exported) ? Object.keys(exported) : [];
        dependencies.set(name, new Set(keys.some((key) => key.startsWith('.')) ? keys.filter((key) => key.startsWith('.')) : keys.length ? ['.'] : []));
      } else if (typeof range === 'string' && isVersionRange(range)) {
        dependencies.set(name, null);
      } else {
        failures.push(`${relativeManifest}: ${field} ${name} is "${range}"; a host dependency is a plain registry range or a workspace range on a ruled package, never an alias, a path, or a link`);
      }
    }
  }
  // This walk enters dist, which the main walk skips by name, so a link or a
  // nested manifest kept there is met here and refused here. A host is not
  // built at all: a dist directory anywhere under it, empty or not, is a
  // place the main scan never reads, so it is refused by name on sight. So
  // is a node_modules directory anywhere but the host root — the root one
  // is install output; a nested one is a place to keep a file the scan
  // never reads.
  const { files: hostFiles, symlinks: hostLinks, directories: hostDirectories } = await walkTree(hostDir, { ignored: new Set(['node_modules']) });
  for (const link of hostLinks) failures.push(symlinkRefusal(relative(root, link).split('\\').join('/')));
  for (const directory of hostDirectories) {
    const path = relative(root, directory).split('\\').join('/');
    if (basename(directory) === 'dist') failures.push(`${path}: a host is not built; a dist directory under a host is a place the scan never reads`);
    else if (basename(directory) === 'node_modules' && directory !== join(hostDir, 'node_modules')) failures.push(`${path}: a node_modules directory below a host's root is not install output; it is a place the scan never reads`);
  }
  for (const path of hostFiles) {
    if (basename(path) === 'package.json' && path !== join(hostDir, 'package.json'))
      failures.push(`${relative(root, path).split('\\').join('/')}: a nested manifest makes itself the package scope of the files beneath it, whatever it is named; a host has one manifest, at its root`);
  }
  hostManifests.set(`hosts/${entry.name}/`, { manifest, dependencies });
}

// The arrows a package may draw: itself, its dependencies, its peers. A
// dependency list from any scan goes through this; a refusal is printed as
// its reason.
const checkArrows = (path, owner, dependencies) => {
  const ownerName = `@obversa/${owner}`;
  const rule = packageRules.get(ownerName);
  const allowed = new Set([ownerName, ...(rule?.dependencies ?? []), ...(rule?.peerDependencies ?? [])]);
  for (const dependency of dependencies) {
    if (isRefusal(dependency)) failures.push(`${path}: ${refusalReason(dependency)}`);
    else if (!allowed.has(dependency)) failures.push(`${path}: ${ownerName} must not import ${dependency}`);
  }
};

for (const path of requiredScanRoots) {
  if (!scanRoots.includes(path)) failures.push(`boundary scan must include ${path}/`);
}

const gitignore = (await readFile(join(root, '.gitignore'), 'utf8'))
  .split(/\r?\n/)
  .map((line) => line.trim());
for (const path of ['.claude/', '.Codex/', '.superpowers/']) {
  if (!gitignore.includes(path)) failures.push(`.gitignore: must ignore ${path}`);
}

// Every directory under packages/ is a workspace package with a rule of its
// own, named for its directory: a package nobody listed would otherwise
// import whatever it liked, and a directory claiming a listed name would
// be taken for the package the rules read at packages/<unscoped name>.
for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifestPath = join(root, 'packages', entry.name, 'package.json');
  if (!(await exists(manifestPath))) {
    failures.push(`packages/${entry.name}: has no package.json; every directory under packages/ is a ruled workspace package`);
    continue;
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  // One manifest per package, at its root: a nested one makes itself the
  // package scope of the files beneath it, whatever it is named, and Node
  // would serve its exports to them under that name.
  // This walk enters dist, which the main walk skips by name, so a link or a
  // nested manifest kept there is met here and refused here.
  const { files: packageFiles, symlinks: packageLinks } = await walkTree(join(root, 'packages', entry.name), { ignored: new Set(['node_modules']) });
  for (const link of packageLinks) failures.push(symlinkRefusal(relative(root, link).split('\\').join('/')));
  for (const nested of packageFiles) {
    if (basename(nested) === 'package.json' && nested !== manifestPath)
      failures.push(`${relative(root, nested).split('\\').join('/')}: a nested manifest makes itself the package scope of the files beneath it, whatever it is named; a package has one manifest, at its root`);
  }
  if (manifest.name !== `@obversa/${entry.name}`)
    failures.push(`packages/${entry.name}: is named ${manifest.name}; a package is named @obversa/<its directory>`);
  else if (!packageRules.has(manifest.name))
    failures.push(`packages/${entry.name}: ${manifest.name} has no boundary rule; add one to packageRules`);
}

const files = [];
const scannedTextFiles = new Set();
for (const path of scanRoots) {
  const absolute = join(root, path);
  if (await exists(absolute)) await walk(absolute, files, failures);
}
for (const path of scanFiles) {
  const absolute = join(root, path);
  if (await exists(absolute)) files.push(absolute);
}

// Every project config under a package, read as the compiler reads it: its
// dependencies are checked here, and its effective options resolve that
// package's imports below.
const projectConfigs = new Map(); // package dir -> [{ absolute, options }]
for (const absolute of files) {
  const path = relative(root, absolute).split('\\').join('/');
  if (extname(absolute) !== '.json') continue;
  const text = await readFile(absolute, 'utf8');
  if (!isProjectConfig(path, text)) continue;
  const owner = path.split('/')[1];
  const { dependencies, options } = projectConfig(text, { file: absolute, root });
  checkArrows(path, owner, dependencies);
  if (!projectConfigs.has(owner)) projectConfigs.set(owner, []);
  projectConfigs.get(owner).push({ absolute, options });
}

for (const [name, rule] of packageRules) {
  const owner = name.slice('@obversa/'.length);
  const directory = join(root, 'packages', owner);
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (manifest.name !== name) failures.push(`${name}: manifest name is ${manifest.name}`);
  if (manifest.version !== rule.version)
    failures.push(`${name}: version must be ${rule.version}`);
  if (rule.private) {
    if (manifest.private !== true) failures.push(`${name}: must be marked private`);
  } else if (manifest.publishConfig?.access !== 'public') {
    failures.push(`${name}: publishConfig.access must be public`);
  }
  if (manifest.bin !== undefined) failures.push(`${name}: D1 must not expose a command`);
  // pnpm promotes publishConfig fields into the packed manifest, so a
  // publishConfig.bin, .exports, .main, .imports, or .types would give the
  // tarball a command or an entry point the checks above never saw. Only
  // the registry sentinels and access may appear there.
  for (const key of Object.keys(manifest.publishConfig ?? {})) {
    if (!['registry', '@obversa:registry', 'access'].includes(key))
      failures.push(`${name}: publishConfig.${key} is promoted into the packed manifest by pnpm, past the checks on ${key}; only registry, @obversa:registry, and access are allowed in publishConfig`);
  }

  // A sibling is named by key, or installed under an alias by value
  // (`npm:@obversa/x`, `workspace:@obversa/x`, `workspace:../x`); both are
  // the same arrow. A refusal is a value the scan could not read: a path, a
  // URL, a Git spec, a tag, a catalog entry.
  const manifestAt = { file: join(directory, 'package.json'), root };
  const named = (field) => internalDependencies(manifest, field, manifestAt).filter((dependency) => {
    if (isRefusal(dependency)) failures.push(`${name}: ${refusalReason(dependency)}`);
    return !isRefusal(dependency);
  });
  const internal = [...new Set([...named('dependencies'), ...named('optionalDependencies')])].sort();
  const expected = [...rule.dependencies].sort();
  if (JSON.stringify(internal) !== JSON.stringify(expected)) {
    failures.push(
      `${name}: internal dependencies must be ${expected.join(', ') || 'none'}; found ${internal.join(', ') || 'none'}`,
    );
  }

  const peers = named('peerDependencies');
  const expectedPeers = [...rule.peerDependencies].sort();
  if (JSON.stringify(peers) !== JSON.stringify(expectedPeers)) {
    failures.push(
      `${name}: internal peers must be ${expectedPeers.join(', ') || 'none'}; found ${peers.join(', ') || 'none'}`,
    );
  }
  // A workspace devDependency and a package `imports` alias are arrows too:
  // both go through the same allowed set as an import in source.
  const allowedArrows = new Set([...rule.dependencies, ...rule.peerDependencies]);
  for (const dependency of named('devDependencies')) {
    if (!allowedArrows.has(dependency)) failures.push(`${name}: devDependencies must not name ${dependency}`);
  }
  // An `imports` alias may point at the package itself (a self-reference),
  // as a source import may; a self devDependency stays refused above.
  const allowedImportTargets = new Set([name, ...allowedArrows]);
  for (const target of manifestImportTargets(manifest, { file: join(directory, 'package.json'), root })) {
    if (isRefusal(target)) failures.push(`${name}: ${refusalReason(target)}`);
    else if (!allowedImportTargets.has(target)) failures.push(`${name}: package imports must not map to ${target}`);
  }
  for (const [dependency, expectedVersion] of Object.entries(
    rule.peerDependencyVersions ?? {},
  )) {
    const actualVersion = manifest.peerDependencies?.[dependency];
    if (actualVersion !== expectedVersion) {
      failures.push(
        `${name}: peer ${dependency} must use ${expectedVersion}; found ${actualVersion ?? 'none'}`,
      );
    }
  }

  // The manifest's own entry fields are followed by a loader, the compiler,
  // or a bundler: each is placed like an import.
  checkArrows(`packages/${owner}/package.json`, owner, manifestPathTargets(manifest, manifestAt));

  // The scripts are exactly the pinned ones.
  const scripts = manifest.scripts ?? {};
  for (const scriptName of new Set([...Object.keys(scripts), ...Object.keys(rule.scripts)])) {
    if (scripts[scriptName] !== rule.scripts[scriptName])
      failures.push(`${name}: script ${scriptName} must be ${JSON.stringify(rule.scripts[scriptName]) ?? 'absent'}; found ${JSON.stringify(scripts[scriptName]) ?? 'absent'}. Scripts are pinned in packageRules; review the boundary rule with any change`);
  }
  // And the configuration files those scripts read are exactly the pinned
  // ones, by content; a tool key in the manifest is another such file.
  const present = (await readdir(directory)).filter((entry) => toolConfigName.test(entry));
  for (const entry of new Set([...present, ...Object.keys(rule.configFiles)])) {
    const pinned = rule.configFiles[entry];
    const actual = present.includes(entry) ? createHash('sha256').update(await readFile(join(directory, entry))).digest('hex') : undefined;
    if (actual !== pinned)
      failures.push(`packages/${owner}/${entry}: content sha256 must be ${pinned ?? 'absent'}; found ${actual ?? 'absent'}. Build and test configuration is pinned in packageRules; review the boundary rule with any change`);
  }
  for (const key of ['tsup', 'vitest', 'vite']) {
    if (manifest[key] !== undefined) failures.push(`${name}: manifest key ${key} configures a tool the scan pins by file; move it to a pinned file`);
  }
}
for (const entry of await readdir(root)) {
  if (toolConfigName.test(entry)) failures.push(`${entry}: a root build or test configuration is read by every package's tools and is not pinned`);
}
// The tools that interpret the pinned configurations, and the guard's own
// parsers, are pinned to exact versions at the root: a content hash only
// means what the reviewed tool made of it.
const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const rootPins = {
  packageManager: 'pnpm@10.15.1',
  // npm is pinned because the release command publishes through it and the
  // publish guard's spec reads its registry rules from it: both resolve this
  // installed copy, never whichever npm is first on PATH.
  devDependencies: { tsup: '8.5.1', vitest: '4.1.11', '@typescript/typescript6': '6.0.2', typescript: '7.0.2', semver: '7.7.2', npm: '10.9.2', pnpm: '10.15.1' },
};
if (rootManifest.packageManager !== rootPins.packageManager)
  failures.push(`package.json: packageManager must be ${rootPins.packageManager}; found ${rootManifest.packageManager ?? 'absent'}`);
for (const [tool, version] of Object.entries(rootPins.devDependencies)) {
  if (rootManifest.devDependencies?.[tool] !== version)
    failures.push(`package.json: devDependencies ${tool} must be exactly ${version}; found ${rootManifest.devDependencies?.[tool] ?? 'absent'}. Tool versions are pinned in rootPins; review the boundary rule with any change`);
  // The version installed is the version pinned: the lockfile, not the
  // manifest, decides what runs.
  let installed;
  try {
    installed = JSON.parse(await readFile(join(root, 'node_modules', tool, 'package.json'), 'utf8')).version;
  } catch {
    installed = undefined;
  }
  if (installed !== version)
    failures.push(`node_modules/${tool}: installed version must be ${version}; found ${installed ?? 'absent'}`);
}

// The root manifest can rewrite what any package installs — a pinned tool
// included — through an override or a resolution, so none is allowed.
// pnpm reads the same settings (`overrides`, `catalog`, `catalogs`,
// `packageExtensions`, `patchedDependencies`) from pnpm-workspace.yaml
// too, and the scan does not read YAML, so that file is pinned verbatim,
// as the scripts are.
for (const field of ['overrides', 'resolutions']) {
  if (rootManifest[field] !== undefined) failures.push(`package.json: ${field} rewrites what packages install; none is allowed`);
}
// The root is the package scope of every file outside packages/ and hosts/,
// and of a host directory that lost its manifest; an exports or imports map,
// an entry field, or a bin there would make those files importable by the
// root's name, so none is allowed.
for (const field of ['exports', 'imports', 'main', 'module', 'browser', 'bin']) {
  if (rootManifest[field] !== undefined) failures.push(`package.json: ${field} makes the root importable by name; the root is private and is never a package anything imports`);
}
// The root `pnpm` settings reach every install: overrides, patches,
// package extensions, and `configDependencies` — plugins whose pnpmfile is
// prepended to the hooks the local refusal covers. Only the execution
// environment is allowed.
for (const field of Object.keys(rootManifest.pnpm ?? {})) {
  if (field !== 'executionEnv') failures.push(`package.json: pnpm.${field} changes how packages install; only pnpm.executionEnv is allowed`);
}
// The workspace is the packages and the hosts: a host is the composition
// root where the packages meet, and it takes them by their public names.
const workspaceFile = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8');
if (!isPinnedWorkspaceFile(workspaceFile))
  failures.push('pnpm-workspace.yaml: must be exactly the packages and hosts globs (pinned in isPinnedWorkspaceFile; review the boundary rule with any change)');
// A pnpmfile hook rewrites manifests as they are read, and an .npmrc can
// name one or change how workspace packages link; neither is read by the
// scan, so their presence at the root or in a package is refused.
for (const dir of ['.', ...[...packageRules.keys()].map((name) => join('packages', name.slice('@obversa/'.length))), ...[...hostRules.keys()].map((name) => join('hosts', name))]) {
  for (const hook of ['.pnpmfile.cjs', 'pnpmfile.cjs', '.pnpmfile.mjs', '.pnpmfile.js', '.npmrc', '.yarnrc', '.yarnrc.yml']) {
    if (await exists(join(root, dir, hook))) failures.push(`${join(dir, hook)}: rewrites what packages install or how they link, which the scan does not read`);
  }
}

for (const path of [
  'packages/lines/src/cli.ts',
  'packages/lines/src/cli.tsx',
  'packages/lines/src/index.ts',
  'packages/lines/src/reporters.ts',
  'packages/lines/src/tui',
  'packages/lines/src/helm',
  'packages/lines/bin',
  'packages/lines/src/core/forge.ts',
  'packages/lines/src/core/pr.ts',
  'packages/lines/src/core/human.ts',
  'packages/lines/src/core/config-file.ts',
  'packages/lines/src/core/consolidate.ts',
  'packages/lines/src/core/curate.ts',
  'packages/lines/src/core/ground.ts',
  'packages/lines/src/core/params.ts',
  'packages/lines/src/core/prompt-bank.ts',
  'packages/lines/src/runtime/hub.ts',
  'packages/lines/src/runtime/signals.ts',
  'packages/lines/src/runtime/semantic.ts',
  'packages/lines/src/runtime/semantic-schema.ts',
  'packages/lines/src/env/docker.ts',
  'packages/lines/src/env/sst.ts',
]) {
  const absolute = join(root, path);
  if (await containsFile(absolute)) failures.push(`${path}: retired D1 surface remains`);
}

for (const absolute of files) {
  const path = relative(root, absolute);
  if (
    path.startsWith('packages/')
    && path.includes('/src/')
    && /(?:\.d\.ts(?:\.map)?|\.js(?:\.map)?)$/.test(path)
  ) {
    failures.push(`${path}: generated build output must not be stored under src`);
  }
  const extension = extname(absolute);
  const extensionlessHostFile = path.startsWith('hosts/') && extension.length === 0;
  if (!textExtensions.has(extension) && !absolute.endsWith('LICENSE') && !extensionlessHostFile)
    continue;
  scannedTextFiles.add(path);
  const buffer = await readFile(absolute);
  if (buffer.includes(0)) {
    failures.push(`${path}: text file contains a NUL byte`);
    continue;
  }
  const text = buffer.toString('utf8');
  for (const rule of forbidden) {
    if (rule.pattern.test(text)) failures.push(`${path}: contains ${rule.name}`);
  }

  // Import scan covers every source form in the workspace: the runtime is
  // TypeScript, the surface packages are plain ES modules. Each specifier is
  // also resolved under every project config its package carries.
  if (scansImports(path)) {
    const owner = path.split('/')[1];
    const configs = (projectConfigs.get(owner) ?? []).map((config) => config.options);
    checkArrows(path, owner, extractObversaImports(text, { file: absolute, root, configs }));
  }
  // Host JavaScript is scanned too: public package names only, no path into
  // packages/, and the loader-hatch rules of shipped source.
  if (isHostScript(path, text)) {
    importScannedHostFiles.add(path);
    // A shebang carries options to node before any import runs:
    // `#!/usr/bin/env -S node --import=./packages/x/src/y.mjs` loads a
    // package path with no specifier the scan reads. A host command's
    // shebang is exactly `#!/usr/bin/env node`, nothing more.
    const shebang = text.split('\n')[0] ?? '';
    if (shebang.startsWith('#!') && shebang !== '#!/usr/bin/env node')
      failures.push(`${path}: a host command's shebang is exactly #!/usr/bin/env node; found ${JSON.stringify(shebang)} — options there load code before any import the scan reads`);
    const edges = [];
    const host = hostManifests.get(hostRootOf(absolute, root));
    for (const finding of hostImportFindings(text, { file: absolute, root, edges, selfName: host?.manifest.name, dependencies: host?.dependencies })) failures.push(`${path}: ${finding}`);
    for (const edge of edges) hostEdges.push({ from: path, ...edge });
  } else if (path.startsWith('hosts/') && !isTestPath(path) && (/^hosts\/[^/]+\/(bin|lib)\//.test(path) || text.startsWith('#!'))) {
    // A shipped host file that is not JavaScript — a shell command, under
    // bin/ or lib/ or carrying a shebang anywhere under the host — runs
    // whatever it says, so it may not name a package directory or an
    // install directory at all: `node ../../../packages/x/src/y.mjs` is the
    // same edge a JavaScript import by path would be, with no import to
    // scan. Only host JavaScript reaches a package, by public name.
    // The closure: the command's content is exactly the pinned one.
    const hostName = /^hosts\/([^/]+)\//.exec(path)[1];
    const pinned = hostRules.get(hostName)?.shell?.[path.slice(`hosts/${hostName}/`.length)];
    const actual = createHash('sha256').update(text).digest('hex');
    if (pinned === undefined) failures.push(`${path}: a shell host command is pinned by content in hostRules; this one is not pinned. Review it, then pin its sha256 (${actual})`);
    else if (actual !== pinned) failures.push(`${path}: content sha256 must be ${pinned}; found ${actual}. Shell host commands are pinned in hostRules; review the boundary rule with any change`);
    for (const named of ['packages/', 'node_modules']) {
      if (text.includes(named)) failures.push(`${path}: a shell host command names ${named}; only host JavaScript reaches a package, by its public name`);
    }
    if (/(^|[^A-Za-z0-9_./-])packages([^A-Za-z0-9_/-]|$)/.test(text)) failures.push(`${path}: a shell host command names the word packages; a path is assembled from pieces, and this is the piece`);
    // A word is never assembled across an expansion: `${P}ages`, `"$N"ode`,
    // `$A$B`, and `pack$X` each touch an expansion to a word character or
    // to another expansion, and are refused whatever they would spell.
    // A bare `$NAME` takes every word character after it into the name, so
    // the shapes are: a braced or parenthesised expansion followed by a word
    // character, any expansion followed by a quote and a word character or
    // by another expansion, and a word character followed by a braced or
    // parenthesised expansion.
    const bare = String.raw`\$[A-Za-z_][A-Za-z0-9_]*`;
    const wrapped = String.raw`(?:\$\{[^}]*\}|\$\([^)]*\))`;
    const assembled = [
      new RegExp(`${wrapped}["']?[A-Za-z0-9_]`),
      new RegExp(`(?:${bare}|${wrapped})["']?\\$`),
      new RegExp(`${bare}["'][A-Za-z0-9_]`),
      new RegExp(`[A-Za-z0-9_]["']?${wrapped}`),
    ];
    if (assembled.some((shape) => shape.test(text)))
      failures.push(`${path}: a shell host command touches an expansion to a word character or to another expansion; a path or a command name is never assembled from pieces`);
    // Text can be assembled (`${P}ages/`), so the geometry is held too: from
    // a host's bin/ or lib/, a package is reached only through a parent
    // segment or an absolute path, and a shell host command has neither — no
    // `../` or `/..`, and no absolute path outside the system directories
    // the glue may run commands from, /tmp, and /dev.
    if (/\.\.\/|\/\.\./.test(text)) failures.push(`${path}: a shell host command holds a parent-directory segment; a host command reaches nothing above its own directory`);
    const allowedAbsolute = ['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin', '/usr/sbin', '/sbin', '/tmp', '/dev'];
    // A literal that continues an expansion (`${HOME}/x`, `$(...)/x`) is a
    // relative tail, not an absolute path; one after any other character is.
    for (const match of text.matchAll(/(?<![A-Za-z0-9_.\/})-])\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*/g)) {
      const literal = match[0];
      if (!allowedAbsolute.some((prefix) => literal === prefix || literal.startsWith(`${prefix}/`)))
        failures.push(`${path}: a shell host command names the absolute path ${literal}; only the system directories, /tmp, and /dev may be named`);
    }
    // Its interpreter is named by absolute path: `#!/usr/bin/env bash`
    // resolves bash through PATH, and a shell command that receives the
    // session URL would hand the token to whatever bash sat first there.
    const shebang = text.split('\n')[0] ?? '';
    if (shebang.startsWith('#!') && !/^#!\/bin\/(ba)?sh$/.test(shebang))
      failures.push(`${path}: a shell host command's shebang is #!/bin/bash or #!/bin/sh; found ${JSON.stringify(shebang)} — an interpreter looked up on PATH would receive what the command is handed`);
  }
}

for (const path of requiredScannedFiles) {
  if (!scannedTextFiles.has(path)) failures.push(`${path}: public host file is not scanned`);
}
for (const path of requiredImportScannedHostFiles) {
  if (!importScannedHostFiles.has(path)) failures.push(`${path}: host script is not import-scanned`);
}
// The final proof for every shipped host edge: its resolved target is a file
// this very walk import-scanned. A target the walk skipped (dist,
// node_modules, a missing or unresolvable file) fails closed.
failures.push(...hostEdgeFailures(hostEdges, importScannedHostFiles));

// Two walks can meet the same link (the main walk and a per-host walk both
// enter hosts/); one refusal is printed once.
const distinctFailures = [...new Set(failures)];
if (distinctFailures.length) {
  console.error(`Boundary check failed (${distinctFailures.length}):`);
  for (const failure of distinctFailures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Boundary check passed for ${packageRules.size} packages and public files.`);
}

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error?.code !== 'EISDIR') return false;
    return true;
  }
}

// `failures` is the check's list, passed in: this function sits outside the
// check's scope, and a refusal it cannot record would surface as a crash.
async function walk(directory, output, failures) {
  const { files, symlinks } = await walkTree(directory);
  output.push(...files);
  // Every link the walk meets, under any scan root, is refused: under
  // packages/ a link can reach another package while the import that names
  // it looks local; under hosts/ it can stand as a shipped command whose
  // code the scan never read; anywhere else (scripts/, .githooks/) it can
  // stand as a guard or a release command whose code lives outside the
  // tree, so the tagged tree stays clean while what runs changes. The
  // per-package and per-host walks, which enter dist, refuse the same way
  // with the same words.
  for (const link of symlinks) failures.push(symlinkRefusal(relative(root, link).split('\\').join('/')));
}

async function containsFile(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) return true;
      if (entry.isDirectory() && (await containsFile(join(path, entry.name)))) return true;
    }
    return false;
  } catch (error) {
    return error?.code === 'ENOTDIR';
  }
}
