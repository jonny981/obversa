import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const script = new URL('./check-docs-versions.mjs', import.meta.url);

test('docs versions follow each package manifest, including plugins', () => {
  const root = mkdtempSync(join(tmpdir(), 'obversa-docs-versions-'));
  try {
    writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n  - 'plugins/*'\n");
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts/publish-allowlist.json'), JSON.stringify({ packages: ['@obversa/runtime', '@obversa/memory-git'] }));
    mkdirSync(join(root, 'docs/public'), { recursive: true });
    for (const [directory, name, version] of [
      ['packages/runtime', '@obversa/runtime', '1.2.3'],
      ['plugins/memory-git', '@obversa/memory-git', '0.4.5'],
    ]) {
      mkdirSync(join(root, directory), { recursive: true });
      writeFileSync(join(root, directory, 'package.json'), JSON.stringify({ name, version }));
    }
    const page = join(root, 'docs/public/index.mdx');
    const table = '## Packages\n\n| Package | Purpose | Version |\n| --- | --- | --- |\n'
      + '| `@obversa/runtime` | Runtime | `1.2.3` |\n'
      + '| `@obversa/memory-git` | Memory | `0.4.5` |\n';
    const forms = [
      (text) => text,
      (text) => text.replace(/^\|/gm, ''),
      (text) => text.replace(/\|$/gm, ''),
      (text) => text.replace(/^\||\|$/gm, ''),
    ];
    const run = () => spawnSync(process.execPath, [script.pathname], { cwd: root, encoding: 'utf8' });
    for (const form of forms) {
      writeFileSync(page, form(table));
      const valid = run();
      assert.equal(valid.status, 0, valid.stderr);
    }

    writeFileSync(join(root, 'plugins/memory-git/package.json'), JSON.stringify({ name: '@obversa/memory-git', version: '0.4.6' }));
    for (const form of forms) {
      writeFileSync(page, form(table));
      const stale = run();
      assert.equal(stale.status, 1);
      assert.match(stale.stderr, /@obversa\/memory-git.*0\.4\.5.*0\.4\.6/);
    }

    writeFileSync(page, table.replace('0.4.5', '0.4.6'));
    assert.equal(run().status, 0);
    writeFileSync(page, table.replace('0.4.5', '0.4.6').replace('| `@obversa/runtime`', ' | `@obversa/runtime`').replace('1.2.3', '9.9.9'));
    const indented = run();
    assert.equal(indented.status, 1);
    assert.match(indented.stderr, /@obversa\/runtime.*9\.9\.9.*1\.2\.3/);
    writeFileSync(page, table.replace('@obversa/memory-git', '@obversa/unknown'));
    assert.match(run().stderr, /@obversa\/unknown.*manifest/);
    writeFileSync(page, '## Packages\n');
    assert.match(run().stderr, /package table.*missing/i);

    const dropped = '## Packages\n\n| Package | Purpose | Version |\n| --- | --- | --- |\n'
      + '| `@obversa/runtime` | Runtime | `1.2.3` |\n';
    writeFileSync(page, dropped);
    const missingRow = run();
    assert.equal(missingRow.status, 1);
    assert.match(missingRow.stderr, /@obversa\/memory-git.*homepage row/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
