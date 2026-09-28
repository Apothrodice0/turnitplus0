import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { createClient } from "@libsql/client";

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
import { AI_UNAVAILABLE_REASON_REPORT_SIZE } from "../lib/ai-unavailable-state.ts";
import { MAX_REPORT_SAVE_REQUEST_BYTES } from "../lib/report-transport-limits.ts";

/**
 * LEGACY-DERIVED-READY WHOLE-REPORT SAVE DOWNGRADE — POST /api/reports could turn a COMPLETE AI result into a failed one.
 *
 * THE SHAPE. A legacy complete report stores ai_status NULL next to its numeric ai_score and a complete aiAnalysis (every report
 * saved before drizzle/0028; POST /api/reports still accepts an absent/null aiStatus). Every read derives it READY
 * (lib/report-rooms.ts deriveRoomStatus -> rooms index, room occupant, SSR detail page; resolveAiDisplayState -> "complete").
 *
 * THE DEFECT (reproduced on 2fb2037). SAVE_REPORT_SQL's LIFECYCLE-02 guard — an incoming 'failed' AI half never replaces a
 * stored ready one — tested the RAW column (`saved_reports.ai_status = 'ready'`). For the legacy row that is false, so a
 * whole-report resave carrying a failed AI result (the request the room page's automatic pass sends when the model fails —
 * from a stale tab/bundle, a replay, or any direct caller holding the owner's session) replaced ai_status/ai_score/ai_tone AND
 * payload_json.aiAnalysis/aiScore: the report's AI result lost. 2fb2037 closed the same gap in the AI-retry route.
 *
 * THE FIX. The guard's stored side is "ai_status 'ready' OR deriveRoomStatus 'ready'", the latter evaluated inside the
 * statement (lib/report-rooms.ts derivedAiReadySql), so a legacy complete row is protected exactly like an explicit 'ready' one
 * and every row the raw check protected stays protected. The incoming side was already the derived one ('failed' is the only
 * value deriveRoomStatus maps to "failed"). The AI-retry route's guard takes the same form: 2fb2037 had made it derived-only,
 * which dropped the protection of an explicit 'ready' row without a calibrated score (test 9 — kept on 851b35a, downgraded on
 * 2fb2037). Nothing else changes — asserted below: a new report's first save, the automatic completion (success, failure,
 * oversized fallback), a failed row's recovery, and complete -> complete replacement all behave as before, with the similarity
 * half byte-identical.
 *
 * HOW. The REAL route handlers and client helpers against a throwaway migrated SQLite DB (fetch routed to the handlers). Every
 * row is produced by the real save routes — never hand-written SQL. A trigger logs every committed UPDATE of a report row
 * with whether its AI half changed (a whole-report resave always rewrites the row's non-AI columns, so "written" and "AI
 * changed" are counted separately). The automatic completion runs through the room page's REAL exported chain —
 * completeAiAnalysisWithRecovery(runAiAnalysis(...)) with a scripted model Worker — saving with saveEnrichedAiResult's exact
 * calls, as tests/ai-retry-double-failure.test.mjs does.
 */

const MAX = MAX_REPORT_SAVE_REQUEST_BYTES;
const TEXT = synthProse(20_000, { seed: 97, messiness: 0.01 });

/** The model Worker (room-page-shell.tsx creates it lazily, once). Each postMessage consumes one scripted behaviour. */
const model = { script: [], runs: 0 };
const originalWorker = globalThis.Worker;
globalThis.Worker = class ScriptedWorker {
  constructor() { this.listeners = new Set(); }
  addEventListener(type, fn) { if (type === "message") this.listeners.add(fn); }
  removeEventListener(type, fn) { this.listeners.delete(fn); }
  terminate() {}
  postMessage({ id, text }) {
    model.runs += 1;
    const behaviour = model.script.shift() ?? "unscripted";
    setImmediate(() => {
      const emit = (data) => { for (const fn of [...this.listeners]) fn({ data }); };
      emit({ type: "prep", stage: "analyzing" });
      if (behaviour === "complete") emit({ id, ok: true, result: fx.syntheticAiAnalysis(text, { seed: 4242 }) });
      else if (behaviour === "oversized") emit({ id, ok: true, result: oversizedAnalysis() });
      else emit({ id, ok: false, error: `Injected model failure (${behaviour})` });
    });
  }
};

/** A structurally valid complete result: the whole-report resave is over the request ceiling, the AI-only request is not. */
function oversizedAnalysis() {
  return {
    status: "complete", score: 0.41, model: "synthetic-test-model", engine: null, threshold: 0.7, eligibleWordCount: 900, analyzedWordCount: 900,
    passages: [{ start: 0, end: 10, score: 0.41, text: "o".repeat(MAX - 2_000) }],
  };
}

// Set up EVERYTHING before the first test() is registered (node:test starts a test the moment it is registered).
const env = await fx.createFixtureEnvironment("report_save_legacy_derived_ready");
process.env.TURSO_DATABASE_URL = `file:${env.dbFile}`;
const kit = createKit(env);
const restoreC2 = fx.pinCompactWrites(undefined);
const restoreAi = fx.pinAiCompactWrites(undefined);
const roomShell = await import("../app/reports/rooms/[room]/room-page-shell.tsx");
const { accountLocalReportOwner, storeReportBestEffort } = await import("../lib/report-store.ts");
const { createMemoryIndexedDb } = await import("./helpers/memory-indexeddb.mjs");
globalThis.indexedDB = createMemoryIndexedDb().factory;

await env.client.execute(`CREATE TABLE test_row_write_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, report_id TEXT, ai_changed INTEGER, ai_status TEXT, ai_analysis_status TEXT, unavailable_reason TEXT)`);
await env.client.execute(`CREATE TRIGGER test_row_write_log_trg AFTER UPDATE ON saved_reports BEGIN
  INSERT INTO test_row_write_log (report_id, ai_changed, ai_status, ai_analysis_status, unavailable_reason)
  VALUES (NEW.id,
    (OLD.ai_status IS NOT NEW.ai_status) OR (OLD.ai_score IS NOT NEW.ai_score) OR (OLD.ai_tone IS NOT NEW.ai_tone)
      OR (json_extract(OLD.payload_json, '$.aiAnalysis') IS NOT json_extract(NEW.payload_json, '$.aiAnalysis'))
      OR (json_extract(OLD.payload_json, '$.aiScore') IS NOT json_extract(NEW.payload_json, '$.aiScore')),
    NEW.ai_status, json_extract(NEW.payload_json, '$.aiAnalysis.status'), json_extract(NEW.payload_json, '$.aiAnalysis.unavailableReason'));
END`);

test.after(() => {
  globalThis.Worker = originalWorker;
  restoreAi();
  restoreC2();
  env.dispose();
});

// ---------------------------------------------------------------------------------------------------------------------
// Rows — every one through the real save routes
// ---------------------------------------------------------------------------------------------------------------------

/** One signed-in browser for `account`: the same device key on every visit (lib/device-key.ts), as a real browser keeps it. */
function asAccount(account, fn) {
  return kit.asBrowser(account, (route) => {
    window.localStorage.setItem("tp_device_key_v1", account.deviceKey);
    return fn(route);
  });
}

let nextId = 1_760_000_000_000;
let nextRoom = 0;
const REPORTS = new Map(); // id -> { report, room } — the client-built report the room page holds for its automatic resave

/** The room page's first save, as a client before drizzle/0028 sent it: the room page's summary with no aiStatus at all. */
async function legacyFirstSave(account, id, room) {
  const report = fx.buildFirstSaveBody({ deviceKey: account.deviceKey, id, text: TEXT, room }).payload;
  const summary = buildReportSummary(report);
  assert.equal("aiStatus" in summary, false, "fixture sanity: the pre-0028 summary carries no aiStatus");
  assert.equal((await saveReportRemote(report, summary, undefined, room)).ok, true, "fixture sanity: legacy first save");
  return report;
}

/** saveEnrichedAiResult's persistence, exactly: the enriched report, the room page's summary for it, persistAiCompletion. */
async function automaticResave(account, report, room, aiResult) {
  const enriched = { ...report, ...aiResult };
  const summary = { ...buildReportSummary(enriched), aiStatus: aiResult.aiAnalysis.status === "complete" ? "ready" : "failed", similarityStatus: "pending" };
  await storeReportBestEffort(enriched, accountLocalReportOwner(account.email));
  return persistAiCompletion(enriched, summary, room);
}

const completeResult = (seed = 11) => {
  const aiAnalysis = fx.syntheticAiAnalysis(TEXT, { seed });
  return { aiScore: aiAnalysis.score, aiAnalysis };
};

const SEEDS = {
  /** Legacy complete: the legacy first save, then the AI resave app/page.tsx sends — buildReportSummary(enriched), no aiStatus. */
  async legacyReady(account, id, room) {
    const report = await legacyFirstSave(account, id, room);
    const enriched = { ...report, ...completeResult() };
    const summary = buildReportSummary(enriched);
    assert.equal("aiStatus" in summary, false, "fixture sanity: app/page.tsx's AI-resave summary carries no aiStatus");
    assert.equal((await persistAiCompletion(enriched, summary)).ok, true, "fixture sanity: legacy AI resave");
    return report;
  },
  /** Current complete: the room page's first save ('processing') and its automatic resave ('ready'). */
  async explicitReady(account, id, room) {
    const report = await kit.firstSave(account, id, TEXT, room);
    assert.equal((await automaticResave(account, report, room, completeResult())).ok, true, "fixture sanity: explicit ready resave");
    return report;
  },
  /** Explicit ready without a calibrated score (test 9): the same automatic resave from a stale worker — ai_status 'ready', ai_score NULL. */
  async explicitReadyNullScore(account, id, room) {
    const report = await kit.firstSave(account, id, TEXT, room);
    const aiAnalysis = { ...fx.syntheticAiAnalysis(TEXT, { seed: 11 }), scoringVersion: 9 }; // a stale worker: not calibratable
    assert.equal((await automaticResave(account, report, room, { aiScore: aiAnalysis.score, aiAnalysis })).ok, true, "fixture sanity: explicit ready resave without a calibrated score");
    return report;
  },
  async failed(account, id, room) {
    const report = await kit.firstSave(account, id, TEXT, room);
    assert.equal((await automaticResave(account, report, room, roomShell.aiAnalysisErrorResult(new Error("worker crashed"), "analyzing"))).ok, true);
    return report;
  },
  processing: (account, id, room) => kit.firstSave(account, id, TEXT, room),
};

/** One fresh account + report in the given shape; logs cleared, so only what happens next is counted. */
async function seed(shape) {
  const account = await env.signUpAccount();
  const id = String(nextId++);
  const room = nextRoom++ % 10;
  const report = await asAccount(account, () => SEEDS[shape](account, id, room));
  REPORTS.set(id, { report, room });
  await env.client.execute("DELETE FROM test_row_write_log");
  model.runs = 0;
  model.script.length = 0;
  return { account, id, room, report };
}

// ---------------------------------------------------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------------------------------------------------

async function rawRow(id) {
  const row = (await env.client.execute({ sql: "SELECT * FROM saved_reports WHERE id = ?", args: [id] })).rows[0];
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, num(value)]));
}

/** The AI columns and the two AI-owned payload fields — "the AI result". */
async function aiHalf(id) {
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

/** Committed UPDATEs of the row: how many, and how many of them changed the AI half. */
async function writesFor(id) {
  const rows = (await env.client.execute({ sql: "SELECT ai_changed, ai_status, ai_analysis_status, unavailable_reason FROM test_row_write_log WHERE report_id = ? ORDER BY seq", args: [id] })).rows;
  return {
    rowWrites: rows.length,
    aiChanges: rows.filter((r) => Number(r.ai_changed) === 1).map((r) => `${r.ai_status}/${r.ai_analysis_status}${r.unavailable_reason ? `/${r.unavailable_reason}` : ""}`),
  };
}

/** The application's own reads of this report's AI state. */
async function effectiveState({ account, id, room }) {
  const row = await findReportRowForUser(env.client, id, account.userId); // app/reports/[id]/page.tsx's read
  const payload = JSON.parse(row.payload_json);
  const display = resolveAiDisplayState({ aiStatus: row.ai_status, aiScore: row.ai_score, aiTone: row.ai_tone, aiAnalysis: payload.aiAnalysis ?? null });
  return asAccount(account, async () => {
    const detail = await fetchRemoteReport(id); // GET /api/reports/[id]
    const listed = (await listRemoteReportSummaries()).find((s) => s.id === id); // GET /api/reports
    const roomRead = await fetchReportRoomContents(room); // GET /api/reports?room= -> findRoomOccupant
    return {
      derived: deriveRoomStatus(row.ai_score, row.ai_status), // SSR detail page, rooms index, room occupant
      display: display.state,
      displayScore: display.score,
      room: roomRead.ok ? roomRead.contents.status : "unreadable",
      listAiStatus: listed?.aiStatus ?? null,
      detailAiAnalysis: detail?.aiAnalysis?.status ?? null,
    };
  });
}

/** The whole-report failed resave: the exact request the room page's automatic pass sends when the model fails. */
const FAILED_SAVES = {
  "automatic-pass failure (client helper)": ({ account, id, room }) => asAccount(account, async (route) => {
    const saved = await automaticResave(account, REPORTS.get(id).report, room, roomShell.aiAnalysisErrorResult(new Error("worker crashed"), "analyzing"));
    return { ok: saved.ok, http: route.requests.filter((r) => r.method === "POST").map((r) => `${r.path}:${r.status}`) };
  }),
  // A direct whole-report POST in the "AI unavailable" shape (failed, tone 'unavailable', a size marker the server strips).
  "unavailable-shaped failure (bare POST)": ({ account, id, room }) => asAccount(account, async (route) => {
    const { report } = REPORTS.get(id);
    const enriched = { ...report, aiScore: null, aiAnalysis: { status: "error", score: null, passages: [], unavailableReason: AI_UNAVAILABLE_REASON_REPORT_SIZE } };
    const saved = await saveReportRemote(enriched, { ...buildReportSummary(enriched), aiStatus: "failed", aiScore: null, aiTone: "unavailable" }, undefined, room);
    return { ok: saved.ok, http: route.requests.filter((r) => r.method === "POST").map((r) => `${r.path}:${r.status}`) };
  }),
};

/** A whole-report complete resave (complete -> complete replacement, unchanged by this fix). */
const completeSave = ({ account, id, room }) => asAccount(account, async (route) => {
  const saved = await automaticResave(account, REPORTS.get(id).report, room, completeResult(4242));
  return { ok: saved.ok, http: route.requests.filter((r) => r.method === "POST").map((r) => `${r.path}:${r.status}`) };
});

// ---------------------------------------------------------------------------------------------------------------------
// 0. The guard itself: SAVE_REPORT_SQL keeps a stored AI half against a late 'failed' EXACTLY when deriveRoomStatus says ready
// ---------------------------------------------------------------------------------------------------------------------

test("0. SAVE_REPORT_SQL keeps the stored AI half against an incoming 'failed' exactly when the stored AI half is ready (ai_status 'ready', or deriveRoomStatus 'ready') — for every stored combination; an incoming 'ready' always replaces it", async (t) => {
  const client = createClient({ url: `file:${env.dbFile}` });
  const { SAVE_REPORT_SQL } = fx.reportsRoute;
  const args = (id, aiScore, aiStatus, note) => [id, "matrix-device", `sub-${id}`, "matrix", new Date().toISOString(), 10, 0, "Low", aiScore, aiScore === null ? null : "low", aiStatus, JSON.stringify({ note }), null, null];
  const table = [];
  try {
    let n = 0;
    for (const storedStatus of [null, "processing", "ready", "failed"]) {
      for (const storedScore of [null, 0, 42]) {
        for (const incoming of ["failed", "ready"]) {
          const id = `matrix-${n++}`;
          await client.execute({ sql: SAVE_REPORT_SQL, args: args(id, storedScore, storedStatus, "stored") }); // the stored row, written by the real upsert
          await client.execute({ sql: SAVE_REPORT_SQL, args: args(id, incoming === "ready" ? 77 : null, incoming, "incoming") });
          const row = (await client.execute({ sql: "SELECT ai_status, ai_score, payload_json FROM saved_reports WHERE id = ?", args: [id] })).rows[0];
          const kept = row.ai_status === storedStatus && num(row.ai_score) === storedScore && JSON.parse(row.payload_json).note === "stored";
          const replaced = row.ai_status === incoming && JSON.parse(row.payload_json).note === "incoming";
          const storedReady = storedStatus === "ready" || deriveRoomStatus(storedScore, storedStatus) === "ready";
          table.push(`${storedStatus}/${storedScore} <- ${incoming}: ${kept ? "KEPT" : replaced ? "REPLACED" : "MIXED"}`);
          assert.ok(kept || replaced, `stored ${storedStatus}/${storedScore} <- ${incoming}: all-or-nothing, never a partial AI half`);
          assert.equal(kept, incoming === "failed" && storedReady, `stored ${storedStatus}/${storedScore} <- ${incoming}: kept iff incoming failed and the stored AI half is ready`);
        }
      }
    }
  } finally {
    t.diagnostic(`MATRIX ${JSON.stringify(table)}`);
    client.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// 1. LEGACY DERIVED READY + FAILED WHOLE-REPORT SAVE
// ---------------------------------------------------------------------------------------------------------------------

test("1a. LEGACY SHAPE: the real save routes produce ai_status NULL + a numeric ai_score + a complete aiAnalysis, and every read derives it READY", async (t) => {
  const r = await seed("legacyReady");
  const ai = await aiHalf(r.id);
  assert.equal(ai.ai_status, null);
  assert.equal(typeof ai.ai_score, "number");
  assert.equal(ai.aiAnalysisStatus, "complete");
  const state = await effectiveState(r);
  t.diagnostic(`CAPTURE legacy-shape ${JSON.stringify({ ai, state })}`);
  assert.deepEqual(state, { derived: "ready", display: "complete", displayScore: ai.ai_score, room: "ready", listAiStatus: null, detailAiAnalysis: "complete" });
});

for (const [label, save] of Object.entries(FAILED_SAVES)) {
  test(`1b. LEGACY DERIVED READY + FAILED WHOLE-REPORT SAVE (${label}): accepted, but the ready AI result is preserved exactly — still READY, similarity unchanged`, async (t) => {
    const r = await seed("legacyReady");
    const before = { ai: await aiHalf(r.id), state: await effectiveState(r), similarity: await similarityHalf(r.id) };
    const response = await save(r);
    const after = { ai: await aiHalf(r.id), state: await effectiveState(r), similarity: await similarityHalf(r.id) };
    const writes = await writesFor(r.id);
    t.diagnostic(`CAPTURE legacy-failed-save via=${label} ${JSON.stringify({ aiBefore: before.ai, stateBefore: before.state, response, modelRuns: model.runs, writes, aiAfter: after.ai, stateAfter: after.state })}`);

    assert.deepEqual(response, { ok: true, http: [`/api/reports:200`] }, "the save itself is accepted (a no-op for the AI half, not a rejected request)");
    assert.deepEqual(writes.aiChanges, [], "no committed write changed the AI half");
    assert.deepEqual(after.ai, before.ai, "the AI result is exactly as it was");
    assert.equal(after.state.derived, "ready");
    assert.deepEqual(after.state, before.state, "every read is unchanged");
    assert.equal(after.similarity, before.similarity, "similarity half byte-identical");
    assert.equal(model.runs, 0);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// 2-4. EXPLICIT READY + FAILED (unchanged); READY + COMPLETE (complete -> complete, unchanged) — legacy answers like explicit
// ---------------------------------------------------------------------------------------------------------------------

test("2-4. EXPLICIT READY is unchanged, and a legacy complete row answers every whole-report save exactly like it: a failure preserves the result; a complete result replaces it (complete -> complete, unchanged)", async (t) => {
  const saves = { ...FAILED_SAVES, "complete result (automatic resave)": completeSave };
  for (const [label, save] of Object.entries(saves)) {
    const outcomes = {};
    for (const shape of ["explicitReady", "legacyReady"]) {
      const r = await seed(shape);
      const before = { ai: await aiHalf(r.id), similarity: await similarityHalf(r.id) };
      const response = await save(r);
      const after = await aiHalf(r.id);
      const { aiChanges } = await writesFor(r.id);
      outcomes[shape] = {
        response,
        aiChanges,
        aiPreserved: JSON.stringify(after) === JSON.stringify(before.ai),
        after: { ai_status: after.ai_status, aiAnalysisStatus: after.aiAnalysisStatus, aiAnalysisSha: after.aiAnalysisSha, rawAiScore: after.rawAiScore },
        derivedAfter: (await effectiveState(r)).derived,
      };
      assert.equal(await similarityHalf(r.id), before.similarity, `${shape} / ${label}: similarity half byte-identical`);
    }
    t.diagnostic(`CAPTURE parity save=${label} ${JSON.stringify(outcomes)}`);
    if (label.startsWith("complete")) {
      assert.deepEqual(outcomes.explicitReady.aiChanges, ["ready/complete"], "explicit ready <- complete: replaced by the new complete result (existing behaviour)");
      assert.equal(outcomes.explicitReady.aiPreserved, false);
      assert.equal(outcomes.explicitReady.after.aiAnalysisSha, sha(JSON.stringify(completeResult(4242).aiAnalysis)).slice(0, 16), "the new complete result is what is stored");
    } else {
      assert.deepEqual(outcomes.explicitReady.aiChanges, [], `explicit ready <- ${label}: preserved (existing LIFECYCLE-02 behaviour)`);
      assert.equal(outcomes.explicitReady.aiPreserved, true);
    }
    assert.equal(outcomes.explicitReady.derivedAfter, "ready");
    assert.deepEqual(
      { ...outcomes.legacyReady, after: { ...outcomes.legacyReady.after } },
      { ...outcomes.explicitReady, after: { ...outcomes.explicitReady.after, ...(label.startsWith("complete") ? {} : { ai_status: null }) } },
      `legacy ready / ${label}: identical to explicit ready (apart from the stored representation it keeps)`,
    );
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// 5. PROCESSING + AUTOMATIC COMPLETION — through the room page's real exported chain
// ---------------------------------------------------------------------------------------------------------------------

/** runCheck's automatic pass: completeAiAnalysisWithRecovery(runAiAnalysis(text, lang), aiResult => saveEnrichedAiResult(...)). */
async function automaticPass({ account, id, room }, behaviour, { rejected = false } = {}) {
  const { report } = REPORTS.get(id);
  return asAccount(account, async (route) => {
    if (!rejected) model.script.push(behaviour);
    const aiAnalysisPromise = rejected ? Promise.reject(new Error("pipeline blew up")) : roomShell.runAiAnalysis(TEXT, "English");
    const saved = await roomShell.completeAiAnalysisWithRecovery(aiAnalysisPromise, async (aiResult) => (await automaticResave(account, report, room, aiResult)).ok);
    return { saved, http: route.requests.filter((r) => r.method === "POST").map((r) => `${r.path}:${r.status}`) };
  });
}

test("5. AUTOMATIC COMPLETION: a processing report's automatic pass persists a completed result (READY) and a failed one (FAILED) in one AI write each — exactly as before", async (t) => {
  for (const [behaviour, expected] of [["complete", { derived: "ready", aiChanges: ["ready/complete"] }], ["error", { derived: "failed", aiChanges: ["failed/error"] }]]) {
    const r = await seed("processing");
    assert.equal((await effectiveState(r)).derived, "processing");
    const similarityBefore = await similarityHalf(r.id);
    const outcome = await automaticPass(r, behaviour);
    const writes = await writesFor(r.id);
    const ai = await aiHalf(r.id);
    t.diagnostic(`CAPTURE automatic behaviour=${behaviour} ${JSON.stringify({ outcome, modelRuns: model.runs, writes, ai })}`);
    assert.deepEqual(outcome, { saved: true, http: ["/api/reports:200"] }, `${behaviour}: one whole-report save, accepted`);
    assert.equal(model.runs, 1, `${behaviour}: exactly one model run`);
    assert.deepEqual(writes.aiChanges, expected.aiChanges);
    assert.equal((await effectiveState(r)).derived, expected.derived);
    if (behaviour === "complete") {
      assert.equal(ai.aiAnalysisSha, sha(JSON.stringify(fx.syntheticAiAnalysis(TEXT, { seed: 4242 }))).slice(0, 16), "the model's own result is what is stored");
      assert.equal(typeof ai.ai_score, "number");
    } else {
      assert.equal(ai.ai_score, null);
      assert.equal(ai.ai_tone, "unavailable");
    }
    assert.equal(await similarityHalf(r.id), similarityBefore, `${behaviour}: similarity half byte-identical`);
    model.runs = 0;
  }
});

test("5b. AUTOMATIC COMPLETION: a pipeline that rejects outright still persists the terminal FAILED state; a late automatic failure after a Retry made the report READY is still refused (LIFECYCLE-02)", async () => {
  const r = await seed("processing");
  assert.deepEqual(await automaticPass(r, null, { rejected: true }), { saved: true, http: ["/api/reports:200"] });
  assert.deepEqual((await writesFor(r.id)).aiChanges, ["failed/error"]);
  assert.equal((await effectiveState(r)).derived, "failed");

  // The race LIFECYCLE-02 exists for: another tab's Retry completes first, this tab's automatic pass fails afterwards.
  const race = await seed("processing");
  const retried = await asAccount(race.account, async () => {
    const full = await fetchRemoteReport(race.id);
    const { enriched, summary } = kit.readyEnrichment(full, fx.syntheticAiAnalysis(TEXT, { seed: 4242 }), 9);
    return persistAiRetryResult(enriched, summary);
  });
  assert.equal(retried.ok, true);
  const readyAi = await aiHalf(race.id);
  assert.deepEqual(await automaticPass(race, "error"), { saved: true, http: ["/api/reports:200"] });
  assert.deepEqual(await aiHalf(race.id), readyAi, "the late automatic failure never displaces the ready result");
  assert.equal((await effectiveState(race)).derived, "ready");
});

// ---------------------------------------------------------------------------------------------------------------------
// 6. FAILED + COMPLETE — recovery
// ---------------------------------------------------------------------------------------------------------------------

test("6. FAILED + COMPLETE: a failed report's complete whole-report resave is persisted and reaches READY", async () => {
  const r = await seed("failed");
  assert.equal((await effectiveState(r)).derived, "failed");
  const similarityBefore = await similarityHalf(r.id);
  assert.deepEqual(await completeSave(r), { ok: true, http: ["/api/reports:200"] });
  assert.deepEqual((await writesFor(r.id)).aiChanges, ["ready/complete"]);
  const state = await effectiveState(r);
  assert.equal(state.derived, "ready");
  assert.equal(state.detailAiAnalysis, "complete");
  assert.equal(await similarityHalf(r.id), similarityBefore);
});

// ---------------------------------------------------------------------------------------------------------------------
// 7. INITIAL SAVE — new-report creation
// ---------------------------------------------------------------------------------------------------------------------

test("7. INITIAL SAVE: a new report is created exactly as before — the room page's first save is 'processing' with no score; a first save without aiStatus stays NULL/NULL (derived processing)", async () => {
  for (const [shape, expected] of [["processing", { ai_status: "processing" }], ["legacyFirst", { ai_status: null }]]) {
    const account = await env.signUpAccount();
    const id = String(nextId++);
    const room = nextRoom++ % 10;
    await asAccount(account, () => (shape === "processing" ? kit.firstSave(account, id, TEXT, room) : legacyFirstSave(account, id, room)));
    const row = await rawRow(id);
    assert.equal(row.ai_status, expected.ai_status, `${shape}: ai_status`);
    assert.equal(row.ai_score, null, `${shape}: no score yet`);
    assert.equal(row.room_number, room, `${shape}: the room it named`);
    assert.equal(row.user_id, account.userId);
    assert.equal(JSON.parse(String(row.payload_json)).aiAnalysis, undefined, `${shape}: no AI result yet`);
    assert.equal(deriveRoomStatus(row.ai_score, row.ai_status), "processing");
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// 8. TERMINAL SIZE / UNAVAILABLE — the automatic pass's oversized fallback is unchanged
// ---------------------------------------------------------------------------------------------------------------------

test("8. TERMINAL SIZE: an automatic result too large for the whole-report save falls back to the AI-only route — a processing report becomes terminally 'unavailable'; a ready one (legacy or explicit) is never displaced", async (t) => {
  const processing = await seed("processing");
  const outcome = await automaticPass(processing, "oversized");
  t.diagnostic(`CAPTURE oversized-processing ${JSON.stringify({ outcome, writes: await writesFor(processing.id) })}`);
  assert.equal(outcome.saved, true);
  assert.deepEqual(outcome.http, ["/api/reports:413", `/api/reports/${processing.id}/ai-retry:200`], "whole-report save 413, then the AI-only route");
  assert.deepEqual((await writesFor(processing.id)).aiChanges, ["ready/complete", `failed/error/${AI_UNAVAILABLE_REASON_REPORT_SIZE}`], "one transaction: tentative candidate, then the marker");
  assert.equal((await effectiveState(processing)).derived, "failed");

  for (const shape of ["legacyReady", "explicitReady", "explicitReadyNullScore"]) {
    const r = await seed(shape);
    const before = await aiHalf(r.id);
    const result = await automaticPass(r, "oversized");
    const writes = await writesFor(r.id);
    t.diagnostic(`CAPTURE oversized-${shape} ${JSON.stringify({ result, modelRuns: model.runs, writes })}`);
    assert.deepEqual(result.http, ["/api/reports:413", `/api/reports/${r.id}/ai-retry:200`], `${shape}: same fallback path`);
    assert.deepEqual(writes.rowWrites, 0, `${shape}: nothing written`);
    assert.deepEqual(await aiHalf(r.id), before, `${shape}: the ready result is untouched`);
    assert.equal(model.runs, 1, `${shape}: exactly one model run`);
    // deriveRoomStatus(NULL, 'ready') is "ready" (test 9): an explicit 'ready' is a complete analysis, with or without a score.
    assert.equal((await effectiveState(r)).derived, "ready", `${shape}: derived status unchanged — ready`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// 9. EXPLICIT READY WITHOUT A CALIBRATED SCORE — ai_status 'ready', ai_score NULL: a complete analysis whose median could not
//    be calibrated (e.g. a stale worker's scoringVersion; lib/ai-display-state.ts rule 4). deriveRoomStatus calls it
//    "ready" (explicit 'ready' is authoritative), it holds a genuine complete result and LIFECYCLE-02 has always kept it against
//    a late failure. Both write paths must keep doing so: the guard is "explicitly ready OR derived ready". The AI-retry
//    route's G2 size policy uses the same guard: an oversized complete result is answered 200 with nothing written — never the
//    REPORT_SIZE marker over the stored result (on 3aa0e38 it wrote the tentative candidate, then the marker: terminal failed).
// ---------------------------------------------------------------------------------------------------------------------

async function seedReadyWithoutScore() {
  const account = await env.signUpAccount();
  const id = String(nextId++);
  const room = nextRoom++ % 10;
  const report = await asAccount(account, () => SEEDS.explicitReadyNullScore(account, id, room));
  REPORTS.set(id, { report, room });
  await env.client.execute("DELETE FROM test_row_write_log");
  const ai = await aiHalf(id);
  assert.deepEqual({ ai_status: ai.ai_status, ai_score: ai.ai_score, aiAnalysisStatus: ai.aiAnalysisStatus }, { ai_status: "ready", ai_score: null, aiAnalysisStatus: "complete" }, "fixture sanity: explicit ready, no calibrated score");
  return { account, id, room, report };
}

test("9. EXPLICIT READY WITHOUT A CALIBRATED SCORE keeps its complete result against a late failure on BOTH write paths — the whole-report save and the AI-retry route — and against an oversized result sent to the AI-retry route", async (t) => {
  assert.equal(deriveRoomStatus(null, "ready"), "ready", "explicit ready is authoritative: a complete analysis without a calibrated score is ready");
  const viaSave = await seedReadyWithoutScore();
  const beforeSave = await aiHalf(viaSave.id);
  assert.deepEqual(await FAILED_SAVES["automatic-pass failure (client helper)"](viaSave), { ok: true, http: ["/api/reports:200"] });
  const afterSave = await aiHalf(viaSave.id);
  const saveChanges = (await writesFor(viaSave.id)).aiChanges;

  const viaRetry = await seedReadyWithoutScore();
  const beforeRetry = await aiHalf(viaRetry.id);
  const retryResponse = await kit.callRetryRoute(viaRetry.id, {
    body: { aiStatus: "failed", aiScore: null, aiTone: "unavailable", payload: { aiScore: null, aiAnalysis: { status: "error", score: null, passages: [] } } },
    cookie: viaRetry.account.cookie,
  });
  const afterRetry = await aiHalf(viaRetry.id);
  const retryChanges = (await writesFor(viaRetry.id)).aiChanges;

  // A structurally valid COMPLETE result that fits the request ceiling but not beside the report, straight to the AI-retry route.
  const viaOversized = await seedReadyWithoutScore();
  const beforeOversized = await aiHalf(viaOversized.id);
  const oversizedResponse = await kit.callRetryRoute(viaOversized.id, { body: kit.retryBodyFor(oversizedAnalysis()), cookie: viaOversized.account.cookie });
  const afterOversized = await aiHalf(viaOversized.id);
  const oversizedWrites = await writesFor(viaOversized.id);
  const oversizedStoredReason = JSON.parse(String((await rawRow(viaOversized.id)).payload_json)).aiAnalysis?.unavailableReason ?? null;

  // Control: the same narrow request without aiScore is malformed — refused before the row is read.
  const viaMissingScore = await seedReadyWithoutScore();
  const beforeMissingScore = await aiHalf(viaMissingScore.id);
  const { aiScore: _omitted, ...withoutAiScore } = kit.retryBodyFor(oversizedAnalysis());
  const missingScoreResponse = await kit.callRetryRoute(viaMissingScore.id, { body: withoutAiScore, cookie: viaMissingScore.account.cookie });
  const afterMissingScore = await aiHalf(viaMissingScore.id);
  const missingScoreWrites = await writesFor(viaMissingScore.id);

  t.diagnostic(`CAPTURE ready-null-score ${JSON.stringify({
    save: { before: beforeSave, after: afterSave, aiChanges: saveChanges },
    retry: { response: { status: retryResponse.status, json: retryResponse.json }, before: beforeRetry, after: afterRetry, aiChanges: retryChanges },
    oversized: { response: { status: oversizedResponse.status, json: oversizedResponse.json }, before: beforeOversized, after: afterOversized, writes: oversizedWrites, storedUnavailableReason: oversizedStoredReason },
    missingAiScore: { response: { status: missingScoreResponse.status, json: missingScoreResponse.json }, before: beforeMissingScore, after: afterMissingScore, writes: missingScoreWrites },
  })}`);

  assert.deepEqual(afterSave, beforeSave, "whole-report save: the complete result is kept");
  assert.deepEqual(saveChanges, []);
  assert.deepEqual({ status: retryResponse.status, json: retryResponse.json }, { status: 200, json: { ok: true } });
  assert.deepEqual(afterRetry, beforeRetry, "AI-retry route: the complete result is kept");
  assert.deepEqual(retryChanges, []);

  assert.deepEqual({ status: oversizedResponse.status, json: oversizedResponse.json }, { status: 200, json: { ok: true } }, "oversized AI-retry: the protected no-op answer, never SIZE_UNAVAILABLE");
  assert.deepEqual(oversizedWrites, { rowWrites: 0, aiChanges: [] }, "oversized AI-retry: nothing written — no tentative candidate, no REPORT_SIZE marker, no 'failed'");
  assert.deepEqual(afterOversized, beforeOversized, "oversized AI-retry: the complete result is kept");
  assert.equal(afterOversized.ai_status, "ready");
  assert.equal(afterOversized.ai_score, null);
  assert.equal(oversizedStoredReason, null, "oversized AI-retry: no REPORT_SIZE marker stored");

  assert.deepEqual({ status: missingScoreResponse.status, json: missingScoreResponse.json }, { status: 400, json: { error: "Invalid AI result" } }, "missing aiScore: still refused");
  assert.deepEqual(missingScoreWrites, { rowWrites: 0, aiChanges: [] }, "missing aiScore: nothing written");
  assert.deepEqual(afterMissingScore, beforeMissingScore, "missing aiScore: the stored state is unchanged");
});
