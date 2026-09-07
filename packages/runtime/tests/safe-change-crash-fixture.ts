import { openSafeChangeRun } from '../../../examples/safe-change/recipe.js';

const [directory, runId, selectedTarget] = process.argv.slice(2);
if (!directory || !runId || !selectedTarget) throw new Error('Expected directory, run id, and target id.');

const run = await openSafeChangeRun({
  directory,
  runId,
  hooks: {
    async afterTargetWrite(actionId, targetId) {
      if (targetId !== selectedTarget) return;
      process.send?.({ actionId, targetId });
      setInterval(() => {}, 1_000);
      await new Promise<never>(() => {});
    },
  },
});

await run.executor.resume(run.approvalPosition, new AbortController().signal);
throw new Error('The selected target write did not reach the crash boundary.');
