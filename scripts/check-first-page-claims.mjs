/**
 * The sentences the first pages must keep.
 *
 * Jonny gave three points for the docs more than once, and more than once a
 * rewrite lost them: a deterministic process around the inference, process
 * modelled at every layer, and inference at the leaves with everything
 * deterministic lifted out around it. Each phrase below is a fragment of his
 * words as they stand on the page, and the check fails the build when a page
 * no longer carries it. Change a phrase here only when the page's sentence
 * changes with it, and never so that the point goes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FIRST_PAGE_CLAIMS = Object.freeze([
  {
    page: 'index.mdx',
    phrases: [
      'deterministic process around the inference',
      'process at every layer',
      'Inference belongs mostly at the leaves',
      'fraction of the cost',
      'small jobs, each with',
    ],
  },
  {
    page: 'concepts/index.mdx',
    phrases: [
      'deterministic process around the inference',
      'process at every layer',
      'saved, shared',
      'Inference belongs mostly at the leaves',
      'fraction of the cost',
      'value stream mapping',
      'small jobs, each with',
    ],
  },
]);

export function checkFirstPageClaims(root, claims = FIRST_PAGE_CLAIMS) {
  const failures = [];
  for (const { page, phrases } of claims) {
    let text;
    try {
      text = readFileSync(join(root, 'docs', 'public', page), 'utf8');
    } catch {
      failures.push(`${page}: the page is missing, so every sentence it must keep is gone`);
      continue;
    }
    for (const phrase of phrases) {
      if (!text.includes(phrase)) failures.push(`${page}: no longer says "${phrase}"`);
    }
  }
  return failures;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const failures = checkFirstPageClaims(process.argv[2] ?? process.cwd());
  if (failures.length) {
    for (const failure of failures) console.error(failure);
    process.exitCode = 1;
  } else {
    const count = FIRST_PAGE_CLAIMS.reduce((n, { phrases }) => n + phrases.length, 0);
    console.log(`The first pages keep all ${count} of the sentences they must keep.`);
  }
}
