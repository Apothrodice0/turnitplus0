import assert from "node:assert/strict";
import test, { mock } from "node:test";
import {
  runAiAnalysis,
  AI_WORKER_INACTIVITY_TIMEOUT_MS,
} from "../app/reports/rooms/[room]/room-page-shell.tsx";

/**
 * REPORT-LIFECYCLE CORRECTNESS FIX — task spec §16 (AI TIMEOUT TEST) /
 * invariant D ("a real current AI run must terminate"). Simulates an AI
 * worker request that never posts back a single message of any kind (no
 * "prep", no "progress", no final result) — the exact hang the prior audit
 * proved has no bound at all. No real model download: a minimal fake
 * `Worker` stands in for the browser API this environment does not provide
 * (matching tests/report-ai-completion.test.mjs's own documented convention
 * that this Node environment has no real `Worker` global), and node:test's
 * fake timers fast-forward past the real inactivity window instantly.
 */

class FakeWorker {
  constructor() {
    this.listeners = new Map();
    this.terminated = false;
    this.posted = [];
    FakeWorker.instances.push(this);
  }
  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }
  removeEventListener(type, handler) {
    if (this.listeners.get(type) === handler) this.listeners.delete(type);
  }
  postMessage(message) {
    this.posted.push(message);
    // Deliberately never responds — this is the hang under test.
  }
  terminate() {
    this.terminated = true;
  }
}
FakeWorker.instances = [];

test("AI WORKER TIMEOUT (§16): a request that never responds eventually times out, terminates the stuck worker, clears the module singleton, and resolves to a terminal 'error' AiAnalysis — runAiAnalysis itself never hangs, never rejects, and never leaves ai_status stuck", async () => {
  FakeWorker.instances.length = 0;
  const originalWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const resultPromise = runAiAnalysis(
      "a long enough passage of ordinary english prose to satisfy any eligibility check the real worker would otherwise apply, though this fake worker never inspects it at all",
      "English",
    );

    assert.equal(FakeWorker.instances.length, 1, "a single fresh worker must have been created for this request");
    assert.equal(FakeWorker.instances[0].posted.length, 1, "the request must have been posted to the worker");
    assert.equal(FakeWorker.instances[0].terminated, false, "must not be terminated before the timeout fires");

    // Fast-forward exactly to (and past) the documented inactivity window —
    // no real waiting, and no assumption about a shorter/longer value than
    // what is actually configured in production code.
    mock.timers.tick(AI_WORKER_INACTIVITY_TIMEOUT_MS);

    const result = await resultPromise;

    assert.equal(result.aiScore, null, "REQUIRED: a timed-out request must never produce a fabricated score");
    assert.equal(result.aiAnalysis.status, "error", "REQUIRED (AI_TIMEOUT_TERMINALIZES_TO_FAILED = YES): a timeout must resolve to the existing, customer-safe terminal 'error' shape — the same one saveEnrichedAiResult already maps to ai_status 'failed'");
    assert.ok(result.aiAnalysis.error && result.aiAnalysis.error.length > 0, "a human-readable error message must be present");

    assert.equal(FakeWorker.instances[0].terminated, true, "REQUIRED: the stuck worker must be terminated on timeout — never left running indefinitely");
  } finally {
    mock.timers.reset();
    globalThis.Worker = originalWorker;
  }
});

test("AI WORKER TIMEOUT (§16, cleanup): after a timeout, the NEXT request gets a fresh worker instance — the module singleton must be cleared, never reused in its stuck state, and no parallel/duplicate worker is created for the new request", async () => {
  FakeWorker.instances.length = 0;
  const originalWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const firstPromise = runAiAnalysis("first request text, long enough to be a plausible passage for this fixture", "English");
    mock.timers.tick(AI_WORKER_INACTIVITY_TIMEOUT_MS);
    await firstPromise;
    assert.equal(FakeWorker.instances.length, 1);
    assert.equal(FakeWorker.instances[0].terminated, true);

    // A second, independent request (e.g. a manual "Retry analysis") must
    // instantiate a fresh worker — never reuse the terminated one, and
    // never spin up more than the one it actually needs.
    const secondPromise = runAiAnalysis("second request text, also long enough, simulating a manual retry after the first request timed out", "English");
    mock.timers.tick(AI_WORKER_INACTIVITY_TIMEOUT_MS);
    await secondPromise;

    assert.equal(FakeWorker.instances.length, 2, "REQUIRED: exactly one new worker for the second request — never zero (reusing the dead one) and never more than one (a stray duplicate)");
    assert.notEqual(FakeWorker.instances[1], FakeWorker.instances[0], "the second request must use a genuinely different worker instance");
    assert.equal(FakeWorker.instances[1].terminated, true, "the second request's own worker must also be cleanly terminated on its own timeout");
  } finally {
    mock.timers.reset();
    globalThis.Worker = originalWorker;
  }
});
