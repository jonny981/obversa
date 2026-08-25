import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRules = new Map([
  ['@obversa/lines', {
    version: '1.0.0',
    dependencies: [],
    peerDependencies: ['@obversa/memory'],
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
]);
const scanRoots = [
  '.changeset',
  'packages',
  'docs/public',
  'examples',
  'scripts',
  '.github',
  '.githooks',
];
const scanFiles = [
  '.gitignore',
  'README.md',
  'SECURITY.md',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
];
const ignoredDirectories = new Set(['dist', 'node_modules']);
const textExtensions = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsonl',
  '.md',
  '.mdx',
  '.mjs',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);
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

const gitignore = (await readFile(join(root, '.gitignore'), 'utf8'))
  .split(/\r?\n/)
  .map((line) => line.trim());
for (const path of ['.claude/', '.Codex/', '.superpowers/']) {
  if (!gitignore.includes(path)) failures.push(`.gitignore: must ignore ${path}`);
}

for (const [name, rule] of packageRules) {
  const directory = join(root, 'packages', name.slice('@obversa/'.length));
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (manifest.name !== name) failures.push(`${name}: manifest name is ${manifest.name}`);
  if (manifest.version !== rule.version)
    failures.push(`${name}: version must be ${rule.version}`);
  if (manifest.publishConfig?.access !== 'public')
    failures.push(`${name}: publishConfig.access must be public`);
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
  'packages/lines/src/index.ts',
  'packages/lines/src/tui',
  'packages/lines/src/helm',
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
]) {
  const absolute = join(root, path);
  if (await containsFile(absolute)) failures.push(`${path}: retired D1 surface remains`);
}

const files = [];
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
  if (!textExtensions.has(extname(absolute)) && !absolute.endsWith('LICENSE')) continue;
  const buffer = await readFile(absolute);
  if (buffer.includes(0)) {
    failures.push(`${path}: text file contains a NUL byte`);
    continue;
  }
  const text = buffer.toString('utf8');
  for (const rule of forbidden) {
    if (rule.pattern.test(text)) failures.push(`${path}: contains ${rule.name}`);
  }

  if (path.startsWith('packages/') && /\.(?:ts|tsx)$/.test(path)) {
    const owner = path.split('/')[1];
    const imports = [...text.matchAll(/(?:from\s*|import\s*)['"](@obversa\/[^'"]+)['"]/g)]
      .map((match) => match[1].split('/').slice(0, 2).join('/'));
    const ownerName = `@obversa/${owner}`;
    const ownerRule = packageRules.get(ownerName);
    const allowed = new Set([
      ownerName,
      ...(ownerRule?.dependencies ?? []),
      ...(ownerRule?.peerDependencies ?? []),
    ]);
    for (const dependency of imports) {
      if (!allowed.has(dependency))
        failures.push(`${path}: ${ownerName} must not import ${dependency}`);
    }
  }
}

if (failures.length) {
  console.error(`Boundary check failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Boundary check passed for four packages and public files.');

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
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, output);
    else if (entry.isFile()) output.push(path);
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
