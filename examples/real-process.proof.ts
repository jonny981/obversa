import assert from 'node:assert/strict';

import { run } from '@obversa/runtime';

import { reportPanel } from './real-process.js';
import { pass, revise, scriptedSeat } from './teams/scripted-engine.js';

const architecture = scriptedSeat('proof-architecture', 'claude', [
  async (request) => {
    assert.match(request.prompt, /Return one JSON object: \{"status":"pass"\|"revise"/);
    return revise('architecture found a defect', 'the proof fixture is red');
  },
]);
const correctness = scriptedSeat('proof-correctness', 'codex', [
  async () => pass('correctness accepted the target'),
]);
const adversary = scriptedSeat('proof-adversary', 'codex', [
  async () => pass('adversary accepted the target'),
]);
const conformance = scriptedSeat('proof-conformance', 'claude', [
  async () => pass('conformance accepted the target'),
]);

const engines = {
  architecture: architecture.engine,
  correctness: correctness.engine,
  adversary: adversary.engine,
  conformance: conformance.engine,
};

const twoOfTwo = await run(
  reportPanel('proof-two-of-two', 'proof-target', 2, engines),
  { cwd: process.cwd() },
);
assert.equal(twoOfTwo.outcome.status, 'fail');

const threeOfFour = await run(
  reportPanel('proof-three-of-four', 'proof-target', 4, engines),
  { cwd: process.cwd() },
);
assert.equal(threeOfFour.outcome.status, 'pass');

console.log(JSON.stringify({
  status: 'pass',
  twoOfTwo: twoOfTwo.outcome.status,
  threeOfFour: threeOfFour.outcome.status,
}, null, 2));
