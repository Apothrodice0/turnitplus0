import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fetchReportRoomIndex, fetchReportRoomContents, fetchRemoteReport, saveReportRemote, classifySaveReportRemoteResult } from "../lib/reports-remote.ts";

/**
 * Production bug fix: fetchReportRoomIndex/fetchReportRoomContents used to
 * collapse EVERY failure mode (429 rate-limited, 500 server error, network
 * failure, malformed response) into the exact same shape a genuinely empty
 * room/room-list returns — "request failed" and "empty" (and, one layer up
 * in the UI, "logged out") must never be conflated; a failed request proves
 * nothing about what's actually in the account. Real fetch stubbing (no
 * mocking framework in this codebase's existing conventions) against the
 * actual exported functions — these two specifically never touch
 * lib/device-key.ts's window-dependent getDeviceKey(), so they're safe to
 * call directly in this Node test environment.
 */

function stubFetchOnce(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => handler(...args);
  return () => {
    globalThis.fetch = original;
  };
}

/**
 * Preview receipt regression follow-up: unlike fetchReportRoomIndex/
 * fetchReportRoomContents above, fetchRemoteReport DOES call
 * lib/device-key.ts's getDeviceKey(), which reads window.localStorage — a
 * real browser global this Node test environment does not have. A minimal,
 * in-memory Map-backed stand-in, scoped to just these tests, is enough to
 * let the REAL fetchRemoteReport run its real body end to end (never a
 * reimplementation of it) while still exercising a real stubbed fetch()
 * underneath.
 */
function stubWindowLocalStorage() {
  const originalWindow = globalThis.window;
  const store = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => { store.set(key, value); },
    },
  };
  return () => {
    globalThis.window = originalWindow;
  };
}

test("fetchReportRoomIndex: a 429 response is reported as a real failure, never as an empty rooms array", async () => {
  const restore = stubFetchOnce(async () => new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 }));
  try {
    const result = await fetchReportRoomIndex();
    assert.deepEqual(result, { ok: false, status: 429 });
  } finally {
    restore();
  }
});

test("fetchReportRoomIndex: a 500 response is reported as a real failure, never as an empty rooms array", async () => {
  const restore = stubFetchOnce(async () => new Response(JSON.stringify({ error: "Internal error" }), { status: 500 }));
  try {
    const result = await fetchReportRoomIndex();
    assert.deepEqual(result, { ok: false, status: 500 });
  } finally {
    restore();
  }
});

test("fetchReportRoomIndex: a thrown network error is reported as a real failure (status: null), never as an empty rooms array", async () => {
  const restore = stubFetchOnce(async () => {
    throw new TypeError("Failed to fetch");
  });
  try {
    const result = await fetchReportRoomIndex();
    assert.deepEqual(result, { ok: false, status: null });
  } finally {
    restore();
  }
});

test("fetchReportRoomIndex: a genuine 200 with real rooms still resolves ok:true with the actual data — the fix didn't break the success path", async () => {
  const rooms = [{ room: 0, status: "empty", mostRecentAt: null, cycleEndsAt: null }];
  const restore = stubFetchOnce(async () => new Response(JSON.stringify({ rooms }), { status: 200 }));
  try {
    const result = await fetchReportRoomIndex();
    assert.deepEqual(result, { ok: true, rooms });
  } finally {
    restore();
  }
});

test("fetchReportRoomContents: a 429 response is reported as a real failure, never as an empty-room result", async () => {
  const restore = stubFetchOnce(async () => new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 }));
  try {
    const result = await fetchReportRoomContents(3);
    assert.deepEqual(result, { ok: false, status: 429 });
  } finally {
    restore();
  }
});

test("fetchReportRoomContents: a 500 response is reported as a real failure, never as an empty-room result", async () => {
  const restore = stubFetchOnce(async () => new Response(JSON.stringify({ error: "Internal error" }), { status: 500 }));
  try {
    const result = await fetchReportRoomContents(3);
    assert.deepEqual(result, { ok: false, status: 500 });
  } finally {
    restore();
  }
});

test("fetchReportRoomContents: a thrown network error is reported as a real failure (status: null), never as an empty-room result", async () => {
  const restore = stubFetchOnce(async () => {
    throw new TypeError("Failed to fetch");
  });
  try {
    const result = await fetchReportRoomContents(3);
    assert.deepEqual(result, { ok: false, status: null });
  } finally {
    restore();
  }
});

test("fetchReportRoomContents: a genuine 200 for a truly empty room still resolves ok:true with status 'empty' — the fix didn't break the real empty case", async () => {
  const restore = stubFetchOnce(async () => new Response(JSON.stringify({ status: "empty", report: null, cycleEndsAt: null }), { status: 200 }));
  try {
    const result = await fetchReportRoomContents(3);
    assert.deepEqual(result, { ok: true, contents: { status: "empty", report: null, cycleEndsAt: null } });
  } finally {
    restore();
  }
});

/**
 * Preview receipt regression follow-up: verifies fetchRemoteReport's exact
 * failure contract, which app/reports/rooms/[room]/room-page-shell.tsx's
 * handleDownloadReceipt and components/reports/report-history-row.tsx's
 * equivalent handler now both depend on via
 * `const full = remote ?? (await getStoredReportById(...).catch(() => null))`.
 * That fallback is only correct if fetchRemoteReport (a) NEVER throws past
 * this function — a rejection here would skip the local fallback entirely,
 * crashing the receipt download instead of degrading to it — and (b) only
 * ever returns null for a genuine request failure, never for a syntactically
 * valid response whose score merely happens to be 0. Both are already
 * guaranteed by fetchRemoteReport's own try/catch and `!response.ok` check
 * (lib/reports-remote.ts) — proven directly below against the real,
 * unmodified function, not a description of it.
 */
test("fetchRemoteReport: a thrown network error resolves null, never rejects — the receipt/detail resolution's own `remote ?? local` fallback depends on this never throwing", async () => {
  const restoreFetch = stubFetchOnce(async () => {
    throw new TypeError("Failed to fetch");
  });
  const restoreWindow = stubWindowLocalStorage();
  try {
    const result = await fetchRemoteReport("some-report-id");
    assert.equal(result, null, "a genuine network failure must resolve null, not throw — the caller's own `??` fallback only ever runs on null/undefined");
  } finally {
    restoreFetch();
    restoreWindow();
  }
});

test("fetchRemoteReport: a 500/404 HTTP failure resolves null, never throws", async () => {
  const restoreWindow = stubWindowLocalStorage();
  try {
    for (const status of [404, 500]) {
      const restoreFetch = stubFetchOnce(async () => new Response(JSON.stringify({ error: "failed" }), { status }));
      try {
        const result = await fetchRemoteReport("some-report-id");
        assert.equal(result, null, `a ${status} response must resolve null, matching the local-fallback contract`);
      } finally {
        restoreFetch();
      }
    }
  } finally {
    restoreWindow();
  }
});

test("fetchRemoteReport: a genuine 200 response with a real 0% score resolves to the full payload object, never null — a legitimate zero must never be conflated with a request failure", async () => {
  const zeroScorePayload = {
    id: "zero-score-report", title: "Zero-score fixture", wordCount: 500, archiveScore: 0,
    unifiedSimilarity: { version: "unified-similarity-v1", wordCount: 500, unifiedScore: 0, uniqueMatchedWords: 0, archiveOnlyWords: 0, liveAcademicOnlyWords: 0, previousUploadOnlyWords: 0, overlapWords: 0, selfExcludedWords: 0, unknownExcludedWords: 0, contributions: [] },
  };
  const restoreFetch = stubFetchOnce(async () => new Response(JSON.stringify({ payload: zeroScorePayload }), { status: 200 }));
  const restoreWindow = stubWindowLocalStorage();
  try {
    const result = await fetchRemoteReport("zero-score-report");
    assert.notEqual(result, null, "REQUIRED: a genuinely successful response must never be treated as a failure just because the score inside it is 0");
    assert.deepEqual(result, zeroScorePayload, "the full authoritative payload — 0% and all — must pass through untouched, never discarded in favor of a local fallback");
  } finally {
    restoreFetch();
    restoreWindow();
  }
});

test("REQUIRED (proves the receipt's exact `remote ?? local` line): a network failure falls back to the local value; a genuine 0% remote is used as-is, never overridden by a stale local value", async () => {
  const staleLocalValue = { id: "receipt-fallback-fixture", title: "Stale local fixture", unifiedSimilarity: { unifiedScore: 42 } };
  const restoreWindow = stubWindowLocalStorage();
  try {
    // Case 1: the network request itself fails.
    let restoreFetch = stubFetchOnce(async () => { throw new TypeError("Failed to fetch"); });
    try {
      const remote = await fetchRemoteReport("receipt-fallback-fixture");
      const full = remote ?? staleLocalValue;
      assert.equal(full, staleLocalValue, "REQUIRED: only a genuine remote failure may fall back to the local value");
    } finally {
      restoreFetch();
    }

    // Case 2: the server responds with a real, valid 0% — must be used as-is.
    const zeroScoreRemote = { id: "receipt-fallback-fixture", title: "Fresh server fixture", unifiedSimilarity: { unifiedScore: 0 } };
    restoreFetch = stubFetchOnce(async () => new Response(JSON.stringify({ payload: zeroScoreRemote }), { status: 200 }));
    try {
      const remote = await fetchRemoteReport("receipt-fallback-fixture");
      const full = remote ?? staleLocalValue;
      assert.notEqual(full, staleLocalValue, "REQUIRED: a valid remote 0% must never be discarded in favor of a stale local value merely because the score is 0");
      assert.deepEqual(full, zeroScoreRemote, "the full remote payload — 0% and all — must be what the receipt actually uses");
      assert.equal(full.unifiedSimilarity.unifiedScore, 0);
    } finally {
      restoreFetch();
    }
  } finally {
    restoreWindow();
  }
});

/**
 * Pre-launch hardening fix — "will retry automatically" removal.
 *
 * saveReportRemote/classifySaveReportRemoteResult are the REAL production
 * functions (no mocking framework in this codebase's existing conventions —
 * see this file's own header comment): every case below stubs only
 * globalThis.fetch/window.localStorage and calls the genuine exported code.
 * A minimal ReportSummary fixture with no `report.text` field keeps
 * maybeAttestReportUpload's Device Passport attestation on its documented
 * fast no-op path (see lib/device-passport.ts's own header comment) without
 * needing to stub WebAuthn/crypto.
 */
const MINIMAL_SUMMARY = {
  id: "save-result-fixture",
  submissionId: "submission-fixture",
  title: "Fixture report",
  createdAt: new Date().toISOString(),
  wordCount: 500,
  archiveScore: 10,
  scoreBand: "low",
  aiScore: null,
  aiTone: null,
};

test("saveReportRemote + classifySaveReportRemoteResult: a genuine 2xx save classifies as SUCCESS", async () => {
  const restoreFetch = stubFetchOnce(async () => new Response(JSON.stringify({}), { status: 200 }));
  const restoreWindow = stubWindowLocalStorage();
  try {
    const result = await saveReportRemote({}, MINIMAL_SUMMARY);
    assert.deepEqual(result, { ok: true });
    assert.equal(classifySaveReportRemoteResult(result), "SUCCESS");
  } finally {
    restoreFetch();
    restoreWindow();
  }
});

test("saveReportRemote + classifySaveReportRemoteResult: HTTP 413 (request/payload too large) classifies as REQUEST_TOO_LARGE, matching app/api/reports/route.ts's exact 'Payload too large' shape", async () => {
  const restoreFetch = stubFetchOnce(async () => new Response(JSON.stringify({ error: "Payload too large" }), { status: 413 }));
  const restoreWindow = stubWindowLocalStorage();
  try {
    const result = await saveReportRemote({}, MINIMAL_SUMMARY);
    assert.equal(result.ok, false);
    assert.equal(result.status, 413);
    assert.equal(classifySaveReportRemoteResult(result), "REQUEST_TOO_LARGE");
  } finally {
    restoreFetch();
    restoreWindow();
  }
});

test("saveReportRemote + classifySaveReportRemoteResult: a generic deterministic 4xx (400) classifies as CLIENT_REJECTED, distinct from REQUEST_TOO_LARGE and from a transient failure", async () => {
  const restoreFetch = stubFetchOnce(async () => new Response(JSON.stringify({ error: "Bad request" }), { status: 400 }));
  const restoreWindow = stubWindowLocalStorage();
  try {
    const result = await saveReportRemote({}, MINIMAL_SUMMARY);
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(classifySaveReportRemoteResult(result), "CLIENT_REJECTED");
  } finally {
    restoreFetch();
    restoreWindow();
  }
});

// One-current-report-per-room, hardening pass: roomReuseNotReady requires
// BOTH status 503 AND body.code === "ROOM_REUSE_NOT_READY" — never status
// alone, since a 503 can also come from a platform/infrastructure failure
// that never reaches application code (a different or absent body).

test("A. saveReportRemote + classifySaveReportRemoteResult: HTTP 503 WITH { code: 'ROOM_REUSE_NOT_READY' } sets roomReuseNotReady=true and classifies as TRANSIENT_OR_UNKNOWN, never conflated with roomOccupied's own distinct 409", async () => {
  const restoreFetch = stubFetchOnce(async () =>
    new Response(JSON.stringify({ error: "This room is finishing its previous check. Please try again shortly.", code: "ROOM_REUSE_NOT_READY" }), { status: 503 }),
  );
  const restoreWindow = stubWindowLocalStorage();
  try {
    const result = await saveReportRemote({}, MINIMAL_SUMMARY);
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.roomReuseNotReady, true);
    assert.equal(result.roomOccupied, false);
    assert.equal(classifySaveReportRemoteResult(result), "TRANSIENT_OR_UNKNOWN");
  } finally {
    restoreFetch();
    restoreWindow();
  }
});

test("B. saveReportRemote: HTTP 503 with a generic/empty body (no code at all — e.g. a platform/infrastructure 503 that never reached application code) sets roomReuseNotReady=false, never misclassified", async () => {
  const restoreFetch = stubFetchOnce(async () => new Response("", { status: 503 }));
  const restoreWindow = stubWindowLocalStorage();
  try {
    const result = await saveReportRemote({}, MINIMAL_SUMMARY);
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.roomReuseNotReady, false, "a bare 503 with no matching application code must never be treated as the room-reuse condition");
    assert.equal(classifySaveReportRemoteResult(result), "TRANSIENT_OR_UNKNOWN");
  } finally {
    restoreFetch();
    restoreWindow();
  }
});

test("C. saveReportRemote: HTTP 503 with a DIFFERENT application code ({ code: 'SOME_OTHER_ERROR' }) sets roomReuseNotReady=false — the discriminator checks the exact code, not just that some code is present", async () => {
  const restoreFetch = stubFetchOnce(async () => new Response(JSON.stringify({ error: "Something else entirely", code: "SOME_OTHER_ERROR" }), { status: 503 }));
  const restoreWindow = stubWindowLocalStorage();
  try {
    const result = await saveReportRemote({}, MINIMAL_SUMMARY);
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.roomReuseNotReady, false);
    assert.equal(classifySaveReportRemoteResult(result), "TRANSIENT_OR_UNKNOWN");
  } finally {
    restoreFetch();
    restoreWindow();
  }
});

test("D. saveReportRemote: HTTP 409 ROOM_OCCUPIED semantics are unchanged by the roomReuseNotReady hardening — roomOccupied=true, roomReuseNotReady=false", async () => {
  const restoreFetch = stubFetchOnce(async () =>
    new Response(JSON.stringify({ error: "Room 1 already has an active report. It will be available again at 2026-01-01T00:00:00.000Z.", cycleEndsAt: "2026-01-01T00:00:00.000Z" }), { status: 409 }),
  );
  const restoreWindow = stubWindowLocalStorage();
  try {
    const result = await saveReportRemote({}, MINIMAL_SUMMARY);
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.equal(result.roomOccupied, true);
    assert.equal(result.roomReuseNotReady, false);
    assert.equal(result.cycleEndsAt, "2026-01-01T00:00:00.000Z");
    assert.equal(classifySaveReportRemoteResult(result), "CLIENT_REJECTED");
  } finally {
    restoreFetch();
    restoreWindow();
  }
});

test("saveReportRemote + classifySaveReportRemoteResult: HTTP 500 classifies as TRANSIENT_OR_UNKNOWN", async () => {
  const restoreFetch = stubFetchOnce(async () => new Response(JSON.stringify({ error: "Internal error" }), { status: 500 }));
  const restoreWindow = stubWindowLocalStorage();
  try {
    const result = await saveReportRemote({}, MINIMAL_SUMMARY);
    assert.equal(result.ok, false);
    assert.equal(result.status, 500);
    assert.equal(classifySaveReportRemoteResult(result), "TRANSIENT_OR_UNKNOWN");
  } finally {
    restoreFetch();
    restoreWindow();
  }
});

test("saveReportRemote + classifySaveReportRemoteResult: a thrown network/fetch exception classifies as TRANSIENT_OR_UNKNOWN (status 0), and saveReportRemote never throws past this — the local copy is always the caller's own separate, already-completed step", async () => {
  const restoreFetch = stubFetchOnce(async () => {
    throw new TypeError("Failed to fetch");
  });
  const restoreWindow = stubWindowLocalStorage();
  try {
    const result = await saveReportRemote({}, MINIMAL_SUMMARY);
    assert.deepEqual(result, { ok: false, status: 0, quotaExceeded: false, roomOccupied: false, roomReuseNotReady: false, emailVerificationRequired: false });
    assert.equal(classifySaveReportRemoteResult(result), "TRANSIENT_OR_UNKNOWN");
  } finally {
    restoreFetch();
    restoreWindow();
  }
});

test("REGRESSION: the customer-facing save path makes no 'will retry automatically' (or equivalent) promise anywhere it is not actually true", async () => {
  // No automatic retry mechanism exists anywhere in this codebase (no
  // background timers, queue persistence, service workers, or repeated
  // fetch loops) — see this fix's own scope notes. Reads the REAL shipped
  // source text of every file that renders a save-result message to the
  // user, so a future regression restoring the false claim (here or in a
  // sibling save-failure code path) fails this test immediately.
  const filesToCheck = ["../app/page.tsx", "../app/reports/rooms/[room]/room-page-shell.tsx", "../lib/reports-remote.ts"];
  for (const relativePath of filesToCheck) {
    const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
    // Strip comments first so this only inspects text that could actually
    // reach a user — this fix's own explanatory comment legitimately
    // mentions the old (removed) claim by name.
    const withoutLineComments = source.replace(/\/\/.*$/gm, "");
    const withoutBlockComments = withoutLineComments.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(
      withoutBlockComments,
      /retry automatically/i,
      `${relativePath} must not promise an automatic retry outside of comments — no such mechanism exists`,
    );
  }
});
