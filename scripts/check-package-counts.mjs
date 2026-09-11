import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
];

function numberWord(number) {
  return NUMBER_WORDS[number] ?? String(number);
}

function directoryCount(root, directory) {
  return readdirSync(join(root, directory), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .length;
}

function oneLine(text) {
  return text.replace(/\s+/g, ' ');
}

function pathWithOptionalMarkdownTicks(path) {
  return `(?:\x60)?${path}/(?:\x60)?`;
}

export function checkPackageCounts(root = ROOT) {
  const allowlist = JSON.parse(readFileSync(join(root, 'scripts/publish-allowlist.json'), 'utf8'));
  if (!Array.isArray(allowlist.packages)) {
    return ['scripts/publish-allowlist.json must contain a packages array'];
  }

  const total = allowlist.packages.length;
  const packageCount = directoryCount(root, 'packages');
  const pluginCount = directoryCount(root, 'plugins');
  const packagesWord = numberWord(packageCount);
  const pluginsWord = numberWord(pluginCount);
  const readme = oneLine(readFileSync(join(root, 'README.md'), 'utf8'));
  const releasing = oneLine(readFileSync(join(root, 'docs/RELEASING.md'), 'utf8'));
  const failures = [];

  if (total !== packageCount + pluginCount) {
    failures.push(`publish allowlist has ${total} names, but packages/ and plugins/ contain ${packageCount + pluginCount} package directories`);
  }
  if (!new RegExp(`\\b${total} publishable packages\\.`).test(readme)) {
    failures.push(`README.md must say ${total} publishable packages`);
  }
  if (!new RegExp(`${pathWithOptionalMarkdownTicks('packages')} holds the ${packagesWord} that define the product:`, 'i').test(readme)) {
    failures.push(`README.md must say packages/ holds the ${packagesWord} packages`);
  }
  if (!new RegExp(`${pathWithOptionalMarkdownTicks('plugins')} holds the ${pluginsWord} adapters:`, 'i').test(readme)) {
    failures.push(`README.md must say plugins/ holds the ${pluginsWord} adapters`);
  }
  if (!new RegExp(`\\(${total} packages\\)`).test(releasing)) {
    failures.push(`docs/RELEASING.md must say ${total} packages`);
  }
  if (!new RegExp(`${packagesWord} public packages use ${pathWithOptionalMarkdownTicks('packages')}<name>(?:\x60)?; ${pluginsWord} plugin packages use ${pathWithOptionalMarkdownTicks('plugins')}<name>(?:\x60)?`, 'i').test(releasing)) {
    failures.push(`docs/RELEASING.md must say ${packagesWord} public packages and ${pluginsWord} plugin packages`);
  }

  return failures;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const failures = checkPackageCounts();
  if (failures.length) {
    console.error(failures.map((failure) => `package count check: ${failure}`).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('package count check passed');
  }
}
