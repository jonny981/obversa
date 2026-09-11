#!/usr/bin/env node
/**
 * Every executable TypeScript block in the README must quote a complete
 * example file byte for byte.
 *
 * The README used to carry hand-written TypeScript that resembled a working
 * example. It was never a copy of anything that runs, which is how it could
 * show a review panel with no `target` while the prose above it promised that
 * a failing reviewer sends work back to the stage that owns it. Three gate
 * rounds found three versions of that same fault before anyone checked whether
 * the code in the README had ever executed.
 *
 * So the README quotes files that run, and this fails when they drift or
 * when a hand-written fragment appears.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Languages whose blocks must come from a file that runs. A shell block is
 *  a command, not an excerpt. */
const EXECUTABLE = new Set(['ts', 'tsx', 'js', 'mjs']);
const EXPECTED = 'examples/teams/feature-delivery.ts';

function examples(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? examples(join(dir, e.name)) : /\.(ts|mjs)$/.test(e.name) ? [join(dir, e.name)] : []);
}

export function checkReadmeExamples(root) {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const problems = [];
  const files = examples(join(root, 'examples'));
  const sources = new Map(files.map((file) => [file.slice(root.length + 1), readFileSync(file, 'utf8')]));
  const executableBlocks = [];
  for (const [, lang, body] of readme.matchAll(/```(\w+)\n([\s\S]*?)```/g)) {
    if (!EXECUTABLE.has(lang)) continue;
    executableBlocks.push(body.replace(/\n$/, ''));
  }

  for (const quoted of executableBlocks) {
    const matchesWholeFile = [...sources.values()].some((source) => source.replace(/\n$/, '') === quoted);
    if (!matchesWholeFile) {
      problems.push(`README: an executable block is not a complete example file:\n      ${quoted.split('\n')[0].slice(0, 90)}`);
    }
  }

  const expectedSource = sources.get(EXPECTED);
  if (!expectedSource) {
    problems.push(`expected example file is missing: ${EXPECTED}`);
  } else if (!executableBlocks.includes(expectedSource.replace(/\n$/, ''))) {
    problems.push(`README does not quote the expected example file: ${EXPECTED}`);
  }

  return { problems, files: executableBlocks.length };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { problems, files } = checkReadmeExamples(root);
  if (problems.length) {
    console.error('The README no longer matches the examples it quotes:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  console.log(`README quotes ${files} complete example file(s) byte for byte.`);
}
