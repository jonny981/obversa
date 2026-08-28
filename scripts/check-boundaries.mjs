import { readFileSync, realpathSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The TypeScript compiler's parser (the pinned TypeScript 6 build; the
// TypeScript 7 native build exposes no parser API). A real parser is the only
// honest way to find imports: strings, template literals, regex literals, and
// comments are decided by the language's grammar, so none of them can hide a
// specifier from this fail-closed guard or fake one.
import ts from '@typescript/typescript6';

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

// Every module specifier a file names, in source order: static imports and
// re-exports, side-effect and dynamic `import(...)`, CommonJS `require(...)`,
// `import x = require(...)`, type-position `import("x").T` / `typeof
// import("x")` (a distinct ImportTypeNode — a type-only import is still a
// dependency, an internal note), and the JSDoc form `@type {import("x").T}` in
// JavaScript files. A specifier that is not a plain string (a computed
// expression) is reported as `null`, because a guard that cannot read it must
// fail rather than assume. Exported so the spec can pin each form.
export function moduleSpecifiers(text, fileName = 'module.ts') {
  const kind = scriptKinds.get(extname(fileName)) ?? ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const specifiers = [];
  const literal = (node) =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
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
      const callee = node.expression;
      // `import(...)`, and the phase forms `import.defer(...)` / `import.source(...)`
      // (a MetaProperty on the import keyword).
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isMetaProperty(callee) && callee.keywordToken === ts.SyntaxKind.ImportKeyword);
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      if ((isImport || isRequire) && node.arguments.length > 0) specifiers.push(literal(node.arguments[0]));
    }
    // JSDoc is not part of the child walk; its type expressions can carry
    // import types too.
    for (const doc of node.jsDoc ?? []) ts.forEachChild(doc, visit);
    ts.forEachChild(node, visit);
  };
  visit(source);
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

// Every tsconfig under a package, at any depth, carries dependency fields.
export function scansTsconfig(path) {
  return /^packages\/[^/]+\/(?:.*\/)?tsconfig[^/]*\.json$/.test(path);
}

// The fields of a tsconfig that can name a module or a path, and so a
// dependency: `compilerOptions.jsxImportSource` (the compiler emits an import
// of `<source>/jsx-runtime` into every JSX file with no pragma of its own),
// `types`, `typeRoots`, `paths` targets, `baseUrl`, `rootDirs`, and
// `plugins[].name`; `typeAcquisition.include`; project `references[].path`;
// `extends`; and `include`/`files`. This list is the claim: a field outside
// it is not a resolver field the scan knows about.
// Each candidate carries the directory a relative value resolves against:
// `paths` targets resolve against `baseUrl` when it is set (that is how the
// compiler resolves them), everything else against the config's directory.
function tsconfigCandidates(config, configDir) {
  const options = config?.compilerOptions ?? {};
  const pathsBase = options.baseUrl && configDir ? resolve(configDir, options.baseUrl) : configDir;
  const from = (base, values) =>
    [].concat(values ?? []).filter((value) => typeof value === 'string' && value.length > 0).map((value) => ({ value, base }));
  return [
    ...from(configDir, options.jsxImportSource),
    ...from(configDir, options.types),
    ...from(configDir, options.typeRoots),
    ...from(pathsBase, Object.values(options.paths ?? {}).flat()),
    ...from(configDir, options.baseUrl),
    ...from(configDir, options.rootDirs),
    ...from(configDir, [].concat(options.plugins ?? []).map((plugin) => plugin?.name)),
    ...from(configDir, config?.typeAcquisition?.include),
    ...from(configDir, [].concat(config?.references ?? []).map((ref) => ref?.path)),
    ...from(configDir, config?.extends),
    ...from(configDir, config?.include),
    ...from(configDir, config?.files),
  ];
}

const readConfigText = (absolute) => {
  try {
    return readFileSync(absolute, 'utf8');
  } catch {
    return null;
  }
};

// The packages a tsconfig makes its package depend on, through every field
// in tsconfigCandidates, and through every config it extends: a same-package
// base can carry the field, so a relative `extends` is read and its own
// dependencies added, recursively, with a cycle guard. A `@obversa/...` name
// counts by name; a relative path counts when it resolves into another
// package's directory (a glob by its literal prefix). A base that cannot be
// read is reported as the sentinel `@obversa/<unreadable-extends>`, so the
// scan fails closed on it. Read with the compiler's own reader, so comments
// and trailing commas parse. `file` is the tsconfig's absolute path and
// `root` the repository root; without them only names are reported. `read`
// is how an extended config is loaded (the spec injects one).
export function tsconfigDependencies(text, { file, root: repoRoot, read = readConfigText, seen = new Set() } = {}) {
  const { config } = ts.readConfigFile(file ?? 'tsconfig.json', () => text);
  const found = [];
  const configDir = file ? dirname(file) : undefined;
  for (const { value, base } of tsconfigCandidates(config, configDir)) {
    if (value.startsWith('@obversa/')) {
      found.push(value.split('/').slice(0, 2).join('/'));
      continue;
    }
    // Any other value is a path — relative to its base, or absolute — whose
    // literal prefix (before any glob) may land in another package.
    if (!file || !repoRoot || !base) continue;
    const target = resolve(base, value.split(/[*?]/)[0]);
    const dir = packageDirOf(target, repoRoot);
    if (dir && dir !== packageDirOf(file, repoRoot)) found.push(`@obversa/${dir}`);
  }
  if (file) {
    seen.add(file);
    for (const parent of [].concat(config?.extends ?? [])) {
      if (typeof parent !== 'string' || !/^\.\.?\//.test(parent)) continue;
      const absolute = resolve(dirname(file), parent);
      // A base in another package is a crossing in itself, reported above;
      // only a base of this package, or one outside every package (the
      // repository's shared base), is inherited and read.
      const baseDir = repoRoot ? packageDirOf(absolute, repoRoot) : undefined;
      if (baseDir && baseDir !== packageDirOf(file, repoRoot)) continue;
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      const parentText = read(absolute);
      if (parentText === null) {
        found.push('@obversa/<unreadable-extends>');
        continue;
      }
      found.push(...tsconfigDependencies(parentText, { file: absolute, root: repoRoot, read, seen }));
    }
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

// The workspace packages a file depends on: `@obversa/...` specifiers by name,
// and relative paths that resolve into another `packages/<dir>/` (a path inside
// the importing package is not a crossing). A computed specifier is reported
// as the sentinel `@obversa/<computed>` so the caller fails closed on it.
// `file` is the importing file's absolute path and `root` the repository root;
// without them only package-name specifiers are reported. Package directory
// names equal the unscoped package names today; the plugin split maps
// directories through their manifests.
export function extractObversaImports(text, { file, root: repoRoot } = {}) {
  const found = [];
  for (const specifier of moduleSpecifiers(text, file ?? 'module.ts')) {
    if (specifier === null) {
      found.push('@obversa/<computed>');
      continue;
    }
    const crossing = crossingPackage(specifier, { file, root: repoRoot });
    if (crossing) found.push(crossing);
  }
  return found;
}

// Compare real paths: Node resolves symlinks for import.meta but keeps the
// invoked path in argv, so a symlinked invocation must still count as main.
const isMain = process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
if (isMain) await main();

async function main() {
const packageRules = new Map([
  ['@obversa/lines', {
    version: '1.0.0',
    dependencies: [],
    peerDependencies: ['@obversa/memory'],
    peerDependencyVersions: { '@obversa/memory': '>=0.1.0 <0.2.0' },
  }],
  ['@obversa/memory', { version: '0.1.0', dependencies: [], peerDependencies: [] }],
  ['@obversa/memory-simple', {
    version: '0.1.0',
    dependencies: ['@obversa/memory'],
    peerDependencies: [],
  }],
  ['@obversa/memory-git', {
    version: '0.1.0',
    dependencies: ['@obversa/memory'],
    peerDependencies: [],
  }],
  // Private workspace packages get a rule too, so a sibling import inside
  // them is caught the same way. Surfacer must never depend on the runtime or
  // another package; source must never import surfacer (it takes the surface
  // port by injection from the host composition root).
  ['@obversa/surfacer', { version: '0.1.0', private: true, dependencies: [], peerDependencies: [] }],
  ['@obversa/source', { version: '0.1.0', private: true, dependencies: [], peerDependencies: [] }],
]);
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

for (const path of requiredScanRoots) {
  if (!scanRoots.includes(path)) failures.push(`boundary scan must include ${path}/`);
}

const gitignore = (await readFile(join(root, '.gitignore'), 'utf8'))
  .split(/\r?\n/)
  .map((line) => line.trim());
for (const path of ['.claude/', '.Codex/', '.superpowers/']) {
  if (!gitignore.includes(path)) failures.push(`.gitignore: must ignore ${path}`);
}

// Every workspace package must have a rule: a new package that nobody listed
// would otherwise import whatever it liked without the scan noticing.
for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifestPath = join(root, 'packages', entry.name, 'package.json');
  if (!(await exists(manifestPath))) continue;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!packageRules.has(manifest.name))
    failures.push(`packages/${entry.name}: ${manifest.name} has no boundary rule; add one to packageRules`);
}

for (const [name, rule] of packageRules) {
  const directory = join(root, 'packages', name.slice('@obversa/'.length));
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

  const internal = Object.entries({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
  })
    .filter(([dependency]) => dependency.startsWith('@obversa/'))
    .map(([dependency]) => dependency)
    .sort();
  const expected = [...rule.dependencies].sort();
  if (JSON.stringify(internal) !== JSON.stringify(expected)) {
    failures.push(
      `${name}: internal dependencies must be ${expected.join(', ') || 'none'}; found ${internal.join(', ') || 'none'}`,
    );
  }

  const peers = Object.keys(manifest.peerDependencies ?? {})
    .filter((dependency) => dependency.startsWith('@obversa/'))
    .sort();
  const expectedPeers = [...rule.peerDependencies].sort();
  if (JSON.stringify(peers) !== JSON.stringify(expectedPeers)) {
    failures.push(
      `${name}: internal peers must be ${expectedPeers.join(', ') || 'none'}; found ${peers.join(', ') || 'none'}`,
    );
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

  for (const value of Object.values({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
  })) {
    if (/^(?:file|link|git|https?):/i.test(String(value)))
      failures.push(`${name}: dependency ${value} is not registry-safe`);
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
  // TypeScript, the surface packages are plain ES modules.
  // A package tsconfig can name a dependency for every file at once.
  const tsconfigDeps = scansTsconfig(path) ? tsconfigDependencies(text, { file: absolute, root }) : [];
  if (scansImports(path) || tsconfigDeps.length > 0) {
    const owner = path.split('/')[1];
    const imports = scansImports(path) ? extractObversaImports(text, { file: absolute, root }) : tsconfigDeps;
    const ownerName = `@obversa/${owner}`;
    const ownerRule = packageRules.get(ownerName);
    const allowed = new Set([
      ownerName,
      ...(ownerRule?.dependencies ?? []),
      ...(ownerRule?.peerDependencies ?? []),
    ]);
    for (const dependency of imports) {
      if (dependency === '@obversa/<computed>')
        failures.push(`${path}: a computed module specifier cannot be checked; use a plain string`);
      else if (dependency === '@obversa/<unreadable-extends>')
        failures.push(`${path}: a config it extends could not be read, so its dependencies cannot be checked`);
      else if (!allowed.has(dependency))
        failures.push(`${path}: ${ownerName} must not import ${dependency}`);
    }
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
