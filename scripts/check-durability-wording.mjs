import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CORE = 'Steps that finished are never repeated. A step that was mid-flight when the worker died runs again only if its binding declares it safe to retry; otherwise the run pauses and asks a person to reconcile it before it continues, so uncertain work is never repeated silently.';

function coreSpan(text) {
  const flat = text.replace(/\s+/g, ' ');
  const start = flat.indexOf('Steps that finished are never repeated.');
  if (start < 0) return undefined;
  const end = flat.indexOf('never repeated silently.', start);
  if (end < 0) return undefined;
  return flat.slice(start, end + 'never repeated silently.'.length);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const root = process.cwd();
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const page = readFileSync(join(root, 'docs/public/recording/how-a-run-is-recorded.mdx'), 'utf8');
    const failures = [];
    const readmeSpan = coreSpan(readme);
    const pageSpan = coreSpan(page);
    if (readmeSpan === undefined) {
      failures.push('README.md does not carry the durability sentences');
    }
    if (pageSpan === undefined) {
      failures.push('the record page does not carry the durability sentences');
    }
    if (readmeSpan !== undefined && pageSpan !== undefined && readmeSpan !== pageSpan) {
      failures.push('the README and the record page state the durability rule differently');
    }
    if (readmeSpan !== undefined && readmeSpan !== CORE) {
      failures.push('the README durability sentences do not match the ruled wording');
    }
    if (failures.length) {
      for (const failure of failures) console.error(failure);
      process.exitCode = 1;
    } else {
      console.log('Durability wording is identical in the README and the record page.');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
