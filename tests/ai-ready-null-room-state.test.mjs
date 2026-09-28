import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import React from "react";
import { createMemoryIndexedDb, createMemoryLocalStorage } from "./helpers/memory-indexeddb.mjs";
import * as fx from "./helpers/large-report-retry-fixture.mjs";
import { num } from "./helpers/ai-compact-integration-kit.mjs";
import { synthProse } from "./helpers/real-ai-windows.mjs";
import * as aiRetryRoute from "../app/api/reports/[id]/ai-retry/route.ts";
import * as roomsRoute from "../app/api/reports/rooms/route.ts";
import * as archiveMatchRoute from "../app/api/archive/match/route.ts";
import { seedArchiveDocument } from "../lib/archive-corpus-seed.ts";
import { rebuildArchiveScalableIndex } from "../lib/archive-index-build.ts";
import { saveReportRemote, fetchReportRoomContents } from "../lib/reports-remote.ts";
import { persistAiCompletion } from "../lib/report-ai-completion.ts";
import { accountLocalReportOwner, storeReportBestEffort } from "../lib/report-store.ts";
import { buildReportSummary } from "../lib/report-types.ts";
import { findRoomOccupant } from "../lib/reports-repo.ts";
import { deriveRoomStatus, derivedAiReadySql } from "../lib/report-rooms.ts";
import { AI_SCORING_VERSION } from "../lib/ai-core.ts";
import { buildSizeUnavailableAiAnalysis } from "../lib/ai-unavailable-state.ts";

register("./helpers/ssr-next-hooks.mjs", import.meta.url);

/**
 * EXPLICIT READY WITHOUT A CALIBRATED SCORE — the room settles.
 *
 * THE STATE. ai_status 'ready' means the AI analysis is COMPLETE; a numeric ai_score is optional. A complete analysis the
 * client cannot calibrate (a page/worker bundle skew: scoringVersion != AI_SCORING_VERSION, or a null median) is saved by the
 * real automatic pass as ai_status 'ready' + ai_score NULL + payload.aiAnalysis.status 'complete'. That is "analysis complete,
 * score unavailable" — never "processing".
 *
 * THE DEFECT (reproduced on 506da72). lib/report-rooms.ts deriveRoomStatus ignored an explicit 'ready' ('failed' wins,
 * otherwise NULL score -> "processing"), so the room occupant (SSR + every poll), the rooms index and the detail SSR said
 * "processing" for the whole 24 h cycle: "Analysis in progress" / "Analyzing…", 10 polls then "Check again" and a Retry that
 * only answered "already complete", a disabled Receipt; the originating tab never promoted similarity; a lost-response AI save
 * was reported as "could not be saved". And POST /api/reports accepted an explicit 'ready' with no complete analysis.
 *
 * THE FIX. deriveRoomStatus: explicit 'failed' -> failed, explicit 'ready' -> ready, otherwise the legacy ai_score rule
 * (derivedAiReadySql in lockstep). POST /api/reports refuses an explicit 'ready' whose payload does not carry a complete
 * analysis (the checks the AI-result route makes of a 'ready' result). The room's AI tile reads "— Unscored" with
 * "Analysis complete; score unavailable." for a ready report without a number.
 *
 * HOW. The REAL RoomPageShell under a minimal hook host (tests/ai-save-lost-response-reconciliation.test.mjs's technique), the
 * REAL routes on a throwaway migrated SQLite DB, lib/report-store.ts on an in-memory IndexedDB, a virtual clock for window
 * timers. Only the two browser Workers are scripted; "stale" results carry scoringVersion AI_SCORING_VERSION - 1. A trigger
 * records every COMMITTED write of a report's AI/payload columns. Rows are built through the real routes; shapes a product
 * writer never produces are labelled CONSTRUCTED.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Browser surroundings — set up EVERYTHING before the first test() is registered.
// ---------------------------------------------------------------------------------------------------------------------

const idb = createMemoryIndexedDb();
globalThis.indexedDB = idb.factory;

const clock = { now: 0, seq: 0, timers: new Map() };
globalThis.window = {
  localStorage: createMemoryLocalStorage(),
  setTimeout(fn, ms = 0, ...args) {
    const id = ++clock.seq;
    clock.timers.set(id, { due: clock.now + ms, fn: () => fn(...args) });
    return id;
  },
  clearTimeout(id) { clock.timers.delete(id); },
  setInterval() { return ++clock.seq; },
  clearInterval() {},
};

const settle = () => new Promise((resolve) => setImmediate(resolve));
const realDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runNextTimer() {
  const next = [...clock.timers.entries()].sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
  if (!next) return false;
  clock.timers.delete(next[0]);
  clock.now = Math.max(clock.now, next[1].due);
  await next[1].fn();
  await settle();
  return true;
}

async function runTimers({ until = () => false, max = 200 } = {}) {
  for (let i = 0; i < max && !until(); i += 1) if (!(await runNextTimer())) return;
}

async function waitFor(condition, what, max = 4000) {
  for (let i = 0; i < max && !condition(); i += 1) await realDelay(2);
  assert.ok(condition(), `timed out waiting for ${what}`);
  for (let i = 0; i < 20; i += 1) await settle();
}

/** Scripted Workers. AI behaviours: "complete" | "complete-stale" (uncalibratable) | "error", optional "-held" suffix. */
const worker = { script: [], runs: [], held: [] };
class FakeWorker {
  constructor(url) {
    this.kind = String(url).includes("web-check-worker") ? "web" : "ai";
    this.listeners = new Set();
  }
  addEventListener(type, fn) { if (type === "message") this.listeners.add(fn); }
  removeEventListener(type, fn) { this.listeners.delete(fn); }
  terminate() {}
  postMessage({ id, text }) {
    const emit = (data) => { for (const fn of [...this.listeners]) fn({ data }); };
    if (this.kind === "web") {
      setImmediate(() => emit({ id, ok: false, error: "web check offline in this test" }));
      return;
    }
    const behaviour = worker.script.shift() ?? "unscripted";
    worker.runs.push(behaviour);
    const respond = () => {
      emit({ type: "prep", stage: "analyzing" });
      if (behaviour.startsWith("complete")) {
        const result = fx.syntheticAiAnalysis(text, { seed: 4242 });
        if (behaviour.includes("stale")) result.scoringVersion = AI_SCORING_VERSION - 1;
        emit({ id, ok: true, result });
      } else emit({ id, ok: false, error: `Injected model failure (${behaviour})` });
    };
    if (behaviour.endsWith("-held")) worker.held.push(respond);
    else setImmediate(respond);
  }
}
globalThis.Worker = FakeWorker;

const env = await fx.createFixtureEnvironment("ai_ready_null_room_state");
process.env.TURSO_DATABASE_URL = `file:${env.dbFile}`;
const restoreC2 = fx.pinCompactWrites(undefined);
const restoreAi = fx.pinAiCompactWrites(undefined);
const archiveFlagBefore = process.env.ARCHIVE_SERVER_SIDE_ENABLED;
process.env.ARCHIVE_SERVER_SIDE_ENABLED = "true";

// A small synthetic archive for the real server-side archive match the upload runs (unrelated to the manuscript: 0% archive).
{
  const distinctive = (ns, n) => Array.from({ length: n }, (_, i) => `zq${ns}x${i.toString(36)}w`).join(" ");
  const seeded = await seedArchiveDocument(
    env.client,
    { archiveArticleId: "ready-null-room-a", title: "Ready Null Room Archive A", originalSimilarity: null, text: distinctive(1, 600), archiveOrder: 0 },
    { corpusVersion: "ready-null-room-v1", firstSeenAt: "2020-01-01 00:00:00" },
  );
  assert.equal(seeded.status, "SEEDED");
  await rebuildArchiveScalableIndex(env.client);
}

await env.client.execute(`CREATE TABLE test_ai_write_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, report_id TEXT, ai_status TEXT, ai_analysis_status TEXT)`);
await env.client.execute(`CREATE TRIGGER test_ai_write_log_trg AFTER UPDATE OF ai_status, ai_score, ai_tone, payload_json ON saved_reports BEGIN
  INSERT INTO test_ai_write_log (report_id, ai_status, ai_analysis_status) VALUES (NEW.id, NEW.ai_status, json_extract(NEW.payload_json, '$.aiAnalysis.status'));
END`);

const roomShell = await import("../app/reports/rooms/[room]/room-page-shell.tsx");

test.after(() => {
  if (archiveFlagBefore === undefined) delete process.env.ARCHIVE_SERVER_SIDE_ENABLED;
  else process.env.ARCHIVE_SERVER_SIDE_ENABLED = archiveFlagBefore;
  restoreAi();
  restoreC2();
  env.dispose();
});

const AUTO_SAVE_FAILED = "AI analysis finished but could not be saved. Retry analysis once it settles, or reopen this room.";
const UNSCORED_TILE = "—Unscored";
const UNSCORED_NOTE = "Analysis complete; score unavailable.";
/** Wording a SETTLED ready room must never show. */
const IN_PROGRESS_WORDING = /Pending|Analyzing|Analysis in progress|taking longer than usual|Preparing…|Calculating…/;

// ---------------------------------------------------------------------------------------------------------------------
// The hook host: the real component function under a dispatcher that implements exactly the hooks it uses.
// ---------------------------------------------------------------------------------------------------------------------

const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

function mountRoom(props) {
  const slots = [];
  const toasts = [];
  let cursor = 0;
  let tree = null;
  let dirty = false;
  let scheduled = false;
  let unmounted = false;
  let pendingEffects = [];
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
  const dispatcher = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) {
        const slot = { value: typeof initial === "function" ? initial() : initial };
        slot.set = (next) => {
          if (unmounted) return;
          const value = typeof next === "function" ? next(slot.value) : next;
          if (Object.is(value, slot.value)) return;
          slot.value = value;
          dirty = true;
          if (!scheduled) { scheduled = true; queueMicrotask(flush); }
        };
        slots[index] = slot;
      }
      return [slots[index].value, slots[index].set];
    },
    useRef(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(create, deps) {
      const index = cursor++;
      const slot = slots[index] ?? (slots[index] = { deps: undefined, cleanup: undefined });
      if (changed(slot.deps, deps)) {
        slot.deps = deps;
        slot.create = create;
        pendingEffects.push(slot);
      }
    },
  };
  function render() {
    cursor = 0;
    const previous = internals.H;
    internals.H = dispatcher;
    try {
      tree = roomShell.RoomPageShell(props);
    } finally {
      internals.H = previous;
    }
    const toast = toastOf(tree);
    if (toast && toast !== toasts.at(-1)) toasts.push(toast);
    const effects = pendingEffects;
    pendingEffects = [];
    for (const slot of effects) {
      slot.cleanup?.();
      const cleanup = slot.create();
      slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    }
  }
  function flush() {
    scheduled = false;
    if (unmounted) return;
    for (let guard = 0; dirty && guard < 50; guard += 1) {
      dirty = false;
      render();
    }
  }
  render();
  return {
    get tree() { return tree; },
    toasts,
    unmount() {
      unmounted = true;
      for (const slot of slots) slot?.cleanup?.();
    },
  };
}

function* walk(node) {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  if (typeof node !== "object" || !node.props) return;
  // SimilarityMetricTile is a hook-free child component the host does not expand: expand it (pure) so its text is visible.
  if (node.type === roomShell.SimilarityMetricTile) {
    yield* walk(node.type(node.props));
    return;
  }
  yield node;
  yield* walk(node.props.children);
}
const textOf = (node) => {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && node.type === roomShell.SimilarityMetricTile) return textOf(node.type(node.props));
  return node.props ? textOf(node.props.children) : "";
};
function toastOf(tree) {
  for (const container of walk(tree)) {
    if (container.props.className !== "room-page-container") continue;
    for (const el of [container.props.children].flat(Infinity)) {
      const child = el?.props?.children;
      if (el?.type === "div" && el.props.role === "status" && el.props.className === "ai-analysis-message" && child?.type === "p" && typeof child.props.children === "string") return child.props.children;
    }
  }
  return null;
}
function retryButtonOf(tree) {
  for (const el of walk(tree)) {
    if (el.type === "button" && typeof el.props.onClick === "function" && /Retry analysis|Checking…/.test(textOf(el.props.children))) return el;
  }
  return null;
}
function uploadPanelOf(tree) {
  for (const el of walk(tree)) if (typeof el.props.onGenerate === "function") return el;
  return null;
}
/** What the customer sees: the heading's status line, the three tiles, the AI note, the loading/exhausted notice, Check again, Retry. */
function uiOf(host) {
  const ui = { statusLine: null, aiTile: null, similarityTile: null, receiptTile: null, receiptEnabled: null, notes: [], exhausted: false, loading: null, checkAgainVisible: false };
  for (const el of walk(host.tree)) {
    const cls = el.props.className;
    const text = textOf(el.props.children);
    if (cls === "room-page-status") ui.statusLine = text;
    if (typeof cls === "string" && cls.startsWith("room-metric")) {
      if (ui.aiTile === null && text.startsWith("AI Detection")) ui.aiTile = text.slice("AI Detection".length);
      if (ui.similarityTile === null && text.startsWith("Similarity")) ui.similarityTile = text.slice("Similarity".length);
      if (ui.receiptTile === null && text.startsWith("Receipt")) {
        ui.receiptTile = text.slice("Receipt".length);
        ui.receiptEnabled = el.type === "button" && el.props.disabled !== true && typeof el.props.onClick === "function";
      }
    }
    if (cls === "room-cycle-note") ui.notes.push(text);
    if (el.type === "p" && text === "Analysis is taking longer than usual.") ui.exhausted = true;
    if (cls === "ai-analysis-loading") ui.loading = text;
    if (el.type === "button" && text === "Check again") ui.checkAgainVisible = true;
  }
  ui.retryVisible = retryButtonOf(host.tree) !== null;
  ui.toast = toastOf(host.tree);
  ui.allText = textOf(host.tree);
  return ui;
}
const briefUi = ({ allText: _all, ...rest }) => rest;

// ---------------------------------------------------------------------------------------------------------------------
// The browser's network: real routes; one-shot faults at the fetch boundary; every room read's returned status recorded.
// ---------------------------------------------------------------------------------------------------------------------

let nextId = 1_761_000_000_000;
const TEXT = synthProse(12_000, { seed: 91, messiness: 0.01 });

function browser(account) {
  window.localStorage.setItem("tp_device_key_v1", account.deviceKey);
  const route = fx.installRouteFetch(account, {
    "POST /api/reports/:id/ai-retry": aiRetryRoute.POST,
    "GET /api/archive/match": archiveMatchRoute.GET,
    "POST /api/archive/match": archiveMatchRoute.POST,
  });
  const routedFetch = globalThis.fetch;
  const faults = [];
  const log = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, "http://localhost");
    const method = String(init.method ?? "GET").toUpperCase();
    const key = `${method} ${url.pathname.replace(/^\/api\/reports\/\d+/, "/api/reports/:id")}${method === "GET" && url.pathname === "/api/reports" && url.searchParams.has("room") ? "?room" : ""}`;
    const entry = { key, outcome: "pending" };
    log.push(entry);
    const at = faults.findIndex((f) => f.key === key);
    if (at >= 0) {
      const [fault] = faults.splice(at, 1);
      // The request REALLY runs (the route commits), then the answer is lost on the way back.
      const response = await routedFetch(input, init);
      entry.outcome = `${response.status}->${fault.mode}`;
      throw new TypeError("network connection lost after the request was sent");
    }
    const response = await routedFetch(input, init);
    entry.outcome = response.status;
    if (key === "GET /api/reports?room") {
      try { entry.outcome = `${response.status}:${(await response.clone().json()).status}`; } catch { entry.outcome = `${response.status}:unparsed`; }
    }
    return response;
  };
  return {
    log,
    owner: accountLocalReportOwner(account.email),
    /** One-shot "drop-after-commit" on the next matching request. */
    dropAfterCommit(key) { faults.push({ key, mode: "drop-after-commit" }); },
    restore() { route.restore(); },
  };
}

function requestsSince(b, mark) {
  const entries = b.log.slice(mark);
  return {
    aiSaves: entries.filter((e) => e.key === "POST /api/reports" || e.key === "POST /api/reports/:id/ai-retry").map((e) => e.outcome),
    roomReads: entries.filter((e) => e.key === "GET /api/reports?room").map((e) => e.outcome),
  };
}

let roomCounter = 0;
async function scenario(fn) {
  const account = await env.signUpAccount();
  const b = browser(account);
  worker.script.length = 0;
  worker.runs.length = 0;
  worker.held.length = 0;
  try {
    return await fn({ account, b, room: roomCounter++ % 10 });
  } finally {
    b.restore();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Stored state and seeds — real routes wherever the shape is reachable.
// ---------------------------------------------------------------------------------------------------------------------

async function storedRow(id) {
  const row = (await env.client.execute({ sql: "SELECT ai_status, ai_score, payload_json FROM saved_reports WHERE id = ?", args: [id] })).rows[0];
  if (!row) return null;
  const payload = JSON.parse(String(row.payload_json));
  return {
    ai_status: row.ai_status === null ? null : String(row.ai_status),
    ai_score: num(row.ai_score),
    aiAnalysis: payload.aiAnalysis ? payload.aiAnalysis.status : "ABSENT",
    payload_json: String(row.payload_json),
  };
}
const aiHalfOf = (row) => ({ ai_status: row.ai_status, ai_score: row.ai_score, aiAnalysis: row.aiAnalysis });

async function writesFor(id) {
  const rows = (await env.client.execute({ sql: "SELECT ai_status, ai_analysis_status FROM test_ai_write_log WHERE report_id = ? ORDER BY seq", args: [id] })).rows;
  return rows.map((r) => `${r.ai_status}/${r.ai_analysis_status}`);
}

function analysisOf({ stale = false, status = "complete" } = {}) {
  if (status !== "complete") return fx.syntheticAiAnalysis(TEXT, { status });
  const a = fx.syntheticAiAnalysis(TEXT, { seed: 11 });
  if (stale) a.scoringVersion = AI_SCORING_VERSION - 1;
  return a;
}

/** The room page's first save: the report exists, AI still processing. */
async function firstSave(account, b, room) {
  const id = nextId++;
  const body = fx.buildFirstSaveBody({ deviceKey: account.deviceKey, id: String(id), text: TEXT, room });
  const report = { ...body.payload, id };
  assert.equal((await saveReportRemote(report, { ...buildReportSummary(report), aiStatus: "processing", similarityStatus: "pending" }, undefined, room)).ok, true, "fixture: first save");
  return { id: String(id), report };
}

const SEEDS = {
  // REAL: the automatic resave (saveEnrichedAiResult's mapping, through persistAiCompletion) of a calibratable analysis.
  readyScore: (e, s, room) => persistAiCompletion(e, { ...s, aiStatus: "ready" }, room),
  // REAL: the same resave of a complete analysis from a stale worker — no calibrated score.
  readyNull: (e, s, room) => persistAiCompletion(e, { ...s, aiStatus: "ready" }, room),
  // CONSTRUCTED: the same request without an aiScore key — the route stores `aiScore ?? null`.
  readyAbsentScore: (e, s, room) => { const { aiScore: _dropped, ...rest } = s; return persistAiCompletion(e, { ...rest, aiStatus: "ready" }, room); },
  // CONSTRUCTED: a 'processing' resave carrying a complete analysis.
  processingComplete: (e, s, room) => saveReportRemote(e, { ...s, aiStatus: "processing", aiScore: null, aiTone: null }, undefined, room),
  // CONSTRUCTED: a 'failed' resave carrying a complete analysis.
  failedComplete: (e, s, room) => persistAiCompletion(e, { ...s, aiStatus: "failed", aiScore: null, aiTone: "unavailable" }, room),
  // REAL legacy shapes: a statusless resave (app/page.tsx / pre-0028 bundles).
  legacyScore: (e, s, room) => saveReportRemote(e, s, undefined, room),
  legacyNull: (e, s, room) => saveReportRemote(e, s, undefined, room),
};
const SEED_ANALYSIS = { readyScore: {}, readyNull: { stale: true }, readyAbsentScore: { stale: true }, processingComplete: {}, failedComplete: {}, legacyScore: {}, legacyNull: { stale: true } };

async function seed(kind, account, b, room) {
  const { id, report } = await firstSave(account, b, room);
  const enriched = { ...report, aiScore: 5, aiAnalysis: analysisOf(SEED_ANALYSIS[kind]) };
  const summary = { ...buildReportSummary(enriched), similarityStatus: "pending" };
  delete summary.aiStatus;
  const saved = await SEEDS[kind](enriched, summary, room);
  assert.equal(saved.ok, true, `fixture: ${kind}`);
  await env.client.execute("DELETE FROM test_ai_write_log");
  return id;
}

async function roomsIndexStatus(account, room) {
  const ip = `${account.tag}-rooms-index`;
  await fx.resetRateForTest(ip);
  const res = await roomsRoute.GET(new Request("http://localhost/api/reports/rooms", { headers: { cookie: `tp_session_v1=${account.cookie}`, "x-forwarded-for": ip } }));
  const body = await res.json();
  return body.rooms?.find((r) => r.room === room)?.status ?? `http${res.status}`;
}

/** Every server read of the room: the stored row's derivation (the detail page SSR), the SSR occupant, the poll route, the rooms index. */
async function readSurfaces(account, room, id) {
  const row = await storedRow(id);
  const occupant = await findRoomOccupant(env.client, account.userId, room);
  const poll = await fetchReportRoomContents(room);
  return {
    derived: deriveRoomStatus(row.ai_score, row.ai_status), // app/reports/[id]/page.tsx
    occupant: { status: occupant.status, aiScore: occupant.report?.aiScore ?? null, similarityStatus: occupant.report?.similarityStatus ?? null },
    poll: poll.ok ? poll.contents.status : "error",
    roomsIndex: await roomsIndexStatus(account, room),
  };
}

async function mount(account, room) {
  return mountRoom({ room, accountEmail: account.email, initialOccupant: await findRoomOccupant(env.client, account.userId, room) });
}

/** A settled, truthful ready + NULL room (G). `occupant` is the server's own view it must reflect. */
function assertSettledUnscoredRoom(ui, occupant, label) {
  assert.match(ui.statusLine ?? "", /^Report ready · Last checked /, `${label}: heading`);
  assert.equal(ui.aiTile, UNSCORED_TILE, `${label}: AI tile`);
  assert.ok(ui.notes.includes(UNSCORED_NOTE), `${label}: supporting text`);
  assert.equal(occupant.report.similarityStatus, "resolved", `${label}: the server's similarity is resolved`);
  const similarity = occupant.report.primaryScore ?? occupant.report.archiveScore;
  assert.equal(typeof similarity, "number", `${label}: the server's similarity result`);
  assert.match(ui.similarityTile ?? "", new RegExp(`^${similarity}%`), `${label}: Similarity shows the server's stored result`);
  assert.equal(ui.receiptTile, "Download", `${label}: Receipt available`);
  assert.equal(ui.receiptEnabled, true, `${label}: Receipt downloadable`);
  assert.equal(ui.retryVisible, false, `${label}: no Retry analysis`);
  assert.equal(ui.checkAgainVisible, false, `${label}: no Check again`);
  assert.equal(ui.loading, null, `${label}: no loading notice`);
  assert.doesNotMatch(ui.allText, IN_PROGRESS_WORDING, `${label}: no in-progress wording anywhere`);
}

// =====================================================================================================================
// C. THE SQL TWIN — derivedAiReadySql is deriveRoomStatus(...) === "ready", for every stored combination
// =====================================================================================================================

test("C. SQL TWIN: derivedAiReadySql (alone, without any extra explicit-'ready' OR) equals deriveRoomStatus(ai_score, ai_status) === 'ready' for every stored combination, and is never NULL", async (t) => {
  await env.client.execute("CREATE TABLE test_twin_rows (id INTEGER PRIMARY KEY, ai_status TEXT, ai_score REAL)");
  const cells = [];
  for (const aiStatus of [null, "processing", "ready", "failed"]) for (const aiScore of [null, 0, 42]) cells.push([aiStatus, aiScore]);
  for (const [i, [aiStatus, aiScore]] of cells.entries()) {
    await env.client.execute({ sql: "INSERT INTO test_twin_rows (id, ai_status, ai_score) VALUES (?, ?, ?)", args: [i, aiStatus, aiScore] });
  }
  const rows = (await env.client.execute(`SELECT id, ${derivedAiReadySql("test_twin_rows")} AS ready FROM test_twin_rows ORDER BY id`)).rows;
  const table = [];
  for (const row of rows) {
    const [aiStatus, aiScore] = cells[Number(row.id)];
    const js = deriveRoomStatus(aiScore, aiStatus) === "ready";
    table.push(`${aiStatus}/${aiScore}: js=${js} sql=${row.ready}`);
    assert.ok(row.ready === 0 || row.ready === 1 || row.ready === 0n || row.ready === 1n, `(${aiStatus}, ${aiScore}): the predicate is 0/1, never NULL`);
    assert.equal(Number(row.ready) === 1, js, `(${aiStatus}, ${aiScore}): SQL and JS agree`);
  }
  t.diagnostic(`TWIN ${JSON.stringify(table)}`);
  // The task's eight named cells, pinned literally (the score values 0 and 42 behave alike).
  const pinned = { "failed/42": false, "failed/null": false, "ready/42": true, "ready/null": true, "processing/42": true, "processing/null": false, "null/42": true, "null/null": false };
  for (const [cell, ready] of Object.entries(pinned)) {
    const [s, v] = cell.split("/");
    assert.equal(deriveRoomStatus(v === "null" ? null : Number(v), s === "null" ? null : s) === "ready", ready, `JS ${cell}`);
    const i = cells.findIndex(([aiStatus, aiScore]) => String(aiStatus) === s && String(aiScore) === v);
    assert.equal(Number(rows[i].ready) === 1, ready, `SQL ${cell}`);
  }
  await env.client.execute("DROP TABLE test_twin_rows");
});

// =====================================================================================================================
// B/G. READ PATH + SETTLED ROOM — another device, or a reload
// =====================================================================================================================

test("B/G. READY + NULL + COMPLETE (real automatic save of an uncalibratable analysis): every server read says ready; the room is settled — 'Report ready', '— Unscored' + 'Analysis complete; score unavailable.', the stored similarity, Receipt Download, no Retry, no Check again, 0 polls, 0 model runs, 0 writes; a reload is identical", async (t) => {
  await scenario(async ({ account, b, room }) => {
    const id = await seed("readyNull", account, b, room);
    const row = await storedRow(id);
    assert.deepEqual(aiHalfOf(row), { ai_status: "ready", ai_score: null, aiAnalysis: "complete" }, "fixture sanity: explicit ready, no score, complete analysis");

    const surfaces = await readSurfaces(account, room, id);
    t.diagnostic(`CAPTURE surfaces ${JSON.stringify(surfaces)}`);
    assert.deepEqual(surfaces, { derived: "ready", occupant: { status: "ready", aiScore: null, similarityStatus: "resolved" }, poll: "ready", roomsIndex: "ready" });

    for (const pass of ["mount", "reload"]) {
      const occupant = await findRoomOccupant(env.client, account.userId, room);
      const host = mountRoom({ room, accountEmail: account.email, initialOccupant: occupant });
      const mark = b.log.length;
      const runs0 = worker.runs.length;
      assert.equal(roomShell.evaluatePollTick({ ok: true, contents: occupant }, 1, roomShell.MAX_POLL_ATTEMPTS).outcome, "revealed", `${pass}: the server answer is terminal`);
      await runTimers({ max: 40 });
      const ui = uiOf(host);
      t.diagnostic(`CAPTURE ${pass} ${JSON.stringify({ ui: briefUi(ui), requests: requestsSince(b, mark) })}`);
      assertSettledUnscoredRoom(ui, occupant, pass);
      assert.deepEqual(requestsSince(b, mark), { aiSaves: [], roomReads: [] }, `${pass}: no poll, no save`);
      assert.equal(worker.runs.length - runs0, 0, `${pass}: no model run`);
      assert.deepEqual(host.toasts, [], `${pass}: no message`);
      host.unmount();
    }
    assert.deepEqual(await writesFor(id), [], "nothing was written by displaying, polling or reloading");
    assert.deepEqual(aiHalfOf(await storedRow(id)), { ai_status: "ready", ai_score: null, aiAnalysis: "complete" }, "stored state unchanged");
  });
});

// =====================================================================================================================
// H. THE ORIGINATING TAB — the real upload whose own automatic completion is uncalibratable
// =====================================================================================================================

async function upload(host, account, ai) {
  worker.script.push(ai);
  uploadPanelOf(host.tree).props.onChooseFile(new File([TEXT], "ready-null-room.txt", { type: "text/plain" }));
  await settle();
  let finished = false;
  const running = uploadPanelOf(host.tree).props.onGenerate().then(() => { finished = true; });
  for (let i = 0; i < 4000 && !finished; i += 1) {
    await realDelay(3);
    if (!finished && i % 4 === 3) await runNextTimer(); // the upload animation wait and the generation watchdog run on window timers
  }
  await running;
  const rows = (await env.client.execute({ sql: "SELECT id FROM saved_reports WHERE user_id = ?", args: [account.userId] })).rows;
  assert.equal(rows.length, 1, "the upload saved exactly one report");
  return String(rows[0].id);
}

for (const [label, lost] of [
  ["H. ORIGINATING TAB", false],
  ["I. LOST RESPONSE", true],
]) {
  const title = lost
    ? "I. LOST RESPONSE: the uncalibratable automatic AI save COMMITS ready + NULL + complete but its answer is lost — the one reconciliation read accepts it as ready: no 'could not be saved' message, no second save, no second model run, the room settles from the server's own read"
    : "H. ORIGINATING TAB: the tab that ran the upload and the uncalibratable automatic AI save (holding its own local state) converges on the next authoritative room read — ready, the server's similarity, Receipt, '— Unscored', one poll, not ten";
  test(title, async (t) => {
    await scenario(async ({ account, b, room }) => {
      const host = await mount(account, room);
      const id = await upload(host, account, "complete-stale-held");
      await env.client.execute("DELETE FROM test_ai_write_log");
      if (lost) b.dropAfterCommit("POST /api/reports");
      const mark = b.log.length;
      worker.held.shift()();
      await waitFor(() => requestsSince(b, mark).aiSaves.length >= 1 && (uiOf(host).aiTile === UNSCORED_TILE || host.toasts.length > 0), "the automatic AI save to settle");
      for (let i = 0; i < 20; i += 1) await settle();
      const afterSave = { ui: briefUi(uiOf(host)), requests: requestsSince(b, mark), writes: await writesFor(id), stored: aiHalfOf(await storedRow(id)), toasts: host.toasts.slice() };
      t.diagnostic(`CAPTURE ${label} after-save ${JSON.stringify(afterSave)}`);

      assert.deepEqual(afterSave.stored, { ai_status: "ready", ai_score: null, aiAnalysis: "complete" }, "the server holds ready + NULL + complete");
      assert.deepEqual(afterSave.writes, ["ready/complete"], "exactly one committed AI write");
      assert.deepEqual(afterSave.requests.aiSaves, [lost ? "200->drop-after-commit" : 200], "exactly one AI save request; never re-sent, never sent to the AI-retry route");
      assert.deepEqual(afterSave.requests.roomReads, lost ? ["200:ready"] : [], lost ? "one reconciliation read, and the server says ready" : "no reconciliation read after a confirmed save");
      assert.equal(afterSave.ui.aiTile, UNSCORED_TILE, "the AI tile is settled — never 'Pending' / 'Analyzing…'");
      assert.ok(!host.toasts.some((m) => /could not be saved/.test(m)), "no false 'could not be saved' message");

      // The next authoritative room read (the completion poll — or, after a lost answer, the reconciliation read already made)
      // settles the tab: similarity from the server, Receipt, and polling stops.
      const pollMark = b.log.length;
      await runTimers({ until: () => /^Report ready/.test(uiOf(host).statusLine ?? ""), max: 40 });
      const revealPolls = requestsSince(b, pollMark).roomReads;
      const settledMark = b.log.length;
      await runTimers({ max: 40 });
      const occupant = await findRoomOccupant(env.client, account.userId, room);
      const ui = uiOf(host);
      t.diagnostic(`CAPTURE ${label} settled ${JSON.stringify({ revealPolls, laterRequests: requestsSince(b, settledMark), ui: briefUi(ui) })}`);
      assert.deepEqual(revealPolls, lost ? [] : ["200:ready"], lost ? "the adopted server occupant is already settled: no poll" : "exactly one poll, and it says ready");
      assert.deepEqual(requestsSince(b, settledMark), { aiSaves: [], roomReads: [] }, "polling has stopped; nothing is saved");
      assertSettledUnscoredRoom(ui, occupant, label);
      assert.equal(worker.runs.length, 1, "exactly one model run");
      assert.deepEqual(await writesFor(id), ["ready/complete"], "no additional AI write");
      assert.ok(!host.toasts.includes(AUTO_SAVE_FAILED));
      host.unmount();

      const reloaded = await mount(account, room);
      const reloadMark = b.log.length;
      await runTimers({ max: 40 });
      assertSettledUnscoredRoom(uiOf(reloaded), await findRoomOccupant(env.client, account.userId, room), `${label} reload`);
      assert.deepEqual(requestsSince(b, reloadMark), { aiSaves: [], roomReads: [] }, "reload: no poll, no save");
      reloaded.unmount();
      assert.equal(worker.runs.length, 1);
      assert.deepEqual(await writesFor(id), ["ready/complete"]);
    });
  });
}

// =====================================================================================================================
// K. THE STORED MATRIX — every other shape keeps its semantics
// =====================================================================================================================

for (const [kind, expected, title] of [
  ["readyScore", { derived: "ready", tile: /^\d+%/ }, "1. ready + numeric + complete -> ready with its number"],
  ["readyAbsentScore", { derived: "ready", tile: UNSCORED_TILE }, "3. ready + absent score (CONSTRUCTED; stored as NULL) + complete -> ready / Unscored"],
  ["processingComplete", { derived: "processing" }, "4. processing + NULL + complete (CONSTRUCTED) -> processing, unchanged"],
  ["failedComplete", { derived: "failed" }, "5. failed + NULL + complete (CONSTRUCTED) -> failed"],
  ["legacyScore", { derived: "ready", tile: /^\d+%/ }, "6. legacy (no ai_status) + numeric -> ready with its number"],
  ["legacyNull", { derived: "processing" }, "6b. legacy (no ai_status) + NULL + complete -> processing, unchanged (no explicit ready)"],
]) {
  test(`K${title}`, async (t) => {
    await scenario(async ({ account, b, room }) => {
      const id = await seed(kind, account, b, room);
      const row = await storedRow(id);
      const surfaces = await readSurfaces(account, room, id);
      t.diagnostic(`CAPTURE ${kind} ${JSON.stringify({ stored: aiHalfOf(row), surfaces })}`);
      if (kind === "readyAbsentScore") assert.deepEqual(aiHalfOf(row), { ai_status: "ready", ai_score: null, aiAnalysis: "complete" }, "an absent score is stored as NULL");
      assert.equal(surfaces.derived, expected.derived);
      assert.equal(surfaces.occupant.status, expected.derived);
      assert.equal(surfaces.poll, expected.derived);
      assert.equal(surfaces.roomsIndex, expected.derived);
      const host = await mount(account, room);
      const ui = uiOf(host);
      if (expected.derived === "ready") {
        assertTile(ui.aiTile, expected.tile, kind);
        assert.match(ui.statusLine ?? "", /^Report ready · Last checked /);
        assert.equal(ui.retryVisible, false);
        assert.equal(ui.notes.includes(UNSCORED_NOTE), expected.tile === UNSCORED_TILE, "the Unscored note appears exactly when there is no number");
      } else if (expected.derived === "failed") {
        assert.equal(ui.statusLine, "Report ready · AI analysis unavailable");
        assert.equal(ui.aiTile, "—Unavailable");
      } else {
        assert.equal(ui.statusLine, "Analysis in progress");
        assert.equal(ui.aiTile, "···Analyzing…");
      }
      host.unmount();
      assert.deepEqual(await writesFor(id), [], "reading and displaying writes nothing");
    });
  });
}

function assertTile(tile, expected, label) {
  if (expected instanceof RegExp) assert.match(tile ?? "", expected, `${label}: AI tile`);
  else assert.equal(tile, expected, `${label}: AI tile`);
}

// =====================================================================================================================
// D. WRITE BOUNDARY — POST /api/reports refuses an explicit 'ready' without a complete analysis; zero writes
// =====================================================================================================================

const INVALID_READY_ANALYSES = [
  ["missing analysis, NULL score", undefined, null],
  ["missing analysis, numeric score", undefined, 42],
  ["error analysis", "error", null],
  ["unsupported analysis", "unsupported", null],
  ["processing analysis", { status: "processing", score: null, passages: [] }, null],
  ["size-unavailable marker", "marker", null],
  ["null analysis", null, null],
  ["array analysis", [], null],
  ["complete analysis with a non-array passages field", "complete-bad-passages", null],
];
function analysisFor(spec) {
  if (spec === "error" || spec === "unsupported") return analysisOf({ status: spec });
  if (spec === "marker") return buildSizeUnavailableAiAnalysis();
  if (spec === "complete-bad-passages") return { ...analysisOf({ stale: true }), passages: "not-an-array" };
  return spec;
}

test("D. POST /api/reports: an explicit 'ready' whose payload has no complete analysis is refused 400 'Invalid AI result' before anything is written — missing, incomplete, error, unsupported, the size marker, malformed; on a first save no row is created; the AI-result route answers the same shapes the same way", async (t) => {
  await scenario(async ({ account, b, room }) => {
    const { id, report } = await firstSave(account, b, room);
    await env.client.execute("DELETE FROM test_ai_write_log");
    const before = await storedRow(id);
    assert.equal(before.ai_status, "processing");
    const outcomes = [];
    for (const [label, spec, aiScore] of INVALID_READY_ANALYSES) {
      const analysis = analysisFor(spec);
      const enriched = { ...report, aiScore: null, ...(analysis === undefined ? {} : { aiAnalysis: analysis }) };
      const summary = { ...buildReportSummary({ ...report }), aiStatus: "ready", aiScore, aiTone: aiScore === null ? "unavailable" : "review", similarityStatus: "pending" };
      const post = await saveReportRemote(enriched, summary, undefined, room);
      // The same AI result through the AI-result route (the validation this mirrors).
      const retry = await fetch(`/api/reports/${id}/ai-retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ aiStatus: "ready", aiScore, aiTone: summary.aiTone, payload: { aiScore: null, ...(analysis === undefined ? {} : { aiAnalysis: analysis }) } }),
      });
      const retryBody = await retry.json();
      outcomes.push({ label, post: post.status, postError: post.error, retry: retry.status, retryError: retryBody.error });
      assert.equal(post.ok, false, `${label}: POST refused`);
      assert.equal(post.status, 400, `${label}: POST 400`);
      assert.equal(post.error, "Invalid AI result", `${label}: POST error shape`);
      assert.equal(retry.status, 400, `${label}: the AI-result route refuses it too`);
      assert.equal(retryBody.error, "Invalid AI result", `${label}: same error`);
    }
    t.diagnostic(`CAPTURE invalid-ready ${JSON.stringify(outcomes)}`);
    assert.deepEqual(await writesFor(id), [], "zero writes");
    assert.equal((await storedRow(id)).payload_json, before.payload_json, "the stored report is byte-identical");
    assert.deepEqual(aiHalfOf(await storedRow(id)), aiHalfOf(before));

    // A FIRST save declaring 'ready' without an analysis creates nothing.
    const newId = String(nextId++);
    const body = fx.buildFirstSaveBody({ deviceKey: account.deviceKey, id: newId, text: TEXT, room: (room + 1) % 10 });
    const fresh = { ...body.payload, id: newId };
    const firstReady = await saveReportRemote(fresh, { ...buildReportSummary(fresh), aiStatus: "ready", aiScore: 42, aiTone: "review", similarityStatus: "pending" }, undefined, (room + 1) % 10);
    assert.equal(firstReady.status, 400);
    assert.equal(await storedRow(newId), null, "no row was created");

    // Valid explicit-ready saves are accepted on both routes: complete with NULL, complete with a number.
    const nullSummary = { ...buildReportSummary({ ...report, aiAnalysis: analysisOf({ stale: true }) }), aiStatus: "ready", similarityStatus: "pending" };
    assert.equal(nullSummary.aiScore, null, "fixture sanity: uncalibratable");
    assert.equal((await saveReportRemote({ ...report, aiScore: 5, aiAnalysis: analysisOf({ stale: true }) }, nullSummary, undefined, room)).ok, true, "ready + NULL + complete is accepted");
    assert.deepEqual(aiHalfOf(await storedRow(id)), { ai_status: "ready", ai_score: null, aiAnalysis: "complete" });
    const numericSummary = { ...buildReportSummary({ ...report, aiAnalysis: analysisOf() }), aiStatus: "ready", similarityStatus: "pending" };
    assert.equal(typeof numericSummary.aiScore, "number", "fixture sanity: calibratable");
    assert.equal((await saveReportRemote({ ...report, aiScore: 5, aiAnalysis: analysisOf() }, numericSummary, undefined, room)).ok, true, "ready + numeric + complete is accepted");
    assert.deepEqual(aiHalfOf(await storedRow(id)), { ai_status: "ready", ai_score: numericSummary.aiScore, aiAnalysis: "complete" });
  });
});

test("D. POST /api/reports: only the explicit 'ready' declaration is checked — a 'processing' first save, a 'failed' error result and a statusless (legacy) resave without an analysis are accepted exactly as before", async () => {
  await scenario(async ({ account, b, room }) => {
    const { id, report } = await firstSave(account, b, room); // 'processing', no analysis
    assert.equal((await storedRow(id)).ai_status, "processing");
    const failed = { ...report, aiScore: null, aiAnalysis: analysisOf({ status: "error" }) };
    assert.equal((await saveReportRemote(failed, { ...buildReportSummary(failed), aiStatus: "failed", aiScore: null, aiTone: "unavailable", similarityStatus: "pending" }, undefined, room)).ok, true, "failed + error analysis");
    assert.deepEqual(aiHalfOf(await storedRow(id)), { ai_status: "failed", ai_score: null, aiAnalysis: "error" });

    const { id: legacyId, report: legacyReport } = await firstSave(account, b, (room + 1) % 10);
    const legacySummary = { ...buildReportSummary(legacyReport), aiScore: 42, aiTone: "review" };
    delete legacySummary.aiStatus;
    assert.equal((await saveReportRemote(legacyReport, legacySummary, undefined, (room + 1) % 10)).ok, true, "statusless + score, no analysis");
    assert.deepEqual(aiHalfOf(await storedRow(legacyId)), { ai_status: null, ai_score: 42, aiAnalysis: "ABSENT" });
  });
});
