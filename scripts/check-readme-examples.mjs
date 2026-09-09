#!/usr/bin/env node
/**
 * Every marked span in a runnable example must appear in the README byte for
 * byte.
 *
 * The README used to carry hand-written TypeScript that resembled a working
 * example. It was never a copy of anything that runs, which is how it could
 * show a review panel with no `target` while the prose above it promised that
 * a failing reviewer sends work back to the stage that owns it. Three gate
 * rounds found three versions of that same fault before anyone checked whether
 * the code in the README had ever executed.
 *
 * So the README quotes files that run, and this fails when they drift.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPAN = /\/\/ README-SPAN-START (\S+)\n([\s\S]*?)\/\/ README-SPAN-END \1\n/g;

function examples(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? examples(join(dir, e.name)) : /\.(ts|mjs)$/.test(e.name) ? [join(dir, e.name)] : []);
}

const readme = readFileSync(join(root, 'README.md'), 'utf8');
const problems = [];
let spans = 0;

for (const file of examples(join(root, 'examples'))) {
  const source = readFileSync(file, 'utf8');
  for (const [, name, body] of source.matchAll(SPAN)) {
    spans += 1;
    const quoted = body.replace(/\n$/, '');
    if (!readme.includes(quoted)) {
      problems.push(`${file.slice(root.length + 1)}: span "${name}" is not in the README byte for byte`);
    }
  }
}

if (spans === 0) {
  console.error('check-readme-examples: no README-SPAN markers found; the check would pass on any README');
  process.exit(1);
}
if (problems.length) {
  console.error('The README no longer matches the examples it quotes:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`README quotes ${spans} example span(s) byte for byte.`);
