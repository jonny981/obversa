import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { checkRetiredNames } from './check-retired-names.mjs';

function withTree(files, check) {
  const root = mkdtempSync(join(tmpdir(), 'retired-names-'));
  try {
    for (const directory of ['scripts', 'docs', 'examples', 'packages', 'plugins', 'hosts']) {
      mkdirSync(join(root, directory));
    }
    for (const [file, text] of Object.entries(files)) {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('retired package names fail in imports, filters, JSON, and tarball entries', () => {
  withTree({
    'scripts/import.mjs': "import '@obversa/engine';\n",
    'scripts/run.mjs': "const args = ['--filter', '@obversa/teams'];\n",
    'packages/current/package.json': '{"dependencies":{"@obversa/memory":"workspace:^"}}',
    'scripts/archive.mjs': "const name = 'obversa-source-0.1.0.tgz';\n",
    'scripts/adapter.mjs': "const name = '@obversa/engine-codex';\n",
  }, (root) => {
    const failures = checkRetiredNames(root).join('\n');
    for (const file of ['import.mjs', 'run.mjs', 'package.json', 'archive.mjs', 'adapter.mjs']) {
      assert.match(failures, new RegExp(file.replace('.', '\\.')));
    }
  });
});

test('each retired public name and package directory is covered', () => {
  for (const name of [
    '@obversa/process', '@obversa/teams', '@obversa/engine', '@obversa/memory',
    '@obversa/source', '@obversa/surfacer', '@obversa/engine-codex',
    '@obversa/engine-agent-sdk', '@obversa/surface-decision',
    '@obversa/search-markdown',
  ]) {
    withTree({ 'scripts/name.mjs': JSON.stringify({ dependency: name }) }, (root) => {
      assert.match(checkRetiredNames(root).join('\n'), /scripts\/name\.mjs/, name);
    });
  }
  for (const path of [
    'packages/process', 'packages/teams', 'packages/engine', 'packages/memory',
    'packages/source', 'packages/surfacer', 'plugins/engine-codex',
    'plugins/engine-agent-sdk', 'packages/source/assets/app.js',
    'packages/surface-decision', 'plugins/search-markdown',
  ]) {
    withTree({ 'scripts/path.mjs': JSON.stringify({ cwd: path }) }, (root) => {
      assert.match(checkRetiredNames(root).join('\n'), /scripts\/path\.mjs/, path);
    });
  }
});

test('retired directories fail as full paths, split join operands, or named concatenation operands', () => {
  withTree({
    'scripts/full.mjs': "const path = 'packages/surfacer/src/index.mjs';\n",
    'scripts/split.mjs': "const cwd = join(root, 'packages', 'memory');\n",
    'scripts/page.mjs': "const page = join(root, 'docs', 'public', 'packages', 'process.mdx');\n",
    'scripts/named.mjs': "const parent = 'packages'; const old = 'source'; const cwd = join(root, parent, old);\n",
    'scripts/concat.mjs': "const old = 'process'; const cwd = 'packages/' + old;\n",
  }, (root) => {
    const failures = checkRetiredNames(root).join('\n');
    for (const file of ['full.mjs', 'split.mjs', 'page.mjs', 'named.mjs', 'concat.mjs']) {
      assert.match(failures, new RegExp(file.replace('.', '\\.')));
    }
  });
});

test('escaped regex fixtures still name retired paths', () => {
  withTree({
    'scripts/split-regex.mjs': "assert.match(source, /packages', 'process\\.mdx'/);\n",
    'scripts/escaped-regex.mjs': "assert.match(source, /packages\\/source\\/assets\\/app\\.js/);\n",
  }, (root) => {
    const failures = checkRetiredNames(root).join('\n');
    assert.match(failures, /split-regex\.mjs/);
    assert.match(failures, /escaped-regex\.mjs/);
  });
});

test('normalized text catches literal concatenation and template interpolation', () => {
  withTree({
    'scripts/concat-literals.mjs': "const cwd = 'packages/' + 'source/src';\n",
    'scripts/concat-lines.mjs': "const cwd = 'packages/' +\n  'surfacer/src';\n",
    'scripts/template.mjs': "const cwd = `packages/${'memory'}/package.json`;\n",
    'scripts/dotted-regex.mjs': "assert.match(source, /packages\\.process\\.mdx/);\n",
  }, (root) => {
    const failures = checkRetiredNames(root).join('\n');
    for (const file of ['concat-literals.mjs', 'concat-lines.mjs', 'template.mjs', 'dotted-regex.mjs']) {
      assert.match(failures, new RegExp(file.replace('.', '\\.')));
    }
  });
});

test('a retired name under the released heading is caught, not exempt', () => {
  withTree({
    'CHANGELOG.md': '## [Unreleased]\n\n## [1.0.0] - 2026-09-15\n@obversa/engine\n',
  }, (root) => {
    assert.match(checkRetiredNames(root).join('\n'), /CHANGELOG\.md/);
  });
});

test('only the exact old-page redirects are exempt', () => {
  withTree({
    'docs/public/docs.json': JSON.stringify({
      redirects: [
        { source: '/packages/engine', destination: '/packages/api' },
        { source: '/packages/source', destination: '/packages/surface-diff' },
      ],
    }),
    'CHANGELOG.md': '## [Unreleased]\n\n## [1.0.0] - 2026-09-15\n',
    'docs/public/page.mdx': 'Install @obversa/api.\n',
    'scripts/valid.mjs': "const archive = 'package/assets/app.js'; const plugin = '@obversa/engine-codex-cli';\n",
  }, (root) => assert.deepEqual(checkRetiredNames(root), []));
  withTree({
    'docs/public/docs.json': JSON.stringify({
      redirects: [{ source: '/packages/engine', destination: '/packages/runner' }],
    }),
    'docs/public/page.mdx': 'See /packages/source for setup.\n',
    'CHANGELOG.md': '## [Unreleased]\n@obversa/memory\n\n## [1.0.0] - 2026-09-15\n',
  }, (root) => {
    const failures = checkRetiredNames(root).join('\n');
    assert.match(failures, /docs\/public\/docs\.json/);
    assert.match(failures, /docs\/public\/page\.mdx/);
    assert.match(failures, /CHANGELOG\.md/);
  });
});

test('a planted scratch file is read even before it is tracked by Git', () => {
  withTree({ 'scripts/scratch-retired-name.mjs': "const cwd = join(root, 'packages', 'engine');\n" }, (root) => {
    assert.match(checkRetiredNames(root).join('\n'), /scratch-retired-name\.mjs/);
  });
});

test('workflow, contribution, security, agent link, and changeset files reject retired names', () => {
  withTree({
    '.github/workflows/rename.yml': 'run: pnpm --filter @obversa/memory test\n',
    'CONTRIBUTING.md': 'Build packages/process before contributing.\n',
    'CLAUDE.md': 'Use @obversa/engine in examples.\n',
    'SECURITY.md': 'Inspect packages/source for secrets.\n',
    '.changeset/rename.md': 'Bump @obversa/teams.\n',
  }, (root) => {
    const failures = checkRetiredNames(root).join('\n');
    for (const file of [
      '.github/workflows/rename.yml',
      'CONTRIBUTING.md',
      'CLAUDE.md',
      'SECURITY.md',
      '.changeset/rename.md',
    ]) {
      assert.ok(failures.includes(file), file);
    }
  });
});

test('a file holding two retired names reports both, so one pass fixes both', () => {
  // Reporting the first match only rebuilt the loop this check exists to end:
  // a reader fixes what is printed, runs again, and is told about the next one.
  withTree({
    'examples/two.ts': "import { codex } from '@obversa/engine-codex';\nimport { workflow } from '@obversa/teams';\n",
  }, (root) => {
    const line = checkRetiredNames(root).find((failure) => failure.startsWith('examples/two.ts'));
    assert.ok(line, 'the file is named');
    assert.match(line, /@obversa\/engine-codex/);
    assert.match(line, /@obversa\/teams/);
  });
});

test('the recorded F91 branch name is exempt, but package uses beside it still fail', () => {
  withTree({
    'scripts/stage-merge.mjs': "export const stageBranches = { F91: 'docs/search-markdown-contract' };\n",
  }, (root) => assert.deepEqual(checkRetiredNames(root), []));

  withTree({
    'scripts/stage-merge.mjs': "export const stageBranches = { F91: 'docs/search-markdown-contract' };\nconst packageName = '@obversa/search-markdown';\n",
  }, (root) => assert.match(checkRetiredNames(root).join('\n'), /@obversa\/search-markdown/));
});
