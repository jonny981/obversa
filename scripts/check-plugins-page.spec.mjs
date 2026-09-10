import assert from 'node:assert/strict';
import test from 'node:test';

import { checkPluginsPage } from './check-plugins-page.mjs';

const front = (description) => `---\ntitle: "Plugins and tools"\ndescription: "${description}"\n---\n\n`;

const goodRow = (name) => `- **${name}.** \`@obversa/${name}\` runs one thing. A reader needs\n  Node.js 22.12 or later. Home: [example.com](https://example.com).\n`;
const seeRow = (name) => `- **${name}.** \`@obversa/${name}\` runs one thing. A reader needs\n  Node.js 22.12 or later. See [The page](/packages/${name}).\n`;

test('a page whose every row meets the contract passes', () => {
  const document = front('One row per tool.') + '\n' + goodRow('one') + goodRow('two');
  assert.deepEqual(checkPluginsPage(document), []);
});

test('the description fails on a digit', () => {
  const document = front('One row per tool, 6 engines.') + '\n' + goodRow('one') + goodRow('two');
  assert.ok(checkPluginsPage(document).some((f) => f.includes('digit')));
});

test('the description fails on a list of kinds', () => {
  const document = front('One row per tool: engines, memory, and hosts.') + '\n' + goodRow('one') + goodRow('two');
  assert.ok(checkPluginsPage(document).some((f) => f.includes('lists kinds')));
});

test('a row without an install sentence fails', () => {
  const row = '- **one.** `@obversa/one` runs one thing. Home: [example.com](https://example.com).\n';
  const document = front('One row per tool.') + '\n' + row + goodRow('two');
  assert.ok(checkPluginsPage(document).some((f) => f === 'one: the row does not say what a reader must have installed'));
});

test('a row without a home link fails', () => {
  const row = '- **one.** `@obversa/one` runs one thing. A reader needs Node.js 22.12 or later.\n';
  const document = front('One row per tool.') + '\n' + row + goodRow('two');
  assert.ok(checkPluginsPage(document).some((f) => f === 'one: the row does not link the tool\'s own home'));
});

test('a row that names only the tool fails', () => {
  const row = '- **one.**\n';
  const document = front('One row per tool.') + '\n' + row + goodRow('two');
  assert.ok(checkPluginsPage(document).some((f) => f === 'one: the row does not say what the tool is'));
});

test('a See link counts as a home', () => {
  const document = front('One row per tool.') + '\n' + seeRow('one') + seeRow('two');
  assert.deepEqual(checkPluginsPage(document), []);
});

test('a wrapped sentence still reads as one line', () => {
  const row = '- **one.** `@obversa/one` runs one thing. A reader needs\n  Node.js 22.12 or later and a working tool. Home:\n  [example.com](https://example.com).\n';
  const document = front('One row per tool.') + '\n' + row + goodRow('two');
  assert.deepEqual(checkPluginsPage(document), []);
});
