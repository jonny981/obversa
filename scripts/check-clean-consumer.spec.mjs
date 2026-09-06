import assert from 'node:assert/strict';
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
