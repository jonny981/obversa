#!/usr/bin/env node
// Fail the build if the change names a no-go from the pitch, or the scope
// file is empty. Usage: node tools/check-build.mjs <pitch id>
import { readFileSync } from 'node:fs';

const [pitchId] = process.argv.slice(2);
const pitch = readFileSync(`pitches/${pitchId}.md`, 'utf8');
const change = readFileSync(`build/${pitchId}/change.md`, 'utf8').toLowerCase();
const scope = readFileSync(`build/${pitchId}/scope.md`, 'utf8').trim();

const noGos = (pitch.split(/^## No-gos\s*$/m)[1] ?? '')
  .split('\n')
  .map((line) => line.replace(/^-\s*/, '').trim().toLowerCase())
  .filter(Boolean)
  .map((line) => line.split(/[.:(]/)[0].trim());
const named = noGos.filter((noGo) => noGo && change.includes(noGo));

if (scope.length === 0) {
  console.error(`build/${pitchId}/scope.md is empty; something is always cut`);
  process.exit(1);
}
if (named.length > 0) {
  console.error(`the change names a no-go: ${named.join('; ')}`);
  process.exit(1);
}
console.log(`inside the appetite: no no-go named, scope written (${scope.split('\n').length} lines)`);
