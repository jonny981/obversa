import { spawn } from 'node:child_process';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = join(repository, 'examples/packages/turn-taking.ts');

function replaceOnce(source, before, after) {
  const index = source.indexOf(before);
  if (index === -1) {
    throw new Error(`The turn-taking example changed near: ${before.slice(0, 80)}`);
  }
  return `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
}

function graphEvents(result, type) {
  return result.events.filter((event) => event.type === `graph:${type}`);
}

async function runFixture(path, environment) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path], {
      cwd: repository,
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (value) => { stdout += value; });
    child.stderr.on('data', (value) => { stderr += value; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

const temporary = await mkdtemp(join(tmpdir(), 'obversa-d10-crash-'));
const fixtureDirectory = await mkdtemp(join(
  repository,
  'examples/packages/.d10-crash-',
));
try {
  const baselineDirectory = join(temporary, 'baseline');
  const crashDirectory = join(temporary, 'crash');
  await Promise.all([mkdir(baselineDirectory), mkdir(crashDirectory)]);

  let source = await readFile(sourcePath, 'utf8');
  source = replaceOnce(
    source,
    "const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'obversa-turn-taking-')));",
    'const temporaryRoot = await realpath(process.env.OBVERSA_RUN_DIRECTORY ?? await mkdtemp(join(tmpdir(), \'obversa-turn-taking-\')));',
  );
  source = replaceOnce(
    source,
    '  await persistRunDefinition(storage, {',
    '  if (!process.env.OBVERSA_RESUME_POSITION) await persistRunDefinition(storage, {',
  );
  source = replaceOnce(
    source,
    "  const fallback = new MockEngine(() => {\n    fallbackCalls += 1;\n    return 'accepted';\n  });",
    "  const fallback = new MockEngine(() => {\n    fallbackCalls += 1;\n    if (fallbackCalls === Number(process.env.OBVERSA_CRASH_ON_FALLBACK_CALL)) {\n      process.kill(process.pid, 'SIGKILL');\n    }\n    return 'accepted';\n  });",
  );
  source = replaceOnce(
    source,
    '  const executorResult = await executor.run(new AbortController().signal);',
    "  const executorResult = process.env.OBVERSA_RESUME_POSITION\n    ? await executor.resume(process.env.OBVERSA_RESUME_POSITION, new AbortController().signal)\n    : await executor.run(new AbortController().signal);",
  );
  source = replaceOnce(
    source,
    "  })) storedEvents.push(event);\n\n  console.log(JSON.stringify({",
    "  })) storedEvents.push(event);\n  if (process.env.OBVERSA_EVENT_EXPORT) {\n    const { writeFile: writeEventExport } = await import('node:fs/promises');\n    await writeEventExport(process.env.OBVERSA_EVENT_EXPORT, JSON.stringify({\n      executor: executorResult,\n      primaryCalls,\n      fallbackCalls,\n      events: storedEvents,\n    }));\n  }\n\n  console.log(JSON.stringify({",
  );
  source = replaceOnce(
    source,
    "} finally {\n  await rm(temporaryRoot, { recursive: true, force: true });\n}",
    "} finally {\n  if (!process.env.OBVERSA_RUN_DIRECTORY) {\n    await rm(temporaryRoot, { recursive: true, force: true });\n  }\n}",
  );
  const fixturePath = join(fixtureDirectory, 'turn-taking.ts');
  await writeFile(fixturePath, source, 'utf8');

  const baselinePath = join(temporary, 'baseline.json');
  const baselineRun = await runFixture(fixturePath, {
    OBVERSA_RUN_DIRECTORY: baselineDirectory,
    OBVERSA_EVENT_EXPORT: baselinePath,
  });
  assert.equal(baselineRun.code, 0, baselineRun.stderr || baselineRun.stdout);

  const crashRun = await runFixture(fixturePath, {
    OBVERSA_RUN_DIRECTORY: crashDirectory,
    OBVERSA_CRASH_ON_FALLBACK_CALL: '2',
  });
  assert.equal(crashRun.signal, 'SIGKILL', crashRun.stderr || crashRun.stdout);

  const resumedPath = join(temporary, 'resumed.json');
  const resumedRun = await runFixture(fixturePath, {
    OBVERSA_RUN_DIRECTORY: crashDirectory,
    OBVERSA_RESUME_POSITION: 'turns/2-critic',
    OBVERSA_EVENT_EXPORT: resumedPath,
  });
  assert.equal(resumedRun.code, 0, resumedRun.stderr || resumedRun.stdout);

  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  const resumed = JSON.parse(await readFile(resumedPath, 'utf8'));
  const baselineDispatches = graphEvents(baseline, 'node-dispatched');
  const resumedDispatches = graphEvents(resumed, 'node-dispatched');
  const baselinePositions = baselineDispatches.map((event) => event.payload.position);
  const resumedPositions = resumedDispatches.map((event) => event.payload.position);

  assert.deepEqual(resumed.executor, baseline.executor);
  assert.deepEqual(resumedPositions, baselinePositions);
  assert.equal(new Set(resumedPositions).size, 6);
  assert.deepEqual(
    graphEvents(resumed, 'node-completed').map((event) => event.payload),
    graphEvents(baseline, 'node-completed').map((event) => event.payload),
  );
  assert.equal(graphEvents(resumed, 'node-failed').length, 0);
  assert.equal(graphEvents(resumed, 'node-paused').length, 0);
  assert.equal(graphEvents(resumed, 'node-attempt-started').length, 6);
  assert.deepEqual(
    graphEvents(resumed, 'node-resumed').map((event) => event.payload),
    [{ nodeId: 'critic', position: 'turns/2-critic' }],
  );

  process.stdout.write(`${JSON.stringify({
    ok: true,
    fixture: relative(repository, sourcePath),
    killedBy: crashRun.signal,
    resumedPosition: 'turns/2-critic',
    uniquePositions: new Set(resumedPositions).size,
    outcome: resumed.executor.kind,
  })}\n`);
} finally {
  await Promise.all([
    rm(temporary, { recursive: true, force: true }),
    rm(fixtureDirectory, { recursive: true, force: true }),
  ]);
}
