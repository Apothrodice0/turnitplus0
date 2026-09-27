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
import { persistAiCompletion } from "../lib/report-ai-completion.ts";
import { buildReportSummary } from "../lib/report-types.ts";
import { findReportRowForUser } from "../lib/reports-repo.ts";
import { deriveRoomStatus, derivedAiReadySql } from "../lib/report-rooms.ts";
import { resolveAiDisplayState } from "../lib/ai-display-state.ts";
import { isCompactAiAnalysis } from "../lib/ai-passage-table.ts";

/**
 * READY -> PROCESSING REPLAY — a stale POST /api/reports whole-report save carrying aiStatus 'processing' erased a READY AI result.
 *
 * THE REQUEST. The room page's first save (runCheck) is the only request that sends aiStatus 'processing': ai_score NULL and a
 * payload with no aiAnalysis yet, under a fresh id. Re-sent for an id that already exists (a duplicated or replayed request, a
 * stale tab or bundle, any direct caller holding the owner's session) it is no longer a first save: the route treats it as a
 * resave (no room check) and upserts it through SAVE_REPORT_SQL.
 *
 * THE DEFECT (reproduced on 00d7e07). SAVE_REPORT_SQL's LIFECYCLE-02 guard kept a protected-ready stored AI half (ai_status
 * 'ready', or ready by lib/report-rooms.ts deriveRoomStatus) only against an incoming 'failed'. An incoming 'processing' took the
 * ELSE branches: ai_status/ai_score/ai_tone <- 'processing'/NULL/NULL, and payload_json <- the incoming payload (no aiAnalysis)
 * whenever the stored similarity generation was not newer — the complete AI result gone, every read back to "processing" — for
 * an explicit ready row, a legacy-derived-ready row and an explicit ready row without a calibrated score alike.
 *
 * THE FIX. The guard's incoming side is "the incoming AI state is not a result": 'failed' or 'processing' (and, since the
 * statusless-resave fix, NULL — tests/report-save-ready-null-replay.test.mjs; test 0 below covers it). Its stored side is
 * unchanged (explicit 'ready' OR derived ready). Nothing else changes — asserted below: complete -> complete replacement, the
 * automatic completion, a new report's first save, a failed row's recovery and a failed row receiving 'processing' all behave as
 * before, with the similarity half byte-identical.
 *
 * HOW. The REAL route handlers and client helpers against a throwaway migrated SQLite DB (fetch routed to the handlers), every
 * row produced by the real save routes. The replayed request is the report's own recorded first-save request, byte for byte, or
 * the room page's first-save request re-sent through the real client helper. A trigger logs every committed UPDATE of a report
 * row with whether its AI half changed. The automatic completion runs through the room page's REAL exported chain —
 * completeAiAnalysisWithRecovery(runAiAnalysis(...)) with a scripted model Worker — saving with saveEnrichedAiResult's exact calls.
 */

const TEXT = synthProse(20_000, { seed: 113, messiness: 0.01 });

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
      else emit({ id, ok: false, error: `Injected model failure (${behaviour})` });
    });
  }
};

// Set up EVERYTHING before the first test() is registered (node:test starts a test the moment it is registered).
const env = await fx.createFixtureEnvironment("report_save_ready_processing_replay");
process.env.TURSO_DATABASE_URL = `file:${env.dbFile}`;
const kit = createKit(env);
const restoreC2 = fx.pinCompactWrites(undefined);
const restoreAi = fx.pinAiCompactWrites(undefined);
const roomShell = await import("../app/reports/rooms/[room]/room-page-shell.tsx");
const { accountLocalReportOwner, storeReportBestEffort } = await import("../lib/report-store.ts");
const { createMemoryIndexedDb } = await import("./helpers/memory-indexeddb.mjs");
globalThis.indexedDB = createMemoryIndexedDb().factory;

await env.client.execute(`CREATE TABLE test_row_write_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, report_id TEXT, ai_changed INTEGER, ai_status TEXT, ai_analysis_status TEXT)`);
await env.client.execute(`CREATE TRIGGER test_row_write_log_trg AFTER UPDATE ON saved_reports BEGIN
  INSERT INTO test_row_write_log (report_id, ai_changed, ai_status, ai_analysis_status)
  VALUES (NEW.id,
    (OLD.ai_status IS NOT NEW.ai_status) OR (OLD.ai_score IS NOT NEW.ai_score) OR (OLD.ai_tone IS NOT NEW.ai_tone)
      OR (json_extract(OLD.payload_json, '$.aiAnalysis') IS NOT json_extract(NEW.payload_json, '$.aiAnalysis'))
      OR (json_extract(OLD.payload_json, '$.aiScore') IS NOT json_extract(NEW.payload_json, '$.aiScore')),
    NEW.ai_status, json_extract(NEW.payload_json, '$.aiAnalysis.status'));
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

const posts = (route) => route.requests.filter((r) => r.method === "POST").map((r) => `${r.path}:${r.status}`);

/** Runs `fn` inside asAccount, recording the exact body of every POST /api/reports it sends. */
async function recordingReportPosts(fn) {
  const routed = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = (input, init = {}) => {
    const path = new URL(typeof input === "string" ? input : input.url, "http://localhost").pathname;
    if (path === "/api/reports" && String(init.method ?? "GET").toUpperCase() === "POST") bodies.push(String(init.body));
    return routed(input, init);
  };
  try {
    return { result: await fn(), bodies };
  } finally {
    globalThis.fetch = routed;
  }
}

let nextId = 1_770_000_000_000;
let nextRoom = 0;
const REPORTS = new Map(); // id -> { report, room } — the client-built report the room page holds
const FIRST_SAVE_BODIES = new Map(); // id -> the exact bytes of the report's first-save request

/** runCheck's first-save summary for `report`. */
const processingSummary = (report) => ({ ...buildReportSummary(report), aiStatus: "processing", similarityStatus: "pending" });

/** The room page's first save (aiStatus 'processing'), its request bytes recorded for a later verbatim replay. */
async function roomFirstSave(account, id, room) {
  const { result: report, bodies } = await recordingReportPosts(() => kit.firstSave(account, id, TEXT, room));
  assert.equal(bodies.length, 1, "fixture sanity: one first-save request");
  assert.equal(JSON.parse(bodies[0]).aiStatus, "processing", "fixture sanity: the room page's first save is 'processing'");
  FIRST_SAVE_BODIES.set(id, bodies[0]);
  return report;
}

/** The room page's first save as a client before drizzle/0028 sent it: no aiStatus at all. */
async function legacyFirstSave(account, id, room) {
  const report = fx.buildFirstSaveBody({ deviceKey: account.deviceKey, id, text: TEXT, room }).payload;
  const summary = buildReportSummary(report);
  assert.equal("aiStatus" in summary, false, "fixture sanity: the pre-0028 summary carries no aiStatus");
  const { result, bodies } = await recordingReportPosts(() => saveReportRemote(report, summary, undefined, room));
  assert.equal(result.ok, true, "fixture sanity: legacy first save");
  FIRST_SAVE_BODIES.set(id, bodies[0]);
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
  /** Current complete: the room page's first save ('processing') and its automatic resave ('ready', numeric score). */
  async explicitReady(account, id, room) {
    const report = await roomFirstSave(account, id, room);
    assert.equal((await automaticResave(account, report, room, completeResult())).ok, true, "fixture sanity: explicit ready resave");
    return report;
  },
  /** The same, with the ai-compact-v1 writer on: the stored aiAnalysis is the compact table. */
  async explicitReadyCompact(account, id, room) {
    const report = await roomFirstSave(account, id, room);
    const saved = await fx.withAiCompactWrites("true", () => automaticResave(account, report, room, completeResult()));
    assert.equal(saved.ok, true, "fixture sanity: compact explicit ready resave");
    return report;
  },
  /** Legacy complete: the legacy first save, then the AI resave app/page.tsx sends — buildReportSummary(enriched), no aiStatus. */
  async legacyReady(account, id, room) {
    const report = await legacyFirstSave(account, id, room);
    const enriched = { ...report, ...completeResult() };
    const summary = buildReportSummary(enriched);
    assert.equal("aiStatus" in summary, false, "fixture sanity: app/page.tsx's AI-resave summary carries no aiStatus");
    assert.equal((await persistAiCompletion(enriched, summary)).ok, true, "fixture sanity: legacy AI resave");
    return report;
  },
  /** Explicit ready without a calibrated score: a complete analysis from a stale worker scoringVersion (lib/ai-display-state.ts rule 4). */
  async explicitReadyNullScore(account, id, room) {
    const report = await roomFirstSave(account, id, room);
    const aiAnalysis = { ...fx.syntheticAiAnalysis(TEXT, { seed: 11 }), scoringVersion: 9 };
    assert.equal((await automaticResave(account, report, room, { aiScore: aiAnalysis.score, aiAnalysis })).ok, true);
    return report;
  },
  async failed(account, id, room) {
    const report = await roomFirstSave(account, id, room);
    assert.equal((await automaticResave(account, report, room, roomShell.aiAnalysisErrorResult(new Error("worker crashed"), "analyzing"))).ok, true);
    return report;
  },
  processing: (account, id, room) => roomFirstSave(account, id, room),
};

/** The stored AI representation each seed must produce (fixture sanity). */
const SEED_SHAPES = {
  explicitReady: { ai_status: "ready", scored: true, aiAnalysisStatus: "complete" },
  explicitReadyCompact: { ai_status: "ready", scored: true, aiAnalysisStatus: "complete" },
  legacyReady: { ai_status: null, scored: true, aiAnalysisStatus: "complete" },
  explicitReadyNullScore: { ai_status: "ready", scored: false, aiAnalysisStatus: "complete" },
  failed: { ai_status: "failed", scored: false, aiAnalysisStatus: "error" },
  processing: { ai_status: "processing", scored: false, aiAnalysisStatus: null },
};

/** One fresh account + report in the given shape; logs cleared, so only what happens next is counted. */
async function seed(shape) {
  const account = await env.signUpAccount();
  const id = String(nextId++);
  const room = nextRoom++ % 10;
  const report = await asAccount(account, () => SEEDS[shape](account, id, room));
  REPORTS.set(id, { report, room });
  const ai = await aiHalf(id);
  const expected = SEED_SHAPES[shape];
  assert.deepEqual(
    { ai_status: ai.ai_status, scored: typeof ai.ai_score === "number", aiAnalysisStatus: ai.aiAnalysisStatus },
    expected,
    `fixture sanity: ${shape} stored AI representation`,
  );
  await env.client.execute("DELETE FROM test_row_write_log");
  model.runs = 0;
  model.script.length = 0;
  return { account, id, room, report, shape };
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
    aiAnalysisCompact: isCompactAiAnalysis(payload.aiAnalysis),
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
  const rows = (await env.client.execute({ sql: "SELECT ai_changed, ai_status, ai_analysis_status FROM test_row_write_log WHERE report_id = ? ORDER BY seq", args: [id] })).rows;
  return {
    rowWrites: rows.length,
    aiChanges: rows.filter((r) => Number(r.ai_changed) === 1).map((r) => `${r.ai_status}/${r.ai_analysis_status}`),
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
      protectedReady: row.ai_status === "ready" || deriveRoomStatus(row.ai_score, row.ai_status) === "ready",
      display: display.state,
      displayScore: display.score,
      room: roomRead.ok ? roomRead.contents.status : "unreadable",
      listAiStatus: listed?.aiStatus ?? null,
      detailAiAnalysis: detail?.aiAnalysis?.status ?? null,
    };
  });
}

/** The AI fields a whole-report save request declares. */
function incomingAiOf(body) {
  const parsed = JSON.parse(body);
  return { aiStatus: parsed.aiStatus ?? null, aiScore: parsed.aiScore ?? null, aiTone: parsed.aiTone ?? null, payloadAiAnalysis: parsed.payload?.aiAnalysis?.status ?? null };
}

/** A stale 'processing' whole-report save for an existing report. */
const PROCESSING_REPLAYS = {
  // The report's own recorded first-save request, byte for byte (a duplicated/replayed request, or any client re-sending it).
  "verbatim first-save replay": ({ account, id }) => asAccount(account, async (route) => {
    const body = FIRST_SAVE_BODIES.get(id);
    const response = await fetch("/api/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    return { ok: response.ok, http: posts(route), incoming: incomingAiOf(body) };
  }),
  // runCheck's first-save request for this report, re-sent through the real client helper (a stale tab/bundle, or a direct caller).
  "room-page first save re-sent": ({ account, id, room }) => asAccount(account, async (route) => {
    const { report } = REPORTS.get(id);
    const { result, bodies } = await recordingReportPosts(() => saveReportRemote(report, processingSummary(report), undefined, room));
    return { ok: result.ok, http: posts(route), incoming: incomingAiOf(bodies[0]) };
  }),
};

/** The replays that apply to a shape: the verbatim replay needs a recorded 'processing' first save (a legacy row never had one). */
const replaysFor = (shape) => Object.entries(PROCESSING_REPLAYS).filter(([label]) => shape !== "legacyReady" || label !== "verbatim first-save replay");

/** Applies `save` to a fresh `shape` report and captures everything the task asks for. */
async function capture(shape, save) {
  const r = await seed(shape);
  const before = { ai: await aiHalf(r.id), state: await effectiveState(r), similarity: await similarityHalf(r.id) };
  const response = await save(r);
  const after = { ai: await aiHalf(r.id), state: await effectiveState(r), similarity: await similarityHalf(r.id) };
  const writes = await writesFor(r.id);
  return {
    r,
    before,
    response,
    writes,
    after,
    aiAnalysisErased: before.ai.aiAnalysisSha !== null && after.ai.aiAnalysisSha === null,
    aiAnalysisReplaced: before.ai.aiAnalysisSha !== after.ai.aiAnalysisSha,
    modelRuns: model.runs,
  };
}

const summarize = (c) => ({
  rawBefore: c.before.ai,
  effectiveBefore: c.before.state,
  incoming: c.response.incoming,
  http: c.response.http,
  writes: c.writes,
  rawAfter: c.after.ai,
  effectiveAfter: c.after.state,
  aiAnalysisErased: c.aiAnalysisErased,
  aiAnalysisReplaced: c.aiAnalysisReplaced,
  similarityUnchanged: c.after.similarity === c.before.similarity,
});

/** The protected-ready + stale 'processing' outcome every ready shape must have. */
function assertReadyPreserved(c, label) {
  assert.deepEqual(c.response.incoming.aiStatus, "processing", `${label}: the replay declares 'processing'`);
  assert.equal(c.response.ok, true, `${label}: the save itself is accepted (a no-op for the AI half, not a rejected request)`);
  assert.deepEqual(c.response.http, ["/api/reports:200"], label);
  assert.deepEqual(c.writes.aiChanges, [], `${label}: no committed write changed the AI half`);
  assert.deepEqual(c.after.ai, c.before.ai, `${label}: the AI result is exactly as it was`);
  assert.equal(c.aiAnalysisErased, false, `${label}: aiAnalysis not erased`);
  assert.equal(c.aiAnalysisReplaced, false, `${label}: aiAnalysis not replaced`);
  assert.equal(c.after.state.protectedReady, true, `${label}: still protected-ready`);
  assert.deepEqual(c.after.state, c.before.state, `${label}: every read is unchanged`);
  assert.equal(c.after.similarity, c.before.similarity, `${label}: similarity half byte-identical`);
  assert.equal(c.modelRuns, 0, `${label}: no model run`);
}

// ---------------------------------------------------------------------------------------------------------------------
// 0. The guard itself, for every stored x incoming combination, and the SQL/JS protection predicates agree
// ---------------------------------------------------------------------------------------------------------------------

test("0. MATRIX: SAVE_REPORT_SQL keeps the stored AI half exactly when it is protected-ready (ai_status 'ready' OR deriveRoomStatus 'ready') and the incoming AI state is 'failed' or 'processing'; an incoming 'ready' always replaces it; the SQL protection predicate equals the JS one for every stored state", async (t) => {
  const client = createClient({ url: `file:${env.dbFile}` });
  const { SAVE_REPORT_SQL } = fx.reportsRoute;
  // [ai_status, ai_score, ai_tone] each incoming state carries (the room page's first save sends buildReportSummary's no-AI
  // tone; a statusless save is app/page.tsx's / the pre-0028 room page's — without an AI result, or with a legacy complete one).
  const INCOMING = {
    processing: ["processing", null, "unavailable"],
    failed: ["failed", null, "unavailable"],
    ready: ["ready", 77, "high"],
    null: [null, null, "unavailable"],
    "null+score": [null, 77, "high"],
  };
  const args = (id, aiScore, aiTone, aiStatus, note) => [id, "matrix-device", `sub-${id}`, "matrix", new Date().toISOString(), 10, 0, "Low", aiScore, aiTone, aiStatus, JSON.stringify({ note }), null, null];
  const cells = [];
  try {
    let n = 0;
    for (const storedStatus of [null, "processing", "ready", "failed"]) {
      for (const storedScore of [null, 0, 42]) {
        const jsProtected = storedStatus === "ready" || deriveRoomStatus(storedScore, storedStatus) === "ready";
        for (const [incoming, [inStatus, inScore, inTone]] of Object.entries(INCOMING)) {
          const id = `matrix-${n++}`;
          await client.execute({ sql: SAVE_REPORT_SQL, args: args(id, storedScore, storedScore === null ? null : "low", storedStatus, "stored") }); // the stored row, written by the real upsert
          const sqlProtected = num((await client.execute({
            sql: `SELECT CASE WHEN (saved_reports.ai_status = 'ready' OR ${derivedAiReadySql("saved_reports")}) THEN 1 ELSE 0 END AS p FROM saved_reports WHERE id = ?`,
            args: [id],
          })).rows[0].p) === 1;
          await client.execute({ sql: SAVE_REPORT_SQL, args: args(id, inScore, inTone, inStatus, "incoming") });
          const row = (await client.execute({ sql: "SELECT ai_status, ai_score, ai_tone, payload_json FROM saved_reports WHERE id = ?", args: [id] })).rows[0];
          const kept = row.ai_status === storedStatus && num(row.ai_score) === storedScore && JSON.parse(row.payload_json).note === "stored";
          const replaced = row.ai_status === inStatus && num(row.ai_score) === inScore && row.ai_tone === inTone && JSON.parse(row.payload_json).note === "incoming";
          cells.push({ storedStatus, storedScore, incoming, inStatus, sqlProtected, jsProtected, kept, replaced });
        }
      }
    }
  } finally {
    t.diagnostic(`PREDICATES ${JSON.stringify(cells.filter((c) => c.incoming === "processing").map((c) => `${c.storedStatus}/${c.storedScore}: sql=${c.sqlProtected} js=${c.jsProtected}`))}`);
    t.diagnostic(`MATRIX ${JSON.stringify(cells.map((c) => `${c.storedStatus}/${c.storedScore} <- ${c.incoming}: ${c.kept ? "PRESERVE_STORED_AI" : c.replaced ? "ACCEPT_INCOMING_AI" : "MIXED"}`))}`);
    client.close();
  }
  assert.equal(cells.length, 60);
  for (const c of cells) {
    const cell = `stored ${c.storedStatus}/${c.storedScore} <- ${c.incoming}`;
    assert.equal(c.sqlProtected, c.jsProtected, `${cell}: SQL and JS protected-ready predicates agree`);
    assert.ok(c.kept || c.replaced, `${cell}: all-or-nothing, never a partial AI half`);
    assert.equal(c.kept, c.jsProtected && (c.inStatus === null || c.inStatus === "failed" || c.inStatus === "processing"), `${cell}: kept iff the stored AI half is protected-ready and the incoming one is not a declared result`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// 1-3. PROTECTED-READY + STALE PROCESSING SAVE — explicit ready (numeric score, and compact-stored), legacy-derived ready,
//      explicit ready without a calibrated score
// ---------------------------------------------------------------------------------------------------------------------

for (const [num_, shape, title] of [
  ["1", "explicitReady", "EXPLICIT READY (numeric score)"],
  ["1c", "explicitReadyCompact", "EXPLICIT READY, compact-stored AI result"],
  ["2", "legacyReady", "LEGACY-DERIVED READY (ai_status NULL, numeric score)"],
  ["3", "explicitReadyNullScore", "EXPLICIT READY WITHOUT A CALIBRATED SCORE (ai_status 'ready', ai_score NULL)"],
]) {
  for (const [label, replay] of replaysFor(shape)) {
    test(`${num_}. ${title} + PROCESSING REPLAY (${label}): accepted, but the ready AI result is preserved exactly — still ready, similarity unchanged`, async (t) => {
      const c = await capture(shape, replay);
      t.diagnostic(`CAPTURE shape=${shape} via=${label} ${JSON.stringify(summarize(c))}`);
      assert.equal(c.before.state.protectedReady, true, "fixture sanity: protected-ready before");
      if (shape === "explicitReadyCompact") assert.equal(c.before.ai.aiAnalysisCompact, true, "fixture sanity: the stored AI result is the compact table");
      if (shape === "explicitReadyNullScore") assert.equal(c.before.state.derived, "processing", "fixture sanity: the derived rule alone would not protect this row");
      assertReadyPreserved(c, `${shape} <- ${label}`);
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// 4. READY + FAILED — the 00d7e07 protection, unchanged
// ---------------------------------------------------------------------------------------------------------------------

const failedSave = ({ account, id, room }) => asAccount(account, async (route) => {
  const saved = await automaticResave(account, REPORTS.get(id).report, room, roomShell.aiAnalysisErrorResult(new Error("worker crashed"), "analyzing"));
  return { ok: saved.ok, http: posts(route), incoming: { aiStatus: "failed" } };
});

test("4. READY + FAILED: a late failed whole-report save still never displaces a protected-ready AI result (explicit, legacy, uncalibrated)", async (t) => {
  for (const shape of ["explicitReady", "legacyReady", "explicitReadyNullScore"]) {
    const c = await capture(shape, failedSave);
    t.diagnostic(`CAPTURE ready-failed shape=${shape} ${JSON.stringify(summarize(c))}`);
    assert.deepEqual(c.response.http, ["/api/reports:200"], shape);
    assert.deepEqual(c.writes.aiChanges, [], `${shape}: no AI change`);
    assert.deepEqual(c.after.ai, c.before.ai, `${shape}: the AI result is exactly as it was`);
    assert.deepEqual(c.after.state, c.before.state, `${shape}: every read is unchanged`);
    assert.equal(c.after.similarity, c.before.similarity, `${shape}: similarity half byte-identical`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// 5. READY + READY — complete -> complete replacement, unchanged
// ---------------------------------------------------------------------------------------------------------------------

const completeSave = ({ account, id, room }) => asAccount(account, async (route) => {
  const saved = await automaticResave(account, REPORTS.get(id).report, room, completeResult(4242));
  return { ok: saved.ok, http: posts(route), incoming: { aiStatus: "ready" } };
});

test("5. READY + READY: a complete whole-report resave still replaces a ready AI result (complete -> complete, unchanged) — explicit, legacy, uncalibrated", async (t) => {
  const newSha = sha(JSON.stringify(completeResult(4242).aiAnalysis)).slice(0, 16);
  for (const shape of ["explicitReady", "legacyReady", "explicitReadyNullScore"]) {
    const c = await capture(shape, completeSave);
    t.diagnostic(`CAPTURE ready-ready shape=${shape} ${JSON.stringify(summarize(c))}`);
    assert.deepEqual(c.response.http, ["/api/reports:200"], shape);
    assert.deepEqual(c.writes.aiChanges, ["ready/complete"], `${shape}: one AI write, to the new complete result`);
    assert.equal(c.after.ai.aiAnalysisSha, newSha, `${shape}: the new complete result is what is stored`);
    assert.equal(c.after.ai.ai_status, "ready");
    assert.equal(typeof c.after.ai.ai_score, "number");
    assert.equal(c.after.state.derived, "ready");
    assert.equal(c.after.similarity, c.before.similarity, `${shape}: similarity half byte-identical`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// 6. PROCESSING + READY — the automatic completion, through the room page's real exported chain
// ---------------------------------------------------------------------------------------------------------------------

/** runCheck's automatic pass: completeAiAnalysisWithRecovery(runAiAnalysis(text, lang), aiResult => saveEnrichedAiResult(...)). */
async function automaticPass({ account, id, room }, behaviour) {
  const { report } = REPORTS.get(id);
  return asAccount(account, async (route) => {
    model.script.push(behaviour);
    const saved = await roomShell.completeAiAnalysisWithRecovery(roomShell.runAiAnalysis(TEXT, "English"), async (aiResult) => (await automaticResave(account, report, room, aiResult)).ok);
    return { saved, http: posts(route) };
  });
}

test("6. PROCESSING + READY: a fresh processing report's automatic AI run still persists READY in one AI write — and a stale replay of its first save afterwards no longer undoes it", async (t) => {
  const r = await seed("processing");
  assert.equal((await effectiveState(r)).derived, "processing");
  const similarityBefore = await similarityHalf(r.id);
  const outcome = await automaticPass(r, "complete");
  const completed = { writes: await writesFor(r.id), ai: await aiHalf(r.id), state: await effectiveState(r) };
  t.diagnostic(`CAPTURE automatic-completion ${JSON.stringify({ outcome, modelRuns: model.runs, ...completed })}`);
  assert.deepEqual(outcome, { saved: true, http: ["/api/reports:200"] }, "one whole-report save, accepted");
  assert.equal(model.runs, 1, "exactly one model run");
  assert.deepEqual(completed.writes.aiChanges, ["ready/complete"]);
  assert.equal(completed.ai.aiAnalysisSha, sha(JSON.stringify(fx.syntheticAiAnalysis(TEXT, { seed: 4242 }))).slice(0, 16), "the model's own result is what is stored");
  assert.equal(completed.ai.ai_status, "ready");
  assert.equal(typeof completed.ai.ai_score, "number");
  assert.equal(completed.state.derived, "ready");
  assert.equal(completed.state.room, "ready");
  assert.equal(await similarityHalf(r.id), similarityBefore, "similarity half byte-identical");

  // The same report's own first-save request, replayed after the automatic completion landed.
  await env.client.execute("DELETE FROM test_row_write_log");
  model.runs = 0;
  const replay = await PROCESSING_REPLAYS["verbatim first-save replay"](r);
  assert.deepEqual(replay.http, ["/api/reports:200"]);
  assert.deepEqual((await writesFor(r.id)).aiChanges, [], "the replay changes nothing in the AI half");
  assert.deepEqual(await aiHalf(r.id), completed.ai, "the automatic result survives the replay");
  assert.deepEqual(await effectiveState(r), completed.state);
});

test("6b. PROCESSING + FAILED: the automatic pass still persists a genuine model failure (unchanged)", async () => {
  const r = await seed("processing");
  assert.deepEqual(await automaticPass(r, "error"), { saved: true, http: ["/api/reports:200"] });
  assert.deepEqual((await writesFor(r.id)).aiChanges, ["failed/error"]);
  assert.equal((await effectiveState(r)).derived, "failed");
});

// ---------------------------------------------------------------------------------------------------------------------
// 7. INITIAL PROCESSING SAVE — new-report creation, unchanged
// ---------------------------------------------------------------------------------------------------------------------

test("7. INITIAL PROCESSING SAVE: a new report is created exactly as before — 'processing', no score, no AI result, its room, its owner", async (t) => {
  const account = await env.signUpAccount();
  const id = String(nextId++);
  const room = nextRoom++ % 10;
  await env.client.execute("DELETE FROM test_row_write_log");
  const http = await asAccount(account, async (route) => {
    await roomFirstSave(account, id, room);
    return posts(route);
  });
  assert.deepEqual(http, ["/api/reports:200"]);
  const incoming = incomingAiOf(FIRST_SAVE_BODIES.get(id));
  const row = await rawRow(id);
  assert.equal(row.ai_status, "processing");
  assert.equal(row.ai_score, null);
  assert.equal(row.ai_tone, incoming.aiTone, "the tone the first save sent (buildReportSummary's no-AI tone)");
  assert.equal(row.room_number, room);
  assert.equal(row.user_id, account.userId);
  assert.equal(JSON.parse(String(row.payload_json)).aiAnalysis, undefined, "no AI result yet");
  assert.equal(deriveRoomStatus(row.ai_score, row.ai_status), "processing");
  const writes = await writesFor(id);
  t.diagnostic(`CAPTURE initial-save ${JSON.stringify({ incoming, http, writes, ai: await aiHalf(id) })}`);
  assert.deepEqual(writes.aiChanges, [], "nothing after the insert touches its AI half (the save's own follow-up writes are non-AI side effects)");
});

// ---------------------------------------------------------------------------------------------------------------------
// 8. FAILED + READY — recovery, unchanged
// ---------------------------------------------------------------------------------------------------------------------

test("8. FAILED + READY: a failed report's complete whole-report resave is persisted and reaches READY (unchanged)", async (t) => {
  const c = await capture("failed", completeSave);
  t.diagnostic(`CAPTURE failed-ready ${JSON.stringify(summarize(c))}`);
  assert.equal(c.before.state.derived, "failed");
  assert.deepEqual(c.response.http, ["/api/reports:200"]);
  assert.deepEqual(c.writes.aiChanges, ["ready/complete"]);
  assert.equal(c.after.state.derived, "ready");
  assert.equal(c.after.state.detailAiAnalysis, "complete");
  assert.equal(c.after.similarity, c.before.similarity);
});

// ---------------------------------------------------------------------------------------------------------------------
// 9. FAILED + PROCESSING — characterized, unchanged: a failed AI half is not protected-ready, so the incoming one is accepted
// ---------------------------------------------------------------------------------------------------------------------

test("9. FAILED + PROCESSING: a stale 'processing' save onto a FAILED report is accepted exactly as before (not protected-ready) — the report is processing again, Retry-able; similarity unchanged", async (t) => {
  for (const [label, replay] of replaysFor("failed")) {
    const c = await capture("failed", replay);
    t.diagnostic(`CAPTURE failed-processing via=${label} ${JSON.stringify(summarize(c))}`);
    assert.equal(c.before.state.derived, "failed");
    assert.deepEqual(c.response.http, ["/api/reports:200"], label);
    assert.deepEqual(c.writes.aiChanges, ["processing/null"], `${label}: the incoming 'processing' AI half is written`);
    assert.deepEqual(
      { ai_status: c.after.ai.ai_status, ai_score: c.after.ai.ai_score, ai_tone: c.after.ai.ai_tone, aiAnalysisStatus: c.after.ai.aiAnalysisStatus },
      { ai_status: "processing", ai_score: null, ai_tone: c.response.incoming.aiTone, aiAnalysisStatus: null },
      label,
    );
    assert.equal(c.after.state.derived, "processing", label);
    assert.equal(c.after.similarity, c.before.similarity, `${label}: similarity half byte-identical`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// 10. The other AI-writing route cannot carry 'processing' at all
// ---------------------------------------------------------------------------------------------------------------------

test("10. AI-RETRY ROUTE: the only other server path that writes the AI half refuses aiStatus 'processing' outright (400) and writes nothing — explicit, legacy, uncalibrated", async () => {
  for (const shape of ["explicitReady", "legacyReady", "explicitReadyNullScore"]) {
    const r = await seed(shape);
    const before = await aiHalf(r.id);
    const response = await kit.callRetryRoute(r.id, {
      body: { aiStatus: "processing", aiScore: null, aiTone: "unavailable", payload: { aiScore: null, aiAnalysis: { status: "error", score: null, passages: [] } } },
      cookie: r.account.cookie,
    });
    assert.deepEqual({ status: response.status, json: response.json }, { status: 400, json: { error: "Invalid AI result" } }, shape);
    assert.equal((await writesFor(r.id)).rowWrites, 0, `${shape}: nothing written`);
    assert.deepEqual(await aiHalf(r.id), before, `${shape}: the AI result is untouched`);
  }
});
