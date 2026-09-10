import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function checkPluginsPage(document) {
  const failures = [];
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(document);
  if (!frontmatter) {
    return ['plugins.mdx has no frontmatter'];
  }
  const description = /description:\s*"([^"]*)"/.exec(frontmatter[1]);
  if (!description) {
    failures.push('plugins.mdx has no description');
  } else {
    const text = description[1];
    if (/[0-9]/.test(text)) {
      failures.push('the description contains a digit; a reader counts the rows themselves');
    }
    if (/:[^"]*,/.test(text)) {
      failures.push('the description lists kinds; the rows below are the list');
    }
  }
  const rows = document
    .split(/\r?\n(?=- \*\*|#)/)
    .map((block) => block.trim())
    .filter((block) => /^- \*\*[^*]+\.\*\*/.test(block));
  if (rows.length < 2) {
    failures.push('plugins.mdx has no tool rows');
    return failures;
  }
  for (const row of rows) {
    const name = /^\*\*([^*]+)\.\*\*/.exec(row.slice(2))?.[1] ?? 'a row';
    const flat = row.replace(/\s+/g, ' ');
    const described = /\*\*[^*]+\.\*\*\s+\S/.test(row.slice(2));
    if (!described) {
      failures.push(`${name}: the row does not say what the tool is`);
    }
    if (!/A reader needs[^.]+\./.test(flat)) {
      failures.push(`${name}: the row does not say what a reader must have installed`);
    }
    const homeLink = /Home:\s*\[[^\]]+\]\([^)]+\)/.test(flat)
      || /See\s+\[[^\]]+\]\([^)]+\)/.test(flat);
    if (!homeLink) {
      failures.push(`${name}: the row does not link the tool's own home`);
    }
  }
  return failures;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const root = process.cwd();
    const document = readFileSync(join(root, 'docs/public/plugins.mdx'), 'utf8');
    const failures = checkPluginsPage(document);
    if (failures.length) {
      for (const failure of failures) console.error(failure);
      process.exitCode = 1;
    } else {
      console.log(`Plugins page rows meet the contract, ${rows(document)} rows checked.`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function rows(document) {
  return document
    .split(/\r?\n(?=- \*\*|#)/)
    .map((block) => block.trim())
    .filter((block) => /^- \*\*[^*]+\.\*\*/.test(block)).length;
}
