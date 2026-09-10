import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The crash-recovery claim is the one sentence pair a reader is most likely
 * to act on and most likely to get wrong, so every file that makes it states
 * it in the same words. Add a file here the moment it makes the claim.
 */
const CORE = 'Steps that finished are never repeated. A step that was mid-flight when the worker died runs again only if its binding declares it safe to retry; otherwise the run pauses and asks a person to reconcile it before it continues, so uncertain work is never repeated silently.';

const FILES = [
  { path: 'README.md', name: 'the README' },
  { path: 'AGENTS.md', name: 'the contributor guide' },
  { path: 'docs/public/recording/how-a-run-is-recorded.mdx', name: 'the record page' },
];

const OPENING = 'Steps that finished are never repeated.';
const CLOSING = 'never repeated silently.';

function coreSpan(text) {
  const flat = text.replace(/\s+/g, ' ');
  const start = flat.indexOf(OPENING);
  if (start < 0) return { present: false };
  const end = flat.indexOf(CLOSING, start);
  if (end < 0) return { present: true, span: flat.slice(start) };
  return { present: true, span: flat.slice(start, end + CLOSING.length) };
}

export function checkDurabilityWording(root) {
  const failures = [];
  for (const file of FILES) {
    const found = coreSpan(readFileSync(join(root, file.path), 'utf8'));
    if (!found.present) {
      failures.push(`${file.name} does not carry the durability sentences`);
    } else if (found.span !== CORE) {
      failures.push(`${file.name} states the durability rule in different words`);
    }
  }
  return failures;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const failures = checkDurabilityWording(process.cwd());
    if (failures.length) {
      for (const failure of failures) console.error(failure);
      process.exitCode = 1;
    } else {
      console.log(`Durability wording is identical in all ${FILES.length} files that make the claim.`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
