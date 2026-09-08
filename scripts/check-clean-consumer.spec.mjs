import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sep } from 'node:path';
import test from 'node:test';
import { checkedAttemptOutput } from './check-clean-consumer.mjs';

const report = Object.fromEntries(['grok', 'opencode'].map((name) => [name, {
  requested: { executable: `${sep}fixtures${sep}${name}-fixture.mjs` },
  effective: { executable: `${sep}fixtures${sep}${name}-fixture.mjs` },
  final: { answer: 42 },
}]));
const display = JSON.parse(JSON.stringify(report, (key, value) => (
  key === 'executable' ? value.split(sep).at(-1) : value
)));

for (const indent of [undefined, 4]) {
  test(`attempt report accepts printed JSON with indentation ${indent ?? 'none'}`, () => {
    const result = checkedAttemptOutput(JSON.stringify(display, null, indent), report);
    assert.deepEqual(result.grok, { requested: {}, effective: {}, final: { answer: 42 } });
    assert.deepEqual(result.opencode, { requested: {}, effective: {}, final: { answer: 42 } });
  });
}

test('attempt report still rejects unsanitized display and relative exported paths', () => {
  assert.throws(() => checkedAttemptOutput(JSON.stringify(report), report));
  assert.throws(() => checkedAttemptOutput(JSON.stringify(display), display));
});

test('clean consumer wires the safe-change production line', async () => {
  const source = await readFile(new URL('./check-clean-consumer.mjs', import.meta.url), 'utf8');
  assert.match(source, /examples', 'safe-change', 'example\.ts'/);
  assert.match(source, /safe-change\.mdx/);
  assert.match(source, /compiledSafeChange/);
});

test('clean consumer wires the feature-delivery production line', async () => {
  const source = await readFile(new URL('./check-clean-consumer.mjs', import.meta.url), 'utf8');
  assert.match(source, /'feature-delivery\.line\.ts',/);
  assert.match(source, /'feature-delivery\.mdx'/);
  assert.match(source, /feature-delivery\.deny\.line\.ts/);
  assert.match(source, /feature-delivery\.red\.line\.ts/);
  assert.match(source, /featureLine\.acceptedKickbacks !== 1/);
  assert.doesNotMatch(source, /recordEvents !== \d+/);
});
