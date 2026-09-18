import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCAN_DIRS = ['scripts', 'docs', 'examples', 'packages', 'plugins', 'hosts', '.github/workflows', '.changeset'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.next', 'coverage']);
const SELF = new Set(['scripts/check-retired-names.mjs', 'scripts/check-retired-names.spec.mjs']);
const OLD_DIRS = ['process', 'source', 'surfacer', 'memory', 'engine', 'teams'];
const REDIRECTS = new Map([
  ['/packages/engine', '/packages/api'],
  ['/packages/memory', '/packages/api'],
  ['/packages/process', '/packages/core'],
  ['/packages/teams', '/packages/builtin-workflows'],
  ['/packages/source', '/packages/surface-diff'],
  ['/packages/surfacer', '/packages/surface-decision'],
  ['/packages/engine-codex', '/packages/engine-codex-cli'],
  ['/packages/engine-agent-sdk', '/packages/engine-claude-agent-sdk'],
]);
const OLD_PATH = /(?:^|[^A-Za-z0-9_-])(?:packages\/(?:process|source|surfacer|memory|engine|teams)|plugins\/(?:engine-codex|engine-agent-sdk))(?![A-Za-z0-9_-])/g;
const OLD_NAME = /(?:@obversa\/(?:process|teams|engine|memory|source|surfacer|engine-codex|engine-agent-sdk)|(?:^|[^A-Za-z0-9_-])(?:engine-codex|engine-agent-sdk))(?![A-Za-z0-9_-])/g;
const OLD_ARCHIVE = /obversa-(?:process|teams|engine|memory|source|surfacer|engine-codex|engine-agent-sdk)(?:\.tgz|-[0-9]|-\$\{)/g;
const NORMALIZED_PATH = /(?:^|[^A-Za-z0-9_-])(?:packages[/.]?(?:process|source|surfacer|memory|engine|teams)|plugins[/.]?(?:engine-codex|engine-agent-sdk))(?![A-Za-z0-9_-])/gm;

function filesUnder(root, directory) {
  const base = join(root, directory);
  if (!existsSync(base)) return [];
  const entries = readdirSync(base, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(base, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : filesUnder(root, join(directory, entry.name));
    return entry.isFile() ? [path] : [];
  });
}

function textFor(root, file) {
  const name = relative(root, file).replaceAll('\\', '/');
  if (name === 'CHANGELOG.md') {
    return readFileSync(file, 'utf8').split(/^## \[1\.0\.0\]/m)[0];
  }
  if (name === 'docs/public/docs.json') {
    const document = JSON.parse(readFileSync(file, 'utf8'));
    document.redirects = (document.redirects ?? []).filter(
      (redirect) => REDIRECTS.get(redirect.source) !== redirect.destination,
    );
    return JSON.stringify(document);
  }
  const bytes = readFileSync(file);
  return bytes.includes(0) ? '' : bytes.toString('utf8');
}

function stringValue(expression, variables) {
  const value = expression.trim();
  const quoted = /^(['"])([^'"]*)\1$/.exec(value);
  if (quoted) return quoted[2];
  if (/^[A-Za-z_$][\w$]*$/.test(value)) return variables.get(value);
  const parts = value.split(/\s*\+\s*/);
  if (parts.length > 1) {
    const values = parts.map((part) => stringValue(part, variables));
    if (values.every((part) => part !== undefined)) return values.join('');
  }
  return undefined;
}

function splitPathHits(text) {
  const variables = new Map();
  for (const match of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])([^'"]*)\2/g)) {
    variables.set(match[1], match[3]);
  }
  const hits = [];
  for (const call of text.matchAll(/\b(?:join|resolve|path\.join|path\.resolve)\s*\(([^;]*?)\)/gs)) {
    const values = call[1].split(',').map((part) => stringValue(part, variables));
    const path = values.filter((value) => value !== undefined).join('/').replaceAll('//', '/');
    if (OLD_PATH.test(path)) hits.push('split retired package path');
    OLD_PATH.lastIndex = 0;
  }
  for (const match of text.matchAll(/(['"])packages\/\1\s*\+\s*([A-Za-z_$][\w$]*)/g)) {
    if (OLD_DIRS.includes(variables.get(match[2]))) hits.push('concatenated retired package path');
  }
  return hits;
}

export function checkRetiredNames(root = ROOT) {
  const files = SCAN_DIRS.flatMap((directory) => filesUnder(root, directory));
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if ((entry.isFile() || entry.name === 'CLAUDE.md' && entry.isSymbolicLink())
      && /^(?:README|AGENTS|CLAUDE|CONTRIBUTING|SECURITY|CHANGELOG)\.md$|\.(?:json|ya?ml|cjs|mjs)$/.test(entry.name)) {
      files.push(join(root, entry.name));
    }
  }
  const failures = [];
  for (const file of files.sort()) {
    const name = relative(root, file).replaceAll('\\', '/');
    if (SELF.has(name)) continue;
    let text;
    try { text = textFor(root, file); } catch (error) {
      failures.push(name + ': cannot read: ' + String(error));
      continue;
    }
    // Regex escapes, quotes, and joined literals still describe locations.
    // Read those spellings as paths, while keeping each ordinary line separate.
    const normalized = text.replaceAll('\\/', '/').replaceAll('\\.', '.');
    const hits = [];
    for (const [label, pattern] of [
      ['retired package path', OLD_PATH],
      ['retired package name', OLD_NAME],
      ['retired package archive', OLD_ARCHIVE],
    ]) {
      const match = pattern.exec(normalized);
      pattern.lastIndex = 0;
      if (match) hits.push(label + ' ' + match[0].trim());
    }
    const compact = normalized.replace(/\+\s*\n\s*/g, '+')
      .split('\n').map((line) => line.replace(/[\\'"`\s+{},()$]/g, '')).join('\n');
    if (NORMALIZED_PATH.test(compact)) hits.push('retired package path in compact text');
    NORMALIZED_PATH.lastIndex = 0;
    hits.push(...splitPathHits(normalized));
    if (hits.length) failures.push(name + ': ' + [...new Set(hits)].join('; '));
  }
  return failures;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const failures = checkRetiredNames();
    if (failures.length) {
      for (const failure of failures) console.error(failure);
      process.exitCode = 1;
    } else {
      console.log('No retired package names or locations remain outside release history and redirects.');
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
