import assert from "node:assert/strict";
import test from "node:test";
import { runAfterResponse } from "../lib/run-after-response.ts";

// This file's tests all invoke runAfterResponse the exact same way every
// route-handler test in this project invokes a route handler: as a plain
// async function call, with no real Next.js server underneath. That means
// next/server's after() is guaranteed to throw "called outside a request
// scope" every time here — so every test below is really exercising the
// fallback path, which is also therefore the path every other test file in
// this project relies on (implicitly) whenever it POSTs to /api/reports.
// See lib/run-after-response.ts's own comment for why that's the correct,
// intentional behavior rather than a gap in coverage.

test("runs work to completion before resolving, when called outside a request scope", async () => {
  let ran = false;
  await runAfterResponse(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    ran = true;
  });
  assert.equal(ran, true, "work must have completed by the time runAfterResponse's own promise resolves");
});

test("propagates a rejection from work back to the caller", async () => {
  await assert.rejects(
    () => runAfterResponse(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
});

test("does not run work twice", async () => {
  let callCount = 0;
  await runAfterResponse(async () => {
    callCount += 1;
  });
  assert.equal(callCount, 1);
});

test("returns whatever work itself resolves with no wrapping (void) — callers rely on side effects, not a return value", async () => {
  const result = await runAfterResponse(async () => {
    // intentionally returns nothing
  });
  assert.equal(result, undefined);
});
