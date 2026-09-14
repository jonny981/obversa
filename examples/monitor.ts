/**
 * Watch a run in the browser.
 *
 * A run can serve a page about itself while it works. `monitor: true` binds
 * a free port on the loopback address and folds the run's own events into
 * the state of each declared step. The address arrives as one `monitor`
 * event, so it is in the record and never on stdout. This example runs two
 * plain steps offline, reads the page's state as JSON once the run is done,
 * and closes the page. Open the printed address while a longer run is going
 * to watch it move.
 */
import { fnJob, pipeline, run, type LoopEvent } from '@obversa/runtime';

const gather = fnJob('gather', () => ({ status: 'pass', summary: 'two files read' }));
const summarise = fnJob('summarise', () => ({ status: 'pass', summary: 'one page written' }));

const digest = pipeline('digest', [
  { name: 'gather', job: gather },
  { name: 'summarise', job: summarise },
]);

let address: string | undefined;
const result = await run(digest, {
  monitor: true,
  onEvent: (event: LoopEvent) => {
    if (event.kind === 'monitor') address = event.url;
  },
});

const state = address === undefined
  ? undefined
  : (await (await fetch(`${address}state`)).json()) as {
    status: string;
    outcome?: { status: string };
    nodes: Record<string, { phase: string }>;
  };
console.log(JSON.stringify({
  address,
  run: result.outcome.status,
  page: state?.status,
  steps: state ? Object.fromEntries(Object.entries(state.nodes).map(([name, node]) => [name, node.phase])) : undefined,
}, null, 2));
await result.monitor?.close();

/**
 * Part of the documentation proof: it must fail when the behaviour it shows
 * stops happening. A page that never announced its address, or that still
 * said running after the run, would otherwise print a passing run.
 */
const faults: string[] = [];
if (address === undefined) faults.push('the run announced no monitor address');
if (result.monitor?.url !== address) faults.push('result.monitor.url is not the announced address');
if (state?.status !== 'done') faults.push(`the page says ${state?.status ?? 'nothing'} after the run`);
if (state && Object.values(state.nodes).some((node) => node.phase !== 'done')) faults.push('a step is not done on the page');
if (faults.length) {
  for (const fault of faults) console.error(fault);
  process.exitCode = 1;
}
