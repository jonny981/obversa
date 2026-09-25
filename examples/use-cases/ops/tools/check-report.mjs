#!/usr/bin/env node
// Fail unless every incident id in report/facts.md appears in report/draft.md.
import { readFileSync } from 'node:fs';

const facts = readFileSync('report/facts.md', 'utf8');
const draft = readFileSync('report/draft.md', 'utf8');
const ids = [...new Set(facts.match(/INC-\d+/g) ?? [])];
const missing = ids.filter((id) => !draft.includes(id));
if (ids.length === 0) {
  console.error('the facts file names no incidents');
  process.exit(1);
}
if (missing.length > 0) {
  console.error(`the draft does not mention: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`every incident is in the draft: ${ids.join(', ')}`);
