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

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docs = join(root, 'docs/public');

/** Every `import { a, b } from '@obversa/x'` on a page, with its source line. */
function importsIn(text) {
  const found = [];
  for (const match of text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'(@obversa\/[^']+)'/gs)) {
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
 * What the built package declares, read from its type declarations.
 *
 * An earlier version imported the built entry to list its runtime exports.
 * That executes the module, so it needs every runtime dependency installed
 * and it fails on a package whose entry pulls in a third-party library. The
 * declarations name both values and types, cost nothing to read, and answer
 * the only question here: does this name exist in what we publish.
 */
function provided(dir, subpath) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const entry = manifest.exports?.[subpath];
  if (!entry) return null;
  // Anchor on the manifest's `types`, not its runtime entry. One package
  // ships `.` as `./src/index.mjs` with declarations under `dist/src/`, and a
  // subpath like `./command` declares into `dist/command/`. Following the
  // runtime entry finds neither, and reports a correct page as broken.
  const declarations = entry.types;
  if (!declarations) return null;
  const built = join(dir, declarations);
  if (!existsSync(built)) return null;
  // Every declaration beside it, because an entry file is mostly
  // `export * from './contracts.js'` and reading it alone reports a
  // re-exported name as missing.
  const distDir = dirname(built);
  const declared = [];
  if (existsSync(distDir)) {
    for (const file of readdirSync(distDir)) {
      if (file.endsWith('.d.ts') || file.endsWith('.d.mts')) {
        declared.push(readFileSync(join(distDir, file), 'utf8'));
      }
    }
  }
  return declared.join('\n');
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
    const declared = cache.get(key);
    if (!declared) {
      failures.push(`${page.slice(docs.length + 1)}:${line}: ${specifier} has no built entry point; run the build first`);
      continue;
    }
    for (const name of names) {
      checked += 1;
      if (new RegExp(`\\b${name}\\b`).test(declared)) continue;
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
