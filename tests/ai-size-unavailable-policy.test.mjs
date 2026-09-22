import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The room / detail / history components are real client components: next/link and next/navigation are redirected to stand-ins
// (same arrangement as the R2 SSR tests). Register BEFORE dynamically importing them.
register("./helpers/ssr-next-hooks.mjs", import.meta.url);

import * as fx from "./helpers/large-report-retry-fixture.mjs";
import { createKit, sha, num, payloadOf, lastPost } from "./helpers/ai-compact-integration-kit.mjs";
import { synthProse } from "./helpers/real-ai-windows.mjs";
import { fetchRemoteReport, fetchReportRoomContents, saveReportRemote } from "../lib/reports-remote.ts";
import { persistAiCompletion, persistAiRetryResult } from "../lib/report-ai-completion.ts";
import { buildReportSummary, aiSignalDisplay } from "../lib/report-types.ts";
import { MAX_REPORT_SAVE_REQUEST_BYTES, persistedPayloadSize, persistedFitFromSqlBounds } from "../lib/report-transport-limits.ts";
import { prepareAiAnalysisForTransport } from "../lib/ai-passage-table.ts";
import { isAiCompactPassagesWriteEnabled, AI_COMPACT_PASSAGES_WRITE_FLAG } from "../lib/ai-compact-passages-flag.ts";
import * as unavailable from "../lib/ai-unavailable-state.ts";
import { buildAiSizeUnavailableTelemetryEvent } from "../lib/ai-size-unavailable-telemetry.ts";
import { resolveAiDisplayState } from "../lib/ai-display-state.ts";
import { deriveRoomStatus } from "../lib/report-rooms.ts";
import { computeDetailRevealState } from "../lib/report-detail-poll.ts";

const roomShell = await import("../app/reports/rooms/[room]/room-page-shell.tsx");
const { ReportHistoryRow } = await import("../components/reports/report-history-row.tsx");
const { AiReport } = await import("../components/report/ai-report.tsx");
const { ReportDetailShell } = await import("../app/reports/[id]/report-detail-shell.tsx");

/**
 * G2 — POLICY_B_KEEP_REPORT_AI_UNAVAILABLE_FOR_SIZE.
 *
 * AI-writing analysis is enrichment on a similarity report that is already valid. If the real AI result cannot be stored next
 * to that report inside the (unchanged) 2,000,000-character persisted ceiling, the report must still finish: similarity is left
 * exactly as it is and the AI half ends in a tiny, honest, TERMINAL "unavailable" state, decided by the SERVER from its own exact
 * projected size — never by a manuscript-length threshold and never by anything a browser declares.
 *
 * Everything drives the REAL route handlers against a real, throwaway, migrated SQLite DB through the REAL client helpers (fetch
 * is routed to the handlers, with an explicit content-length as a browser sends). All text is synthetic. The ai-compact-v1 WRITER
 * gate (default OFF, NEXT_PUBLIC_AI_COMPACT_PASSAGES_WRITE_ENABLED) is pinned ON process-locally for this file — the activation
 * configuration the policy is validated in — and restored afterwards (asserted at the end). The report compact-write flag stays at
 * its default (OFF). The two heavy regressions (a ~1.85M-character manuscript, a dense-evidence report) live in
 * tests/ai-size-unavailable-large-regression.test.mjs.
 *
 * Sections:  A server decision · B trust boundary · C automatic fallback · D boundaries · E first-save reserve · F stale Retry ·
 *            G UI (room / detail / receipt / history) · H safety · I regressions · J logging · K compatibility
 */

const MAX = MAX_REPORT_SAVE_REQUEST_BYTES;
const MARKER = unavailable.buildSizeUnavailableAiAnalysis();
const MARKER_JSON = JSON.stringify(MARKER);
const TEXT = synthProse(40_000, { seed: 31, messiness: 0.01 });

// Set up EVERYTHING before the first test() is registered (node:test starts a test the moment it is registered).
const env = await fx.createFixtureEnvironment("g2_size_policy");
process.env.TURSO_DATABASE_URL = `file:${env.dbFile}`;
const kit = createKit(env);
const ambientAiFlag = process.env[AI_COMPACT_PASSAGES_WRITE_FLAG];
const restoreC2 = fx.pinCompactWrites(undefined);
const restoreAi = fx.pinAiCompactWrites("true");
test.after(() => {
  restoreAi();
  restoreC2();
  env.dispose();
});

const newAccount = () => env.signUpAccount();

// ----------------------------------------------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------------------------------------------

const realAi = (text = TEXT, status = "complete") => fx.syntheticAiAnalysis(text, { status });
const wireOf = (aiAnalysis, text = TEXT) => prepareAiAnalysisForTransport(aiAnalysis, text);

/** The enrichment the room performs once the model has answered, and the summary it derives — exactly as room-page-shell.tsx does. */
function enrich(report, text = TEXT, status = "complete") {
  const aiResult = { aiScore: status === "complete" ? 7 : null, aiAnalysis: realAi(text, status) };
  const enriched = { ...report, ...aiResult };
  const summary = { ...buildReportSummary(enriched), aiStatus: status === "complete" ? "ready" : "failed", similarityStatus: "pending" };
  return { aiResult, enriched, summary };
}

async function snapshot(id) {
  const row = await kit.readRow(id);
  return sha(JSON.stringify([num(row.ai_score), row.ai_tone, row.ai_status, row.payload_json]));
}

async function rawSubtrees(id) {
  const result = await env.client.execute({
    sql: `SELECT json_extract(payload_json, '$.unifiedSimilarity') AS us, json_extract(payload_json, '$.evidenceInterpretation') AS ei,
                 json_extract(payload_json, '$.reportCompletion') AS rc, json_extract(payload_json, '$.unifiedSimilarityGeneration') AS gen
          FROM saved_reports WHERE id = ?`,
    args: [id],
  });
  const row = result.rows[0];
  return { us: String(row.us), ei: String(row.ei), rc: String(row.rc), gen: num(row.gen) };
}

const withoutAiFields = (payload) => {
  const { aiAnalysis: _a, aiScore: _s, __pad: _p, ...rest } = payload;
  return rest;
};

const EMOJI = "\u{1F600}"; // U+1F600: 1 code point, 2 UTF-16 code units, 4 UTF-8 bytes

/**
 * THE CANONICAL SIZE the ceiling is about (persistedPayloadSize: UTF-16 code units of the serialized JSON) of the payload a write of
 * `analysis` (with raw score `rawAiScore`) WOULD store for report `id` — measured on an ACTUAL merge: the same `json_set` the route
 * issues, applied in a rolled-back transaction and read back as a JS string. Independent of the route's own decision path, and
 * exact by construction (it includes whatever SQLite really writes, e.g. `5.0` for a bound integer-valued score).
 */
async function mergedMeasure(id, analysis, rawAiScore = 5) {
  const tx = await env.client.transaction("write");
  try {
    await tx.execute({
      sql: "UPDATE saved_reports SET payload_json = json_set(payload_json, '$.aiAnalysis', json(?), '$.aiScore', ?) WHERE id = ?",
      args: [JSON.stringify(analysis), rawAiScore, id],
    });
    const row = (await tx.execute({ sql: "SELECT payload_json, length(payload_json) AS cp, length(CAST(payload_json AS BLOB)) AS bytes FROM saved_reports WHERE id = ?", args: [id] })).rows[0];
    return { units: persistedPayloadSize(String(row.payload_json)), codePoints: num(row.cp), utf8Bytes: num(row.bytes) };
  } finally {
    await tx.rollback().catch(() => {});
    tx.close();
  }
}
const mergedUnits = async (id, analysis, rawAiScore = 5) => (await mergedMeasure(id, analysis, rawAiScore)).units;

/** The stored payload's size in the canonical unit, and its SQL `length()` (code points) — they differ by the number of astral characters. */
async function storedSizes(id) {
  const row = (await env.client.execute({ sql: "SELECT payload_json, length(payload_json) AS code_points FROM saved_reports WHERE id = ?", args: [id] })).rows[0];
  return { units: persistedPayloadSize(String(row.payload_json)), sqlCodePoints: num(row.code_points) };
}

/** The pre-correction route's arithmetic, kept ONLY to document what it would have decided: SQL code points for the stored terms, JS units for the candidate, +64. */
async function preCorrectionProjection(id, analysis) {
  const r = (await env.client.execute({ sql: "SELECT length(payload_json) AS p, length(json_extract(payload_json, '$.aiAnalysis')) AS a FROM saved_reports WHERE id = ?", args: [id] })).rows[0];
  return num(r.p) - num(r.a ?? 0) + JSON.stringify(analysis).length + 64;
}

/**
 * Test-only direct edit: sets a plain `__pad` string (`astral` non-BMP characters, then ASCII filler) in the STORED payload until the
 * canonical merged size of writing `analysis` is exactly `target`. `astral` lets a fixture be Unicode-heavy without changing the target.
 */
async function padTo(id, analysis, target, { raw = 5, astral = 0 } = {}) {
  const setPad = (ascii) => env.client.execute({ sql: "UPDATE saved_reports SET payload_json = json_set(payload_json, '$.__pad', ?) WHERE id = ?", args: [EMOJI.repeat(astral) + "p".repeat(ascii), id] });
  await setPad(0);
  for (let i = 0; i < 4; i += 1) {
    const current = await mergedUnits(id, analysis, raw);
    if (current === target) return;
    const pad = String((await env.client.execute({ sql: "SELECT json_extract(payload_json, '$.__pad') AS p FROM saved_reports WHERE id = ?", args: [id] })).rows[0].p);
    await setPad(Math.max(0, pad.length - 2 * astral + (target - current)));
  }
  assert.equal(await mergedUnits(id, analysis, raw), target, "fixture sanity: padded to the exact canonical merged size");
}

/** A first save (the report exists, AI still `processing`), returning the client-side report. */
const seed = (account, id, room, text = TEXT) => kit.firstSave(account, id, text, room);

/** Reads the report row's AI half. */
async function aiHalf(id) {
  const row = await kit.readRow(id);
  const payload = payloadOf(row);
  return { ai_status: row.ai_status, ai_score: num(row.ai_score), ai_tone: row.ai_tone, aiAnalysis: payload.aiAnalysis, aiScore: payload.aiScore, chars: String(row.payload_json).length };
}

const failedBody = (extraAnalysis = {}) => ({
  aiStatus: "failed", aiScore: null, aiTone: null,
  payload: { aiScore: null, aiAnalysis: { ...realAi(TEXT, "error"), ...extraAnalysis } },
});

const room0 = (overrides = {}) => ({ room: 0, accountEmail: "size-policy@example.test", ...overrides });
const renderRoom = (occupant) => renderToStaticMarkup(React.createElement(roomShell.RoomPageShell, { ...room0(), initialOccupant: occupant }));
const CYCLE_END = () => new Date(Date.now() + 86_400_000).toISOString();
const TECHNICAL = /2,000,000|2 MB|2MB|ceiling|storage limit|too large|payload|persist|bytes|REPORT_SIZE|projected/i;

const measured = { markerChars: MARKER_JSON.length };

// ----------------------------------------------------------------------------------------------------------------
// A. THE SERVER'S EXACT SIZE DECISION
// ----------------------------------------------------------------------------------------------------------------

test("A1 FITS: a real AI result that fits next to the saved report is persisted normally — ready, its score, its analysis, no marker, no outcome flag; similarity untouched", async () => {
  const account = await newAccount();
  await kit.asBrowser(account, async () => {
    const id = "szA1-fit";
    const report = await seed(account, id, 0);
    const subtreesBefore = await rawSubtrees(id);
    const { enriched, summary, aiResult } = enrich(report);
    const saved = await persistAiRetryResult(enriched, summary);
    assert.equal(saved.ok, true);
    assert.equal(saved.summary, summary, "nothing was overridden: the caller's own summary comes back");
    assert.equal(saved.summary.aiUnavailableReason, undefined);
    const half = await aiHalf(id);
    assert.equal(half.ai_status, "ready");
    assert.equal(half.ai_score, summary.aiScore);
    assert.equal(half.aiAnalysis.status, "complete");
    assert.equal("unavailableReason" in half.aiAnalysis, false, "a fitting result is never replaced by the marker");
    assert.equal(half.aiScore, aiResult.aiScore);
    assert.deepEqual(await rawSubtrees(id), subtreesBefore, "similarity / explanation / completion are byte-identical");
  });
  // The raw route answer for a fitting result is the plain { ok: true } — no outcome flag.
  const other = await newAccount();
  await kit.asBrowser(other, async () => {
    await seed(other, "szA1-raw", 0);
  });
  const direct = await kit.callRetryRoute("szA1-raw", { body: kit.retryBodyFor(wireOf(realAi())), cookie: other.cookie });
  assert.equal(direct.status, 200);
  assert.deepEqual(direct.json, { ok: true });
});

test("A2 TOO LARGE: a real result that would push the saved report over the ceiling is NOT persisted — the server writes its own tiny terminal 'AI unavailable' state; similarity is byte-identical; no score", async () => {
  const account = await newAccount();
  await kit.asBrowser(account, async (route) => {
    const id = "szA2-over";
    const report = await seed(account, id, 0);
    const { enriched, summary } = enrich(report);
    await padTo(id, wireOf(enriched.aiAnalysis), MAX + 1); // the real result exceeds the ceiling by exactly one character (canonical units)
    const roomBefore = await fetchReportRoomContents(0);
    const before = await kit.readRow(id);
    const subtreesBefore = await rawSubtrees(id);

    const saved = await persistAiRetryResult(enriched, summary);
    const request = lastPost(route, (r) => r.path === `/api/reports/${id}/ai-retry`);
    assert.equal(request.status, 200, "no 413");
    assert.ok(request.bytes < MAX, "the request itself was tiny (compact wire form)");
    assert.equal(saved.ok, true, "the save succeeded: the report reached a terminal AI state");
    assert.equal(saved.summary.aiStatus, "failed");
    assert.equal(saved.summary.aiScore, null);
    assert.equal(saved.summary.aiTone, "unavailable");
    assert.equal(saved.summary.aiUnavailableReason, "REPORT_SIZE");

    const half = await aiHalf(id);
    assert.equal(half.ai_status, "failed");
    assert.equal(half.ai_score, null, "no AI score");
    assert.equal(half.ai_tone, "unavailable");
    assert.equal(half.aiScore, null);
    assert.deepEqual(half.aiAnalysis, MARKER, "exactly the server-authored marker");
    assert.deepEqual(half.aiAnalysis.passages, [], "no passage array, no manuscript copy");
    assert.equal(JSON.stringify(half.aiAnalysis).length, measured.markerChars, "SIZE_UNAVAILABLE_MARKER_BYTES");
    assert.ok(half.chars <= MAX, "the saved report still fits the unchanged ceiling");

    // Nothing but the AI half changed: every other field and every similarity subtree is byte-identical.
    assert.deepEqual(withoutAiFields(payloadOf(await kit.readRow(id))), withoutAiFields(payloadOf(before)));
    assert.deepEqual(await rawSubtrees(id), subtreesBefore);

    // ... and the report is complete for the customer.
    const roomAfter = await fetchReportRoomContents(0);
    assert.equal(roomAfter.ok && roomAfter.contents.status, "failed");
    assert.equal(roomAfter.contents.report.aiUnavailableReason, "REPORT_SIZE");
    assert.equal(roomAfter.contents.report.similarityStatus, "resolved");
    assert.equal(roomAfter.contents.report.primaryScore, roomBefore.contents.report.primaryScore, "the similarity score did not change");
    assert.equal(roomAfter.contents.report.aiScore, null);
  });
});

test("A3 READY IS NEVER DOWNGRADED: a stored ready result survives an oversized later result, a later failure, and a forged size claim — byte-identical each time; a legacy complete row is protected too", async () => {
  const account = await newAccount();
  const id = "szA3-ready";
  await kit.asBrowser(account, async () => {
    const report = await seed(account, id, 0);
    const { enriched, summary } = enrich(report);
    assert.equal((await persistAiRetryResult(enriched, summary)).ok, true);
  });
  assert.equal((await aiHalf(id)).ai_status, "ready");
  const readySnapshot = await snapshot(id);

  // (a) a later real result that no longer fits (the stored row grew): 200, nothing written, and NOT reported as size-unavailable.
  await padTo(id, wireOf(realAi()), MAX + 1);
  const paddedSnapshot = await snapshot(id);
  const oversized = await kit.callRetryRoute(id, { body: kit.retryBodyFor(wireOf(realAi())), cookie: account.cookie });
  assert.equal(oversized.status, 200, "not a 413 loop");
  assert.deepEqual(oversized.json, { ok: true }, "and not claimed to be size-unavailable");
  assert.equal(await snapshot(id), paddedSnapshot, "a legitimate ready result is never displaced by an oversized one");

  // (b) a later ordinary failure (LIFECYCLE-02) and (c) a later failure carrying a forged size claim.
  for (const [label, body] of [["failed", failedBody()], ["forged size claim", failedBody({ unavailableReason: "REPORT_SIZE" })]]) {
    const late = await kit.callRetryRoute(id, { body, cookie: account.cookie });
    assert.equal(late.status, 200, label);
    assert.equal(await snapshot(id), paddedSnapshot, `${label}: a stored ready result is never downgraded`);
  }
  assert.equal((await aiHalf(id)).ai_status, "ready");
  assert.notEqual(readySnapshot, paddedSnapshot, "fixture sanity: the padding edit was a real change");

  // (d) a LEGACY complete row (ai_status NULL, a persisted score): the repo's own derived definition of ready protects it too.
  const legacy = await newAccount();
  const legacyId = "szA3-legacy";
  await env.client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, ai_score, ai_tone, ai_status, payload_json, user_id, room_number, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [legacyId, legacy.deviceKey, `sub-${legacyId}`, "Legacy", new Date().toISOString(), 10, 0, "Low", 7, "low", null, JSON.stringify({ id: legacyId, text: "t", padding: "p".repeat(MAX - 20_000) }), legacy.userId, 3],
  });
  const legacySnapshot = await snapshot(legacyId);
  const legacyBody = kit.retryBodyFor(realAi()); // legacy full passages (~96k chars): does not fit in the remaining 20k
  const legacyResponse = await kit.callRetryRoute(legacyId, { body: legacyBody, cookie: legacy.cookie });
  assert.equal(legacyResponse.status, 200);
  assert.deepEqual(legacyResponse.json, { ok: true });
  assert.equal(await snapshot(legacyId), legacySnapshot, "a legacy complete row is never downgraded to size-unavailable");
});

// ----------------------------------------------------------------------------------------------------------------
// B. TRUST BOUNDARY — a client can never declare "too large"
// ----------------------------------------------------------------------------------------------------------------

test("B1 A CLIENT CANNOT FORGE THE SIZE STATE: `unavailableReason` in what the browser sends is stripped by both save routes — a real result that fits stays ready and visible, an ordinary failure stays retryable", async () => {
  const account = await newAccount();
  await kit.asBrowser(account, async () => {
    // (a) narrow route, complete result that fits, forged reason. A COMPACT table is validated strictly (any unknown key is
    // refused 400 and nothing is written); a legacy-shaped result has the reason stripped and is persisted as the real result.
    const idA = "szB1-a";
    await seed(account, idA, 0);
    const snapA = await snapshot(idA);
    const forgedCompact = await kit.callRetryRoute(idA, { body: kit.retryBodyFor({ ...wireOf(realAi()), unavailableReason: "REPORT_SIZE" }), cookie: account.cookie });
    assert.equal(forgedCompact.status, 400, "a forged reason inside a compact table is refused outright");
    assert.equal(await snapshot(idA), snapA, "and nothing was written");
    const forgedReady = await kit.callRetryRoute(idA, { body: kit.retryBodyFor({ ...realAi(), unavailableReason: "REPORT_SIZE" }), cookie: account.cookie });
    assert.equal(forgedReady.status, 200);
    assert.deepEqual(forgedReady.json, { ok: true });
    const a = await aiHalf(idA);
    assert.equal(a.ai_status, "ready");
    assert.equal(a.aiAnalysis.status, "complete");
    assert.equal("unavailableReason" in a.aiAnalysis, false, "the forged reason was dropped — the real result was NOT hidden");
    const roomA = await fetchReportRoomContents(0);
    assert.equal(roomA.contents.status, "ready");
    assert.equal(roomA.contents.report.aiUnavailableReason, undefined);

    // (b) narrow route, ordinary failure, forged reason -> still an ordinary (retryable) failure
    const idB = "szB1-b";
    await seed(account, idB, 1);
    const forgedFailed = await kit.callRetryRoute(idB, { body: failedBody({ unavailableReason: "REPORT_SIZE" }), cookie: account.cookie });
    assert.equal(forgedFailed.status, 200);
    assert.deepEqual(forgedFailed.json, { ok: true }, "no outcome flag: the server did not decide anything");
    const b = await aiHalf(idB);
    assert.equal(b.ai_status, "failed");
    assert.equal("unavailableReason" in b.aiAnalysis, false);
    const roomB = await fetchReportRoomContents(1);
    assert.equal(roomB.contents.status, "failed");
    assert.equal(roomB.contents.report.aiUnavailableReason, undefined);
    assert.equal(unavailable.isAiRetryOffered(roomB.contents.report), true, "an ordinary failure keeps its Retry");
  });

  // (c) the whole-report route (POST /api/reports): the same trust boundary.
  const other = await newAccount();
  await kit.asBrowser(other, async () => {
    for (const [index, status] of ["complete", "error"].entries()) {
      const id = `szB1-c${index}`;
      const report = await seed(other, id, index);
      const forged = { ...realAi(TEXT, status), unavailableReason: "REPORT_SIZE" };
      const enriched = { ...report, aiScore: status === "complete" ? 7 : null, aiAnalysis: forged };
      const summary = { ...buildReportSummary(enriched), aiStatus: status === "complete" ? "ready" : "failed", similarityStatus: "pending" };
      assert.equal((await persistAiCompletion(enriched, summary, index)).ok, true);
      const half = await aiHalf(id);
      assert.equal("unavailableReason" in half.aiAnalysis, false, `whole-report save (${status}): a client-declared reason is never persisted`);
      const contents = await fetchReportRoomContents(index);
      assert.equal(contents.contents.report.aiUnavailableReason, undefined);
    }
  });
});

// ----------------------------------------------------------------------------------------------------------------
// C. AUTOMATIC COMPLETION FALLBACK
// ----------------------------------------------------------------------------------------------------------------

const SUMMARY = (overrides = {}) => ({ id: "auto-1", submissionId: "s", title: "t", createdAt: new Date().toISOString(), wordCount: 100, archiveScore: 0, scoreBand: "Low", aiScore: 7, aiTone: "low", aiStatus: "ready", similarityStatus: "pending", ...overrides });
const AUTO_REPORT = () => ({ id: "auto-1", text: TEXT, aiScore: 7, aiAnalysis: { status: "complete", score: 7, model: "m", engine: null, threshold: 0.7, eligibleWordCount: 900, analyzedWordCount: 900, passages: [{ start: 0, end: 5, wordStart: 0, wordEnd: 1, text: "hello", wordCount: 1, probability: 0.1 }] } });
const failure = (status) => ({ ok: false, status, quotaExceeded: status === 429, roomOccupied: status === 409, roomReuseNotReady: false });

test("C1 AUTOMATIC SIZE 413 FALLS BACK: a whole-report resave refused for size (the existing typed REQUEST_TOO_LARGE class) hands the SAME AI result to the narrow route, and the summary reflects what the server persisted", async () => {
  const report = AUTO_REPORT();
  const calls = { whole: 0, narrow: [] };
  const saveRemote = async () => { calls.whole += 1; return failure(413); };
  const saveNarrow = async (input) => { calls.narrow.push(input); return { ok: true }; };
  const persisted = await persistAiCompletion(report, SUMMARY(), 4, saveRemote, saveNarrow);
  assert.equal(calls.whole, 1);
  assert.equal(calls.narrow.length, 1, "exactly one fallback call");
  assert.deepEqual(calls.narrow[0].aiAnalysis, prepareAiAnalysisForTransport(report.aiAnalysis, report.text), "the same AI result (in its wire form) — nothing recomputed, nothing truncated");
  assert.deepEqual({ id: calls.narrow[0].id, aiStatus: calls.narrow[0].aiStatus, aiScore: calls.narrow[0].aiScore, aiTone: calls.narrow[0].aiTone, rawAiScore: calls.narrow[0].rawAiScore }, { id: "auto-1", aiStatus: "ready", aiScore: 7, aiTone: "low", rawAiScore: 7 });
  assert.equal(persisted.ok, true);
  assert.equal(persisted.summary.aiStatus, "ready", "the real result was persisted by the narrow route");

  // The server's decision comes back in the summary: failed, no score, no Retry.
  const decided = await persistAiCompletion(report, SUMMARY(), 4, saveRemote, async () => ({ ok: true, aiOutcome: "SIZE_UNAVAILABLE" }));
  assert.equal(decided.ok, true);
  assert.equal(decided.summary.aiStatus, "failed");
  assert.equal(decided.summary.aiScore, null);
  assert.equal(decided.summary.aiUnavailableReason, "REPORT_SIZE");
  // ... and when even the narrow route fails, the automatic save simply fails (the room's existing recovery applies).
  const failed = await persistAiCompletion(report, SUMMARY(), 4, saveRemote, async () => failure(500));
  assert.equal(failed.ok, false);
});

test("C2 UNRELATED AUTOMATIC FAILURES DO NOT FALL BACK: 401, 403, 404, 400, 409, 429, 500, 503, a network failure — and a success — never call the narrow route", async () => {
  for (const status of [0, 400, 401, 403, 404, 409, 429, 500, 502, 503]) {
    let narrowCalls = 0;
    const result = await persistAiCompletion(AUTO_REPORT(), SUMMARY(), 0, async () => failure(status), async () => { narrowCalls += 1; return { ok: true }; });
    assert.equal(result.ok, false, `status ${status}`);
    assert.equal(narrowCalls, 0, `status ${status} must not fall back`);
  }
  let narrowCalls = 0;
  const success = await persistAiCompletion(AUTO_REPORT(), SUMMARY(), 0, async () => ({ ok: true }), async () => { narrowCalls += 1; return { ok: true }; });
  assert.equal(success.ok, true);
  assert.equal(narrowCalls, 0, "a successful whole-report save needs no fallback");
  // A 413 with nothing terminal to send (no AI result / a non-terminal summary) has nothing to fall back with.
  const nothing = await persistAiCompletion({ id: "x", text: "t" }, SUMMARY(), 0, async () => failure(413), async () => { narrowCalls += 1; return { ok: true }; });
  assert.equal(nothing.ok, false);
  assert.equal((await persistAiCompletion(AUTO_REPORT(), SUMMARY({ aiStatus: "processing" }), 0, async () => failure(413), async () => { narrowCalls += 1; return { ok: true }; })).ok, false);
  assert.equal(narrowCalls, 0);
});

test("C3 THE FALLBACK NEVER RE-RUNS THE AI: the model result is computed once, the fallback reuses it; the completion helper contains no model call", async () => {
  let modelRuns = 0;
  const aiPromise = (async () => { modelRuns += 1; return { aiScore: 7, aiAnalysis: AUTO_REPORT().aiAnalysis }; })();
  const sent = [];
  const saved = await roomShell.completeAiAnalysisWithRecovery(aiPromise, async (aiResult) => {
    const enriched = { ...AUTO_REPORT(), ...aiResult };
    const result = await persistAiCompletion(enriched, SUMMARY(), 0, async () => failure(413), async (input) => { sent.push(input); return { ok: true, aiOutcome: "SIZE_UNAVAILABLE" }; });
    return result.ok;
  });
  assert.equal(saved, true);
  assert.equal(modelRuns, 1, "the browser model ran exactly once");
  assert.equal(sent.length, 1);
  const source = await readFile(new URL("../lib/report-ai-completion.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /runAiAnalysis|retryAiAnalysisWithFreshLanguage|new Worker|analyzeAiText/, "the persistence helper cannot run the model");
});

test("C4 AUTOMATIC PATH, REAL HANDLERS: a whole-report resave refused 413 falls back — the real result is persisted when it fits the saved report (recovering what the whole-report path wrongly refused), the terminal state is written when it does not; an unauthenticated 401 never falls back", async () => {
  const account = await newAccount();
  await kit.asBrowser(account, async (route) => {
    const aiRequests = () => route.requests.filter((r) => r.path.endsWith("/ai-retry"));
    // The whole-report request is over the ceiling (a padded echo), while the SAVED report is small: the narrow route can decide.
    const bloat = (report) => ({ ...report, padding: "x".repeat(MAX) });

    // (a) fits -> real AI persisted through the fallback
    const idA = "szC4-fit";
    const reportA = await seed(account, idA, 0);
    const a = enrich(reportA);
    const savedA = await persistAiCompletion(bloat(a.enriched), a.summary, 0);
    assert.equal(route.requests.filter((r) => r.path === "/api/reports" && r.method === "POST").at(-1).status, 413, "the whole-report resave was refused for size");
    assert.equal(aiRequests().at(-1).status, 200, "the fallback reached the narrow route");
    assert.equal(savedA.ok, true);
    assert.equal(savedA.summary.aiUnavailableReason, undefined);
    assert.equal((await aiHalf(idA)).ai_status, "ready");
    assert.equal((await aiHalf(idA)).aiAnalysis.status, "complete");

    // (b) does not fit the saved report -> the server's terminal state, similarity untouched
    const idB = "szC4-over";
    const reportB = await seed(account, idB, 1);
    const b = enrich(reportB);
    await padTo(idB, wireOf(b.enriched.aiAnalysis), MAX + 1);
    const subtreesB = await rawSubtrees(idB);
    const savedB = await persistAiCompletion(bloat(b.enriched), b.summary, 1);
    assert.equal(route.requests.filter((r) => r.path === "/api/reports" && r.method === "POST").at(-1).status, 413);
    assert.equal(aiRequests().at(-1).status, 200);
    assert.equal(savedB.ok, true);
    assert.equal(savedB.summary.aiStatus, "failed");
    assert.equal(savedB.summary.aiUnavailableReason, "REPORT_SIZE");
    assert.deepEqual((await aiHalf(idB)).aiAnalysis, MARKER);
    assert.deepEqual(await rawSubtrees(idB), subtreesB);
  });

  // (c) unauthenticated: the whole-report save is 401 — and there is no fallback call at all.
  const stranger = { tag: "size-anon", cookie: "not-a-session", deviceKey: "size-anon-device" };
  const restoreWindow = fx.stubBrowserWindow();
  const anonRoute = fx.installRouteFetch(stranger, { "POST /api/reports/:id/ai-retry": (await import("../app/api/reports/[id]/ai-retry/route.ts")).POST });
  try {
    const a = enrich(fx.buildFirstSaveBody({ deviceKey: stranger.deviceKey, id: "szC4-anon", text: TEXT, room: 0 }).payload);
    const result = await persistAiCompletion({ ...a.enriched, padding: "x".repeat(MAX) }, a.summary, 0);
    assert.equal(result.ok, false);
    // The oversized whole-report request is refused for size before any session check (the ceiling guard runs first) — but for
    // an UNAUTHENTICATED caller the fallback's own answer is a 401, so nothing is ever written or decided for a stranger.
    assert.equal(anonRoute.requests.filter((r) => r.path === "/api/reports" && r.method === "POST").at(-1).status, 413);
    assert.equal(anonRoute.requests.filter((r) => r.path.endsWith("/ai-retry")).at(-1).status, 401, "the narrow route refuses the stranger");
    const narrowBefore = anonRoute.requests.filter((r) => r.path.endsWith("/ai-retry")).length;
    const noPadding = await persistAiCompletion(a.enriched, a.summary, 0);
    assert.equal(noPadding.ok, false);
    assert.equal(anonRoute.requests.filter((r) => r.path === "/api/reports" && r.method === "POST").at(-1).status, 401, "an ordinary unauthenticated resave is 401");
    assert.equal(anonRoute.requests.filter((r) => r.path.endsWith("/ai-retry")).length, narrowBefore, "401 is not a size failure: no fallback for it");
  } finally {
    anonRoute.restore();
    restoreWindow();
  }
});

// ----------------------------------------------------------------------------------------------------------------
// D. EXACT BOUNDARY
// ----------------------------------------------------------------------------------------------------------------

test("D1 EXACT BOUNDARY: a real result whose merged report is exactly the ceiling (canonical units) is persisted; one unit over becomes the terminal marker — the decision is the server's own measurement of the merged report, at the character", async () => {
  const account = await newAccount();
  await kit.asBrowser(account, async () => {
    const candidate = wireOf(realAi());
    // exactly at the ceiling -> the REAL result
    const idFit = "szD1-fit";
    const reportFit = await seed(account, idFit, 0);
    await padTo(idFit, candidate, MAX);
    const fit = enrich(reportFit);
    assert.equal((await persistAiRetryResult(fit.enriched, fit.summary)).summary.aiUnavailableReason, undefined);
    const fitHalf = await aiHalf(idFit);
    assert.equal(fitHalf.ai_status, "ready");
    assert.equal(fitHalf.aiAnalysis.status, "complete");
    assert.equal(fitHalf.chars, MAX, "the stored report is EXACTLY the ceiling (canonical units) — the measurement is exact, not conservative");

    // one character over -> the marker
    const idOver = "szD1-over";
    const reportOver = await seed(account, idOver, 1);
    await padTo(idOver, candidate, MAX + 1);
    const over = enrich(reportOver);
    assert.equal((await persistAiRetryResult(over.enriched, over.summary)).summary.aiUnavailableReason, "REPORT_SIZE");
    const overHalf = await aiHalf(idOver);
    assert.equal(overHalf.ai_status, "failed");
    assert.deepEqual(overHalf.aiAnalysis, MARKER);
    assert.ok(overHalf.chars <= MAX);
    assert.equal(overHalf.chars, (await mergedUnits(idOver, MARKER, null)), "and it is exactly the marker's merged size");
  });
});

test("D2 THE MARKER ITSELF: a legacy row too full for even the marker (saved before the first-save reserve) keeps the unchanged 413 and is left untouched; one unit less and the marker is written — the marker is held to the same canonical unit", async () => {
  const account = await newAccount();
  const id = "szD2-full";
  await kit.asBrowser(account, async () => { await seed(account, id, 0); });

  // Stored payload so full that the payload WITH THE MARKER merged in is 1 unit over the ceiling.
  await padTo(id, MARKER, MAX + 1, { raw: null });
  const snap = await snapshot(id);
  const refused = await kit.callRetryRoute(id, { body: kit.retryBodyFor(wireOf(realAi())), cookie: account.cookie });
  assert.equal(refused.status, 413);
  assert.deepEqual(refused.json, { error: "Payload too large" });
  assert.equal(await snapshot(id), snap, "nothing written — the tentative candidate and marker were rolled back");

  await padTo(id, MARKER, MAX, { raw: null }); // now the marker's merged report is EXACTLY the ceiling
  const decided = await kit.callRetryRoute(id, { body: kit.retryBodyFor(wireOf(realAi())), cookie: account.cookie });
  assert.equal(decided.status, 200);
  assert.deepEqual(decided.json, { ok: true, aiOutcome: "SIZE_UNAVAILABLE" });
  assert.deepEqual((await aiHalf(id)).aiAnalysis, MARKER);
  assert.equal((await aiHalf(id)).chars, MAX, "the stored report is exactly the ceiling");
});

// ----------------------------------------------------------------------------------------------------------------
// E. FIRST-SAVE RESERVE — every accepted report can reach a terminal AI state
// ----------------------------------------------------------------------------------------------------------------

const PAD_TEXT = "Small synthetic base manuscript for calibration purposes only. ".repeat(40);
/**
 * A first save whose PERSISTED size lands exactly on `target` (the server-added evidence is a constant for a given payload shape and id length,
 * which a same-shape calibration save measures). A fresh account per call: two uploads each, well inside the daily quota.
 */
let landings = 0;
async function landPersisted({ target, aiStatus = "processing", aiAnalysis, astral = 0 }) {
  const account = await newAccount();
  landings += 1;
  const stem = `rsv${String(landings).padStart(3, "0")}`; // unique per call (rows are looked up by id), and calibration/probe ids have the same length
  const shape = (pad) => {
    const id = pad === 1000 ? `${stem}c` : `${stem}r`;
    const body = fx.buildFirstSaveBody({ deviceKey: account.deviceKey, id, text: PAD_TEXT, room: 0 });
    const payload = { ...body.payload, padding: EMOJI.repeat(astral) + "x".repeat(pad - 2 * astral), ...(aiAnalysis ? { aiScore: null, aiAnalysis } : {}) };
    return { id, payload, summary: { ...buildReportSummary(payload), aiStatus, similarityStatus: "pending" } };
  };
  return kit.asBrowser(account, async (route) => {
    const calibration = shape(1000);
    assert.equal((await saveReportRemote(calibration.payload, calibration.summary, undefined, 0)).ok, true, "fixture sanity: calibration save");
    const growth = persistedPayloadSize(String((await env.client.execute({ sql: "SELECT payload_json FROM saved_reports WHERE id = ?", args: [calibration.id] })).rows[0].payload_json)) - 1000; // canonical units, NOT SQL length()
    await env.client.execute({ sql: "DELETE FROM saved_reports WHERE id = ?", args: [calibration.id] });
    const probe = shape(target - growth);
    const saved = await saveReportRemote(probe.payload, probe.summary, undefined, 0);
    const request = lastPost(route);
    const row = await kit.readRow(probe.id);
    return { account, id: probe.id, ok: saved.ok, status: request.status, requestBytes: request.bytes, persisted: row ? persistedPayloadSize(String(row.payload_json)) : null, sqlCodePoints: row ? (await storedSizes(probe.id)).sqlCodePoints : null };
  });
}

test("E1 THE RESERVE: a first save (AI still processing) may fill the persisted ceiling only up to TERMINAL_AI_RESERVE_CHARS short of it; the ceiling constant itself is unchanged", async () => {
  assert.equal(MAX, 2_000_000, "the persistence ceiling is NOT changed");
  assert.equal(unavailable.TERMINAL_AI_RESERVE_CHARS, 1024);
  assert.ok(unavailable.TERMINAL_AI_RESERVE_CHARS <= MAX / 1000, "and is ~0.05 % of the ceiling — not hundreds of KB");

  const atLimit = await landPersisted({ target: MAX - unavailable.TERMINAL_AI_RESERVE_CHARS });
  assert.equal(atLimit.ok, true);
  assert.equal(atLimit.persisted, MAX - unavailable.TERMINAL_AI_RESERVE_CHARS, "landed exactly on the reserve limit");
  assert.ok(atLimit.requestBytes <= MAX, "the request-size guard did not interfere");
  // The reserve is sized against the marker's REAL growth on this stored report (an actual merge, canonical units), with >= 2x headroom.
  const growth = (await mergedUnits(atLimit.id, MARKER, null)) - (await storedSizes(atLimit.id)).units;
  assert.ok(growth >= MARKER_JSON.length, `fixture sanity: the marker adds at least its own JSON (${growth})`);
  assert.ok(unavailable.TERMINAL_AI_RESERVE_CHARS >= 2 * growth, `the reserve (${unavailable.TERMINAL_AI_RESERVE_CHARS}) covers the marker's measured growth (${growth}) with >= 2x headroom`);
  measured.markerGrowthUnits = growth;

  const oneOver = await landPersisted({ target: MAX - unavailable.TERMINAL_AI_RESERVE_CHARS + 1 });
  assert.equal(oneOver.ok, false);
  assert.equal(oneOver.status, 413, "one character into the reserve is refused at first save");
  assert.equal(oneOver.persisted, null, "nothing persisted");
  assert.ok(oneOver.requestBytes <= MAX, "refused by the PERSISTED-size check, not the request-size one");
});

test("E2 THE SLIVER IS CLOSED: a report accepted right at the reserve limit can still reach a terminal AI state — the oversized real result becomes the marker, which fits; nothing is stuck processing", async () => {
  const landed = await landPersisted({ target: MAX - unavailable.TERMINAL_AI_RESERVE_CHARS });
  assert.equal(landed.ok, true);
  const before = await snapshot(landed.id);
  assert.equal((await aiHalf(landed.id)).ai_status, "processing");
  // A real (legacy, ~96k chars) result cannot fit in the ~1k that is left; the marker can.
  const response = await kit.callRetryRoute(landed.id, { body: kit.retryBodyFor(realAi()), cookie: landed.account.cookie });
  assert.equal(response.status, 200, "no 413");
  assert.deepEqual(response.json, { ok: true, aiOutcome: "SIZE_UNAVAILABLE" });
  const half = await aiHalf(landed.id);
  assert.equal(half.ai_status, "failed");
  assert.deepEqual(half.aiAnalysis, MARKER);
  assert.ok(half.chars <= MAX);
  assert.notEqual(await snapshot(landed.id), before);
  // The same call again is idempotent.
  const again = await kit.callRetryRoute(landed.id, { body: kit.retryBodyFor(realAi()), cookie: landed.account.cookie });
  assert.deepEqual(again.json, { ok: true, aiOutcome: "SIZE_UNAVAILABLE" });
});

test("E3 THE RESERVE ONLY GUARDS AN UNRESOLVED-AI SAVE: a save that already carries its terminal AI result fills the ceiling exactly as before (to the character), and an ordinary customer resave is unchanged", async () => {
  const small = { status: "error", score: null, model: "m", engine: null, threshold: 0.7, eligibleWordCount: 0, analyzedWordCount: 0, passages: [], error: "e" };
  const terminalAtCeiling = await landPersisted({ target: MAX, aiStatus: "failed", aiAnalysis: small });
  assert.equal(terminalAtCeiling.ok, true, "a terminal-AI save may still use the whole ceiling");
  assert.equal(terminalAtCeiling.persisted, MAX);
  const terminalOver = await landPersisted({ target: MAX + 1, aiStatus: "failed", aiAnalysis: small });
  assert.equal(terminalOver.ok, false);
  assert.equal(terminalOver.status, 413, "and the ceiling is still the ceiling");

  // An ordinary customer resave of an existing report (same id, terminal AI) lands inside the band the reserve forbids to a processing save.
  const account = await newAccount();
  await kit.asBrowser(account, async () => {
    const id = "szE3-resave";
    const report = await seed(account, id, 0, PAD_TEXT);
    const first = enrich(report, PAD_TEXT);
    const resave = async (pad) => {
      const enriched = { ...first.enriched, padding: "x".repeat(pad) };
      const summary = { ...buildReportSummary(enriched), aiStatus: "ready", similarityStatus: "pending" };
      return saveReportRemote(enriched, summary, undefined, 0);
    };
    assert.equal((await resave(1000)).ok, true, "fixture sanity: calibration resave");
    const p1 = (await storedSizes(id)).units;
    const band = MAX - 100; // 100 chars short of the ceiling: inside the reserve band (MAX-1023..MAX)
    assert.equal((await resave(1000 + (band - p1))).ok, true, "an ordinary terminal-AI resave inside the reserve band is accepted");
    const p2 = (await storedSizes(id)).units;
    assert.equal(p2, band);
    assert.ok(p2 > MAX - unavailable.TERMINAL_AI_RESERVE_CHARS && p2 <= MAX);
    assert.equal((await aiHalf(id)).ai_status, "ready");
  });
});

// ----------------------------------------------------------------------------------------------------------------
// U. CANONICAL SIZE UNIT / UNICODE BOUNDARY
//
// The persisted-report ceiling is about UTF-16 code units of the serialized JSON (persistedPayloadSize), NOT SQL code points and NOT
// bytes. The AI-result route measures the ACTUAL merged payload in that unit. Before this correction it summed SQL code points, JS
// units and a guessed +64: an astral character (an emoji is 1 SQL character but 2 units) under-counted the stored payload — a real
// result could be persisted into a report over the ceiling — and the +64 over-counted the merge growth by ~36 at the boundary.
// Every fixture is synthetic; "astral" fixtures hold real non-BMP characters (U+1F600) in the stored payload.
// ----------------------------------------------------------------------------------------------------------------

/** A processing report whose STORED payload holds `astral` non-BMP characters and is padded so writing `analysis` merges to exactly `target` units. */
async function seedUnicodeReport(account, id, room, { analysis, target, astral, raw = 5 }) {
  const report = await seed(account, id, room);
  await padTo(id, analysis, target, { raw, astral });
  const sizes = await storedSizes(id);
  assert.equal(sizes.units - sizes.sqlCodePoints, astral, "fixture sanity: the stored payload's UTF-16 length exceeds its SQL character count by exactly the astral count");
  return report;
}

test("U1 ASCII, merged report just below / exactly at the ceiling -> the REAL result, stored size == target, similarity byte-identical; the two SQL bounds settle it (nothing read back)", async () => {
  const account = await newAccount();
  await kit.asBrowser(account, async () => {
    const candidate = wireOf(realAi());
    for (const [index, target] of [MAX - 1, MAX].entries()) {
      const id = `szU1-${index}`;
      await seed(account, id, index);
      await padTo(id, candidate, target);
      const bounds = await mergedMeasure(id, candidate);
      assert.equal(bounds.codePoints, bounds.units, "ASCII: SQL characters == UTF-16 units");
      assert.equal(persistedFitFromSqlBounds(bounds.codePoints, bounds.utf8Bytes, MAX), "FITS", "settled by the two SQL bounds — nothing had to be read back");
      const subtrees = await rawSubtrees(id);
      const response = await kit.callRetryRoute(id, { body: kit.retryBodyFor(candidate), cookie: account.cookie });
      assert.deepEqual(response.json, { ok: true }, `target ${target}`);
      const half = await aiHalf(id);
      assert.equal(half.ai_status, "ready");
      assert.equal(half.aiAnalysis.status, "complete");
      assert.equal(half.chars, target, "the stored report is exactly the size that was measured");
      assert.deepEqual(await rawSubtrees(id), subtrees, "similarity byte-identical");
    }
  });
});

test("U2 ASCII, merged report one unit above the ceiling -> the terminal marker (server-authored), stored report <= the ceiling, similarity byte-identical", async () => {
  const account = await newAccount();
  await kit.asBrowser(account, async () => {
    const candidate = wireOf(realAi());
    const id = "szU2-over";
    await seed(account, id, 0);
    await padTo(id, candidate, MAX + 1);
    const subtrees = await rawSubtrees(id);
    const response = await kit.callRetryRoute(id, { body: kit.retryBodyFor(candidate), cookie: account.cookie });
    assert.deepEqual(response.json, { ok: true, aiOutcome: "SIZE_UNAVAILABLE" });
    const half = await aiHalf(id);
    assert.equal(half.ai_status, "failed");
    assert.deepEqual(half.aiAnalysis, MARKER);
    assert.ok(half.chars <= MAX);
    assert.deepEqual(await rawSubtrees(id), subtrees, "similarity byte-identical");
  });
});

test("U3 ASTRAL-heavy stored payload (50,000 emoji: 100,000 units, 50,000 SQL characters), merged report EXACTLY at the canonical ceiling -> the REAL result; only the exact read-back can decide it", async () => {
  const account = await newAccount();
  await kit.asBrowser(account, async () => {
    const candidate = wireOf(realAi());
    const id = "szU3-astral-fit";
    await seedUnicodeReport(account, id, 0, { analysis: candidate, target: MAX, astral: 50_000 });
    const bounds = await mergedMeasure(id, candidate);
    assert.equal(bounds.units, MAX);
    assert.ok(bounds.codePoints < MAX - 40_000, `the SQL character count (${bounds.codePoints}) is far below the canonical size — a code-point rule would call this report small`);
    assert.equal(persistedFitFromSqlBounds(bounds.codePoints, bounds.utf8Bytes, MAX), "AMBIGUOUS", "the SQL bounds cannot decide this payload; the exact measurement does");
    const subtrees = await rawSubtrees(id);
    const response = await kit.callRetryRoute(id, { body: kit.retryBodyFor(candidate), cookie: account.cookie });
    assert.deepEqual(response.json, { ok: true }, "fits by exactly zero units: the real result");
    const half = await aiHalf(id);
    assert.equal(half.ai_status, "ready");
    assert.equal(half.chars, MAX);
    assert.equal((await storedSizes(id)).sqlCodePoints, MAX - 50_000, "and its SQL length is 50,000 lower");
    assert.deepEqual(await rawSubtrees(id), subtrees, "similarity byte-identical");
  });
});

test("U4 the case the pre-correction arithmetic UNDER-COUNTED: astral-heavy stored payload, canonical merged size one unit OVER the ceiling while the old formula says it fits -> the marker, never a real result persisted past the ceiling", async () => {
  const account = await newAccount();
  await kit.asBrowser(account, async () => {
    const candidate = wireOf(realAi());
    for (const [index, astral] of [40, 50_000].entries()) {
      const id = `szU4-${index}`;
      await seedUnicodeReport(account, id, index, { analysis: candidate, target: MAX + 1, astral });
      assert.ok((await mergedUnits(id, candidate)) > MAX, "canonical: the real result exceeds the ceiling");
      assert.ok((await preCorrectionProjection(id, candidate)) <= MAX, `pre-correction arithmetic (SQL code points + guessed +64) said it FITS (${astral} astral)`);
      const subtrees = await rawSubtrees(id);
      const response = await kit.callRetryRoute(id, { body: kit.retryBodyFor(candidate), cookie: account.cookie });
      assert.deepEqual(response.json, { ok: true, aiOutcome: "SIZE_UNAVAILABLE" }, `${astral} astral: the marker`);
      const half = await aiHalf(id);
      assert.equal(half.ai_status, "failed");
      assert.deepEqual(half.aiAnalysis, MARKER);
      assert.ok(half.chars <= MAX, `the stored report (${half.chars}) is within the ceiling — the real result was NOT persisted past it`);
      assert.deepEqual(await rawSubtrees(id), subtrees, "similarity byte-identical");
    }
  });
});

test("U5 astral-heavy, one unit above the canonical ceiling -> marker; repeats and a stale ordinary failure are idempotent 200s (no 413 loop); and the OPPOSITE mistake is gone: a few astral characters, merged report EXACTLY at the ceiling, is the real result (the old +64 refused it)", async () => {
  const account = await newAccount();
  await kit.asBrowser(account, async () => {
    const candidate = wireOf(realAi());
    const id = "szU5-astral-over";
    await seedUnicodeReport(account, id, 0, { analysis: candidate, target: MAX + 1, astral: 20_000 });
    const first = await kit.callRetryRoute(id, { body: kit.retryBodyFor(candidate), cookie: account.cookie });
    assert.deepEqual(first.json, { ok: true, aiOutcome: "SIZE_UNAVAILABLE" });
    const marked = await snapshot(id);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const again = await kit.callRetryRoute(id, { body: attempt === 2 ? failedBody() : kit.retryBodyFor(candidate), cookie: account.cookie });
      assert.equal(again.status, 200, `stale Retry #${attempt}: never a 413`);
      assert.deepEqual(again.json, { ok: true, aiOutcome: "SIZE_UNAVAILABLE" });
    }
    assert.equal(await snapshot(id), marked, "nothing changed on any repeat");

    // opposite direction: 10 astral characters, canonical merged == ceiling. Pre-correction: old = canonical + 36 - 10 > ceiling -> marker (wrong).
    const idFit = "szU5-astral-exact";
    await seedUnicodeReport(account, idFit, 1, { analysis: candidate, target: MAX, astral: 10 });
    assert.ok((await preCorrectionProjection(idFit, candidate)) > MAX, "pre-correction arithmetic refused it (over-counted the merge growth)");
    const fit = await kit.callRetryRoute(idFit, { body: kit.retryBodyFor(candidate), cookie: account.cookie });
    assert.deepEqual(fit.json, { ok: true }, "it fits canonically: the real result");
    assert.equal((await aiHalf(idFit)).ai_status, "ready");
  });
});

test("U6 the terminal marker still fits BECAUSE OF THE RESERVE, with astral content: a first save accepted at exactly MAX-1024 canonical units (non-BMP characters in it) reaches its marker; MAX-1023 is refused although its SQL character count would have passed a code-point rule", async () => {
  const ASTRAL = 300; // the request-size guard (bytes) leaves room for only a few hundred non-BMP characters this close to the ceiling
  const atLimit = await landPersisted({ target: MAX - unavailable.TERMINAL_AI_RESERVE_CHARS, astral: ASTRAL });
  assert.equal(atLimit.ok, true, "accepted exactly at the reserve limit");
  assert.equal(atLimit.persisted, MAX - unavailable.TERMINAL_AI_RESERVE_CHARS);
  assert.equal(atLimit.persisted - atLimit.sqlCodePoints, ASTRAL, "and it really holds non-BMP characters (units - SQL characters == astral count)");
  assert.ok(atLimit.requestBytes <= MAX);
  const before = await snapshot(atLimit.id);
  const response = await kit.callRetryRoute(atLimit.id, { body: kit.retryBodyFor(realAi()), cookie: atLimit.account.cookie });
  assert.equal(response.status, 200, "no 413");
  assert.deepEqual(response.json, { ok: true, aiOutcome: "SIZE_UNAVAILABLE" });
  const half = await aiHalf(atLimit.id);
  assert.deepEqual(half.aiAnalysis, MARKER);
  assert.ok(half.chars <= MAX, "the marker fit");
  assert.ok(half.chars - (MAX - unavailable.TERMINAL_AI_RESERVE_CHARS) <= unavailable.TERMINAL_AI_RESERVE_CHARS / 2, "and used less than half of the reserve");
  assert.notEqual(await snapshot(atLimit.id), before);

  const refused = await landPersisted({ target: MAX - unavailable.TERMINAL_AI_RESERVE_CHARS + 1, astral: ASTRAL });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 413, "one canonical unit into the reserve is refused at first save");
  assert.ok(refused.requestBytes <= MAX, "by the PERSISTED-size check (canonical units), not the request-size one");
  // A code-point (SQL length) rule would have ACCEPTED this report: its SQL character count is ASTRAL below its unit count.
  assert.ok(MAX - unavailable.TERMINAL_AI_RESERVE_CHARS + 1 - ASTRAL <= MAX - unavailable.TERMINAL_AI_RESERVE_CHARS, "fixture sanity: under a code-point rule this save is within the reserve limit");
});

test("U7 a READY result is not downgraded or replaced in the Unicode case: astral-heavy stored payload, later candidate over the canonical ceiling that the old formula said fits -> 200 no-op, byte-identical (it used to REPLACE the ready result and store a report past the ceiling)", async () => {
  const account = await newAccount();
  const id = "szU7-ready";
  const candidate = wireOf(realAi());
  await kit.asBrowser(account, async () => {
    const report = await seed(account, id, 0);
    const { enriched, summary } = enrich(report);
    assert.equal((await persistAiRetryResult(enriched, summary)).ok, true);
    assert.equal((await aiHalf(id)).ai_status, "ready");
    await padTo(id, candidate, MAX + 1, { astral: 50_000 });
  });
  assert.ok((await preCorrectionProjection(id, candidate)) <= MAX, "the old formula would have said this replacement fits");
  const readyStored = await snapshot(id);
  const subtrees = await rawSubtrees(id);
  const response = await kit.callRetryRoute(id, { body: kit.retryBodyFor(candidate), cookie: account.cookie });
  assert.equal(response.status, 200, "not a 413 loop");
  assert.deepEqual(response.json, { ok: true }, "and not claimed to be size-unavailable");
  assert.equal(await snapshot(id), readyStored, "the ready result and the whole row are byte-identical");
  assert.equal((await aiHalf(id)).ai_status, "ready");
  assert.deepEqual(await rawSubtrees(id), subtrees);
  const late = await kit.callRetryRoute(id, { body: failedBody({ unavailableReason: "REPORT_SIZE" }), cookie: account.cookie });
  assert.equal(late.status, 200);
  assert.equal(await snapshot(id), readyStored, "a late failure with a forged size claim also leaves it alone");
});

test("U8 nothing technical leaks in the Unicode case: the AI-result response, the room JSON and the rendered room carry no size, unit, ceiling or character-count vocabulary", async () => {
  const account = await newAccount();
  await kit.asBrowser(account, async () => {
    const candidate = wireOf(realAi());
    const id = "szU8-leak";
    await seedUnicodeReport(account, id, 0, { analysis: candidate, target: MAX + 1, astral: 30_000 });
    const response = await kit.callRetryRoute(id, { body: kit.retryBodyFor(candidate), cookie: account.cookie });
    assert.deepEqual(Object.keys(response.json).sort(), ["aiOutcome", "ok"], "exactly the two documented fields");
    assert.doesNotMatch(response.text, /\d{4,}|units|code point|character|byte|ceiling|limit/i, "no numbers or size vocabulary in the response body");
    const roomFetch = await fetchReportRoomContents(0);
    assert.equal(roomFetch.contents.status, "failed");
    assert.doesNotMatch(JSON.stringify(roomFetch.contents), /units|code point|ceiling|bytes/i);
    const html = renderRoom(roomFetch.contents);
    assert.doesNotMatch(html.replace(/<[^>]+>/g, " "), TECHNICAL);
    assert.doesNotMatch(html.replace(/<[^>]+>/g, " "), /units|code point|characters/i);
    assert.match(html, new RegExp(unavailable.AI_SIZE_UNAVAILABLE_ROOM_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "(?:'|&#x27;)")));
    assert.doesNotMatch(html, /Retry analysis/);
  });
});

test("U9 SQL bounds are sound (property test on SQLite itself): for random ASCII/BMP/astral strings, SQL length() is the code-point count, CAST-AS-BLOB length is the UTF-8 byte count, JS .length is the UTF-16 unit count, and persistedFitFromSqlBounds never returns a wrong FITS/EXCEEDS", async () => {
  let seedState = 0x9e3779b9;
  const rand = () => { seedState = (Math.imul(seedState, 1664525) + 1013904223) >>> 0; return seedState / 0x100000000; };
  const alphabet = ["a", "Z", "7", " ", "\u00E9", "\u00DF", "\u4E2D", "\u3042", "\u20AC", "\u{1F600}", "\u{1D400}", "\u{20BB7}", "\\", "\""];
  let ambiguous = 0;
  let total = 0;
  for (let i = 0; i < 300; i += 1) {
    const s = Array.from({ length: 1 + Math.floor(rand() * 60) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join("");
    const r = (await env.client.execute({ sql: "SELECT length(?) AS cp, length(CAST(? AS BLOB)) AS bytes", args: [s, s] })).rows[0];
    const codePoints = num(r.cp);
    const utf8Bytes = num(r.bytes);
    assert.equal(codePoints, [...s].length, "SQL length() counts code points");
    assert.equal(utf8Bytes, Buffer.byteLength(s, "utf8"), "CAST AS BLOB length is the UTF-8 byte count");
    const units = persistedPayloadSize(s);
    assert.ok(codePoints <= units && units <= utf8Bytes, "code points <= UTF-16 units <= UTF-8 bytes");
    for (const ceiling of [codePoints - 1, codePoints, units - 1, units, units + 1, utf8Bytes - 1, utf8Bytes, utf8Bytes + 1]) {
      const verdict = persistedFitFromSqlBounds(codePoints, utf8Bytes, ceiling);
      total += 1;
      if (verdict === "FITS") assert.ok(units <= ceiling, `FITS must mean units <= ceiling (${units} <= ${ceiling})`);
      else if (verdict === "EXCEEDS") assert.ok(units > ceiling, `EXCEEDS must mean units > ceiling (${units} > ${ceiling})`);
      else { ambiguous += 1; assert.ok(codePoints <= ceiling && ceiling < utf8Bytes); }
    }
  }
  assert.ok(ambiguous > 0 && ambiguous < total, `the ambiguous band exists but is a minority (${ambiguous}/${total})`);
  // and it never occurs for ASCII: bytes == units == code points
  assert.equal(persistedFitFromSqlBounds(1_999_999, 1_999_999, MAX), "FITS");
  assert.equal(persistedFitFromSqlBounds(2_000_000, 2_000_000, MAX), "FITS");
  assert.equal(persistedFitFromSqlBounds(2_000_001, 2_000_001, MAX), "EXCEEDS");
});

test("U10 THE CANONICAL MEASURE IS THE ACTUAL MERGE: SQLite renders a bound integer-valued score as 5.0 (JSON.stringify: 5), so neither SQL-length arithmetic nor a JS re-serialization equals the stored size — the route measures what is stored; the one shared unit is persistedPayloadSize (UTF-16 units)", async () => {
  assert.equal(persistedPayloadSize("a\u{1F600}"), 3, "an astral character counts 2");
  assert.equal(persistedPayloadSize("a\u00E9\u4E2D"), 3, "BMP characters count 1 whatever their UTF-8 width");
  const account = await newAccount();
  await kit.asBrowser(account, async () => {
    const id = "szU10-oracle";
    await seed(account, id, 0);
    const analysis = { status: "error", error: "\u{1F600}" };
    const stored = String((await env.client.execute({ sql: "SELECT payload_json FROM saved_reports WHERE id = ?", args: [id] })).rows[0].payload_json);
    assert.equal(JSON.stringify(JSON.parse(stored)), stored, "fixture sanity: a stored payload is a JSON.stringify fixed point");
    const naive = (raw) => JSON.stringify({ ...JSON.parse(stored), aiAnalysis: analysis, aiScore: raw }).length;
    assert.equal((await mergedUnits(id, analysis, 5)) - naive(5), 2, "integer-valued score: the actual merge is 2 units longer than a JS re-serialization (5.0 vs 5)");
    assert.equal((await mergedUnits(id, analysis, 12.5)) - naive(12.5), 0, "a fractional score agrees");
    assert.equal((await mergedUnits(id, analysis, null)) - naive(null), 0, "null agrees");
  });
  // Structural: one canonical unit, no arithmetic on separately measured lengths.
  const retrySource = await readFile(new URL("../app/api/reports/[id]/ai-retry/route.ts", import.meta.url), "utf8");
  const postSource = await readFile(new URL("../app/api/reports/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(retrySource, /payload_chars|existing_ai_chars|projectPersistedChars|MERGE_OVERHEAD|aiAnalysisJson\.length/, "the AI-result route no longer sums SQL/JS lengths");
  assert.match(retrySource, /persistedFitFromSqlBounds/);
  assert.match(retrySource, /persistedPayloadSize/);
  assert.equal((postSource.match(/persistedPayloadSize\(payloadJsonToPersist\) > persistedCeiling/g) ?? []).length, 3, "all three persisted-size checks use the canonical helper");
  assert.doesNotMatch(postSource, /payloadJsonToPersist\.length/, "no raw .length on the persisted payload");
});

// ----------------------------------------------------------------------------------------------------------------
// F. STALE CLIENT RETRY — idempotent, never a 413 loop
// ----------------------------------------------------------------------------------------------------------------

test("F1 A STALE RETRY ON A SIZE-UNAVAILABLE REPORT is idempotent: an oversized result and an ordinary failure both answer 200 with the terminal state and write nothing; a result that fits NOW is persisted and clears the reason", async () => {
  const account = await newAccount();
  const id = "szF1-stale";
  await kit.asBrowser(account, async () => {
    const report = await seed(account, id, 0);
    const { enriched, summary } = enrich(report);
    await padTo(id, wireOf(enriched.aiAnalysis), MAX + 1);
    assert.equal((await persistAiRetryResult(enriched, summary)).summary.aiUnavailableReason, "REPORT_SIZE");
  });
  const marked = await snapshot(id);

  const oversized = await kit.callRetryRoute(id, { body: kit.retryBodyFor(wireOf(realAi())), cookie: account.cookie });
  assert.equal(oversized.status, 200, "NOT a deterministic 413");
  assert.deepEqual(oversized.json, { ok: true, aiOutcome: "SIZE_UNAVAILABLE" });
  const ordinary = await kit.callRetryRoute(id, { body: failedBody(), cookie: account.cookie });
  assert.equal(ordinary.status, 200);
  assert.deepEqual(ordinary.json, { ok: true, aiOutcome: "SIZE_UNAVAILABLE" }, "an ordinary failure must not erase the size determination");
  assert.equal(await snapshot(id), marked, "byte-identical after both");

  // The stored report shrinks (software or state changed) so the real result now fits: it is persisted, and the reason is gone.
  await env.client.execute({ sql: "UPDATE saved_reports SET payload_json = json_set(payload_json, '$.__pad', '') WHERE id = ?", args: [id] });
  const fits = await kit.callRetryRoute(id, { body: kit.retryBodyFor(wireOf(realAi())), cookie: account.cookie });
  assert.equal(fits.status, 200);
  assert.deepEqual(fits.json, { ok: true });
  const half = await aiHalf(id);
  assert.equal(half.ai_status, "ready");
  assert.equal(half.aiAnalysis.status, "complete");
  assert.equal("unavailableReason" in half.aiAnalysis, false, "the reason cleared with the real result");
});

// ----------------------------------------------------------------------------------------------------------------
// G. WHAT THE CUSTOMER SEES
// ----------------------------------------------------------------------------------------------------------------

async function seedSizeUnavailable(account, id, room) {
  const report = await seed(account, id, room);
  const { enriched, summary } = enrich(report);
  await padTo(id, wireOf(enriched.aiAnalysis), MAX + 1);
  const saved = await persistAiRetryResult(enriched, summary);
  assert.equal(saved.summary.aiUnavailableReason, "REPORT_SIZE", "fixture sanity: the server wrote the terminal state");
  return report;
}

test("G1 ROOM, DETAIL, RECEIPT: the size-unavailable report is fully usable — room revealed and terminal, detail revealed with similarity, source data intact, receipt available, stable on refresh; no Retry, no 'Analyzing…', no 'Preparing…', no AI number, no storage vocabulary", async () => {
  const account = await newAccount();
  await kit.asBrowser(account, async () => {
    const id = "szG1-usable";
    const report = await seed(account, id, 0);
    const detailBefore = await fetchRemoteReport(id);
    const roomBefore = await fetchReportRoomContents(0);
    const { enriched, summary } = enrich(report);
    await padTo(id, wireOf(enriched.aiAnalysis), MAX + 1);
    assert.equal((await persistAiRetryResult(enriched, summary)).summary.aiUnavailableReason, "REPORT_SIZE");

    // ---- room
    const roomFetch = await fetchReportRoomContents(0);
    assert.equal(roomFetch.ok, true);
    const contents = roomFetch.contents;
    assert.equal(contents.status, "failed");
    assert.equal(roomShell.isFullyRevealed(contents), true, "the room reveals");
    assert.equal(roomShell.evaluatePollTick(roomFetch, 1, roomShell.MAX_POLL_ATTEMPTS).outcome, "revealed", "polling ends on the first tick");
    assert.equal(contents.report.similarityStatus, "resolved");
    assert.equal(contents.report.primaryScore, roomBefore.contents.report.primaryScore, "similarity unchanged");
    const html = renderRoom(contents);
    assert.match(html, /Report ready · AI analysis unavailable/);
    assert.match(html, /<strong class="room-metric-value">\d+%<\/strong>/, "the similarity percentage is visible");
    assert.match(html, /Open full report/);
    assert.match(html, />Download</, "the receipt is available");
    assert.match(html, new RegExp(unavailable.AI_SIZE_UNAVAILABLE_ROOM_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "(?:'|&#x27;)")));
    for (const banned of [/Retry analysis/, /Try again/, /Analyzing/, /Preparing/, /Checking/]) assert.doesNotMatch(html, banned);
    assert.match(html, /<span class="room-metric-label">AI Detection<\/span><strong class="room-metric-value">—<\/strong><span class="room-metric-sub">Unavailable<\/span>/, "the AI tile is the non-numeric 'Unavailable' — never an AI 0%");
    assert.equal((html.match(/\d+%/g) ?? []).length, 1, "the only percentage on the card is the similarity result");
    assert.doesNotMatch(html.replace(/<[^>]+>/g, " "), TECHNICAL, "no storage vocabulary reaches the customer");

    // ---- detail (owner GET) — source cards / highlights data are exactly what they were
    const detail = await fetchRemoteReport(id);
    assert.ok(detail, "the owner GET opens the report");
    assert.deepEqual(detail.unifiedSimilarity, detailBefore.unifiedSimilarity);
    assert.deepEqual(detail.evidenceInterpretation, detailBefore.evidenceInterpretation, "source cards / highlights data unchanged");
    assert.deepEqual(detail.reportCompletion, detailBefore.reportCompletion);
    assert.equal(detail.aiAnalysis.unavailableReason, "REPORT_SIZE");
    assert.equal(detail.aiAnalysis.status, "error");
    assert.deepEqual(await fetchRemoteReport(id), detail, "refresh is stable");
    const reveal = computeDetailRevealState({ aiStatus: "failed", similarityStatus: "resolved", pollExhausted: false });
    assert.deepEqual(reveal, { screen: "revealed", aiUnavailable: true, similarityUnavailable: false });
    assert.equal(computeDetailRevealState({ aiStatus: "failed", similarityStatus: "resolved", pollExhausted: true }).screen, "revealed", "and never 'still processing'");

    // ---- the detail page, rendered: honest banner, honest AI panel, similarity content present
    for (const mode of ["similarity", "ai"]) {
      const page = renderToStaticMarkup(React.createElement(ReportDetailShell, {
        id, initialReport: detail, initialAiStatus: "failed", initialAiScore: null, initialAiTone: "unavailable",
        initialSimilarityStatus: "resolved", requiresClientResolution: false, mode, backRoom: 0,
      }));
      assert.doesNotMatch(page, /Still processing|Analysis in progress|Retry analysis|Try again|Run AI analysis/, `${mode}: terminal`);
      assert.match(page, /AI-writing analysis was unavailable for this document\./, `${mode}: the existing honest banner`);
      assert.doesNotMatch(page.replace(/<[^>]+>/g, " "), TECHNICAL, `${mode}: no storage vocabulary`);
      if (mode === "ai") {
        assert.match(page, /isn(?:'|&#x27;)t available for this document/, "the AI panel states the fixed neutral sentence");
        assert.doesNotMatch(page, /ready to calculate/, "not the misleading placeholder");
      }
    }
  });
  // The receipt carries no AI field of any kind, so it never waits on the AI half.
  const receipt = await readFile(new URL("../lib/receipt-pdf.ts", import.meta.url), "utf8");
  assert.doesNotMatch(receipt, /aiAnalysis|aiScore|aiStatus|ai_status|unavailableReason/);
});

test("G2 RETRY VISIBILITY: hidden for the server-authored size state (failed card AND the poll-exhausted branch AND retryAiCheck itself); kept for an ordinary failed AI; the three failed flavours stay distinct", async () => {
  const report = { id: "vis-1", submissionId: "s", title: "vis.pdf", createdAt: new Date().toISOString(), wordCount: 500, archiveScore: 12, primaryScore: 12, isUnified: true, similarityStatus: "resolved", scoreBand: "Low", aiScore: null, aiTone: "unavailable", aiStatus: "failed" };
  const sizeHtml = renderRoom({ status: "failed", report: { ...report, aiUnavailableReason: "REPORT_SIZE" }, cycleEndsAt: CYCLE_END() });
  const ordinaryHtml = renderRoom({ status: "failed", report, cycleEndsAt: CYCLE_END() });
  assert.doesNotMatch(sizeHtml, /Retry analysis/);
  assert.match(ordinaryHtml, /Retry analysis/, "an ordinary failed AI keeps its Retry");
  assert.match(ordinaryHtml, /AI-writing analysis was unavailable for this document\. The similarity result above is complete and unaffected\./, "and its exact copy");
  assert.match(sizeHtml, /Report ready · AI analysis unavailable/);
  assert.match(sizeHtml, /12%/);

  // The poll-exhausted branch and the retry function are structural (React state cannot be preset in a static render).
  const shell = await readFile(new URL("../app/reports/rooms/[room]/room-page-shell.tsx", import.meta.url), "utf8");
  assert.match(shell, /\{occupant\.status !== "ready" && isAiRetryOffered\(occupant\.report\) && \(\s*\n\s*<button className="button subtle" type="button" onClick=\{\(\) => retryAiCheck/, "the poll-exhausted Retry is gated");
  assert.match(shell, /if \(!isAiRetryOffered\(occupant\.report\)\) return;/, "retryAiCheck refuses before loading or running anything");
  assert.equal(unavailable.isAiRetryOffered({ aiUnavailableReason: "REPORT_SIZE" }), false);
  assert.equal(unavailable.isAiRetryOffered({}), true);
  assert.equal(unavailable.isAiRetryOffered(null), true);

  // Signals: unsupported language, ordinary failure, size — three different, honest presentations.
  const persisted = { aiStatus: "failed", aiScore: null, aiTone: "unavailable" };
  const withAi = (aiAnalysis) => ({ ...report, aiAnalysis });
  const unsupported = aiSignalDisplay(withAi({ ...realAi(TEXT, "error"), status: "unsupported" }), persisted);
  const ordinary = aiSignalDisplay(withAi({ ...realAi(TEXT, "error"), error: "AI analysis timed out." }), persisted);
  const size = aiSignalDisplay(withAi(MARKER), persisted);
  assert.deepEqual([unsupported.label, unsupported.range], ["Not enough text", "No AI result"], "unsupported language: unchanged");
  assert.deepEqual([ordinary.label, ordinary.range, ordinary.detail], ["Analysis unavailable", "Try again", "AI analysis timed out."], "ordinary failure: unchanged");
  assert.deepEqual([size.label, size.range, size.detail, size.value], ["Analysis unavailable", "No AI result", unavailable.AI_SIZE_UNAVAILABLE_MESSAGE, null]);
  assert.equal(resolveAiDisplayState({ ...persisted, aiAnalysis: MARKER }).score, null, "never a number, never 0");
  // The AI panel: the size copy, no re-run button even when one is offered.
  const panel = renderToStaticMarkup(React.createElement(AiReport, { report: withAi(MARKER), signal: size, onRetry: () => {} }));
  assert.match(panel, /isn(?:'|&#x27;)t available for this document/);
  assert.doesNotMatch(panel, /Run AI analysis|ready to calculate/);
  const ordinaryPanel = renderToStaticMarkup(React.createElement(AiReport, { report: withAi({ ...realAi(TEXT, "error"), error: "AI analysis timed out." }), signal: ordinary, onRetry: () => {} }));
  assert.match(ordinaryPanel, /Run AI analysis/, "an ordinary failed AI keeps its run button");
});

test("G3 HISTORY: a terminal failed report (size-unavailable included) no longer reads 'AI report pending' in first-party history; healthy rows keep their exact shape; no reason is exposed", async () => {
  const account = await newAccount();
  await kit.asBrowser(account, async () => {
    await seedSizeUnavailable(account, "szG3-size", 0);
    const processing = await seed(account, "szG3-processing", 1);
    const readyReport = await seed(account, "szG3-ready", 2);
    const ready = enrich(readyReport);
    assert.equal((await persistAiRetryResult(ready.enriched, ready.summary)).ok, true);
    const ordinaryReport = await seed(account, "szG3-failed", 3);
    const failed = enrich(ordinaryReport, TEXT, "error");
    assert.equal((await persistAiRetryResult(failed.enriched, failed.summary)).ok, true);
    void processing;

    const list = await (await fetch(`/api/reports?deviceKey=${encodeURIComponent(account.deviceKey)}`)).json();
    const byId = Object.fromEntries(list.reports.map((r) => [r.id, r]));
    assert.equal(byId["szG3-size"].aiStatus, "failed");
    assert.equal(byId["szG3-failed"].aiStatus, "failed");
    assert.equal("aiStatus" in byId["szG3-ready"], false, "a healthy row keeps its exact shape");
    assert.equal("aiStatus" in byId["szG3-processing"], false);
    assert.equal(JSON.stringify(byId["szG3-size"]).includes("REPORT_SIZE"), false, "history exposes no technical reason");
    assert.equal(byId["szG3-size"].aiScore, null);

    const rowHtml = (summary) => renderToStaticMarkup(React.createElement(ReportHistoryRow, { report: summary, onDownloadReceipt: async () => {} }));
    assert.match(rowHtml(byId["szG3-size"]), /AI unavailable/);
    assert.doesNotMatch(rowHtml(byId["szG3-size"]), /AI report pending/, "HISTORY_SIZE_UNAVAILABLE_SHOWS_PENDING = NO");
    assert.match(rowHtml(byId["szG3-processing"]), /AI report pending/, "a genuinely processing report is still pending");
    assert.match(rowHtml(byId["szG3-ready"]), /\d+%/);
  });
});

// ----------------------------------------------------------------------------------------------------------------
// H. SAFETY: authorization, R2, forged fields
// ----------------------------------------------------------------------------------------------------------------

test("H1 AUTHORIZATION: an anonymous request is 401 and another account's report id is a generic 404 — neither can ever produce or read the terminal state; forged similarity / room / text in the body are ignored", async () => {
  const owner = await newAccount();
  const intruder = await newAccount();
  const id = "szH1-owned";
  await kit.asBrowser(owner, async () => {
    const report = await seed(owner, id, 0);
    await padTo(id, wireOf(enrich(report).enriched.aiAnalysis), MAX + 1);
  });
  const before = await snapshot(id);
  const oversize = kit.retryBodyFor(wireOf(realAi()));

  const anonymous = await kit.callRetryRoute(id, { body: oversize, cookie: "" });
  assert.equal(anonymous.status, 401);
  const foreign = await kit.callRetryRoute(id, { body: oversize, cookie: intruder.cookie });
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.json, { error: "Report not found" }, "generic: does not reveal the report exists");
  assert.equal(await snapshot(id), before, "neither request changed anything — no marker was written for someone else's report");

  // The owner, with forged similarity / owner / room / text riding along: all ignored, only the AI half is decided.
  const subtrees = await rawSubtrees(id);
  const rowBefore = await kit.readRow(id);
  const forged = { ...oversize, unifiedSimilarity: { unifiedScore: 99 }, evidenceInterpretation: { format: "x" }, reportCompletion: { state: "X" }, text: "forged text", room: 9, userId: intruder.userId, deviceKey: "forged" };
  const decided = await kit.callRetryRoute(id, { body: forged, cookie: owner.cookie });
  assert.equal(decided.status, 200);
  assert.deepEqual(decided.json, { ok: true, aiOutcome: "SIZE_UNAVAILABLE" });
  assert.deepEqual(await rawSubtrees(id), subtrees, "forged similarity / interpretation / completion never land");
  const payload = payloadOf(await kit.readRow(id));
  assert.notEqual(payload.text, "forged text");
  const row = await kit.readRow(id);
  assert.equal(row.user_id, owner.userId, "ownership is the server's own");
  assert.equal(row.device_key, rowBefore.device_key, "and so is the device key");
});

test("H2 R2 SAFETY: a report whose persisted explanation cannot be decoded is refused with the same generic 503 — even for an oversized result — and is left byte-identical (no marker, no repair)", async () => {
  const account = await newAccount();
  const id = "szH2-r2";
  await kit.asBrowser(account, async () => { await seed(account, id, 0); });
  const payload = payloadOf(await kit.readRow(id));
  payload.evidenceInterpretation = { format: "future-compact/9", formatVersion: 9 };
  await env.client.execute({ sql: "UPDATE saved_reports SET payload_json = ? WHERE id = ?", args: [JSON.stringify(payload), id] });
  await padTo(id, wireOf(realAi()), MAX + 1);
  const before = await snapshot(id);
  const response = await kit.callRetryRoute(id, { body: kit.retryBodyFor(wireOf(realAi())), cookie: account.cookie });
  assert.equal(response.status, 503);
  assert.deepEqual(response.json, { error: "Report temporarily unavailable", code: "REPORT_TEMPORARILY_UNAVAILABLE" });
  assert.equal(await snapshot(id), before);
});

test("H3 MALFORMED COMPACT AI: a compact table that does not match the stored manuscript is refused 400 and never becomes a marker (validation happens before the size decision)", async () => {
  const account = await newAccount();
  const id = "szH3-bad";
  await kit.asBrowser(account, async () => { await seed(account, id, 0); });
  const other = wireOf(realAi(TEXT + " extra words appended so the compact table no longer matches"), TEXT + " extra words appended so the compact table no longer matches");
  await padTo(id, other, MAX + 1);
  const before = await snapshot(id);
  const response = await kit.callRetryRoute(id, { body: kit.retryBodyFor(other), cookie: account.cookie });
  assert.equal(response.status, 400);
  assert.equal(await snapshot(id), before);
});

// ----------------------------------------------------------------------------------------------------------------
// I. UNRELATED BEHAVIOUR
// ----------------------------------------------------------------------------------------------------------------

test("I1 UNCHANGED: unsupported-language and ordinary failed results persist exactly as before (failed, their own analysis, no reason, no outcome flag); a first save with a non-terminal status and a fitting result is unaffected", async () => {
  const account = await newAccount();
  await kit.asBrowser(account, async () => {
    const idU = "szI1-unsupported";
    await seed(account, idU, 0);
    const unsupported = { ...realAi(TEXT, "error"), status: "unsupported", error: undefined };
    const response = await kit.callRetryRoute(idU, { body: { aiStatus: "failed", aiScore: null, aiTone: null, payload: { aiScore: null, aiAnalysis: unsupported } }, cookie: account.cookie });
    assert.deepEqual(response.json, { ok: true });
    const u = await aiHalf(idU);
    assert.equal(u.ai_status, "failed");
    assert.equal(u.aiAnalysis.status, "unsupported");
    assert.equal("unavailableReason" in u.aiAnalysis, false);
    const contents = await fetchReportRoomContents(0);
    assert.equal(contents.contents.status, "failed");
    assert.equal(unavailable.isAiRetryOffered(contents.contents.report), true, "unsupported keeps its Retry, as before");

    const idE = "szI1-error";
    await seed(account, idE, 1);
    const errored = await kit.callRetryRoute(idE, { body: failedBody({ error: "AI analysis timed out." }), cookie: account.cookie });
    assert.deepEqual(errored.json, { ok: true });
    assert.equal((await aiHalf(idE)).aiAnalysis.error, "AI analysis timed out.");
  });
});

// ----------------------------------------------------------------------------------------------------------------
// J. LOGGING
// ----------------------------------------------------------------------------------------------------------------

test("J1 LOGGING IS BOUNDED: exactly one closed-allowlist line when the server chooses the terminal state; nothing for a fitting result or an idempotent repeat; no id, title, text, passage, payload or size", async () => {
  const account = await newAccount();
  const lines = [];
  const capture = (...args) => { lines.push(args.map(String).join(" ")); };
  const warn = mock.method(console, "warn", capture);
  const log = mock.method(console, "log", capture);
  const errorSpy = mock.method(console, "error", capture);
  try {
    await kit.asBrowser(account, async () => {
      const fit = await seed(account, "szJ1-fit", 0);
      const f = enrich(fit);
      await persistAiRetryResult(f.enriched, f.summary);
      const marks = () => lines.filter((l) => l.includes('"event":"ai_size_unavailable"'));
      assert.equal(marks().length, 0, "a fitting result logs nothing");

      const over = await seed(account, "szJ1-over", 1);
      const o = enrich(over);
      await padTo("szJ1-over", wireOf(o.enriched.aiAnalysis), MAX + 1);
      await persistAiRetryResult(o.enriched, o.summary);
      assert.equal(marks().length, 1, "exactly one line for the decision");
      await persistAiRetryResult(o.enriched, o.summary);
      assert.equal(marks().length, 1, "the idempotent repeat logs nothing");

      const event = JSON.parse(marks()[0]);
      assert.deepEqual(event, buildAiSizeUnavailableTelemetryEvent());
      assert.deepEqual(Object.keys(event).sort(), ["authMode", "event", "reason", "status"]);
      assert.deepEqual(event, { event: "ai_size_unavailable", reason: "REPORT_SIZE", status: 200, authMode: "authenticated" });
      const line = marks()[0];
      for (const forbidden of ["szJ1", "G2 large report fixture", TEXT.slice(0, 24), "passages", "payload", "compactPassages", String(MAX), account.email, account.userId]) {
        assert.equal(line.includes(forbidden), false, `the log line must not contain ${forbidden}`);
      }
    });
  } finally {
    warn.mock.restore();
    log.mock.restore();
    errorSpy.mock.restore();
  }
});

// ----------------------------------------------------------------------------------------------------------------
// K. COMPATIBILITY / SCOPE
// ----------------------------------------------------------------------------------------------------------------

test("K1 OLD READERS: the persisted marker is an ordinary failed AI result to any reader that predates the reason — terminal, no score, the customer sentence as its detail; no migration is involved", async () => {
  const oldReaderView = { ...MARKER };
  delete oldReaderView.unavailableReason;
  const report = { id: "old", aiAnalysis: oldReaderView };
  const persisted = { aiStatus: "failed", aiScore: null, aiTone: "unavailable" };
  assert.equal(resolveAiDisplayState({ ...persisted, aiAnalysis: oldReaderView }).state, "failed");
  const signal = aiSignalDisplay(report, persisted);
  assert.equal(signal.value, null);
  assert.equal(signal.detail, unavailable.AI_SIZE_UNAVAILABLE_MESSAGE, "an old bundle still shows the honest sentence");
  assert.equal(deriveRoomStatus(null, "failed"), "failed", "terminal for the room state machine");
  // The same result through the CURRENT reader, with the reason: still failed, never a number.
  assert.equal(resolveAiDisplayState({ ...persisted, aiAnalysis: MARKER }).state, "failed");
  // Shape: only additive fields; the marker has every field the AiAnalysis consumers read.
  for (const field of ["status", "score", "model", "engine", "threshold", "eligibleWordCount", "analyzedWordCount", "passages", "error"]) assert.ok(field in MARKER, field);
  assert.equal(Object.keys(MARKER).filter((k) => !("status,score,model,engine,threshold,thresholdLogOdds,eligibleWordCount,analyzedWordCount,passages,error,unavailableReason".split(",")).includes(k)).length, 0);
});

test("K2 DEFAULTS AND LIMITS: the request/persistence ceiling is 2,000,000 and unchanged; both compact writers default OFF; the AI compact writer pinned by this file is restored", async () => {
  assert.equal(MAX, 2_000_000);
  await fx.withAiCompactWrites(undefined, async () => { assert.equal(isAiCompactPassagesWriteEnabled(), false, "AI_COMPACT_WRITE_DEFAULT = OFF"); });
  assert.equal(process.env[fx.COMPACT_GATE], undefined, "REPORT_COMPACT_WRITE_DEFAULT = OFF (pinned unset for this file)");
  const example = await readFile(new URL("../.env.example", import.meta.url), "utf8").catch(() => "");
  assert.doesNotMatch(example, /^\s*(REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED|NEXT_PUBLIC_AI_COMPACT_PASSAGES_WRITE_ENABLED)\s*=\s*true/mi, "no default was flipped");
  // (this file pinned the AI writer ON at the top; the test.after hook restores it — checked by the final process-level assertion below)
  assert.equal(process.env[AI_COMPACT_PASSAGES_WRITE_FLAG], "true", "pinned for the duration of this file only");
  assert.notEqual(ambientAiFlag, "true", "fixture sanity: the ambient environment did not already enable it");
});

test.after(() => {
  // Runs after the pins above are restored (registered after the first test.after): nothing persists.
  assert.equal(process.env[AI_COMPACT_PASSAGES_WRITE_FLAG], ambientAiFlag, "the AI compact writer flag is back to its ambient value");
  assert.equal(process.env[fx.COMPACT_GATE], undefined, "the report compact writer flag is not left set");
  assert.equal(process.env.IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH, undefined, "no imported-evidence package is configured");
});
