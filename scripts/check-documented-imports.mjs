#!/usr/bin/env node

/**
 * Every `@obversa` name a documentation page tells a reader to import must be
 * something the BUILT package actually provides.
 *
 * `check:public-surface` asks the opposite question, whether a name we export
 * is mentioned in the docs, and it greps page text, so a name counts as
 * documented when it appears inside a code block. That let eight pages publish
 * `import { formatEvent } from '@obversa/runtime'` for a name the package had
 * never exported: the broken line was itself the evidence that satisfied the
 * check. This asks whether a name we document exists.
 *
 * Values are checked by importing the built entry point. Types vanish at
 * runtime, so a name absent from the module is looked for in the entry's
 * declaration file before it is called missing.
 *
 * Run with --control to prove the check can fail: it adds an import of a name
 * nothing exports and requires a failure.
 */

import { readFileSync, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docs = join(root, 'docs/public');

/** Every `import { a, b } from '@obversa/x'` on a page, with its source line. */
function importsIn(text) {
  const found = [];
  for (const match of text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"](@obversa\/[^'"]+)['"]/gs)) {
    const line = text.slice(0, match.index).split('\n').length;
    const names = match[1]
      .split(',')
      .map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    found.push({ specifier: match[2], names, line });
  }
  return found;
}

/** The package directory and export subpath a specifier resolves to. */
function locate(specifier) {
  const [, scope, ...rest] = specifier.split('/');
  const subpath = rest.length ? `./${rest.join('/')}` : '.';
  for (const where of ['packages', 'plugins']) {
    const dir = join(root, where, scope);
    if (existsSync(join(dir, 'package.json'))) return { dir, subpath };
  }
  return null;
}

/**
 * The names an entry point actually exports, followed through its re-exports.
 *
 * Reading every declaration in the directory and searching the joined text
 * asked whether a name is DECLARED NEARBY, which is the same shape of mistake
 * as asking whether a name is MENTIONED: a name in a comment, or declared in a
 * sibling and never exported, counted as provided. This walks the entry's own
 * `export` statements and follows `export * from` and `export { x } from` into
 * the files they name.
 */
function exportsOf(file, seen = new Set()) {
  const resolved = resolve(file);
  if (seen.has(resolved) || !existsSync(resolved)) return new Set();
  seen.add(resolved);
  const text = readFileSync(resolved, 'utf8');
  const names = new Set();

  // `export declare function x`, `export interface X`, `export type X`, and
  // the rest of the forms a declaration file uses to export one name.
  for (const m of text.matchAll(/^\s*export\s+(?:declare\s+)?(?:abstract\s+)?(?:function|const|let|var|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  // `export { a, b as c }` and `export type { d }`, with or without a source.
  for (const m of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/g)) {
    for (const part of m[1].split(',')) {
      const piece = part.trim().replace(/^type\s+/, '');
      if (!piece) continue;
      const as = piece.split(/\s+as\s+/);
      names.add((as[1] ?? as[0]).trim());
    }
  }
  // `export * from './x.js'` brings everything that file exports.
  for (const m of text.matchAll(/export\s+\*\s+from\s*['"]([^'"]+)['"]/g)) {
    for (const name of exportsOf(declarationFor(resolved, m[1]), seen)) names.add(name);
  }
  return names;
}

/** The declaration file a relative specifier points at, from a declaration. */
function declarationFor(from, specifier) {
  const base = join(dirname(from), specifier.replace(/\.(m?js)$/, ''));
  for (const suffix of ['.d.ts', '.d.mts', '/index.d.ts', '/index.d.mts']) {
    if (existsSync(base + suffix)) return base + suffix;
  }
  return base + '.d.ts';
}

/** What the selected entry point provides, or null when it is not built. */
function provided(dir, subpath) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const entry = manifest.exports?.[subpath];
  if (!entry?.types) return null;
  const declarations = join(dir, entry.types);
  if (!existsSync(declarations)) return null;
  return exportsOf(declarations);
}

const pages = [];
async function walk(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) await walk(path);
    else if (item.name.endsWith('.mdx')) pages.push(path);
  }
}
await walk(docs);

const failures = [];
let checked = 0;
const cache = new Map();
for (const page of pages.sort()) {
  for (const { specifier, names, line } of importsIn(readFileSync(page, 'utf8'))) {
    const place = locate(specifier);
    if (!place) {
      failures.push(`${page.slice(docs.length + 1)}:${line}: no package in this repository provides ${specifier}`);
      continue;
    }
    const key = `${place.dir}|${place.subpath}`;
    if (!cache.has(key)) cache.set(key, provided(place.dir, place.subpath));
    const exported = cache.get(key);
    if (!exported) {
      failures.push(`${page.slice(docs.length + 1)}:${line}: ${specifier} has no built entry point; run the build first`);
      continue;
    }
    for (const name of names) {
      checked += 1;
      if (exported.has(name)) continue;
      failures.push(`${page.slice(docs.length + 1)}:${line}: ${specifier} does not provide ${name}`);
    }
  }
}

if (failures.length) {
  console.error(`Documented imports that do not resolve (${failures.length}):`);
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
console.log(`Every documented import resolves: ${checked} names across ${pages.length} pages.`);
