// F66's unambiguous rename pass. Move workflow exports before applying it.
// Usage: node scripts/f66-rename.mjs --check | --apply
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const mode = process.argv[2];
if (!['--check', '--apply'].includes(mode)) throw new Error('use --check or --apply');
const root = process.cwd();
const branch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim();
if (branch !== 'feat/api-polish') throw new Error(`expected feat/api-polish, got ${branch}`);
if (existsSync(join(root, 'packages/process')) || !existsSync(join(root, 'packages/core'))) {
  throw new Error('move packages/process to packages/core before this pass');
}
const moves = [
  ['packages/teams', 'packages/builtin-workflows'],
  ['docs/public/packages/teams.mdx', 'docs/public/packages/builtin-workflows.mdx'],
  ['docs/public/packages/process.mdx', 'docs/public/packages/core.mdx'],
  ['docs/public/packages/surfacer.mdx', 'docs/public/packages/surface-decision.mdx'],
  ['docs/public/packages/engine-codex.mdx', 'docs/public/packages/engine-codex-cli.mdx'],
  ['docs/public/packages/engine-agent-sdk.mdx', 'docs/public/packages/engine-claude-agent-sdk.mdx'],
];
const names = new Map([
  ['@obversa/process', '@obversa/core'],
  ['@obversa/teams', '@obversa/builtin-workflows'],
  ['@obversa/surfacer', '@obversa/surface-decision'],
  ['@obversa/source', '@obversa/surface-diff'],
  ['@obversa/engine-codex', '@obversa/engine-codex-cli'],
  ['@obversa/engine-agent-sdk', '@obversa/engine-claude-agent-sdk'],
]);
const paths = new Map([
  ['packages/process', 'packages/core'],
  ['packages/surfacer', 'packages/surface-decision'],
  ['packages/source', 'packages/surface-diff'],
  ['plugins/engine-codex', 'plugins/engine-codex-cli'],
  ['plugins/engine-agent-sdk', 'plugins/engine-claude-agent-sdk'],
  ...moves.filter(([from]) => !from.endsWith('.mdx')),
]);
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const oldName = new RegExp(`(?:${[...names.keys()].map(escaped).join('|')})(?![A-Za-z0-9-])`, 'g');
const oldPath = new RegExp(`(?:${[...paths.keys()].map(escaped).join('|')})(?![A-Za-z0-9-])`, 'g');
const pageRoutes = new Map([
  ['packages/engine-codex', 'packages/engine-codex-cli'],
  ['packages/engine-agent-sdk', 'packages/engine-claude-agent-sdk'],
]);
const oldPageRoute = new RegExp(`(?:${[...pageRoutes.keys()].map(escaped).join('|')})(?![A-Za-z0-9-])`, 'g');

// This pass changes package spellings in code and manifests. Reader prose,
// historical release text, negative fixtures and the API/core split need a
// separate source review against the accepted symbol map.
const mayRewrite = (file) =>
  (/^(?:packages|plugins|hosts|examples|scripts)\//.test(file) ||
    ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.dependency-cruiser.cjs', 'docs/public/docs.json'].includes(file)) &&
  /\.(?:ts|mts|mjs|cjs|js|json|yaml)$/.test(file) &&
  !/\.spec\.|\/fixtures\//.test(file) &&
  !/f66-rename\.mjs$/.test(file);

for (const [from, to] of moves) {
  if (!existsSync(join(root, from)) || existsSync(join(root, to))) {
    throw new Error(`expected ${from} to exist and ${to} to be absent`);
  }
}
const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
const rewrites = files.filter(mayRewrite).flatMap((file) => {
  const original = readFileSync(join(root, file), 'utf8');
  let changed = original
    .replace(oldName, (match) => names.get(match))
    .replace(oldPath, (match) => paths.get(match));
  if (file === 'docs/public/docs.json') changed = changed.replace(oldPageRoute, (match) => pageRoutes.get(match));
  if (file === 'pnpm-lock.yaml') {
    for (const [from, to] of paths) {
      const link = new RegExp(`(link:(?:\\.\\./)+)${escaped(from.split('/').at(-1))}(?![A-Za-z0-9-])`, 'g');
      changed = changed.replace(link, (_, prefix) => prefix + to.split('/').at(-1));
    }
  }
  return original === changed ? [] : [{ file, changed }];
});
const deferred = files.filter((file) => !mayRewrite(file) && /\.(?:ts|mts|mjs|cjs|js|json|yaml|md|mdx)$/.test(file))
  .filter((file) => {
    const source = readFileSync(join(root, file), 'utf8');
    return [...names.keys(), ...paths.keys()].some((name) => source.includes(name));
  });
console.log(`${moves.length} moves, ${rewrites.length} package-reference files`);
for (const [from, to] of moves) console.log(`move ${from} -> ${to}`);
for (const { file } of rewrites) console.log(`rewrite ${file}`);
console.log(`${deferred.length} files need a content review or contain deliberate old-name fixtures`);
for (const file of deferred) console.log(`review ${file}`);
if (mode === '--apply') {
  const workflowIndex = readFileSync(join(root, 'packages/teams/src/index.ts'), 'utf8');
  if (/\b(?:workflow|stage|person|fromFile)\b/.test(workflowIndex)) {
    throw new Error('move general workflow exports into runtime before renaming teams');
  }
  for (const [from, to] of moves) renameSync(join(root, from), join(root, to));
  for (const { file, changed } of rewrites) {
    const moved = moves.find(([from]) => file === from || file.startsWith(`${from}/`));
    writeFileSync(join(root, moved ? moved[1] + file.slice(moved[0].length) : file), changed);
  }
}
