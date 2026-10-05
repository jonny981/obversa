/** A run that waits until it is stopped. It tells the parent once it has started. */
import { fnJob, run } from '../src/api.ts';

const recordTo = process.argv[2]!;
await run(fnJob('wait', () => new Promise(() => {
  setInterval(() => {}, 1_000);
  process.send?.('started');
})), { recordTo });
