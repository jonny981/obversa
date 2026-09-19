import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = join(root, 'scripts/check-documented-imports.mjs');
const page = join(root, 'docs/public/packages/runtime.mdx');

/** Run the check with one page temporarily carrying an extra import. */
function withPlantedImport(line) {
  const original = readFileSync(page, 'utf8');
  writeFileSync(page, `${original}\n\`\`\`ts\n${line}\n\`\`\`\n`);
  try {
    execFileSync('node', [check], { cwd: root, encoding: 'utf8' });
    return { failed: false, output: '' };
  } catch (error) {
    return { failed: true, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  } finally {
    writeFileSync(page, original);
  }
}

test('the documented imports resolve as the tree stands', () => {
  const output = execFileSync('node', [check], { cwd: root, encoding: 'utf8' });
  assert.match(output, /Every documented import resolves/);
});

// The check exists because check:public-surface passed while eight pages
// published an import of a name the package had never exported. A check that
// has never been seen to fail is the thing that let that through, so these
// two say what makes this one go red.
test('a documented name the package does not provide fails, and is named', () => {
  const { failed, output } = withPlantedImport("import { thisNameIsNotExported } from '@obversa/runtime';");
  assert.equal(failed, true, 'the check must reject a name nothing exports');
  assert.match(output, /does not provide thisNameIsNotExported/);
  assert.match(output, /runtime\.mdx/, 'the page is named');
});

test('a documented package that does not exist fails, and is named', () => {
  const { failed, output } = withPlantedImport("import { anything } from '@obversa/not-a-package';");
  assert.equal(failed, true, 'the check must reject a package nothing provides');
  assert.match(output, /no package in this repository provides @obversa\/not-a-package/);
});

// The two holes the gate found. Both let the check report success on a page
// that tells a reader to import something it cannot get.
test('a DOUBLE-quoted import is seen, not skipped', () => {
  const { failed, output } = withPlantedImport('import { thisNameIsNotExported } from "@obversa/runtime";');
  assert.equal(failed, true, 'a double-quoted import was invisible, so any name passed');
  assert.match(output, /does not provide thisNameIsNotExported/);
});

test('a name declared in a sibling file but never exported through the entry fails', () => {
  // Deciding by joining every declaration in the directory asked whether a
  // name was declared NEARBY. `Awaitable` is declared in the runtime's own
  // dist declarations and is NOT among the 392 names its entry exports, so
  // the old check accepted it and this one must not. The first name I chose
  // here, renderEvent, passed against the old check too and therefore proved
  // nothing: it is private and appears in no declaration at all.
  const { failed, output } = withPlantedImport("import type { Awaitable } from '@obversa/runtime';");
  assert.equal(failed, true, 'being declared somewhere in the package is not being exported');
  assert.match(output, /does not provide Awaitable/);
});

// The third finding, from correctness. @obversa/runtime and
// @obversa/runtime/testing declare into the same dist folder, so joining that
// folder made every name on either path look exported by both. The entry's own
// export graph keeps them apart: /testing exports 35 names and the main entry
// exports 392, and not one of the 35 is among them.
test('a name exported only by a subpath is not accepted from the main entry', () => {
  const { failed, output } = withPlantedImport("import type { EngineConformanceReport } from '@obversa/runtime';");
  assert.equal(failed, true, 'sharing a types folder is not sharing an export');
  assert.match(output, /does not provide EngineConformanceReport/);
});

test('and that same name still resolves from the subpath that does export it', () => {
  const { failed, output } = withPlantedImport("import type { EngineConformanceReport } from '@obversa/runtime/testing';");
  assert.equal(failed, false, `the subpath genuinely exports it: ${output}`);
});

test('a type re-exported from a sibling declaration still resolves', () => {
  // TeamSeat is declared in api's contracts.d.ts and reaches the entry through
  // `export *`. Reading the entry alone reported it missing, which would have
  // failed a page that is correct.
  const { failed, output } = withPlantedImport("import type { TeamSeat } from '@obversa/api';");
  assert.equal(failed, false, `a re-exported type must resolve: ${output}`);
});
