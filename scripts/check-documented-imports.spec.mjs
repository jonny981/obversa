import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { failuresIn } from './check-documented-imports.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = join(root, 'scripts/check-documented-imports.mjs');
const page = join(root, 'docs/public/packages/runtime.mdx');

/**
 * The failures a page would have if it also carried this import.
 *
 * The page is read and the line appended IN MEMORY. An earlier version wrote
 * the line into the tracked page and restored it in a finally, which leaves a
 * published page corrupted in the worktree if the run is killed between the
 * two, on a machine where chains and gates run back to back.
 */
function withPlantedImport(line) {
  const original = readFileSync(page, 'utf8');
  const output = failuresIn('packages/runtime.mdx', `${original}\n\`\`\`ts\n${line}\n\`\`\`\n`).join('\n');
  assert.equal(readFileSync(page, 'utf8'), original, 'the test must not touch the page on disk');
  return { failed: output.length > 0, output };
}

test('the documented imports resolve as the tree stands', () => {
  const output = execFileSync('node', [check], { cwd: root, encoding: 'utf8' });
  assert.match(output, /Every documented import resolves/);
});

// The check exists because check:public-surface passed while eight pages
// published an import of a name the package had never exported. A check that
// has never been seen to fail is the thing that let that through.
test('a documented name the package does not provide fails, and is named', () => {
  const { failed, output } = withPlantedImport("import { thisNameIsNotExported } from '@obversa/runtime';");
  assert.equal(failed, true);
  assert.match(output, /does not provide thisNameIsNotExported/);
  assert.match(output, /runtime\.mdx/, 'the page is named');
});

test('a documented package that does not exist fails, and is named', () => {
  const { failed, output } = withPlantedImport("import { anything } from '@obversa/not-a-package';");
  assert.equal(failed, true);
  assert.match(output, /no package in this repository provides @obversa\/not-a-package/);
});

test('a DOUBLE-quoted import is seen, not skipped', () => {
  const { failed, output } = withPlantedImport('import { thisNameIsNotExported } from "@obversa/runtime";');
  assert.equal(failed, true, 'a double-quoted import was invisible, so any name passed');
  assert.match(output, /does not provide thisNameIsNotExported/);
});

test('a name declared in a sibling file but never exported through the entry fails', () => {
  // `Awaitable` is declared in the runtime's own declarations and is NOT among
  // the names its entry exports. Deciding by joining every declaration in the
  // folder accepted it. The first name tried here was a private function that
  // appears in no declaration at all, so it passed against the old check too
  // and proved nothing.
  const { failed, output } = withPlantedImport("import type { Awaitable } from '@obversa/runtime';");
  assert.equal(failed, true, 'being declared somewhere in the package is not being exported');
  assert.match(output, /does not provide Awaitable/);
});

test('a name exported only by a subpath is not accepted from the main entry', () => {
  const { failed, output } = withPlantedImport("import type { EngineConformanceReport } from '@obversa/runtime';");
  assert.equal(failed, true, 'sharing a types folder is not sharing an export');
  assert.match(output, /does not provide EngineConformanceReport/);
});

test('and that same name still resolves from the subpath that does export it', () => {
  const { failed, output } = withPlantedImport("import type { EngineConformanceReport } from '@obversa/runtime/testing';");
  assert.equal(failed, false, `the subpath genuinely exports it: ${output}`);
});

test('a default import fails, because no package here has a default export', () => {
  const { failed, output } = withPlantedImport("import runtime from '@obversa/runtime';");
  assert.equal(failed, true, 'a default import slipped past the named-import pattern entirely');
  assert.match(output, /has no default export/);
});

test('a namespace import is left alone, because it is legitimate', () => {
  // `import * as x` works for any module, and which names a page uses off it
  // cannot be known without parsing the page's code. A known limit, not a
  // hole: failing it would refuse an honest page.
  const { failed, output } = withPlantedImport("import * as runtime from '@obversa/runtime';");
  assert.equal(failed, false, `a namespace import is valid and must pass: ${output}`);
});

test('a type re-exported from a sibling declaration still resolves', () => {
  const { failed, output } = withPlantedImport("import type { TeamSeat } from '@obversa/api';");
  assert.equal(failed, false, `a re-exported type must resolve: ${output}`);
});
