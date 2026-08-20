/**
 * A small worker-pool helper: runs `worker` over every item in `items`, with
 * at most `concurrency` invocations in flight at once, and returns once every
 * item has been processed. Used by orchestrator.ts's Stage 2 to replace a
 * fully sequential `for` loop over (query, provider) pairs — the measured
 * root cause of ~70s report-generation latency (see the production audit
 * this fixes: 24 queries x 2 providers = 48 sequential round-trips, each up
 * to a 9s provider timeout).
 *
 * Deliberately NOT `Promise.all(items.map(worker))` (unbounded concurrency —
 * would fire all 48 requests at once, which is its own abuse/fairness
 * concern against free public APIs like OpenAIRE/Europe PMC) and deliberately
 * NOT a library dependency — this is the whole implementation a bounded
 * worker pool needs: `concurrency` fixed "runner" loops each pull the next
 * unclaimed index off a shared cursor and process it, so a slow/hung item
 * only ever occupies one of the `concurrency` slots while the others keep
 * making progress on the remaining items.
 */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  let nextIndex = 0;
  async function runner(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, runner));
}
