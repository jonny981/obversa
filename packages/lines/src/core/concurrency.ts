import pLimit from 'p-limit';

export const DEFAULT_FANOUT_CONCURRENCY = 4;

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = pLimit(concurrency);
  return Promise.all(items.map((item, index) => limit(() => fn(item, index))));
}
