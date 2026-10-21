#!/usr/bin/env node
/**
 * Tune the judge's confidence cut-offs against labelled findings.
 *
 * Usage:
 *   node tools/calibrate-judge.mjs <labelled.jsonl> [--dry-run]
 *     [--endpoint URL] [--model ID] [--batch-chars N]
 *
 * Each line of the JSONL file is one labelled finding:
 *   {"finding": {"severity": "should-fix", "evidence": "...", "recommendation": "..."},
 *    "context": {"useCase": "...", "brief": "...", "diff": "..."},
 *    "label": {"impactful": true, "sendBack": true}}
 *
 * `label.impactful` is whether the finding truly is impactful; `label.sendBack`
 * is whether a person would send it back to the builder.
 *
 * The tool asks each finding's score question — the same `findingQuestions`
 * the runtime asks — batched the way the runtime batches a round's questions:
 * one request per group of findings, each request under the runtime's packet
 * size bound. It prints, for each candidate send-back cut-off, how many
 * findings would be sent back wrongly, held back wrongly, or handed to a
 * person. A finding under the hand-off bar goes to a person whatever the
 * send-back cut-off is.
 *
 * `--dry-run` makes no call: it prints the planned requests, the first three
 * request bodies, and an estimate of their input tokens (characters over
 * four). The key comes from
 * `TYPESAFE_API_KEY` and the endpoint from `TYPESAFE_ENDPOINT` or `--endpoint`;
 * the key is never written anywhere.
 */
import { readFileSync, writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function usage(message) {
  console.error(`calibrate-judge: ${message}\n  usage: node tools/calibrate-judge.mjs <labelled.jsonl> [--dry-run] [--endpoint URL] [--model ID] [--batch-chars N]`);
  process.exit(2);
}

const args = process.argv.slice(2);
const flags = { dryRun: false, endpoint: undefined, model: undefined, batchChars: 50_000 };
let file;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--dry-run') flags.dryRun = true;
  else if (arg === '--endpoint') flags.endpoint = args[++index];
  else if (arg === '--model') flags.model = args[++index];
  else if (arg === '--batch-chars') flags.batchChars = Number(args[++index]);
  else if (arg.startsWith('--')) usage(`unknown flag ${arg}`);
  else if (file === undefined) file = arg;
  else usage(`unexpected argument ${arg}`);
}
if (file === undefined) usage('no labelled JSONL file given');
if (!Number.isSafeInteger(flags.batchChars) || flags.batchChars < 1_000) usage('--batch-chars must be a whole number of characters, 1000 or more');

// The questions and the bars come from the built runtime, so the tool asks
// exactly what the judge asks. Run `pnpm build` first.
let findingQuestions, FINDING_LEVELS, JUDGE_CONFIDENCE;
try {
  ({ findingQuestions, FINDING_LEVELS, JUDGE_CONFIDENCE } = await import(
    pathToFileURL(resolve(here, '../packages/runtime/dist/api.js')).href
  ));
} catch (error) {
  console.error(`calibrate-judge: could not load the built runtime (${error.message}). Run pnpm build first.`);
  process.exit(2);
}

const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
const labelled = lines.map((line, index) => {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    usage(`line ${index + 1} is not JSON`);
  }
  const { finding, context, label } = entry;
  if (finding === null || typeof finding !== 'object' || typeof finding.evidence !== 'string') {
    usage(`line ${index + 1} needs finding.evidence`);
  }
  if (label === null || typeof label !== 'object' || typeof label.impactful !== 'boolean' || typeof label.sendBack !== 'boolean') {
    usage(`line ${index + 1} needs label.impactful and label.sendBack as booleans`);
  }
  return { finding, context: context ?? {}, label, line: index + 1 };
});
if (labelled.length === 0) usage('the file holds no labelled findings');

// Group findings into requests the way the runtime batches a round's
// questions: one call carrying every question of the batch, with each
// finding's own context — use case, brief lines and diff — in its
// `how.findings` entry. A batch stays under the packet size bound the
// runtime enforces.
function batchRequest(batch) {
  const state = {
    why: {},
    how: {
      findings: batch.map(({ finding, context }, index) => ({
        id: `finding-${index + 1}`,
        ...finding,
        ...(context.useCase !== undefined ? { useCase: context.useCase } : {}),
        ...(context.brief !== undefined ? { brief: context.brief } : {}),
        ...(context.diff !== undefined ? { diff: context.diff } : {}),
      })),
    },
    when: { round: 1, openFindings: batch.length },
  };
  const questions = findingQuestions(batch.map(({ finding }) => finding));
  return { model: flags.model ?? 'jev-latest', state, questions };
}

const batches = [];
for (const entry of labelled) {
  let batch = batches.at(-1);
  if (batch === undefined || JSON.stringify(batchRequest([...batch, entry])).length > flags.batchChars) {
    batch = [];
    batches.push(batch);
  }
  batch.push(entry);
}

const requests = batches.map(batchRequest);
const tokensOf = (request) => Math.ceil(JSON.stringify(request).length / 4);
// Written straight to stdout: `process.exit` below would lose lines still
// buffered on a pipe.
const say = (line) => writeSync(1, `${line}\n`);
requests.forEach((request, index) => {
  const chars = JSON.stringify(request).length;
  say(`request ${index + 1}: ${batches[index].length} findings, ${chars} characters, ~${tokensOf(request)} input tokens, questions: ${Object.keys(request.questions).join(', ')}`);
});
if (flags.dryRun) {
  for (const [index, request] of requests.slice(0, 3).entries()) {
    say(`request ${index + 1} body:`);
    say(JSON.stringify(request, null, 2));
  }
}
say(`${requests.length} request(s) for ${labelled.length} labelled findings`);
if (flags.dryRun) say(`input tokens: ${requests.reduce((total, request) => total + tokensOf(request), 0)}`);

if (flags.dryRun) process.exit(0);

const endpoint = flags.endpoint ?? process.env.TYPESAFE_ENDPOINT;
const key = process.env.TYPESAFE_API_KEY;
if (endpoint === undefined || endpoint === '') usage('no endpoint: set TYPESAFE_ENDPOINT or pass --endpoint');
if (key === undefined || key === '') usage('no key: set TYPESAFE_API_KEY');

// One answers object per request, kept with its batch: answers come back
// keyed finding-N inside their own batch, so a later request's finding-1 is
// a different answer from an earlier one's.
const answered = [];
for (const [index, request] of requests.entries()) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  const text = await response.text();
  if (!response.ok) {
    console.error(`calibrate-judge: request ${index + 1} failed with ${response.status}: ${text.slice(0, 200)}`);
    process.exit(1);
  }
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || parsed.answers === null || typeof parsed.answers !== 'object') {
    console.error(`calibrate-judge: request ${index + 1} returned no answers object`);
    process.exit(1);
  }
  answered.push(parsed.answers);
}

// How sure an answer is, in [0,1] — the same reading the runtime gives it:
// the reported confidence wins, a probability spread's confidence is the
// share on the top option, and an answer carrying neither reads 0.
function answerConfidence(answer) {
  const reported = answer?.confidence;
  if (typeof reported === 'number' && Number.isFinite(reported) && reported >= 0 && reported <= 1) return reported;
  const given = answer?.probabilities;
  if (given === undefined || given === null) return 0;
  const shares = Array.isArray(given)
    ? given.map((entry) => entry?.probability)
    : Object.values(given);
  return shares.reduce((top, share) =>
    typeof share === 'number' && Number.isFinite(share) && share >= 0 && share <= 1 && share > top ? share : top, 0);
}

// The level a score lands on, and the confidence the answer carries — the
// same reading the runtime gives it: its reported score wins, else the
// weighted level index over the named criteria's probabilities.
function callOf(question, answer) {
  if (question?.type !== 'score' || answer === null || typeof answer !== 'object') return undefined;
  const levels = question.criteria;
  let score;
  if (typeof answer.score === 'number' && Number.isFinite(answer.score)) score = answer.score;
  else {
    const given = answer.probabilities;
    if (Array.isArray(given)) {
      let weight = 0, total = 0;
      for (const entry of given) {
        const index = entry !== null && typeof entry === 'object' ? levels.indexOf(entry.label) : -1;
        const share = entry?.probability;
        if (index === -1 || typeof share !== 'number' || !Number.isFinite(share)) continue;
        weight += index * share;
        total += share;
      }
      if (total > 0) score = weight / total;
    } else if (given !== null && typeof given === 'object') {
      let weight = 0, total = 0;
      for (const [index, level] of levels.entries()) {
        const share = given[level];
        if (typeof share !== 'number' || !Number.isFinite(share)) continue;
        weight += index * share;
        total += share;
      }
      if (total > 0) score = weight / total;
    }
  }
  if (score === undefined) return undefined;
  const level = FINDING_LEVELS[Math.min(Math.max(Math.round(score), 0), FINDING_LEVELS.length - 1)];
  return { level, confidence: answerConfidence(answer) };
}

const rows = [];
for (const [at, batch] of batches.entries()) {
  const answersOfBatch = answered[at] ?? {};
  const questions = requests[at].questions;
  for (const [inner, entry] of batch.entries()) {
    const id = `finding-${inner + 1}`;
    rows.push({ ...entry, call: callOf(questions[id], answersOfBatch[id]) });
  }
}
const unreadable = rows.filter((row) => row.call === undefined);
if (unreadable.length > 0) {
  console.warn(`${unreadable.length} answer(s) held no usable score; they count as handed to a person`);
}

// For each candidate send-back cut-off, replay the runtime's rule: impactful
// sends back at or over the cut-off, blocking at its own lower bar, and an
// answer under the hand-off bar goes to a person whatever the cut-off is.
const bars = [];
for (let value = 0.5; value <= 0.951; value += 0.05) bars.push(Number(value.toFixed(2)));

console.log('\ncut-off  sent-back  wrongly-back  held  wrongly-held  to-person');
for (const bar of bars) {
  let sentBack = 0, wronglyBack = 0, held = 0, wronglyHeld = 0, toPerson = 0;
  for (const { call, label } of rows) {
    const person = call === undefined || call.confidence < JUDGE_CONFIDENCE.handOff;
    if (person) { toPerson += 1; continue; }
    const sendBackBar = call.level === 'blocking' ? JUDGE_CONFIDENCE.sendBackBlocking : bar;
    const acts = (call.level === 'impactful' || call.level === 'blocking') && call.confidence >= sendBackBar;
    if (acts) { sentBack += 1; if (!label.sendBack) wronglyBack += 1; }
    else { held += 1; if (label.sendBack) wronglyHeld += 1; }
  }
  console.log(`${bar.toFixed(2)}    ${sentBack}  ${wronglyBack}  ${held}  ${wronglyHeld}  ${toPerson}`);
}
console.log(`\nthe wrongly columns score each call against label.sendBack === true; the hand-off bar is ${JUDGE_CONFIDENCE.handOff}, and a blocking score sends back at or over ${JUDGE_CONFIDENCE.sendBackBlocking}`);
