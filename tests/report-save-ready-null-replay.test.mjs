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
import { deriveRoomStatus } from "../lib/report-rooms.ts";
import { resolveAiDisplayState } from "../lib/ai-display-state.ts";
import { isCompactAiAnalysis } from "../lib/ai-passage-table.ts";

/**
 * READY <- STATUSLESS RESAVE — a POST /api/reports whole-report save with NO aiStatus (absent, or JSON null) erased a READY AI
 * result.
 *
 * THE REQUESTS. POST /api/reports still accepts aiStatus absent/null: it is the save shape of every client that never sent the
 * column — app/page.tsx's saveReport (buildReportSummary carries no aiStatus) and its AI resave (persistAiCompletion with
 * buildReportSummary(enriched)), and the room page before drizzle/0028. Such a request declares no AI lifecycle state at all;
 * its AI half is only aiScore + payload.aiAnalysis. Sent for an id that already exists (a duplicated/replayed request, a stale
 * tab or bundle, any direct caller holding the owner's session, a claim-by-resave of a legacy anonymous row) it is a resave and
 * goes through SAVE_REPORT_SQL's conflict branch.
 *
 * THE DEFECT (reproduced on 6aed363). SAVE_REPORT_SQL's LIFECYCLE-02 guard kept a protected-ready stored AI half only against an
 * incoming 'failed' or 'processing'. An incoming NULL made `excluded.ai_status IN ('failed', 'processing')` SQL NULL, so every
 * CASE took its ELSE branch: ai_status/ai_score/ai_tone <- the request's (NULL/NULL/'unavailable' for a save without an AI
 * result) and payload_json <- the incoming payload (no aiAnalysis) whenever the stored similarity generation was not newer —
 * the complete AI result gone, explicit, compact-stored, legacy-derived and uncalibrated ready rows alike.
 *
 * THE FIX. The guard's incoming side is "the request does not declare an AI result": NULL, 'failed' or 'processing'. Stored
 * side unchanged (explicit 'ready' OR derived ready). Only an explicit 'ready' replaces a protected-ready AI half. Nothing else
 * changes — asserted below: a new report's statusless first save, a legacy row's statusless AI completion onto its own non-ready
 * row, a non-ready legacy row's claim-by-resave, complete -> complete, the automatic completion and recovery all behave as
 * before, with the similarity half byte-identical wherever the AI half is kept.
 *
 * HOW. The REAL route handlers and client helpers against a throwaway migrated SQLite DB (fetch routed to the handlers); every
 * report row is produced by the real save routes except the legacy anonymous rows, which a POST can no longer create (they are
 * written with the real SAVE_REPORT_SQL, this repo's established pattern — tests/api-reports-account-scoping.test.mjs). A
 * trigger logs every committed UPDATE of a report row with whether its AI half changed.
 */

const TEXT = synthProse(20_000, { seed: 131, messiness: 0.01 });

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
const env = await fx.createFixtureEnvironment("report_save_ready_null_replay");
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

/** One signed-in browser for `account` whose device key is `deviceKey` (lib/device-key.ts) — the account's own by default. */
function asDevice(account, deviceKey, fn) {
  return kit.asBrowser(account, (route) => {
    window.localStorage.setItem("tp_device_key_v1", deviceKey);
    return fn(route);
  });
}
const asAccount = (account, fn) => asDevice(account, account.deviceKey, fn);

const posts = (route) => route.requests.filter((r) => r.method === "POST").map((r) => `${r.path}:${r.status}`);

/** Runs `fn`, recording the exact body of every POST /api/reports it sends. */
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

let nextId = 1_780_000_000_000;
let nextRoom = 0;
const REPORTS = new Map(); // id -> { report, room } — the client-built report the page holds
const FIRST_SAVE_BODIES = new Map(); // id -> the exact bytes of the report's first-save request

/** The room page's first save (aiStatus 'processing'), its request bytes recorded. */
async function roomFirstSave(account, id, room) {
  const { result: report, bodies } = await recordingReportPosts(() => kit.firstSave(account, id, TEXT, room));
  assert.equal(bodies.length, 1, "fixture sanity: one first-save request");
  assert.equal(JSON.parse(bodies[0]).aiStatus, "processing", "fixture sanity: the room page's first save is 'processing'");
  FIRST_SAVE_BODIES.set(id, bodies[0]);
  return report;
}

/** The room page's first save as a client before drizzle/0028 sent it: a room, no aiStatus at all. */
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

/** app/page.tsx generateReport's AI resave, exactly: persistAiCompletion(enriched, buildReportSummary(enriched)) — no aiStatus, no room. */
function statuslessAiResave(report, aiResult) {
  const enriched = { ...report, ...aiResult };
  const summary = buildReportSummary(enriched);
  assert.equal("aiStatus" in summary, false, "fixture sanity: app/page.tsx's AI-resave summary carries no aiStatus");
  return persistAiCompletion(enriched, summary);
}

const completeResult = (seed = 11) => {
  const aiAnalysis = fx.syntheticAiAnalysis(TEXT, { seed });
  return { aiScore: aiAnalysis.score, aiAnalysis };
};
const errorResult = () => roomShell.aiAnalysisErrorResult(new Error("worker crashed"), "analyzing");

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
  /** Legacy complete: the legacy first save, then the statusless AI resave (app/page.tsx's, and the pre-0028 room page's). */
  async legacyReady(account, id, room) {
    const report = await legacyFirstSave(account, id, room);
    assert.equal((await statuslessAiResave(report, completeResult())).ok, true, "fixture sanity: legacy AI resave");
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
    assert.equal((await automaticResave(account, report, room, errorResult())).ok, true);
    return report;
  },
  processing: (account, id, room) => roomFirstSave(account, id, room),
  /** Legacy, AI not finished: the legacy first save only (ai_status NULL, ai_score NULL). */
  legacyPending: (account, id, room) => legacyFirstSave(account, id, room),
};

/** The stored AI representation each seed must produce (fixture sanity). */
const SEED_SHAPES = {
  explicitReady: { ai_status: "ready", scored: true, aiAnalysisStatus: "complete" },
  explicitReadyCompact: { ai_status: "ready", scored: true, aiAnalysisStatus: "complete" },
  legacyReady: { ai_status: null, scored: true, aiAnalysisStatus: "complete" },
  explicitReadyNullScore: { ai_status: "ready", scored: false, aiAnalysisStatus: "complete" },
  failed: { ai_status: "failed", scored: false, aiAnalysisStatus: "error" },
  processing: { ai_status: "processing", scored: false, aiAnalysisStatus: null },
  legacyPending: { ai_status: null, scored: false, aiAnalysisStatus: null },
};

/** One fresh account + report in the given shape; logs cleared, so only what happens next is counted. */
async function seed(shape) {
  const account = await env.signUpAccount();
  const id = String(nextId++);
  const room = nextRoom++ % 10;
  const report = await asAccount(account, () => SEEDS[shape](account, id, room));
  REPORTS.set(id, { report, room });
  const ai = await aiHalf(id);
  assert.deepEqual(
    { ai_status: ai.ai_status, scored: typeof ai.ai_score === "number", aiAnalysisStatus: ai.aiAnalysisStatus },
    SEED_SHAPES[shape],
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
  return row ? Object.fromEntries(Object.entries(row).map(([key, value]) => [key, num(value)])) : null;
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
    const roomRead = room === null ? null : await fetchReportRoomContents(room); // GET /api/reports?room= -> findRoomOccupant
    return {
      derived: deriveRoomStatus(row.ai_score, row.ai_status), // SSR detail page, rooms index, room occupant
      protectedReady: row.ai_status === "ready" || deriveRoomStatus(row.ai_score, row.ai_status) === "ready",
      display: display.state,
      displayScore: display.score,
      room: roomRead === null ? "no room" : roomRead.ok ? roomRead.contents.status : "unreadable",
      listAiStatus: listed?.aiStatus ?? null,
      detailAiAnalysis: detail?.aiAnalysis?.status ?? null,
    };
  });
}

/** The AI fields a whole-report save request declares ("absent" when the key is not in the JSON at all). */
function incomingAiOf(body) {
  const parsed = JSON.parse(body);
  return {
    aiStatus: "aiStatus" in parsed ? parsed.aiStatus : "absent",
    aiScore: parsed.aiScore ?? null,
    aiTone: parsed.aiTone ?? null,
    room: parsed.room ?? "absent",
    payloadAiAnalysis: parsed.payload?.aiAnalysis?.status ?? null,
  };
}

/** POSTs `body` (a string) to /api/reports as `account`'s browser. */
const postRaw = (account, body) => asAccount(account, async (route) => {
  const response = await fetch("/api/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body });
  return { ok: response.ok, http: posts(route), incoming: incomingAiOf(body) };
});

/** The report's own recorded first-save request with its aiStatus rewritten: `undefined` drops the key, `null` sends JSON null. */
function firstSaveWithAiStatus(id, aiStatus) {
  const parsed = JSON.parse(FIRST_SAVE_BODIES.get(id));
  if (aiStatus === undefined) delete parsed.aiStatus;
  else parsed.aiStatus = aiStatus;
  return JSON.stringify(parsed);
}

/**
 * Whole-report saves that declare NO AI lifecycle state, for an existing report.
 * `aiStatus absent` / `aiStatus null` are the same request on the wire except for that one key; the route maps both to NULL.
 */
const STATUSLESS_SAVES = {
  // The report's recorded first-save request without its aiStatus key (for a legacy row: its own legacy first save, verbatim).
  "first save, aiStatus absent": ({ account, id }) => postRaw(account, firstSaveWithAiStatus(id, undefined)),
  // The same request with an explicit JSON null.
  "first save, aiStatus null": ({ account, id }) => postRaw(account, firstSaveWithAiStatus(id, null)),
  // app/page.tsx's saveReport for this report, through the real client helper: buildReportSummary (no aiStatus), no room.
  "app/page.tsx saveReport re-sent": ({ account, id }) => asAccount(account, async (route) => {
    const { report } = REPORTS.get(id);
    const { result, bodies } = await recordingReportPosts(() => saveReportRemote(report, buildReportSummary(report), null));
    return { ok: result.ok, http: posts(route), incoming: incomingAiOf(bodies[0]) };
  }),
  // app/page.tsx's AI resave carrying a model FAILURE for this report (ai_score NULL, aiAnalysis 'error', no aiStatus).
  "app/page.tsx AI resave (error) re-sent": ({ account, id }) => asAccount(account, async (route) => {
    const { report } = REPORTS.get(id);
    const { result, bodies } = await recordingReportPosts(() => statuslessAiResave(report, errorResult()));
    return { ok: result.ok, http: posts(route), incoming: incomingAiOf(bodies[0]) };
  }),
  // app/page.tsx's AI resave carrying a DIFFERENT complete result (numeric ai_score, no aiStatus).
  "app/page.tsx AI resave (other complete result) re-sent": ({ account, id }) => asAccount(account, async (route) => {
    const { report } = REPORTS.get(id);
    const { result, bodies } = await recordingReportPosts(() => statuslessAiResave(report, completeResult(4242)));
    return { ok: result.ok, http: posts(route), incoming: incomingAiOf(bodies[0]) };
  }),
};

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

/** The protected-ready + statusless-save outcome every ready shape must have. */
function assertReadyPreserved(c, label) {
  assert.equal(c.response.incoming.aiStatus === null || c.response.incoming.aiStatus === "absent", true, `${label}: the save declares no aiStatus`);
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
// 1-3. PROTECTED-READY + STATUSLESS SAVE — explicit ready (numeric, and compact-stored), legacy-derived ready, explicit ready
//      without a calibrated score; every statusless request shape
// ---------------------------------------------------------------------------------------------------------------------

for (const [num_, shape, title] of [
  ["1", "explicitReady", "EXPLICIT READY (numeric score)"],
  ["1c", "explicitReadyCompact", "EXPLICIT READY, compact-stored AI result"],
  ["2", "legacyReady", "LEGACY-DERIVED READY (ai_status NULL, numeric score)"],
  ["3", "explicitReadyNullScore", "EXPLICIT READY WITHOUT A CALIBRATED SCORE (ai_status 'ready', ai_score NULL)"],
]) {
  for (const [label, save] of Object.entries(STATUSLESS_SAVES)) {
    test(`${num_}. ${title} + STATUSLESS SAVE (${label}): accepted, but the ready AI result is preserved exactly — still ready, similarity unchanged`, async (t) => {
      const c = await capture(shape, save);
      t.diagnostic(`CAPTURE shape=${shape} via=${label} ${JSON.stringify(summarize(c))}`);
      assert.equal(c.before.state.protectedReady, true, "fixture sanity: protected-ready before");
      if (shape === "explicitReadyCompact") assert.equal(c.before.ai.aiAnalysisCompact, true, "fixture sanity: the stored AI result is the compact table");
      if (shape === "explicitReadyNullScore") assert.equal(c.before.state.derived, "ready", "fixture sanity: explicit ready is authoritative — derived ready without a score");
      assertReadyPreserved(c, `${shape} <- ${label}`);
      if (shape === "explicitReadyCompact") assert.equal(c.after.ai.aiAnalysisCompact, true, "the compact AI table is still what is stored");
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// 4-6. The other incoming AI states onto protected-ready rows — unchanged from 6aed363
// ---------------------------------------------------------------------------------------------------------------------

const PROTECTED_READY_SHAPES = ["explicitReady", "legacyReady", "explicitReadyNullScore"];

test("4. READY + PROCESSING: a stale 'processing' first save still never displaces a protected-ready AI result (6aed363, unchanged)", async (t) => {
  for (const shape of PROTECTED_READY_SHAPES) {
    const c = await capture(shape, ({ account, id }) => {
      // The legacy row's recorded first save carries no aiStatus; send it as the room page's 'processing' first save.
      return postRaw(account, firstSaveWithAiStatus(id, "processing"));
    });
    t.diagnostic(`CAPTURE ready-processing shape=${shape} ${JSON.stringify(summarize(c))}`);
    assert.deepEqual(c.response.http, ["/api/reports:200"], shape);
    assert.deepEqual(c.writes.aiChanges, [], `${shape}: no AI change`);
    assert.deepEqual(c.after.ai, c.before.ai, `${shape}: the AI result is exactly as it was`);
    assert.deepEqual(c.after.state, c.before.state, `${shape}: every read is unchanged`);
    assert.equal(c.after.similarity, c.before.similarity, `${shape}: similarity half byte-identical`);
  }
});

test("5. READY + FAILED: a late failed whole-report save still never displaces a protected-ready AI result (00d7e07, unchanged)", async (t) => {
  for (const shape of PROTECTED_READY_SHAPES) {
    const c = await capture(shape, ({ account, id, room }) => asAccount(account, async (route) => {
      const saved = await automaticResave(account, REPORTS.get(id).report, room, errorResult());
      return { ok: saved.ok, http: posts(route), incoming: { aiStatus: "failed" } };
    }));
    t.diagnostic(`CAPTURE ready-failed shape=${shape} ${JSON.stringify(summarize(c))}`);
    assert.deepEqual(c.response.http, ["/api/reports:200"], shape);
    assert.deepEqual(c.writes.aiChanges, [], `${shape}: no AI change`);
    assert.deepEqual(c.after.ai, c.before.ai, `${shape}: the AI result is exactly as it was`);
    assert.deepEqual(c.after.state, c.before.state, `${shape}: every read is unchanged`);
    assert.equal(c.after.similarity, c.before.similarity, `${shape}: similarity half byte-identical`);
  }
});

const completeSave = ({ account, id, room }) => asAccount(account, async (route) => {
  const saved = await automaticResave(account, REPORTS.get(id).report, room, completeResult(4242));
  return { ok: saved.ok, http: posts(route), incoming: { aiStatus: "ready" } };
});

test("6. READY + READY: an explicit 'ready' whole-report resave still replaces a ready AI result (complete -> complete, unchanged)", async (t) => {
  const newSha = sha(JSON.stringify(completeResult(4242).aiAnalysis)).slice(0, 16);
  for (const shape of PROTECTED_READY_SHAPES) {
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
// 7-8. Automatic completion and recovery — unchanged
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

test("7. PROCESSING + READY: a fresh processing report's automatic AI run still persists READY in one AI write — and a statusless save afterwards no longer undoes it", async (t) => {
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
  assert.equal(completed.state.derived, "ready");
  assert.equal(completed.state.room, "ready");
  assert.equal(await similarityHalf(r.id), similarityBefore, "similarity half byte-identical");

  for (const label of ["first save, aiStatus absent", "app/page.tsx saveReport re-sent"]) {
    await env.client.execute("DELETE FROM test_row_write_log");
    const replay = await STATUSLESS_SAVES[label](r);
    t.diagnostic(`CAPTURE after-completion via=${label} ${JSON.stringify({ replay, writes: await writesFor(r.id), ai: await aiHalf(r.id) })}`);
    assert.deepEqual(replay.http, ["/api/reports:200"], label);
    assert.deepEqual((await writesFor(r.id)).aiChanges, [], `${label}: the statusless save changes nothing in the AI half`);
    assert.deepEqual(await aiHalf(r.id), completed.ai, `${label}: the automatic result survives`);
    assert.deepEqual(await effectiveState(r), completed.state, label);
  }
});

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
// 9-10. New reports — unchanged
// ---------------------------------------------------------------------------------------------------------------------

test("9. NEW REPORT + PROCESSING: the room page's first save creates the report exactly as before — 'processing', no score, no AI result", async () => {
  const account = await env.signUpAccount();
  const id = String(nextId++);
  const room = nextRoom++ % 10;
  const http = await asAccount(account, async (route) => {
    await roomFirstSave(account, id, room);
    return posts(route);
  });
  assert.deepEqual(http, ["/api/reports:200"]);
  const row = await rawRow(id);
  assert.deepEqual(
    { ai_status: row.ai_status, ai_score: row.ai_score, ai_tone: row.ai_tone, room: row.room_number, owner: row.user_id, aiAnalysis: JSON.parse(String(row.payload_json)).aiAnalysis ?? null },
    { ai_status: "processing", ai_score: null, ai_tone: incomingAiOf(FIRST_SAVE_BODIES.get(id)).aiTone, room, owner: account.userId, aiAnalysis: null },
  );
});

test("10. NEW REPORT + STATUSLESS: a statusless first save with a room creates the report exactly as before (ai_status NULL); app/page.tsx's roomless first save and its AI resave are refused (400) and create nothing; a legacy row's statusless AI completion onto its own non-ready row still lands", async (t) => {
  // a. The pre-0028 room page's first save of a NEW report: aiStatus absent, a room.
  const account = await env.signUpAccount();
  const id = String(nextId++);
  const room = nextRoom++ % 10;
  const httpA = await asAccount(account, async (route) => {
    await legacyFirstSave(account, id, room);
    return posts(route);
  });
  const rowA = await rawRow(id);
  const createdA = { ai_status: rowA.ai_status, ai_score: rowA.ai_score, ai_tone: rowA.ai_tone, room: rowA.room_number, owner: rowA.user_id, aiAnalysis: JSON.parse(String(rowA.payload_json)).aiAnalysis ?? null };
  t.diagnostic(`CAPTURE new-statusless-with-room ${JSON.stringify({ incoming: incomingAiOf(FIRST_SAVE_BODIES.get(id)), http: httpA, created: createdA })}`);
  assert.deepEqual(httpA, ["/api/reports:200"]);
  assert.deepEqual(createdA, { ai_status: null, ai_score: null, ai_tone: incomingAiOf(FIRST_SAVE_BODIES.get(id)).aiTone, room, owner: account.userId, aiAnalysis: null });

  // b. app/page.tsx generateReport's saves for a NEW report as a signed-in account: saveReport (no room, no aiStatus), then its
  //    AI resave — both refused by the room rule for an authenticated first save; nothing is created.
  const pageId = String(nextId++);
  const report = fx.buildFirstSaveBody({ deviceKey: account.deviceKey, id: pageId, text: TEXT }).payload;
  const page = await asAccount(account, async (route) => {
    const { result: first, bodies: firstBodies } = await recordingReportPosts(() => saveReportRemote(report, buildReportSummary(report), null));
    const { result: ai, bodies: aiBodies } = await recordingReportPosts(() => statuslessAiResave(report, completeResult()));
    return { first, ai, incoming: [incomingAiOf(firstBodies[0]), incomingAiOf(aiBodies[0])], http: posts(route) };
  });
  t.diagnostic(`CAPTURE app-page-new-report ${JSON.stringify(page)}`);
  assert.deepEqual(page.http, ["/api/reports:400", "/api/reports:400"], "app/page.tsx's roomless saves are refused");
  assert.equal(page.first.ok, false);
  assert.match(String(page.first.error), /^room must be an integer/);
  assert.equal(page.ai.ok, false);
  assert.equal(await rawRow(pageId), null, "nothing was created");

  // c. The legacy lifecycle on its own row: statusless first save (NULL/NULL) -> statusless AI completion (NULL + numeric) lands.
  const c = await capture("legacyPending", ({ account: a, id: i }) => asAccount(a, async (route) => {
    const { result, bodies } = await recordingReportPosts(() => statuslessAiResave(REPORTS.get(i).report, completeResult()));
    return { ok: result.ok, http: posts(route), incoming: incomingAiOf(bodies[0]) };
  }));
  t.diagnostic(`CAPTURE legacy-pending-ai-completion ${JSON.stringify(summarize(c))}`);
  assert.deepEqual(c.response.http, ["/api/reports:200"]);
  assert.deepEqual(c.writes.aiChanges, ["null/complete"], "the legacy AI completion is written");
  assert.equal(c.after.state.derived, "ready");
  assert.equal(c.after.state.display, "complete");

  // d. ...and its statusless AI failure lands too (the legacy row is not protected-ready).
  const d = await capture("legacyPending", ({ account: a, id: i }) => asAccount(a, async (route) => {
    const { result, bodies } = await recordingReportPosts(() => statuslessAiResave(REPORTS.get(i).report, errorResult()));
    return { ok: result.ok, http: posts(route), incoming: incomingAiOf(bodies[0]) };
  }));
  t.diagnostic(`CAPTURE legacy-pending-ai-failure ${JSON.stringify(summarize(d))}`);
  assert.deepEqual(d.response.http, ["/api/reports:200"]);
  assert.deepEqual(d.writes.aiChanges, ["null/error"], "the legacy AI failure is written");
  assert.equal(d.after.state.display, "failed");
});

// ---------------------------------------------------------------------------------------------------------------------
// 11. Claim-by-resave of a legacy anonymous row (app/api/reports/route.ts ownership comment; api-reports-account-scoping H)
// ---------------------------------------------------------------------------------------------------------------------

let legacyAnonCounter = 0;

/** A legacy anonymous row (user_id NULL, no room), written with the real SAVE_REPORT_SQL — a POST can no longer create one. */
async function insertLegacyAnonymousRow({ ready }) {
  legacyAnonCounter += 1;
  const deviceKey = `null-replay-legacy-anon-device-${legacyAnonCounter}`;
  const id = String(nextId++);
  const report = fx.buildFirstSaveBody({ deviceKey, id, text: TEXT }).payload;
  const payload = ready ? { ...report, ...completeResult() } : report;
  const summary = buildReportSummary(payload);
  await env.client.execute({
    sql: fx.reportsRoute.SAVE_REPORT_SQL,
    args: [id, deviceKey, summary.submissionId, summary.title, summary.createdAt, summary.wordCount, summary.archiveScore, summary.scoreBand, summary.aiScore, summary.aiTone, null, JSON.stringify(payload), null, null],
  });
  return { deviceKey, id, report };
}

test("11. CLAIM-BY-RESAVE: an authenticated statusless resave still claims a legacy anonymous row; a non-ready row's content is updated exactly as before, a READY row's AI result is preserved", async (t) => {
  // a. Non-ready legacy row (NULL/NULL): claimed, content replaced — unchanged.
  const pending = await insertLegacyAnonymousRow({ ready: false });
  const claimantA = await env.signUpAccount();
  const retitled = { ...pending.report, title: "claimed-by-resave.pdf" };
  const a = await asDevice(claimantA, pending.deviceKey, async (route) => {
    const { result, bodies } = await recordingReportPosts(() => saveReportRemote(retitled, buildReportSummary(retitled), null));
    return { ok: result.ok, http: posts(route), incoming: incomingAiOf(bodies[0]) };
  });
  const rowA = await rawRow(pending.id);
  t.diagnostic(`CAPTURE claim-non-ready ${JSON.stringify({ ...a, owner: rowA.user_id === claimantA.userId, title: rowA.title, ai: await aiHalf(pending.id) })}`);
  assert.deepEqual(a.http, ["/api/reports:200"]);
  assert.equal(rowA.user_id, claimantA.userId, "claimed");
  assert.equal(rowA.title, "claimed-by-resave.pdf");
  assert.equal(JSON.parse(String(rowA.payload_json)).title, "claimed-by-resave.pdf", "the content is the claimant's");

  // b. READY legacy row (NULL + numeric score + complete aiAnalysis): claimed by a statusless resave with no AI result.
  const ready = await insertLegacyAnonymousRow({ ready: true });
  const claimantB = await env.signUpAccount();
  const aiBefore = await aiHalf(ready.id);
  assert.deepEqual({ ai_status: aiBefore.ai_status, scored: typeof aiBefore.ai_score === "number", aiAnalysisStatus: aiBefore.aiAnalysisStatus }, { ai_status: null, scored: true, aiAnalysisStatus: "complete" }, "fixture sanity: legacy ready");
  await env.client.execute("DELETE FROM test_row_write_log");
  const b = await asDevice(claimantB, ready.deviceKey, async (route) => {
    const { result, bodies } = await recordingReportPosts(() => saveReportRemote(ready.report, buildReportSummary(ready.report), null));
    return { ok: result.ok, http: posts(route), incoming: incomingAiOf(bodies[0]) };
  });
  const rowB = await rawRow(ready.id);
  const stateB = await effectiveState({ account: claimantB, id: ready.id, room: null });
  t.diagnostic(`CAPTURE claim-ready ${JSON.stringify({ ...b, owner: rowB.user_id === claimantB.userId, aiBefore, aiAfter: await aiHalf(ready.id), writes: await writesFor(ready.id), stateAfter: stateB })}`);
  assert.deepEqual(b.http, ["/api/reports:200"]);
  assert.equal(rowB.user_id, claimantB.userId, "claimed");
  assert.deepEqual((await writesFor(ready.id)).aiChanges, [], "the claim did not change the AI half");
  assert.deepEqual(await aiHalf(ready.id), aiBefore, "the legacy complete AI result is preserved");
  assert.equal(stateB.derived, "ready");
  assert.equal(stateB.detailAiAnalysis, "complete");
});

// ---------------------------------------------------------------------------------------------------------------------
// 12. Non-ready stored rows still accept a statusless save — characterized, unchanged
// ---------------------------------------------------------------------------------------------------------------------

test("12. FAILED / PROCESSING + STATUSLESS: a statusless save onto a non-ready report is accepted exactly as before (not protected-ready); similarity unchanged", async (t) => {
  for (const shape of ["failed", "processing"]) {
    const c = await capture(shape, STATUSLESS_SAVES["first save, aiStatus absent"]);
    t.diagnostic(`CAPTURE ${shape}-statusless ${JSON.stringify(summarize(c))}`);
    assert.equal(c.before.state.protectedReady, false);
    assert.deepEqual(c.response.http, ["/api/reports:200"], shape);
    assert.deepEqual(c.writes.aiChanges, ["null/null"], `${shape}: the incoming statusless AI half is written`);
    assert.deepEqual({ ai_status: c.after.ai.ai_status, ai_score: c.after.ai.ai_score, aiAnalysisStatus: c.after.ai.aiAnalysisStatus }, { ai_status: null, ai_score: null, aiAnalysisStatus: null }, shape);
    assert.equal(c.after.similarity, c.before.similarity, `${shape}: similarity half byte-identical`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// 13. The other AI-writing route cannot carry a statusless result at all
// ---------------------------------------------------------------------------------------------------------------------

test("13. AI-RETRY ROUTE: the only other server path that writes the AI half refuses aiStatus absent/null outright (400) and writes nothing", async () => {
  for (const shape of PROTECTED_READY_SHAPES) {
    const r = await seed(shape);
    const before = await aiHalf(r.id);
    for (const aiStatus of [undefined, null]) {
      const body = { aiScore: 12, aiTone: "low", payload: { aiScore: 12, aiAnalysis: fx.syntheticAiAnalysis(TEXT, { seed: 4242 }) } };
      if (aiStatus === null) body.aiStatus = null;
      const response = await kit.callRetryRoute(r.id, { body, cookie: r.account.cookie });
      assert.deepEqual({ status: response.status, json: response.json }, { status: 400, json: { error: "Invalid AI result" } }, `${shape} aiStatus=${aiStatus}`);
    }
    assert.equal((await writesFor(r.id)).rowWrites, 0, `${shape}: nothing written`);
    assert.deepEqual(await aiHalf(r.id), before, `${shape}: the AI result is untouched`);
  }
});
