import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

// room-page-shell.tsx is a real client component (next/navigation etc.): redirect those imports before loading it.
register("./helpers/ssr-next-hooks.mjs", import.meta.url);

import * as fx from "./helpers/large-report-retry-fixture.mjs";
import { createKit, sha, num } from "./helpers/ai-compact-integration-kit.mjs";
import { synthProse } from "./helpers/real-ai-windows.mjs";
import { saveReportRemote, fetchRemoteReport, listRemoteReportSummaries, fetchReportRoomContents } from "../lib/reports-remote.ts";
import { persistAiCompletion, persistAiRetryResult } from "../lib/report-ai-completion.ts";
import { buildReportSummary } from "../lib/report-types.ts";
import { findReportRowForUser } from "../lib/reports-repo.ts";
import { deriveRoomStatus } from "../lib/report-rooms.ts";
import { resolveAiDisplayState } from "../lib/ai-display-state.ts";
import { AI_SAVE_OUTCOME_SIZE_UNAVAILABLE, AI_UNAVAILABLE_REASON_REPORT_SIZE } from "../lib/ai-unavailable-state.ts";
import { MAX_REPORT_SAVE_REQUEST_BYTES } from "../lib/report-transport-limits.ts";

const roomShell = await import("../app/reports/rooms/[room]/room-page-shell.tsx");

/**
 * LEGACY-DERIVED-READY AI RETRY DOWNGRADE — POST /api/reports/[id]/ai-retry could turn a COMPLETE AI result into a failed one.
 *
 * THE SHAPE. `saved_reports.ai_status` arrived in drizzle/0028; every report saved before it has ai_status NULL next to its numeric
 * ai_score, and POST /api/reports still accepts an absent/null aiStatus (app/page.tsx's AI resave sends none). Every read treats that
 * row as complete: deriveRoomStatus (rooms index, room occupant, the SSR detail page) -> "ready", resolveAiDisplayState -> "complete"
 * with the stored score. The room therefore never offers Retry for it.
 *
 * THE DEFECT (reproduced on 851b35a). The retry route's LIFECYCLE-02 guard — "a 'ready' result is never displaced by a late
 * 'failed' one" — compared the RAW column (`ai_status === 'ready'`), not the derived definition the same route already uses for its
 * size policy. A direct Retry request carrying a failed result (a stale bundle, a replayed request, any authenticated owner) was
 * committed onto the legacy row: ai_status 'failed', ai_score NULL, aiAnalysis replaced by the error — the report's AI result lost.
 *
 * THE FIX. The guard uses the route's own `storedIsReady` (deriveRoomStatus), so a legacy complete row is protected exactly like an
 * explicit 'ready' one. Nothing else changes: an explicit 'ready' row, a failed row, a processing row, the terminal size policy,
 * the automatic completion and the similarity half all behave as before — asserted below.
 *
 * HOW. The REAL route handlers and client helpers against a throwaway migrated SQLite DB (fetch routed to the handlers). Every row is
 * produced by the real save routes — the legacy row by the exact requests a pre-0028 client (first save) and app/page.tsx (AI
 * resave) send, never by hand-written SQL. A trigger records every COMMITTED update of a report row, so writes are counted exactly
 * (a rolled-back tentative write takes its log row with it). The model runs only in a browser Worker; a counting Worker stub proves
 * no Retry here ever reached it.
 */

const MAX = MAX_REPORT_SAVE_REQUEST_BYTES;
const TEXT = synthProse(20_000, { seed: 83, messiness: 0.01 });

// Set up EVERYTHING before the first test() is registered (node:test starts a test the moment it is registered).
const env = await fx.createFixtureEnvironment("ai_retry_legacy_derived_ready");
process.env.TURSO_DATABASE_URL = `file:${env.dbFile}`;
const kit = createKit(env);
const restoreC2 = fx.pinCompactWrites(undefined);
const restoreAi = fx.pinAiCompactWrites(undefined);

await env.client.execute(`CREATE TABLE test_ai_write_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, report_id TEXT, ai_status TEXT, ai_analysis_status TEXT, unavailable_reason TEXT)`);
await env.client.execute(`CREATE TRIGGER test_ai_write_log_trg AFTER UPDATE ON saved_reports BEGIN
  INSERT INTO test_ai_write_log (report_id, ai_status, ai_analysis_status, unavailable_reason)
  VALUES (NEW.id, NEW.ai_status, json_extract(NEW.payload_json, '$.aiAnalysis.status'), json_extract(NEW.payload_json, '$.aiAnalysis.unavailableReason'));
END`);

/** The model Worker. Nothing a Retry request does on the server may ever reach it. */
const model = { runs: 0 };
const originalWorker = globalThis.Worker;
globalThis.Worker = class CountingWorker {
  addEventListener() {}
  removeEventListener() {}
  terminate() {}
  postMessage() { model.runs += 1; }
};

test.after(() => {
  globalThis.Worker = originalWorker;
  restoreAi();
  restoreC2();
  env.dispose();
});

// ---------------------------------------------------------------------------------------------------------------------
// Rows — every one through the real save routes
// ---------------------------------------------------------------------------------------------------------------------

let nextId = 1_759_000_000_000;
let nextRoom = 0;
const newReportId = () => String(nextId++);

/** The first save exactly as a client before drizzle/0028 sent it: the room page's own summary, with no aiStatus at all. */
async function legacyFirstSave(account, id, room) {
  const report = fx.buildFirstSaveBody({ deviceKey: account.deviceKey, id, text: TEXT, room }).payload;
  const summary = buildReportSummary(report);
  assert.equal("aiStatus" in summary, false, "fixture sanity: the pre-0028 summary carries no aiStatus");
  assert.equal((await saveReportRemote(report, summary, undefined, room)).ok, true, "fixture sanity: legacy first save");
  return report;
}

/** A LEGACY COMPLETE report: the legacy first save, then the AI resave app/page.tsx sends — buildReportSummary(enriched), no aiStatus. */
async function seedLegacyReady(account, id, room) {
  const report = await legacyFirstSave(account, id, room);
  const aiAnalysis = fx.syntheticAiAnalysis(TEXT, { seed: 11 });
  const enriched = { ...report, aiScore: aiAnalysis.score, aiAnalysis };
  const summary = buildReportSummary(enriched);
  assert.equal("aiStatus" in summary, false, "fixture sanity: app/page.tsx's AI-resave summary carries no aiStatus");
  assert.equal(typeof summary.aiScore, "number", "fixture sanity: the completed analysis yields a display score");
  assert.equal((await persistAiCompletion(enriched, summary)).ok, true, "fixture sanity: legacy AI resave");
}

/** A CURRENT complete report: the room page's first save ('processing') and saveEnrichedAiResult's resave ('ready'). */
async function seedExplicitReady(account, id, room) {
  const report = await kit.firstSave(account, id, TEXT, room);
  const { enriched, summary } = kit.readyEnrichment(report, fx.syntheticAiAnalysis(TEXT, { seed: 11 }), fx.syntheticAiAnalysis(TEXT, { seed: 11 }).score);
  assert.equal((await persistAiCompletion(enriched, summary, room)).ok, true, "fixture sanity: explicit ready resave");
}

const SEEDS = {
  legacyReady: seedLegacyReady,
  explicitReady: seedExplicitReady,
  failed: (account, id, room) => kit.seedFailedReport(account, id, TEXT, room),
  processing: (account, id, room) => kit.firstSave(account, id, TEXT, room),
  legacyProcessing: legacyFirstSave,
};

/** One fresh account + report in the given shape; write log cleared, so only what happens next is counted. */
async function seed(shape) {
  const account = await env.signUpAccount();
  const id = newReportId();
  const room = nextRoom++ % 10;
  await kit.asBrowser(account, () => SEEDS[shape](account, id, room));
  await env.client.execute("DELETE FROM test_ai_write_log");
  model.runs = 0;
  return { account, id, room };
}

// ---------------------------------------------------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------------------------------------------------

/** Every column of the stored row, as stored. "Persisted report unchanged" means this is identical. */
async function rawRow(id) {
  const row = (await env.client.execute({ sql: "SELECT * FROM saved_reports WHERE id = ?", args: [id] })).rows[0];
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, num(value)]));
}

/** The AI columns plus the AI-owned payload fields, for the capture lines. */
async function aiFields(id) {
  const row = await rawRow(id);
  const payload = JSON.parse(String(row.payload_json));
  return {
    ai_status: row.ai_status,
    ai_score: row.ai_score,
    ai_tone: row.ai_tone,
    aiAnalysisStatus: payload.aiAnalysis?.status ?? null,
    aiAnalysisSha: payload.aiAnalysis ? sha(JSON.stringify(payload.aiAnalysis)).slice(0, 16) : null,
    rawAiScore: payload.aiScore ?? null,
  };
}

/** Everything that is not the AI half: the payload without its two AI-owned fields, plus the flat non-AI columns. */
async function similarityHalf(id) {
  const row = await rawRow(id);
  const { aiAnalysis: _a, aiScore: _s, ...rest } = JSON.parse(String(row.payload_json));
  const flat = ["archive_score", "score_band", "word_count", "title", "submission_id", "report_created_at", "room_number", "user_id", "device_key"].map((c) => row[c]);
  return sha(JSON.stringify([rest, flat]));
}

async function writesFor(id) {
  const rows = (await env.client.execute({ sql: "SELECT ai_status, ai_analysis_status, unavailable_reason FROM test_ai_write_log WHERE report_id = ? ORDER BY seq", args: [id] })).rows;
  return rows.map((r) => `${r.ai_status}/${r.ai_analysis_status}${r.unavailable_reason ? `/${r.unavailable_reason}` : ""}`);
}

/** The application's own reads of this report's AI state — every one of them, as the product computes it. */
async function effectiveState({ account, id, room }) {
  const row = await findReportRowForUser(env.client, id, account.userId); // app/reports/[id]/page.tsx's read
  const payload = JSON.parse(row.payload_json);
  const display = resolveAiDisplayState({ aiStatus: row.ai_status, aiScore: row.ai_score, aiTone: row.ai_tone, aiAnalysis: payload.aiAnalysis ?? null });
  return kit.asBrowser(account, async () => {
    const detail = await fetchRemoteReport(id); // GET /api/reports/[id]
    const listed = (await listRemoteReportSummaries()).find((s) => s.id === id); // GET /api/reports (the account's report list)
    const roomRead = await fetchReportRoomContents(room); // GET /api/reports?room= -> findRoomOccupant (room page + poll)
    return {
      derived: deriveRoomStatus(row.ai_score, row.ai_status), // SSR detail page, rooms index, room occupant
      display: display.state,
      displayScore: display.score,
      room: roomRead.ok ? roomRead.contents.status : `unreadable:${roomRead.kind ?? "?"}`,
      listAiStatus: listed?.aiStatus ?? null,
      detailAiAnalysis: detail?.aiAnalysis?.status ?? null,
    };
  });
}

/** Exactly what saveRetriedAiResult sends when the re-run model fails: the real error result, through the real client helper. */
async function clientFailedRetry({ account, id }) {
  return kit.asBrowser(account, async (route) => {
    const full = await fetchRemoteReport(id);
    const enriched = { ...full, ...roomShell.aiAnalysisErrorResult(new Error("worker crashed"), "analyzing") };
    const summary = { ...buildReportSummary(enriched), aiStatus: "failed", similarityStatus: "pending" };
    const saved = await persistAiRetryResult(enriched, summary);
    return { ok: saved.ok, status: route.requests.filter((r) => r.path.endsWith("/ai-retry")).map((r) => r.status) };
  });
}

/** Exactly what saveRetriedAiResult sends when the re-run model completes. */
async function clientReadyRetry({ account, id }, analysis = fx.syntheticAiAnalysis(TEXT, { seed: 4242 })) {
  return kit.asBrowser(account, async (route) => {
    const full = await fetchRemoteReport(id);
    const { enriched, summary } = kit.readyEnrichment(full, analysis, 9);
    const saved = await persistAiRetryResult(enriched, summary);
    return { ok: saved.ok, aiOutcome: saved.summary.aiUnavailableReason ?? null, status: route.requests.filter((r) => r.path.endsWith("/ai-retry")).map((r) => r.status) };
  });
}

/** Direct Retry bodies — no client helper, as any caller holding the session can send them. */
const BODIES = {
  failed: () => ({ aiStatus: "failed", aiScore: null, aiTone: "unavailable", payload: { aiScore: null, aiAnalysis: { status: "error", score: null, passages: [] } } }),
  forgedSizeFailed: () => ({ aiStatus: "failed", aiScore: null, aiTone: "unavailable", payload: { aiScore: null, aiAnalysis: { status: "error", score: null, passages: [], unavailableReason: AI_UNAVAILABLE_REASON_REPORT_SIZE } } }),
  // A structurally valid complete result whose request fits the ceiling but which cannot be stored beside the report.
  oversizedComplete: () => kit.retryBodyFor({ status: "complete", score: 0.41, model: "synthetic-test-model", engine: null, threshold: 0.7, eligibleWordCount: 900, analyzedWordCount: 900, passages: [{ start: 0, end: 10, score: 0.41, text: "o".repeat(MAX - 2_000) }] }),
  complete: () => kit.retryBodyFor(fx.syntheticAiAnalysis(TEXT, { seed: 4242 })),
};

async function directRetry({ account, id }, body) {
  const response = await kit.callRetryRoute(id, { body, cookie: account.cookie });
  return { status: response.status, json: response.json };
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. LEGACY DERIVED READY
// ---------------------------------------------------------------------------------------------------------------------

test("1a. LEGACY SHAPE: the real save routes still produce ai_status NULL + a numeric ai_score + a complete aiAnalysis, and every read derives it READY", async (t) => {
  const r = await seed("legacyReady");
  const ai = await aiFields(r.id);
  assert.equal(ai.ai_status, null, "no ai_status was ever written");
  assert.equal(typeof ai.ai_score, "number", "a numeric display score");
  assert.ok(Number.isFinite(ai.ai_score));
  assert.match(ai.ai_tone, /^(low|review|high)$/);
  assert.equal(ai.aiAnalysisStatus, "complete");
  const state = await effectiveState(r);
  t.diagnostic(`CAPTURE legacy-shape ${JSON.stringify({ ai, state })}`);
  assert.deepEqual(state, {
    derived: "ready",
    display: "complete",
    displayScore: ai.ai_score,
    room: "ready",
    listAiStatus: null,
    detailAiAnalysis: "complete",
  });
});

test("1b. LEGACY DERIVED READY: a direct failed Retry — through the real client helper, or a bare request — is a no-op: 200, nothing written, nothing run, still READY", async (t) => {
  for (const via of ["client helper", "bare request", "bare request with a forged size claim"]) {
    const r = await seed("legacyReady");
    const before = { raw: await rawRow(r.id), ai: await aiFields(r.id), state: await effectiveState(r), similarity: await similarityHalf(r.id) };
    const response =
      via === "client helper" ? await clientFailedRetry(r)
      : await directRetry(r, via === "bare request" ? BODIES.failed() : BODIES.forgedSizeFailed());
    const after = { raw: await rawRow(r.id), ai: await aiFields(r.id), state: await effectiveState(r), similarity: await similarityHalf(r.id) };
    const writes = await writesFor(r.id);
    t.diagnostic(`CAPTURE legacy-failed-retry via=${via} ${JSON.stringify({ aiBefore: before.ai, stateBefore: before.state, response, modelRuns: model.runs, writes, aiAfter: after.ai, stateAfter: after.state })}`);

    if (via === "client helper") assert.deepEqual(response, { ok: true, status: [200] }, `${via}: answered 200 (the same answer an explicit 'ready' row gets)`);
    else assert.deepEqual(response, { status: 200, json: { ok: true } }, `${via}: answered 200 { ok: true }`);
    assert.equal(model.runs, 0, `${via}: no model execution`);
    assert.deepEqual(writes, [], `${via}: no committed write`);
    assert.deepEqual(after.raw, before.raw, `${via}: the stored row is byte-identical`);
    assert.equal(after.state.derived, "ready", `${via}: still ready`);
    assert.deepEqual(after.state, before.state, `${via}: every read is unchanged`);
    assert.equal(after.similarity, before.similarity, `${via}: similarity half byte-identical`);
  }
});

test("1c. LEGACY DERIVED READY: an oversized result is still refused without a write (the size policy already used the derived definition)", async () => {
  const r = await seed("legacyReady");
  const before = await rawRow(r.id);
  assert.deepEqual(await directRetry(r, BODIES.oversizedComplete()), { status: 200, json: { ok: true } });
  assert.deepEqual(await writesFor(r.id), []);
  assert.deepEqual(await rawRow(r.id), before);
  assert.equal(model.runs, 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. CURRENT EXPLICIT READY — unchanged; and the legacy row now answers every Retry body exactly like it
// ---------------------------------------------------------------------------------------------------------------------

test("2. CURRENT EXPLICIT READY is unchanged, and a legacy complete row answers EVERY Retry body exactly like it", async (t) => {
  const expected = {
    failed: { status: 200, json: { ok: true }, writes: [], derivedAfter: "ready" },
    forgedSizeFailed: { status: 200, json: { ok: true }, writes: [], derivedAfter: "ready" },
    oversizedComplete: { status: 200, json: { ok: true }, writes: [], derivedAfter: "ready" },
    // A complete result replacing a complete result is the existing last-writer-wins transition (never a downgrade).
    complete: { status: 200, json: { ok: true }, writes: ["ready/complete"], derivedAfter: "ready" },
  };
  for (const [kind, body] of Object.entries(BODIES)) {
    const outcomes = {};
    for (const shape of ["explicitReady", "legacyReady"]) {
      const r = await seed(shape);
      const similarityBefore = await similarityHalf(r.id);
      const response = await directRetry(r, body());
      outcomes[shape] = { ...response, writes: await writesFor(r.id), derivedAfter: (await effectiveState(r)).derived };
      assert.equal(await similarityHalf(r.id), similarityBefore, `${shape}/${kind}: similarity half byte-identical`);
    }
    t.diagnostic(`CAPTURE parity body=${kind} ${JSON.stringify(outcomes)}`);
    assert.deepEqual(outcomes.explicitReady, expected[kind], `explicit ready / ${kind}: the existing behaviour`);
    assert.deepEqual(outcomes.legacyReady, outcomes.explicitReady, `legacy ready / ${kind}: identical to explicit ready`);
  }
  assert.equal(model.runs, 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. GENUINELY FAILED — still retryable, one write per Retry, can reach READY
// ---------------------------------------------------------------------------------------------------------------------

test("3. GENUINELY FAILED: a Retry that fails again is persisted once (still retryable); a Retry that completes is persisted once and reaches READY", async () => {
  const r = await seed("failed");
  const similarityBefore = await similarityHalf(r.id);
  assert.equal((await effectiveState(r)).derived, "failed");

  assert.deepEqual(await clientFailedRetry(r), { ok: true, status: [200] });
  assert.deepEqual(await writesFor(r.id), ["failed/error"], "failed -> failed, exactly one write");
  assert.equal((await effectiveState(r)).room, "failed");

  assert.deepEqual(await clientReadyRetry(r), { ok: true, aiOutcome: null, status: [200] });
  assert.deepEqual(await writesFor(r.id), ["failed/error", "ready/complete"], "failed -> ready, exactly one more write");
  const state = await effectiveState(r);
  assert.equal(state.derived, "ready");
  assert.equal(state.room, "ready");
  assert.equal(state.detailAiAnalysis, "complete");
  assert.equal(await similarityHalf(r.id), similarityBefore);
});

test("3b. A LEGACY row that never completed (ai_status NULL, ai_score NULL) derives PROCESSING and still accepts a Retry result — the fix does not over-protect", async () => {
  const r = await seed("legacyProcessing");
  const similarityBefore = await similarityHalf(r.id);
  assert.deepEqual(await aiFields(r.id).then(({ ai_status, ai_score }) => ({ ai_status, ai_score })), { ai_status: null, ai_score: null });
  assert.equal((await effectiveState(r)).derived, "processing");
  assert.deepEqual(await directRetry(r, BODIES.failed()), { status: 200, json: { ok: true } });
  assert.deepEqual(await writesFor(r.id), ["failed/error"]);
  assert.equal((await effectiveState(r)).derived, "failed");
  assert.equal(await similarityHalf(r.id), similarityBefore);
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. FAILED SAVE THEN RETRY — the save that never reached the server is recovered by the next Retry
//    (the UI-level regression — the real RoomPageShell's retryAiCheck — is tests/ai-retry-double-failure.test.mjs)
// ---------------------------------------------------------------------------------------------------------------------

test("4. FAILED SAVE THEN RETRY: a completed result whose save failed leaves the row failed; the next Retry persists it once and reaches READY", async () => {
  const r = await seed("failed");
  const similarityBefore = await similarityHalf(r.id);
  const first = await kit.asBrowser(r.account, async (route) => {
    const routed = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
      if (String(typeof input === "string" ? input : input.url).endsWith("/ai-retry")) {
        route.requests.push({ method: "POST", path: `/api/reports/${r.id}/ai-retry`, status: "FAULT:500" });
        return new Response(JSON.stringify({ error: "Unable to save the AI result. Please try again." }), { status: 500 });
      }
      return routed(input, init);
    };
    const full = await fetchRemoteReport(r.id);
    const { enriched, summary } = kit.readyEnrichment(full, fx.syntheticAiAnalysis(TEXT, { seed: 4242 }), 9);
    return (await persistAiRetryResult(enriched, summary)).ok;
  });
  assert.equal(first, false, "the first save failed");
  assert.deepEqual(await writesFor(r.id), [], "nothing reached the server");
  assert.equal((await effectiveState(r)).derived, "failed");

  assert.deepEqual(await clientReadyRetry(r), { ok: true, aiOutcome: null, status: [200] });
  assert.deepEqual(await writesFor(r.id), ["ready/complete"]);
  assert.equal((await effectiveState(r)).derived, "ready");
  assert.equal(await similarityHalf(r.id), similarityBefore);
});

// ---------------------------------------------------------------------------------------------------------------------
// 5. PROCESSING / BUSY
// ---------------------------------------------------------------------------------------------------------------------

test("5a. PROCESSING: a report still mid-analysis accepts a failed Retry result exactly as before", async () => {
  const r = await seed("processing");
  assert.equal((await effectiveState(r)).derived, "processing");
  assert.deepEqual(await directRetry(r, BODIES.failed()), { status: 200, json: { ok: true } });
  assert.deepEqual(await writesFor(r.id), ["failed/error"]);
  assert.equal((await effectiveState(r)).derived, "failed");
});

test("5b. BUSY: simultaneous failed Retries against a legacy complete row all answer 200 and none of them writes", async () => {
  const r = await seed("legacyReady");
  const before = await rawRow(r.id);
  const responses = await Promise.all(Array.from({ length: 4 }, () => directRetry(r, BODIES.failed())));
  assert.deepEqual(responses, Array.from({ length: 4 }, () => ({ status: 200, json: { ok: true } })));
  assert.deepEqual(await writesFor(r.id), []);
  assert.deepEqual(await rawRow(r.id), before);
});

// ---------------------------------------------------------------------------------------------------------------------
// 6. TERMINAL OVERSIZED / UNAVAILABLE — unchanged
// ---------------------------------------------------------------------------------------------------------------------

test("6. TERMINAL OVERSIZED: a failed row's unstorable result becomes the server-authored terminal state once; a later failure is the same terminal answer with no write", async () => {
  const r = await seed("failed");
  const similarityBefore = await similarityHalf(r.id);
  assert.deepEqual(await directRetry(r, BODIES.oversizedComplete()), { status: 200, json: { ok: true, aiOutcome: AI_SAVE_OUTCOME_SIZE_UNAVAILABLE } });
  assert.deepEqual(await writesFor(r.id), ["ready/complete", `failed/error/${AI_UNAVAILABLE_REASON_REPORT_SIZE}`], "one transaction: tentative candidate, then the marker");
  const marked = await rawRow(r.id);
  assert.deepEqual(await directRetry(r, BODIES.failed()), { status: 200, json: { ok: true, aiOutcome: AI_SAVE_OUTCOME_SIZE_UNAVAILABLE } });
  assert.deepEqual(await writesFor(r.id), ["ready/complete", `failed/error/${AI_UNAVAILABLE_REASON_REPORT_SIZE}`], "no further write");
  assert.deepEqual(await rawRow(r.id), marked);
  assert.equal((await effectiveState(r)).derived, "failed");
  assert.equal(await similarityHalf(r.id), similarityBefore);
});

// ---------------------------------------------------------------------------------------------------------------------
// 7. AUTOMATIC COMPLETION — unchanged
// ---------------------------------------------------------------------------------------------------------------------

test("7. AUTOMATIC COMPLETION: the room page's automatic resave still moves a processing report to READY (or FAILED) in one write", async () => {
  for (const outcome of ["complete", "error"]) {
    const account = await env.signUpAccount();
    const id = newReportId();
    const room = nextRoom++ % 10;
    await kit.asBrowser(account, async () => {
      const report = await kit.firstSave(account, id, TEXT, room);
      await env.client.execute("DELETE FROM test_ai_write_log");
      const similarityBefore = await similarityHalf(id);
      const aiResult = outcome === "complete"
        ? { aiScore: 0.33, aiAnalysis: fx.syntheticAiAnalysis(TEXT, { seed: 7 }) }
        : roomShell.aiAnalysisErrorResult(new Error("worker crashed"), "analyzing");
      const enriched = { ...report, ...aiResult };
      const summary = { ...buildReportSummary(enriched), aiStatus: outcome === "complete" ? "ready" : "failed", similarityStatus: "pending" };
      assert.equal((await persistAiCompletion(enriched, summary, room)).ok, true);
      assert.deepEqual(await writesFor(id), [outcome === "complete" ? "ready/complete" : "failed/error"]);
      const row = await rawRow(id);
      assert.equal(deriveRoomStatus(row.ai_score, row.ai_status), outcome === "complete" ? "ready" : "failed");
      assert.equal((await aiFields(id)).aiAnalysisStatus, outcome);
      assert.equal(await similarityHalf(id), similarityBefore, "similarity half byte-identical across the AI resave");
    });
  }
  assert.equal(model.runs, 0);
});
