import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

import {
  compileGraph, createGraphExecutor, dagGraphType, EngineError, EngineIncompleteResultError,
  readRunPreflight,
} from '@obversa/runtime';
import { createLocalRunStorage } from '@obversa/runtime/storage/local';

const value = 'original';
await appendFile(new URL('./module-evaluations.log', import.meta.url), `${process.pid}\n`);

export async function bindRun({ definition, scratchDirectory }) {
  const input = definition.resolvedInputs;
  const graph = compileGraph(dagGraphType, definition.graphDefinition.value);
  const probeControl = async () => input.preflightControl
    ? JSON.parse(await readFile(input.preflightControl, 'utf8')) : {};
  const markProbe = async (stage, request) => {
    await appendFile(join(scratchDirectory, 'preflight-calls.jsonl'), `${JSON.stringify({
      stage, pid: process.pid, attempt: request.attempt,
      model: request.model, tools: request.tools, cwd: request.cwd,
    })}\n`);
  };
  if (input.preflightControl) {
    const store = createLocalRunStorage(input.storage).eventStore;
    const prototype = Object.getPrototypeOf(store);
    const append = prototype.append;
    prototype.append = async function (stream, revision, batch) {
      const result = await append.call(this, stream, revision, batch);
      const control = await probeControl();
      const matches = stream.streamId === definition.runId && batch.some((event) =>
        control.crashAfter === 'resumed' && event.type === 'preflight:resumed'
        || control.crashAfter === 'pause' && event.type === 'preflight:paused'
        || control.crashAfter === 'live-success' && event.type === 'preflight:probe-finished'
          && event.payload.stage === 'live' && event.payload.outcome.kind === 'succeeded');
      if (matches) {
        let first = true;
        try { await writeFile(join(scratchDirectory, 'preflight-crashed'), String(process.pid), { flag: 'wx' }); }
        catch (error) { if (error.code === 'EEXIST') first = false; else throw error; }
        if (first) {
          process.kill(process.pid, 'SIGKILL');
          await new Promise(() => {});
        }
      }
      return result;
    };
  }
  if (input.holdWorkerResult) {
    const store = createLocalRunStorage(input.storage).eventStore;
    const prototype = Object.getPrototypeOf(store);
    const append = prototype.append;
    prototype.append = async function (stream, revision, batch) {
      const result = await append.call(this, stream, revision, batch);
      if (batch.some((event) => event.type === 'runner:worker-result')) {
        await writeFile(join(scratchDirectory, 'worker-result-held'), String(process.pid));
        await new Promise(() => { setInterval(() => {}, 1_000); });
      }
      return result;
    };
  }
  if (input.resumeCrash) {
    const store = createLocalRunStorage(input.storage).eventStore;
    const prototype = Object.getPrototypeOf(store);
    const append = prototype.append;
    async function crashOnce(file = 'resume-crash.json') {
      const crashPath = join(scratchDirectory, file);
      try { await writeFile(crashPath, JSON.stringify({ pid: process.pid, boundary: input.resumeCrash }), { flag: 'wx' }); }
      catch (error) { if (error.code === 'EEXIST') return; throw error; }
      process.kill(process.pid, 'SIGKILL');
      await new Promise(() => {});
    }
    prototype.append = async function (stream, revision, batch) {
      const target = input.resumeCrash.endsWith('resume') ? 'graph:node-resumed' : 'graph:node-completed';
      const matches = stream.streamId === definition.runId
        && batch.some((event) => event.type === target && event.payload.nodeId === 'last');
      if (matches && (input.resumeCrash.startsWith('before-') || input.resumeCrash === 'after-reconcile')) await crashOnce();
      const result = await append.call(this, stream, revision, batch);
      if (matches && input.resumeCrash.startsWith('after-') && input.resumeCrash !== 'after-reconcile') await crashOnce();
      if (input.resumeCrash === 'after-reconcile' && stream.streamId === definition.runId
        && batch.some((event) => event.type === 'graph:node-paused' && event.payload.request?.kind === 'reconcile-attempt')) {
        await crashOnce('reconcile-crash.json');
      }
      return result;
    };
  }
  const lane = definition.graphDefinition.value.nodes[0].data.lane;
  let selection = { adapter: 'fixture', adapterVersion: '1', provider: 'fixture', modelFamily: 'fixture', model: 'fixture', executable: null, capabilities: [] };
  const schema = { type: 'object' };
  const resultContract = input.enginePartBytes ? {
    record: { name: 'fixture-result', version: 1, schemaDigest: `sha256:${createHash('sha256').update(JSON.stringify(schema)).digest('hex')}` }, schema,
    validate(result) {
      if (result === null || typeof result !== 'object' || typeof result.node !== 'string' || typeof result.value !== 'string') {
        throw new TypeError('Fixture result needs node and value strings');
      }
      return result;
    },
  } : null;
  const bindings = {
    graph,
    engines: lane ? [{
      target: lane.requested, selection, hardTokenLimitEnforceable: false,
      engine: {
        name: 'fixture',
        ...(input.preflightControl ? {
          async admit(request, _signal, expected) {
            await markProbe('static', request);
            if ((await probeControl()).mode === 'static-hold') {
              await writeFile(join(scratchDirectory, 'probe.held'), String(process.pid));
              await new Promise(() => { setInterval(() => {}, 1_000); });
            }
            const measured = { ...selection, adapterVersion: '2' };
            if (expected !== undefined && !isDeepStrictEqual(expected, measured)) {
              throw new EngineError({ kind: 'invalid-config', message: 'Fixture selection changed' });
            }
            selection = measured;
            return measured;
          },
        } : {}),
        async run(request) {
          if (request.purpose === 'preflight') {
            await markProbe('live', request);
            const control = await probeControl();
            if (control.child) {
              const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
                detached: false, stdio: 'ignore',
              });
              await appendFile(join(scratchDirectory, 'probe.child'), `${child.pid}\n`);
            }
            if (control.mode === 'hold' || control.mode === 'noisy') {
              await writeFile(join(scratchDirectory, 'probe.held'), String(process.pid));
              if (control.mode === 'noisy') {
                for (;;) await new Promise((resolve) => process.stdout.write('x'.repeat(65_536), resolve));
              }
              await new Promise(() => { setInterval(() => {}, 1_000); });
            }
            if (control.mode === 'fail') throw new EngineError({ kind: 'transient', message: 'Fixture probe refused' });
            const requested = { ...selection, capabilities: [] };
            return {
              parts: [{ kind: 'assistant', text: 'ready', final: true }],
              requested, effective: requested,
              usage: { kind: 'reported', inputTokens: 101, outputTokens: 17 },
            };
          }
          if (input.engineCrashOnce) {
            let crash = true;
            try { await writeFile(join(scratchDirectory, 'engine-crashed'), String(process.pid), { flag: 'wx' }); }
            catch (error) { if (error.code === 'EEXIST') crash = false; else throw error; }
            if (crash) {
              process.kill(process.pid, 'SIGKILL');
              await new Promise(() => {});
            }
          }
          const evidence = {
            usage: { kind: 'reported', inputTokens: 7, outputTokens: 3 },
            requested: selection, effective: selection,
          };
          if (input.engineFail) throw new EngineIncompleteResultError('fixture incomplete', {
            ...evidence, parts: [{ kind: 'assistant', text: input.enginePartBytes ? 'z'.repeat(input.enginePartBytes) : 'partial', final: false }],
            transportFailure: { kind: 'timeout', message: 'fixture timeout', exitCode: 9 },
          });
          if (input.enginePartBytes) return { ...evidence, parts: [{ kind: 'assistant', text: 'z'.repeat(input.enginePartBytes), final: true }] };
          return { ...evidence, parts: [{ kind: 'structured', value: { node: request.attempt.leafId, value }, final: true }] };
        },
      },
    }] : [],
    nodes: Object.fromEntries(definition.graphDefinition.value.nodes.map(({ id }) => [id, {
      prompt: lane ? () => 'fixture prompt' : null,
      scratchDirectory,
      workspace: { mode: 'none', directory: null, allowedPaths: [] },
      trustedCaller: { actor: 'fixture', provenance: 'local-test' },
      permissions: [],
      policy: {
        inputBytes: input.enginePartBytes ? 400_000 : 10_000,
        outputBytes: input.enginePartBytes ? 400_000 : input.resultBytes ? input.resultBytes + 100 : 10_000, timeoutMs: input.nodeTimeoutMs ?? 5_000,
        teardownGraceMs: 100, memoryBytes: 10_000_000,
        filesChanged: 0, linesChanged: 0, callTokens: null,
      },
      resultContract,
      runData: lane ? null : async ({ signal }) => {
        await appendFile(join(scratchDirectory, `${id}.started`), `${process.pid}\n`);
        if (input.child) {
          const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: input.detachedChild === true, stdio: 'ignore' });
          await appendFile(join(scratchDirectory, `${id}.child`), `${child.pid}\n`);
        }
        if (input.noisy) {
          for (;;) {
            await new Promise((resolve) => process.stdout.write('x'.repeat(65_536), resolve));
          }
        }
        if (input.crash) process.kill(process.pid, 'SIGKILL');
        if (input.crashOnce && (await readFile(join(scratchDirectory, `${id}.started`), 'utf8')).trim().split('\n').length === 1) {
          process.kill(process.pid, 'SIGKILL');
        }
        if (input.delayMs) await delay(input.delayMs, undefined, { signal });
        if (input.reportWorkerEnvironment) {
          return { node: id, value: {
            parentSecret: process.env.OBVERSA_TEST_PARENT_SECRET ?? null,
            selectedSecret: process.env.OBVERSA_TEST_SELECTED_SECRET === 'harmless-selected-secret-sentinel',
            nodeOptions: process.env.NODE_OPTIONS ?? null,
            path: process.env.PATH ?? null,
            home: process.env.HOME ?? null,
            attemptId: process.env.OBVERSA_ATTEMPT_ID ?? null,
            runOwner: process.env.OBVERSA_RUN_OWNER ?? null,
          } };
        }
        return { node: id, value: input.resultBytes ? 'x'.repeat(input.resultBytes) : input.value ?? value };
      },
      parseResult: input.enginePartBytes ? (part) => ({ node: id, value: part.text.slice(0, input.resultBytes) }) : null,
      tokenBudget: null, retrySafe: input.retrySafe ?? true,
      decideAction: async () => {
        if (input.wait && (input.waitNode === undefined || input.waitNode === id)) {
          if (input.approvalFile && await readFile(input.approvalFile, 'utf8').catch(() => '') === 'allow') {
            return { kind: 'allow' };
          }
          return { kind: 'wait', reason: 'A person must approve.', request: { kind: 'human' } };
        }
        return input.deny ? { kind: 'deny', reason: 'Not permitted.' } : { kind: 'allow' };
      },
    }])),
  };
  if ((await probeControl()).advanceDuringBind) {
    const storage = createLocalRunStorage(input.storage);
    const state = await readRunPreflight(storage, definition.runId);
    if (state.pause !== null) {
      const executor = await createGraphExecutor({
        ...bindings, storage, runId: definition.runId, preflightScratchDirectory: scratchDirectory,
      });
      const advanced = await executor.resume({ preflightEventId: state.pause.preflightEventId }, new AbortController().signal);
      if (advanced.kind !== 'pause') throw new Error('Fixture race must leave another pause');
      await writeFile(join(scratchDirectory, 'advanced-pause.json'), JSON.stringify(advanced));
    }
  }
  return bindings;
}
