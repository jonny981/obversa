import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
export function moduleSpecifiers(text, fileName = 'module.ts') {
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
  const isEquality = (parent) => ts.isBinaryExpression(parent) && [
    ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
  ].includes(parent.operatorToken.kind);
  const isLoader = (node) => {
    // `module` and `import.meta` hold a loader: as the object of a literal
    // member the member decides (below); compared for identity they load
    // nothing; used as a value — destructured, assigned, passed — the
    // loader goes with them, so the use is refused.
    if ((ts.isIdentifier(node) && node.text === 'module' && !isName(node)) || isImportMeta(node)) {
      const parent = node.parent;
      if (isAccess(parent) && ts.skipOuterExpressions(parent.expression) === node) return false;
      return !isEquality(parent);
    }
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
    if (member === 'require') return true;
    if (accessOn(node, named('module'))) return member === null;
    if (accessOn(node, isRequire)) return member === 'resolve' || member === null;
    if (accessOn(node, isImportMeta)) return member === 'resolve' || member === null;
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
  const isModuleModule = (node) => ['module', 'node:module'].includes(literal(node));
  const moduleModuleNames = new Set(['createRequire', 'builtinModules', 'isBuiltin']);
  const readsModuleModule = (node) => {
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
  const visit = (node, inDoc) => {
    if (!inDoc && isLoader(node) && !handled.has(node)) specifiers.push(null);
    if (!inDoc && isCreateRequire(node) && !handled.has(node)) {
      // Only the callee of `const require = createRequire(...)`; the name
      // identifier under a member access is judged with the access.
      const underAccess = ts.isIdentifier(node) && node.parent && isAccess(node.parent) && node.parent.name === node;
      if (!underAccess) specifiers.push(null);
    }
    if (ts.isImportDeclaration(node) && isModuleModule(node.moduleSpecifier) && !readsModuleModule(node)) {
      specifiers.push(null);
    } else if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      specifiers.push(literal(node.moduleSpecifier));
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      specifiers.push(literal(node.moduleReference.expression));
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
      if (isCreateRequire(callee) && bindsRequire(node)) {
        handled.add(callee);
      } else if (isLoader(callee)) {
        handled.add(callee);
        if (isAccess(callee)) handled.add(ts.skipOuterExpressions(callee.expression));
        // A computed member may or may not be the loader: unreadable, as is
        // a load of the module that makes loaders.
        if ((isAccess(callee) && memberName(callee) === null) || isModuleModule(node.arguments[0])) specifiers.push(null);
        else specifiers.push(literal(node.arguments[0]));
      } else if (isImport && node.arguments.length > 0) {
        specifiers.push(isModuleModule(node.arguments[0]) ? null : literal(node.arguments[0]));
      }
    }
    // JSDoc is not part of the child walk; its type expressions can carry
    // import types too.
    for (const doc of node.jsDoc ?? []) ts.forEachChild(doc, (child) => visit(child, true));
    ts.forEachChild(node, (child) => visit(child, inDoc));
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
  const rel = relative(absolute, join(repoRoot, 'packages'));
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

// A registry version range as pnpm reads one: pnpm hands a selector to
// node-semver's validRange in loose mode and treats a null answer as a
// tag, so the same call, on the same pinned semver, decides here. An empty
// selector is refused outright — validRange reads it as `*`, pnpm as
// nothing. A tag, a URL, a Git spec, a path, or anything else the registry
// does not answer with a versioned package is not a range.
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
  const alias = /^(?:npm|workspace):(@obversa\/[^@/]+)(?:@.*)?$/.exec(value);
  if (alias) return { name: alias[1] };
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
    // is placed whole.
    const literal = field === 'exports' || field === 'typesVersions' ? value.split('*')[0] : value;
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
    return refusal(`${what} reaches ${relative(repoRoot, absolute) || '.'}, which holds every package`);
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
    // `*` is the map's only wildcard; `?` is an ordinary character.
    const crossing = crossingPackage(leaf.split('*')[0], { file, root: repoRoot });
    if (crossing) found.push(crossing);
  }
  return found;
}

// The package a specifier or path names when it crosses a package boundary:
// an `@obversa/...` name by name, a relative path by the package directory it
// resolves into, when that is not the importing file's own. Null otherwise.
function crossingPackage(specifier, { file, root: repoRoot } = {}) {
  if (specifier.startsWith('@obversa/')) return specifier.split('/').slice(0, 2).join('/');
  if (!file || !repoRoot || !/^\.\.?\//.test(specifier)) return null;
  const dir = packageDirOf(resolve(dirname(file), specifier), repoRoot);
  return dir && dir !== packageDirOf(file, repoRoot) ? `@obversa/${dir}` : null;
}

// The package directory an absolute path lies in, or names outright (a bare
// `packages/memory`, as a project reference does), else undefined.
function packageDirOf(absolute, repoRoot) {
  return /^packages\/([^/]+)(?:\/|$)/.exec(relative(repoRoot, absolute).split('\\').join('/'))?.[1];
}

// Every regular file under a directory, and every symlink met on the way. A
// symlink is reported rather than followed: under packages/ one can reach a
// sibling package's code while the import that names it looks local, so the
// boundary scan fails closed on it.
export async function walkTree(directory, { ignored = ignoredDirectories } = {}) {
  const files = [];
  const symlinks = [];
  const visit = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) symlinks.push(path);
      else if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) await visit(path);
      } else if (entry.isFile()) files.push(path);
    }
  };
  await visit(directory);
  return { files, symlinks };
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
  for (const specifier of moduleSpecifiers(text, file ?? 'module.ts')) {
    if (specifier === null) {
      found.push(refusal('a computed module reference cannot be checked; use a plain string'));
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
        const dir = packageDirOf(realpathOf(target, host), repoRoot);
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
const requiredScannedFiles = [
  'hosts/cmux/bin/obversa-order-workspace',
  'hosts/cmux/bin/obversa-plannotator-browser',
  'hosts/cmux/bin/obversa-surface',
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
  if (manifest.name !== `@obversa/${entry.name}`)
    failures.push(`packages/${entry.name}: is named ${manifest.name}; a package is named @obversa/<its directory>`);
  else if (!packageRules.has(manifest.name))
    failures.push(`packages/${entry.name}: ${manifest.name} has no boundary rule; add one to packageRules`);
}

const files = [];
const scannedTextFiles = new Set();
for (const path of scanRoots) {
  const absolute = join(root, path);
  if (await exists(absolute)) await walk(absolute, files);
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
    if (!allowedImportTargets.has(target)) failures.push(`${name}: package imports must not map to ${target}`);
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
  devDependencies: { tsup: '8.5.1', vitest: '4.1.11', '@typescript/typescript6': '6.0.2', typescript: '7.0.2', semver: '7.8.5' },
};
if (rootManifest.packageManager !== rootPins.packageManager)
  failures.push(`package.json: packageManager must be ${rootPins.packageManager}; found ${rootManifest.packageManager ?? 'absent'}`);
for (const [tool, version] of Object.entries(rootPins.devDependencies)) {
  if (rootManifest.devDependencies?.[tool] !== version)
    failures.push(`package.json: devDependencies ${tool} must be exactly ${version}; found ${rootManifest.devDependencies?.[tool] ?? 'absent'}. Tool versions are pinned in rootPins; review the boundary rule with any change`);
}

// The root manifest can rewrite what any package installs: an override or
// a resolution that names a workspace package, or a path, would route a
// dependency into a sibling behind every rule above, so each must be a
// registry range or a registry alias. pnpm reads the same settings
// (`overrides`, `catalog`, `catalogs`, `packageExtensions`,
// `patchedDependencies`) from pnpm-workspace.yaml too, and the scan does
// not read YAML, so that file is pinned verbatim, as the scripts are.
for (const field of ['overrides', 'resolutions']) {
  for (const [key, spec] of Object.entries({ ...rootManifest[field], ...rootManifest.pnpm?.[field] })) {
    const target = dependencyTarget(key, spec, { file: join(root, 'package.json'), root });
    if (!target.external) failures.push(`package.json: ${field} ${key} is ${spec}; an override must be a registry version`);
  }
}
for (const field of ['packageExtensions', 'patchedDependencies']) {
  if (rootManifest.pnpm?.[field] !== undefined) failures.push(`package.json: pnpm.${field} rewrites what packages install, which the scan does not read`);
}
const workspaceFile = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8');
if (workspaceFile !== 'packages:\n  - packages/*\n')
  failures.push('pnpm-workspace.yaml: must be exactly the packages glob (pinned here; review the boundary rule with any change)');
// A pnpmfile hook rewrites manifests as they are read, and an .npmrc can
// name one or change how workspace packages link; neither is read by the
// scan, so their presence at the root or in a package is refused.
for (const dir of ['.', ...[...packageRules.keys()].map((name) => join('packages', name.slice('@obversa/'.length)))]) {
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
}

for (const path of requiredScannedFiles) {
  if (!scannedTextFiles.has(path)) failures.push(`${path}: public host file is not scanned`);
}

if (failures.length) {
  console.error(`Boundary check failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
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

async function walk(directory, output) {
  const { files, symlinks } = await walkTree(directory);
  output.push(...files);
  for (const link of symlinks) {
    const path = relative(root, link).split('\\').join('/');
    if (path.startsWith('packages/'))
      failures.push(`${path}: a symlink under packages/ is refused; it can reach another package while an import that names it looks local`);
  }
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
