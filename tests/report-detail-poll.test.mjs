import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  computeDetailRevealState,
  isAiTerminal,
  isSimilarityTerminal,
  startBoundedPoll,
  DETAIL_POLL_INTERVAL_MS,
  DETAIL_MAX_POLL_ATTEMPTS,
} from "../lib/report-detail-poll.ts";

/**
 * Release-hardening audit finding LIFECYCLE-06 (corrected): deterministic
 * behavior-level proof for report-detail-shell.tsx's reveal/poll state
 * machine, against the SAME functions the component itself imports and
 * calls (lib/report-detail-poll.ts) — not a parallel description of them.
 * This repo has no React mounting harness (no jsdom/testing-library — see
 * tests/report-detail-route.test.mjs's own header comment on why component
 * behavior is otherwise proven via source text instead); node:test's own
 * built-in mock.timers stands in for "fake timers" here, driving the
 * REAL startBoundedPoll implementation through real async/microtask
 * ordering with virtual time, which is what actually proves the timing
 * claims (exactly N attempts, nothing further after exhaustion, a fresh
 * cycle on retry, no activity after cancel) rather than merely asserting
 * they're written that way in the source.
 *
 * Investigation finding, EXTENDED (also recorded in lib/report-detail-poll.ts's
 * own header comment): a first pass concluded the similarity lifecycle had
 * no terminal-failure representation at all. Re-inspected properly: the
 * real terminal-failure signal is lib/report-primary-similarity.ts's
 * resolvePrimarySimilaritySummary itself failing (its own inner try/catch
 * around computeUnifiedSimilarity — a genuine, reproducible
 * overall-computation failure for a report's own data), now propagated
 * through as DetailSimilarityStatus "failed". This is DISTINCT from a
 * fail-soft individual-source issue: ReportHistoricalSubmissionMatch
 * reaching its own real, persisted "FAILED"/"UNAVAILABLE" status
 * (lib/report-historical-match.ts's getOrComputeHistoricalMatchSnapshot,
 * itself never throwing) does NOT set this — lib/unified-similarity.ts's
 * computeUnifiedSimilarity only ever special-cases
 * historicalSubmissionMatch.status === "MATCHED" (see its own sole status
 * check); any other status, "UNAVAILABLE" included, simply contributes
 * zero historical words to an otherwise still-successful computation (see
 * tests/report-primary-similarity.test.mjs's own direct proof of this). So
 * "AI ready + explicit terminal similarity failure" — the mirror image of
 * the real, reachable "AI failed + similarity resolved" case — now has a
 * real, tested trigger too (see the dedicated test below), and
 * isSimilarityTerminal has two true branches ("resolved" and "failed").
 * The "REVEAL NEVER ONE-SIDED" sweep below exhaustively proves no
 * combination of the (now four-value) DetailSimilarityStatus, with any
 * aiStatus or pollExhausted value, can ever produce a "revealed" screen
 * unless similarityStatus is terminal.
 */

async function flushMicrotasks(times = 5) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

// --- computeDetailRevealState: pure reveal-decision function -------------

test("computeDetailRevealState: bothReady (AI terminal + similarity resolved) reveals, aiUnavailable/similarityUnavailable both false when everything genuinely succeeded", () => {
  const state = computeDetailRevealState({ aiStatus: "ready", similarityStatus: "resolved", pollExhausted: false });
  assert.deepEqual(state, { screen: "revealed", aiUnavailable: false, similarityUnavailable: false });
});

test("computeDetailRevealState (proves test-list item 7 — explicit terminal AI failure + terminal similarity success reveals together with AI Unavailable): a real, persisted ai_status 'failed' reveals together with the completed similarity result, never withheld", () => {
  const state = computeDetailRevealState({ aiStatus: "failed", similarityStatus: "resolved", pollExhausted: false });
  assert.deepEqual(state, { screen: "revealed", aiUnavailable: true, similarityUnavailable: false });
  // Exhaustion must never be a prerequisite for this — a genuine terminal
  // failure reveals immediately, on the very first poll that discovers it.
  const stateWithoutExhaustion = computeDetailRevealState({ aiStatus: "failed", similarityStatus: "resolved", pollExhausted: false });
  assert.equal(stateWithoutExhaustion.screen, "revealed");
});

test("REQUIRED (proves the headline LIFECYCLE-06 scenario: AI ready + genuine terminal similarity failure -> complete report becomes revealable with similarity Unavailable): a real, persisted unifiedSimilarityFailed-derived 'failed' status reveals together with the completed AI result, immediately — no poll exhaustion required, and never a temporary/partial score for either side", () => {
  const state = computeDetailRevealState({ aiStatus: "ready", similarityStatus: "failed", pollExhausted: false });
  assert.deepEqual(state, { screen: "revealed", aiUnavailable: false, similarityUnavailable: true });
  // REQUIRED: "terminal similarity failure does not wait forever" — this
  // must reveal on the very first check that discovers it, exactly like
  // the AI-failure mirror case above, never requiring the poll budget to
  // exhaust first.
  const stateWithoutExhaustion = computeDetailRevealState({ aiStatus: "ready", similarityStatus: "failed", pollExhausted: false });
  assert.equal(stateWithoutExhaustion.screen, "revealed", "REQUIRED: a genuine terminal failure must never need to wait out the poll budget to be shown");
});

test("computeDetailRevealState: both terminally failed/unavailable — AI failed, similarity failed — still reveals together, with both Unavailable", () => {
  const state = computeDetailRevealState({ aiStatus: "failed", similarityStatus: "failed", pollExhausted: false });
  assert.deepEqual(state, { screen: "revealed", aiUnavailable: true, similarityUnavailable: true });
});

test("computeDetailRevealState: the anonymous path's null ai_status (its own terminal convention) still reveals together with a genuinely resolved similarity", () => {
  const anonymousState = computeDetailRevealState({ aiStatus: null, similarityStatus: "resolved", pollExhausted: false });
  assert.deepEqual(anonymousState, { screen: "revealed", aiUnavailable: false, similarityUnavailable: false });
});

test("REQUIRED (proves test-list item 5 — AI ready + similarity still processing at exhaustion remains Still processing): exhausting the poll budget while similarity is still pending/stale does NOT reveal and does NOT synthesize an Unavailable similarity result", () => {
  for (const similarityStatus of /** @type {const} */ (["pending", "stale"])) {
    const state = computeDetailRevealState({ aiStatus: "ready", similarityStatus, pollExhausted: true });
    assert.equal(state.screen, "still-processing", `similarityStatus=${similarityStatus}: exhaustion must never promote a still-open similarity result to revealed`);
    // The "still-processing" variant of DetailRevealState structurally has
    // no aiUnavailable/similarityUnavailable field at all — there is
    // nothing for a caller to even read as "Unavailable" here, which is
    // the type-level guarantee behind this requirement, not just a runtime
    // check.
    assert.deepEqual(state, { screen: "still-processing" });
  }
});

test("REQUIRED: exhausting the poll budget while AI is still genuinely processing (similarity already resolved) also does NOT reveal and does NOT mutate ai_status into failed/unavailable", () => {
  const state = computeDetailRevealState({ aiStatus: "processing", similarityStatus: "resolved", pollExhausted: true });
  assert.deepEqual(state, { screen: "still-processing" }, "a timeout must never reinterpret a genuinely processing AI status as failed");
});

test("without exhaustion, a still-open pipeline shows the actively-polling loading screen, not still-processing", () => {
  assert.deepEqual(computeDetailRevealState({ aiStatus: "processing", similarityStatus: "pending", pollExhausted: false }), { screen: "loading" });
  assert.deepEqual(computeDetailRevealState({ aiStatus: "ready", similarityStatus: "pending", pollExhausted: false }), { screen: "loading" });
  assert.deepEqual(computeDetailRevealState({ aiStatus: "processing", similarityStatus: "resolved", pollExhausted: false }), { screen: "loading" });
});

test("REQUIRED (proves test-list item 8 — no intermediate render containing only one score/result): exhaustively, across every aiStatus/similarityStatus/pollExhausted combination, 'revealed' is reached if and only if BOTH aiTerminal and similarityTerminal are true", () => {
  const aiStatuses = /** @type {const} */ (["processing", "ready", "failed", null]);
  const similarityStatuses = /** @type {const} */ (["resolved", "stale", "pending", "failed"]);
  let revealedCount = 0;
  let oneSidedCount = 0;
  for (const aiStatus of aiStatuses) {
    for (const similarityStatus of similarityStatuses) {
      for (const pollExhausted of [false, true]) {
        const state = computeDetailRevealState({ aiStatus, similarityStatus, pollExhausted });
        const aiTerminal = isAiTerminal(aiStatus);
        const similarityTerminal = isSimilarityTerminal(similarityStatus);
        const bothTerminal = aiTerminal && similarityTerminal;
        if (bothTerminal) {
          revealedCount += 1;
          assert.equal(state.screen, "revealed", `aiStatus=${aiStatus} similarityStatus=${similarityStatus} pollExhausted=${pollExhausted}: both terminal must reveal`);
        } else {
          assert.notEqual(state.screen, "revealed", `aiStatus=${aiStatus} similarityStatus=${similarityStatus} pollExhausted=${pollExhausted}: REQUIRED — a one-sided-terminal state must never reveal, regardless of pollExhausted`);
          if (aiTerminal !== similarityTerminal) oneSidedCount += 1;
        }
      }
    }
  }
  // Sanity checks that this exhaustive sweep actually exercised both the
  // "reveals" and "one-sided, must not reveal" cases, so a future change
  // that accidentally made everything (or nothing) reveal would still fail
  // the assertions above rather than this test silently checking nothing.
  assert.ok(revealedCount > 0, "the sweep must include at least one genuinely both-terminal combination");
  assert.ok(oneSidedCount > 0, "the sweep must include at least one genuinely one-sided combination — this is the exact case that must never reveal");
});

test("isSimilarityTerminal has exactly two true branches ('resolved' and 'failed') — documents the EXTENDED investigation finding: a genuine, persisted computeUnifiedSimilarity failure is now a real terminal state, but 'stale'/'pending' remain non-terminal no matter how long they persist (see this file's own header comment)", () => {
  assert.equal(isSimilarityTerminal("resolved"), true);
  assert.equal(isSimilarityTerminal("failed"), true);
  assert.equal(isSimilarityTerminal("stale"), false);
  assert.equal(isSimilarityTerminal("pending"), false);
});

// --- startBoundedPoll: the bounded polling engine, driven by real async ---
// ordering + node:test's mock.timers (virtual time, no real waiting) -------

test("REQUIRED (proves test-list items 1 & 2 — persistent non-terminal responses exhaust exactly the bounded cycle, then no further automatic request occurs): a permanently-inconclusive attempt() is called exactly DETAIL_MAX_POLL_ATTEMPTS times, onExhausted fires exactly once, and time passing afterward triggers no further attempt", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let attemptCount = 0;
    let exhaustedCount = 0;
    startBoundedPoll({
      attempt: async () => { attemptCount += 1; return false; },
      onExhausted: () => { exhaustedCount += 1; },
      intervalMs: DETAIL_POLL_INTERVAL_MS,
      maxAttempts: DETAIL_MAX_POLL_ATTEMPTS,
    });
    await flushMicrotasks();
    assert.equal(attemptCount, 1, "the first attempt must fire immediately, without waiting for the interval");
    for (let i = 0; i < DETAIL_MAX_POLL_ATTEMPTS - 1; i++) {
      mock.timers.tick(DETAIL_POLL_INTERVAL_MS);
      await flushMicrotasks();
    }
    assert.equal(attemptCount, DETAIL_MAX_POLL_ATTEMPTS, `expected exactly ${DETAIL_MAX_POLL_ATTEMPTS} attempts`);
    assert.equal(exhaustedCount, 1, "onExhausted must fire exactly once");

    // REQUIRED: automatic polling stops at exhaustion — advance well past
    // several more intervals and confirm nothing further happens.
    mock.timers.tick(DETAIL_POLL_INTERVAL_MS * 10);
    await flushMicrotasks();
    assert.equal(attemptCount, DETAIL_MAX_POLL_ATTEMPTS, "no further automatic attempt may occur after exhaustion");
    assert.equal(exhaustedCount, 1, "onExhausted must never fire a second time");
  } finally {
    mock.timers.reset();
  }
});

test("startBoundedPoll: reaching terminal (attempt resolves true) stops immediately, before the attempt budget, and onExhausted never fires", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let attemptCount = 0;
    let exhaustedCount = 0;
    startBoundedPoll({
      attempt: async () => {
        attemptCount += 1;
        return attemptCount === 3; // terminal on the 3rd attempt
      },
      onExhausted: () => { exhaustedCount += 1; },
      intervalMs: DETAIL_POLL_INTERVAL_MS,
      maxAttempts: DETAIL_MAX_POLL_ATTEMPTS,
    });
    await flushMicrotasks();
    mock.timers.tick(DETAIL_POLL_INTERVAL_MS);
    await flushMicrotasks();
    mock.timers.tick(DETAIL_POLL_INTERVAL_MS);
    await flushMicrotasks();
    assert.equal(attemptCount, 3, "must stop at the terminal attempt, not continue to the budget");
    // Advance well past what would have been the remaining budget.
    mock.timers.tick(DETAIL_POLL_INTERVAL_MS * 10);
    await flushMicrotasks();
    assert.equal(attemptCount, 3, "no further attempts once terminal");
    assert.equal(exhaustedCount, 0, "onExhausted must never fire when the cycle resolved terminal instead of running out");
  } finally {
    mock.timers.reset();
  }
});

test("REQUIRED (proves test-list item 3 — Retry analysis resets the attempt budget and begins a genuinely fresh bounded cycle): calling startBoundedPoll again after a prior cycle exhausted runs a full, independent DETAIL_MAX_POLL_ATTEMPTS-attempt cycle from zero, exactly mirroring retryAnalysis() resetting pollExhausted and the effect re-running with a brand-new startBoundedPoll call", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let firstCycleAttempts = 0;
    startBoundedPoll({
      attempt: async () => { firstCycleAttempts += 1; return false; },
      onExhausted: () => {},
      intervalMs: DETAIL_POLL_INTERVAL_MS,
      maxAttempts: DETAIL_MAX_POLL_ATTEMPTS,
    });
    await flushMicrotasks();
    for (let i = 0; i < DETAIL_MAX_POLL_ATTEMPTS - 1; i++) {
      mock.timers.tick(DETAIL_POLL_INTERVAL_MS);
      await flushMicrotasks();
    }
    assert.equal(firstCycleAttempts, DETAIL_MAX_POLL_ATTEMPTS, "sanity: the first cycle must have exhausted");

    // Simulate retryAnalysis(): a brand-new startBoundedPoll call, this
    // time resolving terminal on its own 2nd attempt — proving the fresh
    // cycle can genuinely succeed, not just re-exhaust.
    let secondCycleAttempts = 0;
    let secondCycleExhausted = false;
    startBoundedPoll({
      attempt: async () => { secondCycleAttempts += 1; return secondCycleAttempts === 2; },
      onExhausted: () => { secondCycleExhausted = true; },
      intervalMs: DETAIL_POLL_INTERVAL_MS,
      maxAttempts: DETAIL_MAX_POLL_ATTEMPTS,
    });
    await flushMicrotasks();
    assert.equal(secondCycleAttempts, 1, "the fresh cycle must start its own count at 1, not resume from the exhausted count of 10");
    mock.timers.tick(DETAIL_POLL_INTERVAL_MS);
    await flushMicrotasks();
    assert.equal(secondCycleAttempts, 2, "the fresh cycle terminates on its own 2nd attempt");
    assert.equal(secondCycleExhausted, false, "resolving terminal within the fresh budget must never report exhausted");
    assert.equal(firstCycleAttempts, DETAIL_MAX_POLL_ATTEMPTS, "the first (already-finished) cycle's own count must be untouched by the second cycle");
  } finally {
    mock.timers.reset();
  }
});

test("REQUIRED (proves test-list item 9 — unmount cancels pending timer activity and no later fetch/poll occurs after unmount): cancel() mid-cycle stops all further attempts, even though several intervals still pass afterward", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let attemptCount = 0;
    const handle = startBoundedPoll({
      attempt: async () => { attemptCount += 1; return false; },
      onExhausted: () => { throw new Error("must never reach exhaustion once cancelled"); },
      intervalMs: DETAIL_POLL_INTERVAL_MS,
      maxAttempts: DETAIL_MAX_POLL_ATTEMPTS,
    });
    await flushMicrotasks();
    mock.timers.tick(DETAIL_POLL_INTERVAL_MS);
    await flushMicrotasks();
    mock.timers.tick(DETAIL_POLL_INTERVAL_MS);
    await flushMicrotasks();
    assert.equal(attemptCount, 3, "sanity: a few attempts happened before cancellation");

    handle.cancel();
    mock.timers.tick(DETAIL_POLL_INTERVAL_MS * (DETAIL_MAX_POLL_ATTEMPTS + 5));
    await flushMicrotasks();
    assert.equal(attemptCount, 3, "REQUIRED: no attempt may occur after cancel(), no matter how much time passes");
  } finally {
    mock.timers.reset();
  }
});

test("cancel() during an in-flight (already-started but not yet resolved) attempt prevents that attempt's own result from scheduling a further poll", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let attemptCount = 0;
    let resolveInFlight;
    const inFlight = new Promise((resolve) => { resolveInFlight = resolve; });
    const handle = startBoundedPoll({
      attempt: async () => {
        attemptCount += 1;
        if (attemptCount === 1) {
          await inFlight; // block the first attempt until the test resolves it, after cancel() has already run
        }
        return false;
      },
      onExhausted: () => { throw new Error("must never reach exhaustion — cancelled while the first attempt was still in flight"); },
      intervalMs: DETAIL_POLL_INTERVAL_MS,
      maxAttempts: DETAIL_MAX_POLL_ATTEMPTS,
    });
    await flushMicrotasks();
    assert.equal(attemptCount, 1, "the first attempt must have started");

    handle.cancel();
    resolveInFlight(); // let the already-in-flight attempt's own await finish, AFTER cancel() ran
    await flushMicrotasks();
    mock.timers.tick(DETAIL_POLL_INTERVAL_MS * 3);
    await flushMicrotasks();
    assert.equal(attemptCount, 1, "REQUIRED: the in-flight attempt resolving after cancel() must not schedule a second one");
  } finally {
    mock.timers.reset();
  }
});
