import assert from "node:assert/strict";
import test from "node:test";
import { mapWithConcurrency } from "../lib/academic-search/concurrency.ts";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("every item is processed exactly once, regardless of concurrency width", async () => {
  const items = Array.from({ length: 17 }, (_, i) => i);
  const seen = [];
  await mapWithConcurrency(items, 5, async (item) => {
    seen.push(item);
  });
  assert.deepEqual([...seen].sort((a, b) => a - b), items, "every item processed, none skipped, none duplicated");
});

test("never runs more than `concurrency` workers at once", async () => {
  const items = Array.from({ length: 12 }, (_, i) => i);
  let inFlight = 0;
  let maxInFlight = 0;
  await mapWithConcurrency(items, 4, async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await delay(15);
    inFlight -= 1;
  });
  assert.ok(maxInFlight <= 4, `expected at most 4 concurrent, saw ${maxInFlight}`);
  assert.ok(maxInFlight >= 2, `expected genuine overlap (this is what makes it faster than sequential), saw ${maxInFlight}`);
});

test("a single slow item does not block unrelated items from completing", async () => {
  const items = ["slow", "fast-1", "fast-2", "fast-3", "fast-4"];
  const completionOrder = [];
  const start = Date.now();
  await mapWithConcurrency(items, 5, async (item) => {
    if (item === "slow") {
      await delay(300);
    } else {
      await delay(5);
    }
    completionOrder.push(item);
  });
  const totalMs = Date.now() - start;
  // All 5 fit in one batch of 5 concurrent slots, so total time is bounded
  // by the slow item's own delay, not the sum of all delays.
  assert.ok(totalMs < 300 + 150, `expected ~300ms (bounded by the slow item alone), took ${totalMs}ms`);
  // The fast items must finish (and be recorded) before the slow one, proving
  // they were not stuck waiting behind it.
  assert.ok(completionOrder.indexOf("slow") === completionOrder.length - 1, "slow item should finish last, not block the others");
});

test("results land at the caller-assigned slot regardless of completion order (what orchestrator.ts relies on for order-preserving output)", async () => {
  const items = [
    { index: 0, delayMs: 40 },
    { index: 1, delayMs: 5 },
    { index: 2, delayMs: 25 },
  ];
  const slots = new Array(items.length);
  await mapWithConcurrency(items, 3, async (item, i) => {
    await delay(item.delayMs);
    slots[i] = item.index; // caller writes into its own pre-assigned slot
  });
  assert.deepEqual(slots, [0, 1, 2], "slot order must match dispatch order, not completion order");
});

test("a rejecting worker propagates (orchestrator.ts is expected to catch per-task, not rely on this to swallow errors)", async () => {
  await assert.rejects(
    mapWithConcurrency([1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error("boom");
    }),
    /boom/,
  );
});

test("concurrency wider than the item list still processes everything exactly once", async () => {
  const items = [1, 2, 3];
  const seen = [];
  await mapWithConcurrency(items, 10, async (item) => {
    seen.push(item);
  });
  assert.deepEqual([...seen].sort(), items);
});

test("empty item list resolves immediately without invoking the worker", async () => {
  let calls = 0;
  await mapWithConcurrency([], 5, async () => {
    calls += 1;
  });
  assert.equal(calls, 0);
});
