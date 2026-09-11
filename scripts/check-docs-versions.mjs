import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listWorkspacePackages, readAllowlist } from './check-publish-allowlist.mjs';

try {
  const root = process.cwd();
  const document = readFileSync(join(root, 'docs/public/index.mdx'), 'utf8');
  const section = document.split(/^## Packages\s*$/m)[1]?.split(/^## /m)[0] ?? '';
  const rows = section.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes('|'))
    .slice(2)
    .map((line) => line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim().replace(/^`|`$/g, '')));
  if (rows.length === 0) throw new Error('docs/public/index.mdx package table is missing');
  const packages = listWorkspacePackages(root);
  const named = new Set();
  for (const row of rows) {
    if (row.length !== 3) throw new Error('docs/public/index.mdx package table must have three columns');
    const [name, , documentedVersion] = row;
    named.add(name);
    const definition = packages.find((entry) => entry.name === name);
    if (!definition) throw new Error(`${name}: package table has no workspace manifest`);
    const manifest = JSON.parse(readFileSync(join(root, definition.dir, 'package.json'), 'utf8'));
    if (documentedVersion !== manifest.version) {
      throw new Error(`${name}: docs version ${documentedVersion} does not match manifest version ${manifest.version}`);
    }
  }
  // Completeness: every publishable package needs a homepage row, or a version
  // drift slips past the check the way the D15 residual did.
  for (const name of readAllowlist(join(root, 'scripts', 'publish-allowlist.json'))) {
    if (!named.has(name)) throw new Error(`${name}: publishable but has no homepage row`);
  }
  console.log(`Documentation package versions match ${rows.length} manifests.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
