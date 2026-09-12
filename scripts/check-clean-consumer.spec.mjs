import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as consumer from './check-clean-consumer.mjs';
import { CONSUMER_EXAMPLES } from './consumer-examples.mjs';
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
  assert.match(source, /examples', 'safe-change\.ts'/);
  assert.match(source, /safe-change\.mdx/);
  assert.match(source, /compiledSafeChange/);
});

test('clean consumer wires the feature-delivery production line', async () => {
  const source = await readFile(new URL('./check-clean-consumer.mjs', import.meta.url), 'utf8');
  // The compile list lives in consumer-examples.mjs, read by this check and the page-shape check.
  assert.ok(CONSUMER_EXAMPLES.includes('feature-delivery.ts'));
  assert.match(source, /'feature-delivery\.mdx'/);
  assert.match(source, /feature-delivery\.deny\.ts/);
  assert.match(source, /feature-delivery\.red\.ts/);
  assert.match(source, /featureLine\.acceptedKickbacks !== 1/);
  assert.doesNotMatch(source, /recordEvents !== \d+/);
});

test('clean consumer runs the three packed team examples', async () => {
  const source = await readFile(new URL('./check-clean-consumer.mjs', import.meta.url), 'utf8');
  for (const file of [
    'teams/scripted-engine.ts',
    'teams/writer-reviewer-pair.proof.ts',
    'teams/threshold-panel.proof.ts',
    'teams/feature-delivery.proof.ts',
    'teams/writer-reviewer-pair.ts',
    'teams/threshold-panel.ts',
    'teams/feature-delivery.ts',
  ]) assert.ok(CONSUMER_EXAMPLES.includes(file), `${file} is not on the consumer compile list`);
  assert.match(source, /reviewerKickbacks/);
});

test('clean consumer compiles and runs the tournament example', async () => {
  const source = await readFile(new URL('./check-clean-consumer.mjs', import.meta.url), 'utf8');
  assert.ok(CONSUMER_EXAMPLES.includes('tournament.ts'));
  assert.match(source, /compiledTournament/);
});

test('clean consumer compiles and runs both preflight examples', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const source = await readFile(new URL('./check-clean-consumer.mjs', import.meta.url), 'utf8');
  assert.equal(manifest.scripts['verify:d17'],
    'pnpm verify:d45 && pnpm example:preflight && pnpm example:runner-preflight');
  assert.equal(manifest.scripts['example:preflight'],
    'pnpm --filter @obversa/runtime exec tsx ../../examples/preflight-executor.ts');
  assert.equal(manifest.scripts['example:runner-preflight'],
    'pnpm --filter @obversa/runner exec tsx ../../examples/preflight-supervised-run.ts');
  for (const file of ['preflight-executor.ts', 'preflight-supervised-run.ts', 'preflight-host.mjs']) {
    assert.ok(CONSUMER_EXAMPLES.includes(file), `${file} is not on the consumer compile list`);
    assert.ok(source.includes(file), `${file} is not copied into the consumer`);
  }
  assert.match(source, /allowJs: true/);
  assert.match(source, /checkJs: true/);
  for (const name of ['compiledPreflightExecutor', 'directPreflightExecutor',
    'compiledPreflightRunner', 'directPreflightRunner']) {
    assert.ok(source.includes(name), `${name} is not checked by the consumer`);
  }
});

test('team conversation example requires the reply to queue another writer turn', async (t) => {
  const source = await readFile(new URL('../examples/team-conversation.ts', import.meta.url), 'utf8');
  const directory = await mkdtemp(new URL('../examples/.team-conversation-', import.meta.url));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const execute = async (name, text) => {
    const path = join(directory, name);
    await writeFile(path, text);
    return spawnSync(process.execPath, ['--import', 'tsx', path], {
      encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL',
    });
  };
  const good = await execute('complete.ts', source);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  const report = JSON.parse(good.stdout);
  assert.deepEqual(report.order, ['writer', 'reviewer', 'writer']);
  assert.equal(report.replayAddedEvents, false);
  assert.equal(report.temporaryDirectoryRemoved, true);
  const broken = source.replace("mentions: ['writer']", 'mentions: []');
  assert.notEqual(broken, source, 'The control must remove the reviewer mention.');
  const bad = await execute('missing-mention.ts', broken);
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stderr, /writer must finish after receiving the reply/);
  t.diagnostic(JSON.stringify({ control: 'missing reviewer mention', exit: bad.status, stdout: bad.stdout, stderr: bad.stderr }));
});

test('team page checks the whole runnable source and actual printed report', async (t) => {
  assert.equal(typeof consumer.checkedTeamConversationPage, 'function');
  const source = await readFile(new URL('../examples/team-conversation.ts', import.meta.url), 'utf8');
  const page = await readFile(new URL('../docs/public/workflows/team-conversation.mdx', import.meta.url), 'utf8');
  const run = spawnSync(process.execPath, ['--import', 'tsx', new URL('../examples/team-conversation.ts', import.meta.url).pathname], {
    encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL',
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  consumer.checkedTeamConversationPage(page, source, run.stdout);
  assert.throws(() => consumer.checkedTeamConversationPage(page, `${source}// wrong source\n`, run.stdout), /runnable source/);
  const wrong = { ...JSON.parse(run.stdout), replayAddedEvents: true };
  assert.throws(() => consumer.checkedTeamConversationPage(page, source, JSON.stringify(wrong)), /printed report/);

  const sourceHeading = page.indexOf('## Source');
  assert.ok(sourceHeading > 0);
  const introduction = page.slice(0, sourceHeading);
  const completeSource = page.slice(sourceHeading);
  const blocks = [...introduction.matchAll(/```ts\n([\s\S]*?)\n```/g)];
  assert.equal(blocks.length, 3, 'The page must have exactly three short TypeScript blocks.');
  for (const [index, name] of ['imports', 'definition', 'posts'].entries()) {
    await t.test(`rejects a changed ${name} short block while complete source and output match`, () => {
      const block = blocks[index];
      const changedIntroduction = introduction.slice(0, block.index)
        + block[0].replace('```ts\n', `\`\`\`ts\n// Changed ${name} short block.\n`)
        + introduction.slice(block.index + block[0].length);
      assert.throws(
        () => consumer.checkedTeamConversationPage(changedIntroduction + completeSource, source, run.stdout),
        new RegExp(`${name}.*short|short.*${name}`),
      );
    });
  }
  await t.test('rejects a missing imports marker even when the complete source copy matches', () => {
    const withoutMarker = source.replace('// #region imports\n', '');
    assert.notEqual(withoutMarker, source, 'The control must remove the imports marker.');
    const matchedCompleteSource = completeSource.replace(source.trimEnd(), withoutMarker.trimEnd());
    assert.notEqual(matchedCompleteSource, completeSource);
    assert.throws(
      () => consumer.checkedTeamConversationPage(introduction + matchedCompleteSource, withoutMarker, run.stdout),
      /imports source region/,
    );
  });
});

test('clean consumer wires the described-team example', async () => {
  const source = await readFile(new URL('./check-clean-consumer.mjs', import.meta.url), 'utf8');
  assert.match(source, /described-team\.ts/);
  assert.match(source, /expectedDescribedTeamReport/);
});

test('clean consumer wires the bounded process example', async () => {
  const source = await readFile(new URL('./check-clean-consumer.mjs', import.meta.url), 'utf8');
  assert.match(source, /run-child\.ts/);
  assert.match(source, /packages', 'process\.mdx'/);
  assert.match(source, /compiledRunChild/);
  assert.match(source, /directRunChild/);
});

test('a rename that moves several examples is reported in one run, not one per run', async () => {
  const source = await readFile(new URL('./check-clean-consumer.mjs', import.meta.url), 'utf8');
  // The preflight runs before the first read and is driven by the compile
  // list, so every example the throwaway project builds is checked together.
  assert.match(source, /readAllOrReportEveryMissingFile\(\s*\n\s*tsconfig\.include/);
  assert.match(source, /file\(s\) this proof reads are not there/);
  // And it must collect rather than stop: the loop pushes onto `missing`
  // instead of throwing on the first one.
  assert.match(source, /missing\.push\(path\)/);
});
