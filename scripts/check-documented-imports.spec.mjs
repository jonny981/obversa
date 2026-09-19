import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// These exercise command dispatch and diagnostics, including behaviours already supported.
for (const fixture of [
  {
    name: 'missing package',
    line: "import { available } from '@obversa/not-a-package';",
    reason: 'no package in this repository provides @obversa/not-a-package',
  },
  {
    name: 'unexported package path',
    line: "import { available } from '@obversa/example/private';",
    reason: '@obversa/example/private is not an export path of that package',
  },
  {
    name: 'missing declaration output',
    line: "import { available } from '@obversa/example';",
    built: false,
    reason: '@obversa/example is not built; run the build first',
  },
  {
    name: 'missing exported name',
    line: "import { missing } from '@obversa/example';",
    reason: '@obversa/example does not provide missing',
  },
  {
    name: 'default import',
    line: "import example from '@obversa/example';",
    reason: '@obversa/example has no default export, so `import example from` cannot work',
  },
  {
    name: 'valid named import',
    line: "import { available } from '@obversa/example';",
  },
]) {
  test(`the real command handles ${fixture.name} in an isolated tree`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'obversa-documented-imports-'));
    try {
      const fixtureCheck = join(directory, 'scripts/check-documented-imports.mjs');
      const fixturePage = join(directory, 'docs/public/case.mdx');
      const packageDir = join(directory, 'packages/example');
      mkdirSync(dirname(fixtureCheck), { recursive: true });
      mkdirSync(dirname(fixturePage), { recursive: true });
      mkdirSync(join(packageDir, 'dist'), { recursive: true });
      // The command derives its root from its own filename; copy it without edits.
      copyFileSync(check, fixtureCheck);
      writeFileSync(fixturePage, `\`\`\`ts\n${fixture.line}\n\`\`\`\n`);
      writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
        name: '@obversa/example',
        exports: { '.': { types: './dist/index.d.ts' } },
      }));
      if (fixture.built !== false) {
        writeFileSync(join(packageDir, 'dist/index.d.ts'), 'export declare const available: number;\n');
      }

      const child = spawnSync(process.execPath, [fixtureCheck], {
        cwd: directory, encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(child.error, undefined);
      assert.equal(child.signal, null);
      assert.equal(child.status, fixture.reason ? 1 : 0, child.stderr || child.stdout);
      if (fixture.reason) {
        assert.ok(child.stderr.includes(`case.mdx:2: ${fixture.reason}`), child.stderr);
        assert.doesNotMatch(child.stdout, /Every documented import resolves/);
      } else {
        assert.equal(child.stderr, '');
        assert.match(child.stdout, /Every documented import resolves: 1 names across 1 pages\./);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
