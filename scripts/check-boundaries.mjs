import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// (fileURLToPath also reads `file:` specifiers, below.)

// The TypeScript compiler's parser (the pinned TypeScript 6 build; the
// TypeScript 7 native build exposes no parser API). The standard tools own
// the package arrows now — dependency-cruiser proves them, ESLint bans the
// JavaScript loader hatches, pnpm's isolated linker closes the hidden hoist
// — so the parser here serves what no standard tool covers yet: the
// loader-hatch refusal on the TypeScript sources (typescript-eslint refuses
// the TS 7 pin) and the project-config reading that waits on workstream 1's
// references migration.
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

// Every module form the parser map accepts; the predicate scopes the
// TypeScript hatch scan to package sources. Both are exported so the spec
// holds them to that.
export const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const sourcePattern = new RegExp(`(?:${sourceExtensions.map((ext) => ext.replace('.', '\\.')).join('|')})$`);
export function scansImports(path) {
  return /^(?:packages|plugins)\//.test(path) && sourcePattern.test(path);
}

// A host carries placement glue only: bash commands pinned by content, and
// no JavaScript at all. This predicate finds host JavaScript — a source
// file by extension, or an extensionless command whose first line is a node
// shebang — so the scan can refuse it on sight.
export function isHostScript(path, text) {
  if (!path.startsWith('hosts/')) return false;
  if (sourcePattern.test(path)) return true;
  return extname(path) === '' && /^#!.*\bnode\b/.test(text.split('\n')[0] ?? '');
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
export const PINNED_WORKSPACE_FILE = 'packages:\n  - packages/*\n  - hosts/*\n  - plugins/*\nnodeLinker: isolated\nhoist: false\npublicHoistPattern: []\n';
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
  if (!/^(?:packages|plugins)\/[^/]+\/.+\.json$/.test(path) || basename(path) === 'package.json') return false;
  if (/^(?:tsconfig|jsconfig)[^/]*\.json$/.test(basename(path))) return true;
  const { config } = ts.readConfigFile(path, () => text);
  return !!config && typeof config === 'object' && !Array.isArray(config)
    && projectFields.some((field) => field in config);
}

const realpathOf = (path, host) => (typeof host.realpath === 'function' ? host.realpath(path) : path);

const packageRules = new Map([
  ['@obversa/runtime', {
    directory: 'packages/runtime',
    kind: 'runtime',
    version: '1.0.0',
    dependencies: [],
    peerDependencies: ['@obversa/engine', '@obversa/memory'],
    peerDependencyVersions: {
      '@obversa/engine': '>=0.1.0 <0.2.0',
      '@obversa/memory': '>=0.1.0 <0.2.0',
    },
  }],
  ['@obversa/engine', {
    directory: 'packages/engine',
    kind: 'interface',
    version: '0.1.0',
    dependencies: [],
    peerDependencies: [],
  }],
  ['@obversa/memory', {
    directory: 'packages/memory',
    kind: 'interface',
    version: '0.1.0',
    dependencies: [],
    peerDependencies: [],
  }],
  ['@obversa/memory-simple', {
    directory: 'plugins/memory-simple',
    kind: 'plugin',
    version: '0.1.0',
    dependencies: ['@obversa/memory'],
    peerDependencies: [],
  }],
  ['@obversa/memory-git', {
    directory: 'plugins/memory-git',
    kind: 'plugin',
    version: '0.1.0',
    dependencies: ['@obversa/memory'],
    peerDependencies: [],
  }],
  // Private workspace packages get a rule too, so a sibling import inside
  // them is caught the same way. Surfacer must never depend on the runtime or
  // another package. Source depends on surfacer — the flipped arrow: the
  // review command lives in source and injects surfacer's launch port itself,
  // so a host keeps placement glue only.
  ['@obversa/surfacer', { directory: 'packages/surfacer', kind: 'surface', version: '0.1.0', dependencies: [], peerDependencies: [] }],
  ['@obversa/source', { directory: 'packages/source', kind: 'surface', version: '0.1.0', dependencies: ['@obversa/surfacer'], peerDependencies: [] }],
  ['@obversa/engine-agent-sdk', { directory: 'plugins/engine-agent-sdk', kind: 'plugin', version: '0.1.0', dependencies: ['@obversa/engine', '@obversa/memory'], peerDependencies: [] }],
  ['@obversa/engine-anthropic-api', { directory: 'plugins/engine-anthropic-api', kind: 'plugin', version: '0.1.0', dependencies: ['@obversa/engine'], peerDependencies: [] }],
  ['@obversa/engine-claude-cli', { directory: 'plugins/engine-claude-cli', kind: 'plugin', version: '0.1.0', dependencies: ['@obversa/engine'], peerDependencies: [] }],
  ['@obversa/engine-codex', { directory: 'plugins/engine-codex', kind: 'plugin', version: '0.1.0', dependencies: ['@obversa/engine'], peerDependencies: [] }],
  ['@obversa/engine-grok-cli', { directory: 'plugins/engine-grok-cli', kind: 'plugin', version: '0.1.0', dependencies: ['@obversa/engine'], peerDependencies: [] }],
  ['@obversa/engine-opencode-cli', { directory: 'plugins/engine-opencode-cli', kind: 'plugin', version: '0.1.0', dependencies: ['@obversa/engine'], peerDependencies: [] }],
]);
const packageNamesByDirectory = new Map(
  [...packageRules].map(([name, rule]) => [rule.directory, name]),
);

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
  // its real spelling does. Either workspace root can reach several units.
  return ['packages', 'plugins'].some((workspaceRoot) => {
    const rel = relative(realPathOf(absolute), realPathOf(join(repoRoot, workspaceRoot)));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
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
export function projectConfig(text, {
  file,
  root: repoRoot,
  host = ts.sys,
  packageNames = packageNamesByDirectory,
} = {}) {
  const { parsed, diagnostics, extended } = parseProjectConfig(text, { file, host });
  if (diagnostics.length > 0)
    return { dependencies: [refusal(`the config cannot be read as the compiler reads it: ${diagnostics.join('; ')}`)], options: parsed.options };
  const configDir = dirname(file);
  const dependencies = [];
  const place = (named, what) => {
    const placed = placement(named, { file, root: repoRoot, host, what, packageNames });
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
export function dependencyTarget(
  key,
  spec,
  { file, root: repoRoot, packageNames = packageNamesByDirectory } = {},
) {
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
    const name = file && repoRoot
      ? packageNameOf(realpathOf(resolve(dirname(file), linked[1]), ts.sys), repoRoot, packageNames)
      : undefined;
    return name !== undefined
      ? { name }
      : { refused: `${key} links ${linked[1]}, which is not a workspace package the scan can place` };
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
export function manifestPathTargets(manifest, {
  file,
  root: repoRoot,
  host = ts.sys,
  packageNames = packageNamesByDirectory,
} = {}) {
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
    // A manifest entry is a module a consumer loads: one that exists with no
    // source extension (an extensionless file Node loads all the same) is
    // never import-scanned, and what it imports is never seen, so it is
    // refused. Data and type files are not modules that import, and a
    // directory (`directories`) is placed as a place, not opened.
    const named = resolve(dirname(file), literal);
    const real = realpathOf(named, host);
    if (host.fileExists?.(real) && !sourcePattern.test(real) && !/\.(json|css|html|txt|md|d\.ts|d\.mts|d\.cts)$/.test(real)) {
      found.push(refusal(`${field} names ${placedUnder(real, repoRoot)}, a file with no source extension, which the scan never import-scans; a module carries a source extension`));
      continue;
    }
    const placed = placement(named, { file, root: repoRoot, host, what: field, packageNames });
    if (placed) found.push(placed);
  }
  return found;
}

// Where an absolute path lies, relative to the package that owns `file`:
// undefined for the owner (or for a place that is no package at all), the
// sibling's name for a sibling, and a refusal for `packages/` or above —
// a place that holds every package. Real paths are compared, so a symlink
// outside every package that points into one is seen where it lands.
function placement(named, {
  file,
  root: repoRoot,
  host = ts.sys,
  what,
  packageNames = packageNamesByDirectory,
}) {
  const absolute = realpathOf(named, host);
  if (reachesEveryPackage(absolute, repoRoot))
    return refusal(`${what} reaches ${placedUnder(absolute, repoRoot) || '.'}, which holds every package`);
  const name = packageNameOf(absolute, repoRoot, packageNames);
  return name !== undefined && name !== packageNameOf(file, repoRoot, packageNames)
    ? name
    : undefined;
}

// The packages a manifest's `imports` map (`#alias`) can reach. Node resolves
// such an alias to an external package or to a path, through nested
// conditional objects and arrays, so every string leaf counts — by name, or
// by a relative path into another package (a glob by its literal prefix).
export function manifestImportTargets(
  manifest,
  { file, root: repoRoot, packageNames = packageNamesByDirectory } = {},
) {
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
    // An alias is a module a consumer loads by the alias: one whose target
    // exists with no source extension is never import-scanned, and what it
    // imports is never seen — refused, as a manifest entry field is.
    if (file && /^\.\.?\//.test(leaf)) {
      const real = realpathOf(resolve(dirname(file), leaf), ts.sys);
      if (ts.sys.fileExists(real) && !sourcePattern.test(real) && !/\.(json|css|html|txt|md|d\.ts|d\.mts|d\.cts)$/.test(real)) {
        found.push(refusal(`package imports alias ${leaf}, a file with no source extension, which the scan never import-scans; a module carries a source extension`));
        continue;
      }
    }
    const crossing = crossingPackage(leaf, { file, root: repoRoot, packageNames });
    if (crossing) found.push(crossing);
  }
  return found;
}

// The package a specifier or path names when it crosses a package boundary:
// an `@obversa/...` name by name, a relative or absolute path by the package
// directory it resolves into, when that is not the importing file's own.
// Null otherwise.
function crossingPackage(
  specifier,
  { file, root: repoRoot, packageNames = packageNamesByDirectory } = {},
) {
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
  // A module the loader would open must be one the scan reads: a file that
  // exists at the target with no source extension (an extensionless module,
  // which Node loads all the same) is never import-scanned, and what it
  // imports is never seen. A target that does not exist as spelled is the
  // compiler's to place (`./x` for x.ts); data files JSON can carry are not
  // modules that import.
  if (!isTestPath(file) && ts.sys.fileExists(real) && !sourcePattern.test(real) && !/\.(json|css|html|txt|md)$/.test(real))
    return refusal(`${specifier} names ${placed}, a file with no source extension, which the scan never import-scans; a module carries a source extension`);
  const owner = packageNameOf(realpathOf(file, ts.sys), realRoot, packageNames);
  // A package or plugin imports nothing from outside the two code roots: a
  // host is the composition root, and scripts/ plus the repository root are
  // the guard's own ground.
  if (owner !== undefined && !isTestPath(file) && !/^(?:packages|plugins)\//.test(placed)) return refusal(`${specifier} reaches ${placed || '.'}, outside packages/ and plugins/; a package imports nothing from hosts, scripts, or the repository root`);
  const name = packageNameOf(real, realRoot, packageNames);
  return name && name !== owner ? name : null;
}

// The explicit package identity whose ruled directory contains an absolute
// path, or which the path names outright (as a project reference does).
// Directory spelling is never rebuilt into a public package name.
export function packageNameOf(
  absolute,
  repoRoot,
  packageNames = packageNamesByDirectory,
) {
  const placed = placedUnder(absolute, repoRoot);
  for (const [directory, name] of packageNames) {
    if (placed === directory || placed.startsWith(`${directory}/`)) return name;
  }
  return undefined;
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
// Compare real paths: Node resolves symlinks for import.meta but keeps the
// invoked path in argv, so a symlinked invocation must still count as main.
const isMain = process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
if (isMain) await main();

async function main() {
const scanRoots = [
  '.changeset',
  'packages',
  'plugins',
  'hosts',
  'docs/public',
  'examples',
  'scripts',
  '.github',
  '.githooks',
];
const requiredScanRoots = ['hosts', 'plugins'];
// The host JavaScript that must be import-scanned, by name, so a rename or a
// scan gap cannot leave the composition root unchecked.
const requiredScannedFiles = [
  'hosts/cmux/bin/obversa-cmux-workspace',
  'hosts/cmux/bin/obversa-order-workspace',
  'hosts/cmux/bin/obversa-plannotator-browser',
  'hosts/cmux/bin/obversa-surface',
  'hosts/cmux/test/f0-proof.sh',
  'hosts/cmux/test/f2b-placement-proof.sh',
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
    name: 'retired runtime package name',
    pattern: new RegExp(`@obversa/${'lin' + 'es'}`, 'i'),
  },
  {
    name: 'retired runtime environment prefix',
    pattern: new RegExp(`${'LIN' + 'ES'}_`),
  },
  {
    name: 'retired runtime state directory',
    pattern: new RegExp(`\\.${'lin' + 'es'}(?:/|["'\\x60])`, 'i'),
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
    scripts: {},
    shell: {
      'bin/obversa-cmux-workspace': '797bff9eef5818c7e3296dbc8aa01644b6d10c2082a921bc21f1dce678e5ef37',
      'bin/obversa-order-workspace': '4a8821485b2c1c67041ffd248075a42042674bddb3aebfb4f6915b007e7299f8',
      'bin/obversa-peer-send': '15e38b2a7d4d232122a1653df6dc2ca17085d03e78ad7d687192daa95ac78da8',
      'bin/obversa-plannotator-browser': 'ef180a43d479ad9c9ae2242bb7f24b74ab58f85781465ffd6eace1c45b9ef34a',
      'bin/obversa-surface': 'd2e704106aaf9c6d07a8e6057ce1a09ca504471fc2cacacedb7e0eb95b5ab552',
      'bin/obversa-whereis': 'e29448c5f6626b177b72b64d00fae4f9b5512f66049d1db31e7b4a4e5a2a8aa3',
    },
  }],
]);
for (const entry of await readdir(join(root, 'hosts'), { withFileTypes: true })) {
  // Nothing but host directories lives directly under hosts/: a file there
  // belongs to no host, so no host rule could hold it.
  if (!entry.isDirectory()) {
    failures.push(`hosts/${entry.name}: a file directly under hosts/ belongs to no host; every host file lives under hosts/<name>/`);
    continue;
  }
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
          exported = JSON.parse(await readFile(join(root, packageRules.get(name).directory, 'package.json'), 'utf8')).exports;
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
}

// The arrows a package may draw: itself, its dependencies, its peers. A
// dependency list from any scan goes through this; a refusal is printed as
// its reason.
const checkArrows = (path, owner, dependencies) => {
  const rule = packageRules.get(owner);
  const allowed = new Set([owner, ...(rule?.dependencies ?? []), ...(rule?.peerDependencies ?? [])]);
  for (const dependency of dependencies) {
    if (isRefusal(dependency)) failures.push(`${path}: ${refusalReason(dependency)}`);
    else if (!allowed.has(dependency)) failures.push(`${path}: ${owner} must not import ${dependency}`);
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

// Every package and plugin directory is claimed by one explicit rule. The
// manifest owns the public name; directory spelling is not an identity rule.
if (packageNamesByDirectory.size !== packageRules.size) failures.push('packageRules: every package name must own a distinct directory');
for (const workspaceRoot of ['packages', 'plugins']) {
  for (const entry of await readdir(join(root, workspaceRoot), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const ruledDirectory = `${workspaceRoot}/${entry.name}`;
    const manifestPath = join(root, ruledDirectory, 'package.json');
    if (!(await exists(manifestPath))) {
      failures.push(`${ruledDirectory}: has no package.json; every workspace directory is a ruled package or plugin`);
      continue;
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const { files: packageFiles, symlinks: packageLinks } = await walkTree(join(root, ruledDirectory), { ignored: new Set(['node_modules']) });
    for (const link of packageLinks) failures.push(symlinkRefusal(relative(root, link).split('\\').join('/')));
    for (const nested of packageFiles) {
      if (basename(nested) === 'package.json' && nested !== manifestPath)
        failures.push(`${relative(root, nested).split('\\').join('/')}: a nested manifest makes itself the package scope of the files beneath it, whatever it is named; a package has one manifest, at its root`);
    }
    const expectedName = packageNamesByDirectory.get(ruledDirectory);
    if (!expectedName) failures.push(`${ruledDirectory}: ${manifest.name} has no boundary rule with this directory`);
    else if (manifest.name !== expectedName) failures.push(`${ruledDirectory}: is named ${manifest.name}; its boundary rule names ${expectedName}`);
  }
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
const projectConfigs = new Map(); // package name -> [{ absolute, options }]
for (const absolute of files) {
  const path = relative(root, absolute).split('\\').join('/');
  if (extname(absolute) !== '.json') continue;
  const text = await readFile(absolute, 'utf8');
  if (!isProjectConfig(path, text)) continue;
  const owner = packageNameOf(absolute, root);
  if (!owner) {
    failures.push(`${path}: project config has no package boundary rule`);
    continue;
  }
  const { dependencies, options } = projectConfig(text, { file: absolute, root });
  checkArrows(path, owner, dependencies);
  if (!projectConfigs.has(owner)) projectConfigs.set(owner, []);
  projectConfigs.get(owner).push({ absolute, options });
}

for (const [name, rule] of packageRules) {
  if (!['interface', 'runtime', 'plugin', 'surface'].includes(rule.kind))
    failures.push(`${name}: boundary kind must be interface, runtime, plugin, or surface; found ${rule.kind ?? 'absent'}`);
  const directory = join(root, rule.directory);
  if (rule.kind === 'runtime' || rule.kind === 'plugin') {
    for (const dependency of [...rule.dependencies, ...rule.peerDependencies]) {
      if (packageRules.get(dependency)?.kind !== 'interface')
        failures.push(`${name}: a ${rule.kind} may depend only on interface packages; ${dependency} is ${packageRules.get(dependency)?.kind ?? 'unruled'}`);
    }
  }
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (manifest.name !== name) failures.push(`${name}: manifest name is ${manifest.name}`);
  if (manifest.version !== rule.version)
    failures.push(`${name}: version must be ${rule.version}`);
  if (rule.private) {
    if (manifest.private !== true) failures.push(`${name}: must be marked private`);
  } else if (manifest.publishConfig?.access !== 'public') {
    failures.push(`${name}: publishConfig.access must be public`);
  }
  // The review command is @obversa/source's one bin (an internal note);
  // no other package exposes a command.
  const allowedBins = name === '@obversa/source' ? { 'obversa-review': './bin/obversa-review.mjs' } : undefined;
  if (JSON.stringify(manifest.bin) !== JSON.stringify(allowedBins))
    failures.push(`${name}: bin must be ${JSON.stringify(allowedBins) ?? 'absent'}; found ${JSON.stringify(manifest.bin) ?? 'absent'}`);
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
  checkArrows(`${rule.directory}/package.json`, name, manifestPathTargets(manifest, manifestAt));

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
  devDependencies: { tsup: '8.5.1', vitest: '4.1.11', '@typescript/typescript6': '6.0.2', typescript: '7.0.2', semver: '7.7.2', npm: '10.9.2', pnpm: '10.15.1', 'dependency-cruiser': '18.2.0', eslint: '10.9.1', 'eslint-plugin-import-x': '4.17.1', 'eslint-import-resolver-typescript': '4.4.5', publint: '0.3.24', '@arethetypeswrong/cli': '0.18.5' },
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
// environment is allowed, plus one exact package extension: dependency-cruiser
// needs a `typescript` in its supported range to parse TypeScript sources, the
// root pins typescript 7 for the compilers, and the extension hands the
// cruiser the already-pinned TS6 wrapper by its alias. Anything else that
// rewrites what a package installs is refused.
const allowedPackageExtensions = JSON.stringify({
  'dependency-cruiser': { dependencies: { typescript: 'npm:@typescript/typescript6@6.0.2' } },
});
for (const field of Object.keys(rootManifest.pnpm ?? {})) {
  if (field === 'executionEnv') continue;
  if (field === 'packageExtensions' && JSON.stringify(rootManifest.pnpm.packageExtensions) === allowedPackageExtensions) continue;
  failures.push(`package.json: pnpm.${field} changes how packages install; only pnpm.executionEnv and the exact dependency-cruiser typescript extension are allowed`);
}
// The workspace is the packages, plugins, and hosts. A host is the
// composition root where the packages meet, and it takes them by name.
const workspaceFile = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8');
if (!isPinnedWorkspaceFile(workspaceFile))
  failures.push('pnpm-workspace.yaml: must be exactly the packages, hosts, and plugins globs (pinned in isPinnedWorkspaceFile; review the boundary rule with any change)');
// A pnpmfile hook rewrites manifests as they are read, and an .npmrc can
// name one or change how workspace packages link; neither is read by the
// scan, so their presence at the root or in a package is refused.
for (const dir of ['.', ...[...packageRules.values()].map((rule) => rule.directory), ...[...hostRules.keys()].map((name) => join('hosts', name))]) {
  for (const hook of ['.pnpmfile.cjs', 'pnpmfile.cjs', '.pnpmfile.mjs', '.pnpmfile.js', '.npmrc', '.yarnrc', '.yarnrc.yml']) {
    if (await exists(join(root, dir, hook))) failures.push(`${join(dir, hook)}: rewrites what packages install or how they link, which the scan does not read`);
  }
}

for (const path of [
  'packages/runtime/src/cli.ts',
  'packages/runtime/src/cli.tsx',
  'packages/runtime/src/index.ts',
  'packages/runtime/src/reporters.ts',
  'packages/runtime/src/tui',
  'packages/runtime/src/helm',
  'packages/runtime/bin',
  'packages/runtime/src/core/forge.ts',
  'packages/runtime/src/core/pr.ts',
  'packages/runtime/src/core/human.ts',
  'packages/runtime/src/core/config-file.ts',
  'packages/runtime/src/core/consolidate.ts',
  'packages/runtime/src/core/curate.ts',
  'packages/runtime/src/core/ground.ts',
  'packages/runtime/src/core/params.ts',
  'packages/runtime/src/core/prompt-bank.ts',
  'packages/runtime/src/runtime/hub.ts',
  'packages/runtime/src/runtime/signals.ts',
  'packages/runtime/src/runtime/semantic.ts',
  'packages/runtime/src/runtime/semantic-schema.ts',
  'packages/runtime/src/env/docker.ts',
  'packages/runtime/src/env/sst.ts',
]) {
  const absolute = join(root, path);
  if (await containsFile(absolute)) failures.push(`${path}: retired D1 surface remains`);
}

for (const absolute of files) {
  const path = relative(root, absolute);
  if (
    /^(?:packages|plugins)\//.test(path)
    && path.includes('/src/')
    && /(?:\.d\.ts(?:\.map)?|\.js(?:\.map)?)$/.test(path)
  ) {
    failures.push(`${path}: generated build output must not be stored under src`);
  }
  const extension = extname(absolute);
  // Every file under a host is read whatever its extension: a shell command
  // saved as .bash or .py would otherwise be skipped here before any host
  // check — pin, shebang, path, assembly — ever saw it.
  const hostFile = path.startsWith('hosts/');
  if (!textExtensions.has(extension) && !absolute.endsWith('LICENSE') && !hostFile)
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

  // Package arrows are dependency-cruiser's job now (check:arrows and its
  // fixture matrix); the compiler-resolution import scan is deleted with
  // that replacement in place. What stays here for source files is the
  // loader-hatch refusal on the TypeScript packages alone: the ESLint
  // config bans the same forms in JavaScript, and typescript-eslint refuses
  // the root's TS 7 pin, so this one narrowed rule holds the line until
  // workstream 1's migration lands a TypeScript parser story.
  if (/\.(ts|tsx|mts|cts)$/.test(path) && scansImports(path)) {
    // The parser reports a hatch as a null entry among the specifiers.
    if (moduleSpecifiers(text, path).includes(null)) {
      failures.push(`${path}: a loader hatch (eval, Function, a vm or module loader, a computed or unreadable specifier) is refused in TypeScript sources; the ESLint bans cover the JavaScript files`);
    }
  }
  // A host carries placement glue only: the review command lives in
  // @obversa/source, so host JavaScript — a .mjs/.cjs/.js file, or an
  // extensionless command with a node shebang — is refused on sight rather
  // than import-scanned. dependency-cruiser cannot read an extensionless
  // script, so the refusal is what keeps a node command from reappearing
  // under a host unseen.
  if (isHostScript(path, text)) {
    failures.push(`${path}: a host carries placement glue only; host JavaScript moved into the packages, and a node command here would run outside every arrow check`);
  } else if (path.startsWith('hosts/') && !/^hosts\/[^/]+\/test\//.test(path) && (/^hosts\/[^/]+\/(bin|lib)\//.test(path) || text.startsWith('#!'))) {
    // A shipped host file that is not JavaScript — a shell command, under
    // bin/ or lib/ or carrying a shebang anywhere under the host — runs
    // whatever it says, so it may not name a package directory or an
    // install directory at all: `node ../../../packages/x/src/y.mjs` is the
    // same edge a JavaScript import by path would be, with no import to
    // scan. Only host JavaScript reaches a package, by public name.
    // Under bin/ or lib/ a file is an extensionless command (a node command
    // above, a pinned shell command here) or JavaScript source (above); any
    // other extension there is refused, whatever it holds.
    if (/^hosts\/[^/]+\/(bin|lib)\//.test(path) && extname(path) !== '')
      failures.push(`${path}: a file under a host's bin/ or lib/ is an extensionless command or JavaScript source; ${extname(path)} is neither`);
    // The closure: the command's content is exactly the pinned one. A file
    // directly under hosts/ belongs to no host and is refused as such, as a
    // listed failure rather than a crash.
    const hostName = /^hosts\/([^/]+)\//.exec(path)?.[1];
    if (hostName === undefined) {
      failures.push(`${path}: a file directly under hosts/ belongs to no host; every host file lives under hosts/<name>/`);
      continue;
    }
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
