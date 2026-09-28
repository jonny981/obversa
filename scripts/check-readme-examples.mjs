#!/usr/bin/env node
/**
 * Every executable TypeScript block in the README is a file that runs: a
 * complete example file byte for byte, or an excerpt whose title names the
 * file and ends "(excerpt)" and whose lines are one contiguous run of it,
 * the same rule the docs pages are held to.
 *
 * The README used to carry hand-written TypeScript that resembled a working
 * example. It was never a copy of anything that runs, which is how it could
 * show a review panel with no `target` while the prose above it promised that
 * a failing reviewer sends work back to the stage that owns it. Three gate
 * rounds found three versions of that same fault before anyone checked whether
 * the code in the README had ever executed.
 *
 * So the README quotes files that run, whole or in contiguous excerpts, and
 * this fails when they drift or when a hand-written fragment appears. The
 * flagship file is named on the page, so a reader can find the whole of it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fencedBlocks, isContiguousRun } from './check-page-shape.mjs';

/** Languages whose blocks must come from a file that runs. A shell block is
 *  a command, not an excerpt. */
const EXECUTABLE = new Set(['ts', 'tsx', 'js', 'mjs']);
const EXPECTED = 'examples/teams/feature-delivery.ts';
const EXCERPT = /(examples\/[A-Za-z0-9_./-]+\.(?:ts|mjs))\s+\(excerpt\)/;

function examples(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? examples(join(dir, e.name)) : /\.(ts|mjs)$/.test(e.name) ? [join(dir, e.name)] : []);
}

export function checkReadmeExamples(root) {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const problems = [];
  const files = examples(join(root, 'examples'));
  const sources = new Map(files.map((file) => [file.slice(root.length + 1), readFileSync(file, 'utf8').replace(/\n+$/, '')]));
  const blocks = fencedBlocks(readme).filter((block) => EXECUTABLE.has(block.lang));

  for (const block of blocks) {
    const first = (block.body.split('\n')[0] ?? '').slice(0, 90);
    const excerpt = block.meta.match(EXCERPT);
    if (excerpt) {
      const content = sources.get(excerpt[1]);
      if (content === undefined) {
        problems.push(`README: an excerpt names ${excerpt[1]}, which does not exist`);
      } else if (!isContiguousRun(content, block.body)) {
        problems.push(`README: an excerpt of ${excerpt[1]} is not a contiguous run of its lines:\n      ${first}`);
      }
      continue;
    }
    const matchesWholeFile = [...sources.values()].some((source) => source === block.body);
    if (!matchesWholeFile) {
      problems.push(`README: an executable block is not a complete example file:\n      ${first}`);
    }
  }

  const expectedSource = sources.get(EXPECTED);
  if (expectedSource === undefined) {
    problems.push(`expected example file is missing: ${EXPECTED}`);
  } else if (!readme.includes(EXPECTED) && !blocks.some((block) => block.body === expectedSource)) {
    problems.push(`README does not name the expected example file: ${EXPECTED}`);
  }

  return { problems, files: blocks.length };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { problems, files } = checkReadmeExamples(root);
  if (problems.length) {
    console.error('The README no longer matches the examples it quotes:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  console.log(`README quotes ${files} example block(s), each a whole file or a contiguous excerpt of one.`);
}
