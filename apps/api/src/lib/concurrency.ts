/**
 * A gate that runs at most `count` tasks at once; the rest wait in order.
 * A finishing task hands its slot straight to the next waiter, so a newcomer
 * can never slip in and make it `count + 1`.
 */
export function slots(count: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= count) await new Promise<void>((resolve) => waiting.push(resolve));
    else running++;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}

/** Map with at most `concurrency` calls in flight, keeping order. */
export async function mapLimit<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}
