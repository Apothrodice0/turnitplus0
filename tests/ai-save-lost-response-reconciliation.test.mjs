import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import React from "react";
import { createMemoryIndexedDb, createMemoryLocalStorage } from "./helpers/memory-indexeddb.mjs";
import * as fx from "./helpers/large-report-retry-fixture.mjs";
import { sha, num } from "./helpers/ai-compact-integration-kit.mjs";
import { synthProse } from "./helpers/real-ai-windows.mjs";
import * as aiRetryRoute from "../app/api/reports/[id]/ai-retry/route.ts";
import * as archiveMatchRoute from "../app/api/archive/match/route.ts";
import { seedArchiveDocument } from "../lib/archive-corpus-seed.ts";
import { rebuildArchiveScalableIndex } from "../lib/archive-index-build.ts";
import { saveReportRemote } from "../lib/reports-remote.ts";
import { persistAiCompletion, persistAiRetryResult } from "../lib/report-ai-completion.ts";
import { accountLocalReportOwner, storeReportBestEffort, getStoredReportById } from "../lib/report-store.ts";
import { buildReportSummary } from "../lib/report-types.ts";
import { findRoomOccupant } from "../lib/reports-repo.ts";

register("./helpers/ssr-next-hooks.mjs", import.meta.url);

/**
 * AI SAVE — LOST RESPONSE AFTER A SUCCESSFUL COMMIT.
 *
 * THE DEFECT (reproduced on 9870d69). Both AI saves of a room — the automatic post-upload pass (runCheck ->
 * saveEnrichedAiResult -> persistAiCompletion -> POST /api/reports) and the manual Retry (retryAiCheck -> saveRetriedAiResult
 * -> persistAiRetryResult -> POST /api/reports/[id]/ai-retry) — turned EVERY non-2xx answer and every fetch rejection into
 * "the save failed". A request that reached the server and COMMITTED, but whose response never reached the browser (a dropped
 * connection, a gateway 5xx after the function finished), therefore left the room failed (Retry) or processing (automatic)
 * with a "could not be saved" message while the server already held the ready result; a reload showed ready, and Retry only
 * said "already complete" without moving the room.
 *
 * THE FIX. A failed save is classified: a 4xx is a definite refusal (both routes answer every 4xx before writing anything);
 * no response, a 5xx or an unexpected throw is AMBIGUOUS (the server may have committed). After an ambiguous failure the room
 * reads the server's own view of itself (GET /api/reports?room=N — the same read the completion poll and SSR use) and adopts it
 * only when it says THIS report's AI is ready. The model is never re-run and the result never re-sent; anything else keeps the
 * existing failure behaviour.
 *
 * HOW. The REAL RoomPageShell is rendered by a minimal hook host (same technique as tests/ai-retry-double-failure.test.mjs);
 * the automatic pass is driven through the REAL upload (DocumentUploadPanel's onGenerate -> runCheck) and the manual Retry
 * through the REAL "Retry analysis" button. Everything behind them is real: text extraction, the archive match route (server
 * engine, seeded archive), the report/ai-retry/room routes on a throwaway migrated SQLite DB, lib/report-store.ts on an
 * in-memory IndexedDB. Only the two browser Workers are scripted (AI result; the Wikipedia check reports offline), and faults
 * are injected ONLY at the fetch boundary — "drop-after-commit" really runs the route (it commits) and then loses the answer.
 * A trigger records every COMMITTED write of a report's AI/payload columns, so persistence is counted, not inferred.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Browser surroundings — set up EVERYTHING before the first test() is registered.
// ---------------------------------------------------------------------------------------------------------------------

const idb = createMemoryIndexedDb();
globalThis.indexedDB = idb.factory;

/** window with localStorage and a virtual clock for window.setTimeout (the poll, the watchdog, the toast clear, the upload animation). */
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

/** Runs the earliest due window timer (awaiting an async callback such as a poll tick). */
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
  for (let i = 0; i < 20; i += 1) await settle(); // anything the same continuation still does
}

/**
 * The two browser Workers. The AI detector consumes one scripted behaviour per model run ("complete" | "error", optionally
 * "-held" so the test decides WHEN the model finishes); the Wikipedia web check always reports offline (runCheck tolerates it).
 */
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
      if (behaviour.startsWith("complete")) emit({ id, ok: true, result: fx.syntheticAiAnalysis(text, { seed: 4242 }) });
      else emit({ id, ok: false, error: `Injected model failure (${behaviour})` });
    };
    if (behaviour.endsWith("-held")) worker.held.push(respond);
    else setImmediate(respond);
  }
}
globalThis.Worker = FakeWorker;

const env = await fx.createFixtureEnvironment("ai_save_lost_response");
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
    { archiveArticleId: "lost-response-a", title: "Lost Response Archive A", originalSimilarity: null, text: distinctive(1, 600), archiveOrder: 0 },
    { corpusVersion: "lost-response-v1", firstSeenAt: "2020-01-01 00:00:00" },
  );
  assert.equal(seeded.status, "SEEDED");
  await rebuildArchiveScalableIndex(env.client);
}

// Every COMMITTED write of a report's AI/payload columns (a rolled-back tentative write takes its log row with it; the
// deferred document-identity link does not touch these columns and is not a persistence of AI state).
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
const RETRY_SAVE_FAILED = "Could not save the updated AI result. Please try again.";
const RETRY_COMPLETE = "AI analysis complete.";
const ALREADY_COMPLETE = "AI analysis for this report is already complete.";

// ---------------------------------------------------------------------------------------------------------------------
// The hook host (tests/ai-retry-double-failure.test.mjs): the real component function under a dispatcher that implements
// exactly the hooks it uses. Updates are batched and flushed in a microtask, then passive effects run.
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
  yield node;
  yield* walk(node.props.children);
}
const textOf = (node) => {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
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
/** What the customer sees in the room: the heading's status line, the AI tile, the poll-exhausted notice, Retry, the toast. */
function uiOf(host) {
  let statusLine = null;
  let aiTile = null;
  let exhausted = false;
  for (const el of walk(host.tree)) {
    const cls = el.props.className;
    if (cls === "room-page-status") statusLine = textOf(el.props.children);
    if (aiTile === null && typeof cls === "string" && cls.startsWith("room-metric") && textOf(el.props.children).startsWith("AI Detection")) aiTile = textOf(el.props.children).slice("AI Detection".length);
    if (el.type === "p" && textOf(el.props.children) === "Analysis is taking longer than usual.") exhausted = true;
  }
  return { statusLine, aiTile, exhausted, retryOffered: retryButtonOf(host.tree) !== null, toast: toastOf(host.tree) };
}
const isReadyUi = (ui) => /^Report ready · Last checked/.test(ui.statusLine ?? "") && /^\d+%/.test(ui.aiTile ?? "") && !ui.retryOffered;

async function clickRetry(host) {
  const button = retryButtonOf(host.tree);
  assert.ok(button, "the room offers Retry analysis");
  assert.equal(button.props.disabled, false, "Retry is enabled before the click");
  await button.props.onClick();
  await settle();
}

// ---------------------------------------------------------------------------------------------------------------------
// The browser's network: real routes, with one-shot faults injected at the fetch boundary.
// ---------------------------------------------------------------------------------------------------------------------

let nextId = 1_759_000_000_000;
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
      if (fault.mode === "drop-after-commit" || fault.mode === "502-after-commit") {
        // The request REALLY runs (the route commits), then the answer is lost on the way back.
        const response = await routedFetch(input, init);
        entry.outcome = `${response.status}->${fault.mode}`;
        if (fault.snapshot) fault.committed = await fault.snapshot();
        if (fault.mode === "502-after-commit") return new Response("<html>Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
        throw new TypeError("network connection lost after the request was sent");
      }
      entry.outcome = `FAULT:${fault.mode}`; // never reaches the server
      if (fault.mode === "network") throw new TypeError("Failed to fetch");
      throw new Error(`unknown fault ${fault.mode}`);
    }
    const response = await routedFetch(input, init);
    entry.outcome = response.status;
    return response;
  };
  return {
    route,
    log,
    owner: accountLocalReportOwner(account.email),
    /** One-shot fault on the next matching request: "network" (never reaches the server) | "drop-after-commit" | "502-after-commit". */
    fault(key, mode, snapshot) {
      const fault = { key, mode, snapshot, committed: undefined };
      faults.push(fault);
      return fault;
    },
    restore() { route.restore(); },
  };
}

/** What a stretch of the request log did: AI saves (whole-report resave or ai-retry), room reads (GET ?room=N), full report reads. */
function requestsSince(b, mark) {
  const entries = b.log.slice(mark);
  return {
    aiSaves: entries.filter((e) => e.key === "POST /api/reports" || e.key === "POST /api/reports/:id/ai-retry").map((e) => e.outcome),
    roomReads: entries.filter((e) => e.key === "GET /api/reports?room").map((e) => e.outcome),
    reportReads: entries.filter((e) => e.key === "GET /api/reports/:id").map((e) => e.outcome),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Server/local state.
// ---------------------------------------------------------------------------------------------------------------------

/** A room whose report already exists (the same calls runCheck and saveEnrichedAiResult make, in their order). */
async function seedRoom(account, b, { room, analysis }) {
  const id = nextId++;
  const body = fx.buildFirstSaveBody({ deviceKey: account.deviceKey, id: String(id), text: TEXT, room });
  const report = { ...body.payload, id };
  await storeReportBestEffort(report, b.owner);
  assert.equal((await saveReportRemote(report, { ...buildReportSummary(report), aiStatus: "processing", similarityStatus: "pending" }, undefined, room)).ok, true);
  if (analysis === "failed") {
    const aiResult = roomShell.aiAnalysisErrorResult(new Error("worker crashed"), "analyzing");
    const enriched = { ...report, ...aiResult };
    await storeReportBestEffort(enriched, b.owner);
    assert.equal((await persistAiCompletion(enriched, { ...buildReportSummary(enriched), aiStatus: "failed", similarityStatus: "pending" }, room)).ok, true);
  }
  await env.client.execute("DELETE FROM test_ai_write_log");
  return String(id);
}

/** The REAL upload: choose a .txt file and press Generate (runCheck). Resolves once runCheck returned (first save done). */
async function upload(host, account, ai) {
  worker.script.push(ai);
  uploadPanelOf(host.tree).props.onChooseFile(new File([TEXT], "lost-response-report.txt", { type: "text/plain" }));
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

async function mount(account, room) {
  const initialOccupant = await findRoomOccupant(env.client, account.userId, room);
  return mountRoom({ room, accountEmail: account.email, initialOccupant });
}

async function serverState(id) {
  const row = (await env.client.execute({
    sql: `SELECT ai_status, ai_score, ai_tone, archive_score, score_band, word_count, title, submission_id, report_created_at, room_number, user_id, device_key, payload_json
          FROM saved_reports WHERE id = ?`,
    args: [id],
  })).rows[0];
  const payload = JSON.parse(String(row.payload_json));
  const { aiAnalysis, aiScore, ...similarityHalf } = payload;
  const flat = [row.archive_score, row.score_band, row.word_count, row.title, row.submission_id, row.report_created_at, row.room_number, row.user_id, row.device_key].map(num);
  return {
    aiStatus: row.ai_status,
    aiScore: num(row.ai_score),
    aiTone: row.ai_tone,
    aiAnalysis: aiAnalysis ?? null,
    rawAiScore: aiScore ?? null,
    similarity: sha(JSON.stringify([similarityHalf, flat])),
  };
}

async function writesFor(id) {
  const rows = (await env.client.execute({ sql: "SELECT ai_status, ai_analysis_status FROM test_ai_write_log WHERE report_id = ? ORDER BY seq", args: [id] })).rows;
  return rows.map((r) => `${r.ai_status}/${r.ai_analysis_status}`);
}

const localAiStatus = async (id, b) => (await getStoredReportById(id, b.owner))?.aiAnalysis?.status ?? null;

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

/** One line per scenario with every captured count and state, emitted BEFORE the assertions (so a failing baseline run still records them). */
function capture(t, label, data) {
  t.diagnostic(`CAPTURE ${label} ${JSON.stringify(data)}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. MANUAL RETRY — the save commits, the answer is lost
// ---------------------------------------------------------------------------------------------------------------------

for (const mode of ["drop-after-commit", "502-after-commit"]) {
  test(`MANUAL RETRY, COMMIT + LOST RESPONSE (${mode}): the room reaches ready from the server's own answer — one model run, one save, one write, no re-send`, async (t) => {
    await scenario(async ({ account, b, room }) => {
      const id = await seedRoom(account, b, { room, analysis: "failed" });
      const before = await serverState(id);
      const host = await mount(account, room);
      assert.equal(uiOf(host).retryOffered, true, "starting state: failed, Retry offered");

      worker.script.push("complete");
      const fault = b.fault("POST /api/reports/:id/ai-retry", mode, () => serverState(id));
      const mark = b.log.length;
      await clickRetry(host);
      const requests = requestsSince(b, mark);
      const server = await serverState(id);
      const ui = uiOf(host);
      const serverRoom = await findRoomOccupant(env.client, account.userId, room);
      capture(t, `manual-retry/${mode}`, {
        AI_MODEL_EXECUTIONS: worker.runs.length, AI_SAVE_REQUESTS: requests.aiSaves, SUCCESSFUL_SERVER_WRITES: await writesFor(id),
        RECONCILIATION_READS: requests.roomReads, reportReads: requests.reportReads, server: server.aiStatus, serverRoom: serverRoom.status,
        local: await localAiStatus(id, b), ui, toasts: host.toasts,
      });

      assert.equal(worker.runs.length, 1, "AI_MODEL_EXECUTIONS = 1");
      assert.deepEqual(requests.aiSaves, [`200->${mode}`], "AI_SAVE_REQUESTS = 1 (and it committed)");
      assert.deepEqual(await writesFor(id), ["ready/complete"], "SUCCESSFUL_SERVER_WRITES = 1");
      assert.ok(requests.roomReads.length >= 1, "RECONCILIATION_READS >= 1");
      assert.deepEqual(requests.roomReads, [200], "the reconciliation is one read of the room");
      assert.equal(server.aiStatus, "ready", "server final state: ready");
      assert.deepEqual(server, fault.committed, "the reconciliation wrote nothing: the row is exactly as the lost save committed it");
      assert.equal(server.similarity, before.similarity, "similarity half byte-identical");
      assert.equal(serverRoom.status, "ready");
      assert.ok(isReadyUi(ui), `client final state: ready (${JSON.stringify(ui)})`);
      assert.equal(ui.retryOffered, false, "Retry is no longer offered");
      assert.ok(ui.aiTile.startsWith(`${serverRoom.report.aiScore}%`), "the AI tile shows the server's canonical score");
      assert.equal(ui.toast, RETRY_COMPLETE, "the customer is told what a successful save says");
      assert.ok(!host.toasts.includes(RETRY_SAVE_FAILED), "no false 'could not save'");
      assert.equal(await localAiStatus(id, b), "complete", "the local copy (written before the save, unchanged) agrees");

      // Nothing scheduled afterwards re-runs, re-saves or flips the room back.
      await runTimers({ max: 20 });
      assert.equal(worker.runs.length, 1, "SECOND model run = 0");
      assert.deepEqual(requestsSince(b, mark).aiSaves, [`200->${mode}`], "SECOND_AI_SAVE = 0");
      assert.deepEqual(await writesFor(id), ["ready/complete"]);
      assert.ok(isReadyUi(uiOf(host)), "no stale failure overwrites the ready room");
      host.unmount();

      const reloaded = await mount(account, room);
      assert.ok(isReadyUi(uiOf(reloaded)), "a reload agrees");
      reloaded.unmount();
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. AUTOMATIC COMPLETION — the whole-report AI resave commits, the answer is lost
// ---------------------------------------------------------------------------------------------------------------------

for (const variant of ["poll exhausted", "poll still running"]) {
  test(`AUTOMATIC COMPLETION, COMMIT + LOST RESPONSE (${variant}): the room reaches ready from the server's own answer — one model run, one AI save, one write`, async (t) => {
    await scenario(async ({ account, b, room }) => {
      const host = await mount(account, room);
      assert.ok(uploadPanelOf(host.tree), "starting state: empty room with the upload panel");
      const id = await upload(host, account, "complete-held");
      assert.equal(uiOf(host).aiTile, "···Analyzing…", "after the first save the room is processing while the model runs");
      if (variant === "poll exhausted") {
        await runTimers({ until: () => uiOf(host).exhausted, max: 60 });
        assert.equal(uiOf(host).exhausted, true, "the bounded poll gave up while the model was still running (a slow model download)");
      }
      const before = await serverState(id);
      assert.equal(before.aiStatus, "processing");
      await env.client.execute("DELETE FROM test_ai_write_log");

      const fault = b.fault("POST /api/reports", "drop-after-commit", () => serverState(id));
      const mark = b.log.length;
      worker.held.shift()(); // the model finishes
      await waitFor(() => host.toasts.includes(AUTO_SAVE_FAILED) || isReadyUi(uiOf(host)), "the automatic save to settle");
      const requests = requestsSince(b, mark);
      const server = await serverState(id);
      const ui = uiOf(host);
      const serverRoom = await findRoomOccupant(env.client, account.userId, room);
      capture(t, `automatic/${variant}`, {
        AI_MODEL_EXECUTIONS: worker.runs.length, AI_SAVE_REQUESTS: requests.aiSaves, SUCCESSFUL_SERVER_WRITES: await writesFor(id),
        RECONCILIATION_READS: requests.roomReads, server: server.aiStatus, serverRoom: serverRoom.status,
        local: await localAiStatus(id, b), ui, toasts: host.toasts, similarityChangedByAiResave: server.similarity !== before.similarity,
      });

      assert.equal(worker.runs.length, 1, "AI_MODEL_EXECUTIONS = 1");
      assert.deepEqual(requests.aiSaves, ["200->drop-after-commit"], "AI_SAVE_REQUESTS = 1 (and it committed)");
      assert.deepEqual(await writesFor(id), ["ready/complete"], "SUCCESSFUL_SERVER_WRITES = 1");
      assert.deepEqual(requests.roomReads, [200], "RECONCILIATION_READS = 1");
      assert.equal(server.aiStatus, "ready");
      assert.deepEqual(server, fault.committed, "the reconciliation wrote nothing: the row (similarity included) is exactly as the lost save committed it");
      assert.equal(serverRoom.status, "ready");
      assert.ok(isReadyUi(ui), `client final state: ready (${JSON.stringify(ui)})`);
      assert.ok(ui.aiTile.startsWith(`${serverRoom.report.aiScore}%`), "the AI tile shows the server's canonical score");
      assert.ok(!host.toasts.includes(AUTO_SAVE_FAILED), "no false 'could not be saved'");
      assert.equal(await localAiStatus(id, b), "complete");

      await runTimers({ max: 20 });
      assert.equal(worker.runs.length, 1, "SECOND model run = 0");
      assert.deepEqual(requestsSince(b, mark).aiSaves, ["200->drop-after-commit"], "SECOND_AI_SAVE = 0");
      assert.deepEqual(await writesFor(id), ["ready/complete"]);
      assert.ok(isReadyUi(uiOf(host)), "still ready");
      host.unmount();
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. TRUE SERVER SAVE FAILURE — nothing was committed
// ---------------------------------------------------------------------------------------------------------------------

/** Makes the next AI write of report `id` fail INSIDE the server (the route's transaction aborts: a real 500, nothing committed). */
async function abortAiWritesOf(id) {
  await env.client.execute(`CREATE TRIGGER test_abort_ai_write BEFORE UPDATE OF ai_status ON saved_reports WHEN NEW.id = '${id}' BEGIN SELECT RAISE(ABORT, 'injected write failure'); END`);
  return () => env.client.execute("DROP TRIGGER IF EXISTS test_abort_ai_write");
}

test("TRUE SERVER FAILURE, MANUAL RETRY (the server's write aborts -> real 500): the read says not ready, the room stays failed, nothing was written", async (t) => {
  await scenario(async ({ account, b, room }) => {
    const id = await seedRoom(account, b, { room, analysis: "failed" });
    const before = await serverState(id);
    const host = await mount(account, room);
    const restore = await abortAiWritesOf(id);
    try {
      worker.script.push("complete");
      const mark = b.log.length;
      await clickRetry(host);
      const requests = requestsSince(b, mark);
      capture(t, "true-failure/manual-500", { AI_MODEL_EXECUTIONS: worker.runs.length, AI_SAVE_REQUESTS: requests.aiSaves, SUCCESSFUL_SERVER_WRITES: await writesFor(id), RECONCILIATION_READS: requests.roomReads, ui: uiOf(host) });
      assert.equal(worker.runs.length, 1);
      assert.deepEqual(requests.aiSaves, [500], "a real server error");
      assert.deepEqual(await writesFor(id), [], "SUCCESSFUL_SERVER_WRITES = 0");
      assert.deepEqual(requests.roomReads, [200], "a 5xx is ambiguous: the room is read once");
      assert.equal((await findRoomOccupant(env.client, account.userId, room)).status, "failed", "the authoritative read is not ready");
      const ui = uiOf(host);
      assert.equal(ui.toast, RETRY_SAVE_FAILED, "the failure is reported as before");
      assert.ok(!isReadyUi(ui), "no false ready");
      assert.equal(ui.retryOffered, true, "Retry stays offered");
      assert.deepEqual(await serverState(id), before, "server unchanged");
    } finally {
      await restore();
    }
    host.unmount();
  });
});

test("CONFIRMED SERVER FAILURE, MANUAL RETRY (session revoked -> real 401): a definite refusal is not reconciled at all, the room stays failed", async (t) => {
  await scenario(async ({ account, b, room }) => {
    const id = await seedRoom(account, b, { room, analysis: "failed" });
    const before = await serverState(id);
    const host = await mount(account, room);
    await env.client.execute({ sql: "DELETE FROM sessions WHERE user_id = ?", args: [account.userId] });
    worker.script.push("complete");
    const mark = b.log.length;
    await clickRetry(host);
    const requests = requestsSince(b, mark);
    capture(t, "confirmed-failure/manual-401", { AI_MODEL_EXECUTIONS: worker.runs.length, AI_SAVE_REQUESTS: requests.aiSaves, SUCCESSFUL_SERVER_WRITES: await writesFor(id), RECONCILIATION_READS: requests.roomReads, ui: uiOf(host) });
    assert.equal(worker.runs.length, 1);
    assert.deepEqual(requests.aiSaves, [401]);
    assert.deepEqual(await writesFor(id), [], "SUCCESSFUL_SERVER_WRITES = 0");
    assert.deepEqual(requests.roomReads, [], "a 4xx is a definite refusal: no reconciliation read");
    assert.equal(uiOf(host).toast, RETRY_SAVE_FAILED);
    assert.ok(!isReadyUi(uiOf(host)));
    assert.equal(uiOf(host).retryOffered, true);
    assert.deepEqual(await serverState(id), before);
    host.unmount();
  });
});

test("TRUE SERVER FAILURE, AUTOMATIC COMPLETION (the whole-report write aborts -> real 500): the read says processing, the room stays processing with the existing message", async (t) => {
  await scenario(async ({ account, b, room }) => {
    const host = await mount(account, room);
    const id = await upload(host, account, "complete-held");
    await runTimers({ until: () => uiOf(host).exhausted, max: 60 });
    const before = await serverState(id);
    await env.client.execute("DELETE FROM test_ai_write_log");
    const restore = await abortAiWritesOf(id);
    try {
      const mark = b.log.length;
      worker.held.shift()();
      await waitFor(() => host.toasts.includes(AUTO_SAVE_FAILED) || isReadyUi(uiOf(host)), "the automatic save to settle");
      const requests = requestsSince(b, mark);
      capture(t, "true-failure/automatic-500", { AI_MODEL_EXECUTIONS: worker.runs.length, AI_SAVE_REQUESTS: requests.aiSaves, SUCCESSFUL_SERVER_WRITES: await writesFor(id), RECONCILIATION_READS: requests.roomReads, ui: uiOf(host) });
      assert.equal(worker.runs.length, 1);
      assert.deepEqual(requests.aiSaves, [500]);
      assert.deepEqual(await writesFor(id), [], "SUCCESSFUL_SERVER_WRITES = 0");
      assert.deepEqual(requests.roomReads, [200], "ambiguous -> one read");
      assert.equal((await serverState(id)).aiStatus, "processing");
      assert.deepEqual(await serverState(id), before);
      assert.ok(host.toasts.includes(AUTO_SAVE_FAILED), "the existing message");
      assert.ok(!isReadyUi(uiOf(host)), "no false ready");
      assert.equal(uiOf(host).aiTile, "···Analyzing…", "still processing");
    } finally {
      await restore();
    }
    host.unmount();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. LOST RESPONSE + SERVER STILL PROCESSING
// ---------------------------------------------------------------------------------------------------------------------

test("LOST RESPONSE + SERVER STILL PROCESSING, AUTOMATIC (the request never arrived): no false ready, no re-run from the reconciliation; the existing Retry still recovers", async (t) => {
  await scenario(async ({ account, b, room }) => {
    const host = await mount(account, room);
    const id = await upload(host, account, "complete-held");
    await runTimers({ until: () => uiOf(host).exhausted, max: 60 });
    const before = await serverState(id);
    await env.client.execute("DELETE FROM test_ai_write_log");
    b.fault("POST /api/reports", "network");
    const mark = b.log.length;
    worker.held.shift()();
    await waitFor(() => host.toasts.includes(AUTO_SAVE_FAILED) || isReadyUi(uiOf(host)), "the automatic save to settle");
    const requests = requestsSince(b, mark);
    capture(t, "processing/automatic-network", { AI_MODEL_EXECUTIONS: worker.runs.length, AI_SAVE_REQUESTS: requests.aiSaves, SUCCESSFUL_SERVER_WRITES: await writesFor(id), RECONCILIATION_READS: requests.roomReads, ui: uiOf(host) });
    assert.equal(worker.runs.length, 1);
    assert.deepEqual(requests.aiSaves, ["FAULT:network"]);
    assert.deepEqual(await writesFor(id), []);
    assert.deepEqual(requests.roomReads, [200], "ambiguous -> one read, which says processing");
    assert.equal((await serverState(id)).aiStatus, "processing");
    assert.ok(host.toasts.includes(AUTO_SAVE_FAILED));
    assert.ok(!isReadyUi(uiOf(host)), "no false ready");
    assert.equal(uiOf(host).retryOffered, true, "the processing room's Retry is offered as before");

    // The customer's explicit Retry (not the reconciliation) is the one further model run; it persists (851b35a behaviour).
    worker.script.push("complete");
    await clickRetry(host);
    assert.equal(worker.runs.length, 2);
    assert.deepEqual(await writesFor(id), ["ready/complete"]);
    assert.equal((await serverState(id)).similarity, before.similarity);
    assert.ok(isReadyUi(uiOf(host)) || uiOf(host).aiTile?.match(/^\d+%/), "Retry recovers the room");
    host.unmount();
  });
});

test("LOST RESPONSE + SERVER STILL PROCESSING, MANUAL RETRY (poll-exhausted processing room, request never arrived): no false ready", async (t) => {
  await scenario(async ({ account, b, room }) => {
    const id = await seedRoom(account, b, { room, analysis: "processing" });
    const before = await serverState(id);
    const host = await mount(account, room);
    await runTimers({ until: () => uiOf(host).retryOffered, max: 60 });
    assert.equal(uiOf(host).retryOffered, true);
    worker.script.push("complete");
    b.fault("POST /api/reports/:id/ai-retry", "network");
    const mark = b.log.length;
    await clickRetry(host);
    const requests = requestsSince(b, mark);
    capture(t, "processing/manual-network", { AI_MODEL_EXECUTIONS: worker.runs.length, AI_SAVE_REQUESTS: requests.aiSaves, SUCCESSFUL_SERVER_WRITES: await writesFor(id), RECONCILIATION_READS: requests.roomReads, ui: uiOf(host) });
    assert.equal(worker.runs.length, 1);
    assert.deepEqual(requests.aiSaves, ["FAULT:network"]);
    assert.deepEqual(await writesFor(id), []);
    assert.deepEqual(requests.roomReads, [200]);
    assert.equal(uiOf(host).toast, RETRY_SAVE_FAILED);
    assert.ok(!isReadyUi(uiOf(host)));
    assert.equal(uiOf(host).aiTile, "···Analyzing…");
    assert.deepEqual(await serverState(id), before);
    host.unmount();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 5. LOST RESPONSE + SERVER FAILED
// ---------------------------------------------------------------------------------------------------------------------

test("LOST RESPONSE + SERVER FAILED, MANUAL RETRY (request never arrived): the read says failed, the room stays failed with Retry", async (t) => {
  await scenario(async ({ account, b, room }) => {
    const id = await seedRoom(account, b, { room, analysis: "failed" });
    const before = await serverState(id);
    const host = await mount(account, room);
    worker.script.push("complete");
    b.fault("POST /api/reports/:id/ai-retry", "network");
    const mark = b.log.length;
    await clickRetry(host);
    const requests = requestsSince(b, mark);
    capture(t, "failed/manual-network", { AI_MODEL_EXECUTIONS: worker.runs.length, AI_SAVE_REQUESTS: requests.aiSaves, SUCCESSFUL_SERVER_WRITES: await writesFor(id), RECONCILIATION_READS: requests.roomReads, ui: uiOf(host) });
    assert.equal(worker.runs.length, 1);
    assert.deepEqual(requests.aiSaves, ["FAULT:network"]);
    assert.deepEqual(await writesFor(id), []);
    assert.deepEqual(requests.roomReads, [200]);
    assert.equal(uiOf(host).toast, RETRY_SAVE_FAILED);
    assert.ok(!isReadyUi(uiOf(host)), "no false ready");
    assert.equal(uiOf(host).retryOffered, true);
    assert.deepEqual(await serverState(id), before);
    host.unmount();
  });
});

test("LOST RESPONSE + SERVER FAILED, MANUAL RETRY (the model failed again and that failed result committed): not ready -> the existing failure behaviour", async (t) => {
  await scenario(async ({ account, b, room }) => {
    const id = await seedRoom(account, b, { room, analysis: "failed" });
    const before = await serverState(id);
    const host = await mount(account, room);
    worker.script.push("error");
    b.fault("POST /api/reports/:id/ai-retry", "drop-after-commit");
    const mark = b.log.length;
    await clickRetry(host);
    const requests = requestsSince(b, mark);
    capture(t, "failed/manual-error-drop", { AI_MODEL_EXECUTIONS: worker.runs.length, AI_SAVE_REQUESTS: requests.aiSaves, SUCCESSFUL_SERVER_WRITES: await writesFor(id), RECONCILIATION_READS: requests.roomReads, ui: uiOf(host) });
    assert.equal(worker.runs.length, 1);
    assert.deepEqual(requests.aiSaves, ["200->drop-after-commit"]);
    assert.deepEqual(await writesFor(id), ["failed/error"]);
    assert.deepEqual(requests.roomReads, [200]);
    assert.equal((await serverState(id)).aiStatus, "failed");
    assert.equal((await serverState(id)).similarity, before.similarity);
    assert.equal(uiOf(host).toast, RETRY_SAVE_FAILED);
    assert.ok(!isReadyUi(uiOf(host)), "no false ready");
    assert.equal(uiOf(host).retryOffered, true);
    host.unmount();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 6. NORMAL SUCCESS — unchanged, and never reconciled
// ---------------------------------------------------------------------------------------------------------------------

test("NORMAL SUCCESS, MANUAL RETRY: one run, one save, one write, 'AI analysis complete.', no reconciliation read", async (t) => {
  await scenario(async ({ account, b, room }) => {
    const id = await seedRoom(account, b, { room, analysis: "failed" });
    const before = await serverState(id);
    const host = await mount(account, room);
    worker.script.push("complete");
    const mark = b.log.length;
    await clickRetry(host);
    const requests = requestsSince(b, mark);
    capture(t, "success/manual", { AI_MODEL_EXECUTIONS: worker.runs.length, AI_SAVE_REQUESTS: requests.aiSaves, SUCCESSFUL_SERVER_WRITES: await writesFor(id), RECONCILIATION_READS: requests.roomReads, ui: uiOf(host) });
    assert.equal(worker.runs.length, 1);
    assert.deepEqual(requests.aiSaves, [200]);
    assert.deepEqual(await writesFor(id), ["ready/complete"]);
    assert.deepEqual(requests.roomReads, [], "no reconciliation read after a confirmed success");
    assert.equal(uiOf(host).toast, RETRY_COMPLETE);
    assert.equal(uiOf(host).retryOffered, false);
    assert.equal((await serverState(id)).similarity, before.similarity);
    host.unmount();
  });
});

test("NORMAL SUCCESS, AUTOMATIC COMPLETION: one run, one AI save, one write, the room's AI tile is ready, no reconciliation read, no failure message", async (t) => {
  await scenario(async ({ account, b, room }) => {
    const host = await mount(account, room);
    const id = await upload(host, account, "complete-held");
    await env.client.execute("DELETE FROM test_ai_write_log");
    const mark = b.log.length;
    worker.held.shift()();
    await waitFor(() => /^\d+%/.test(uiOf(host).aiTile ?? "") || host.toasts.includes(AUTO_SAVE_FAILED), "the automatic save to settle");
    const requests = requestsSince(b, mark);
    capture(t, "success/automatic", { AI_MODEL_EXECUTIONS: worker.runs.length, AI_SAVE_REQUESTS: requests.aiSaves, SUCCESSFUL_SERVER_WRITES: await writesFor(id), RECONCILIATION_READS: requests.roomReads, ui: uiOf(host) });
    assert.equal(worker.runs.length, 1);
    assert.deepEqual(requests.aiSaves, [200]);
    assert.deepEqual(await writesFor(id), ["ready/complete"]);
    assert.deepEqual(requests.roomReads, [], "no reconciliation read after a confirmed success");
    assert.match(uiOf(host).aiTile, /^\d+%/);
    assert.ok(!host.toasts.includes(AUTO_SAVE_FAILED));
    assert.equal((await serverState(id)).aiStatus, "ready");
    // The existing poll then reveals the room from the server, exactly as before.
    await runTimers({ until: () => isReadyUi(uiOf(host)), max: 20 });
    assert.ok(isReadyUi(uiOf(host)));
    host.unmount();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// H. The save's answer is lost AND the reconciliation read fails
// ---------------------------------------------------------------------------------------------------------------------

test("AUTHORITATIVE READ FAILURE, MANUAL RETRY: no false success, no second run, no second save; a reload recovers", async (t) => {
  await scenario(async ({ account, b, room }) => {
    const id = await seedRoom(account, b, { room, analysis: "failed" });
    const host = await mount(account, room);
    worker.script.push("complete");
    b.fault("POST /api/reports/:id/ai-retry", "drop-after-commit");
    b.fault("GET /api/reports?room", "network");
    const mark = b.log.length;
    await clickRetry(host);
    const requests = requestsSince(b, mark);
    capture(t, "read-failure/manual", { AI_MODEL_EXECUTIONS: worker.runs.length, AI_SAVE_REQUESTS: requests.aiSaves, SUCCESSFUL_SERVER_WRITES: await writesFor(id), RECONCILIATION_READS: requests.roomReads, ui: uiOf(host) });
    assert.equal(worker.runs.length, 1);
    assert.deepEqual(requests.aiSaves, ["200->drop-after-commit"]);
    assert.deepEqual(await writesFor(id), ["ready/complete"], "the save did commit");
    assert.deepEqual(requests.roomReads, ["FAULT:network"], "one read, which failed — no loop");
    assert.equal(uiOf(host).toast, RETRY_SAVE_FAILED, "no false success: the existing failure message");
    assert.ok(!isReadyUi(uiOf(host)));
    assert.equal(uiOf(host).retryOffered, true);

    // The existing recovery paths: a same-tab Retry is told the truth from the server's copy (no run, no save) ...
    worker.script.push("error");
    await clickRetry(host);
    assert.equal(uiOf(host).toast, ALREADY_COMPLETE);
    assert.equal(worker.runs.length, 1, "no second model run");
    assert.deepEqual(requestsSince(b, mark).aiSaves, ["200->drop-after-commit"], "no second save");
    assert.deepEqual(await writesFor(id), ["ready/complete"]);
    host.unmount();
    // ... and a reload shows the ready room.
    const reloaded = await mount(account, room);
    assert.ok(isReadyUi(uiOf(reloaded)));
    reloaded.unmount();
  });
});

test("AUTHORITATIVE READ FAILURE, AUTOMATIC COMPLETION: no false success; 'Check again' (the existing poll) then reveals the ready room", async (t) => {
  await scenario(async ({ account, b, room }) => {
    const host = await mount(account, room);
    const id = await upload(host, account, "complete-held");
    await runTimers({ until: () => uiOf(host).exhausted, max: 60 });
    await env.client.execute("DELETE FROM test_ai_write_log");
    b.fault("POST /api/reports", "drop-after-commit");
    b.fault("GET /api/reports?room", "network");
    const mark = b.log.length;
    worker.held.shift()();
    await waitFor(() => host.toasts.includes(AUTO_SAVE_FAILED) || isReadyUi(uiOf(host)), "the automatic save to settle");
    const requests = requestsSince(b, mark);
    capture(t, "read-failure/automatic", { AI_MODEL_EXECUTIONS: worker.runs.length, AI_SAVE_REQUESTS: requests.aiSaves, SUCCESSFUL_SERVER_WRITES: await writesFor(id), RECONCILIATION_READS: requests.roomReads, ui: uiOf(host) });
    assert.equal(worker.runs.length, 1);
    assert.deepEqual(requests.aiSaves, ["200->drop-after-commit"]);
    assert.deepEqual(await writesFor(id), ["ready/complete"]);
    assert.deepEqual(requests.roomReads, ["FAULT:network"]);
    assert.ok(host.toasts.includes(AUTO_SAVE_FAILED));
    assert.ok(!isReadyUi(uiOf(host)));
    let checkAgain = null;
    for (const el of walk(host.tree)) if (el.type === "button" && textOf(el.props.children) === "Check again") checkAgain = el;
    assert.ok(checkAgain, "the exhausted room offers Check again");
    checkAgain.props.onClick();
    await settle();
    await runTimers({ until: () => isReadyUi(uiOf(host)), max: 20 });
    assert.ok(isReadyUi(uiOf(host)), "the existing poll reveals the ready room");
    assert.equal(worker.runs.length, 1);
    assert.deepEqual(await writesFor(id), ["ready/complete"]);
    host.unmount();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 10. Concurrency guard
// ---------------------------------------------------------------------------------------------------------------------

test("DOUBLE CLICK during a lost-response Retry: the busy guard (held through the reconciliation) admits exactly one run and one save", async (t) => {
  await scenario(async ({ account, b, room }) => {
    const id = await seedRoom(account, b, { room, analysis: "failed" });
    const host = await mount(account, room);
    worker.script.push("complete", "complete");
    b.fault("POST /api/reports/:id/ai-retry", "drop-after-commit");
    const mark = b.log.length;
    const first = retryButtonOf(host.tree).props.onClick();
    await Promise.resolve();
    const second = retryButtonOf(host.tree);
    assert.equal(second.props.disabled, true, "Retry is disabled while one is running");
    await second.props.onClick();
    await first;
    await settle();
    const requests = requestsSince(b, mark);
    capture(t, "double-click/manual-drop", { AI_MODEL_EXECUTIONS: worker.runs.length, AI_SAVE_REQUESTS: requests.aiSaves, SUCCESSFUL_SERVER_WRITES: await writesFor(id), RECONCILIATION_READS: requests.roomReads, ui: uiOf(host) });
    assert.equal(worker.runs.length, 1);
    assert.deepEqual(requests.aiSaves, ["200->drop-after-commit"]);
    assert.deepEqual(await writesFor(id), ["ready/complete"]);
    assert.ok(isReadyUi(uiOf(host)));
    host.unmount();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Units: the ambiguity classification, and the reconciliation decision
// ---------------------------------------------------------------------------------------------------------------------

const SUMMARY = (overrides = {}) => ({ id: "unit-1", submissionId: "s", title: "t", createdAt: new Date().toISOString(), wordCount: 100, archiveScore: 0, scoreBand: "Low", aiScore: 7, aiTone: "low", aiStatus: "ready", similarityStatus: "pending", ...overrides });
const UNIT_REPORT = () => ({ id: "unit-1", text: TEXT.slice(0, 2_000), aiScore: 7, aiAnalysis: { status: "complete", score: 7, model: "m", engine: null, threshold: 0.7, eligibleWordCount: 300, analyzedWordCount: 300, passages: [] } });
const failure = (status) => ({ ok: false, status, quotaExceeded: status === 429, roomOccupied: status === 409, roomReuseNotReady: false });

test("UNIT: a failed AI save is AMBIGUOUS exactly when the server may have committed it (no response, 5xx, unexpected throw) — every 4xx is definite, a success carries no flag", async () => {
  for (const status of [0, 500, 502, 503, 504]) {
    const retry = await persistAiRetryResult(UNIT_REPORT(), SUMMARY(), async () => failure(status));
    assert.deepEqual({ ok: retry.ok, ambiguous: retry.ambiguous }, { ok: false, ambiguous: true }, `retry ${status}`);
    const auto = await persistAiCompletion(UNIT_REPORT(), SUMMARY(), 1, async () => failure(status), async () => { throw new Error("narrow route must not be called"); });
    assert.deepEqual({ ok: auto.ok, ambiguous: auto.ambiguous }, { ok: false, ambiguous: true }, `automatic ${status}`);
  }
  for (const status of [400, 401, 403, 404, 409, 413, 429]) {
    const retry = await persistAiRetryResult(UNIT_REPORT(), SUMMARY(), async () => failure(status));
    assert.equal(retry.ok, false);
    assert.equal(retry.ambiguous, undefined, `retry ${status} is a definite refusal`);
  }
  for (const status of [400, 401, 403, 404, 409, 429]) {
    const auto = await persistAiCompletion(UNIT_REPORT(), SUMMARY(), 1, async () => failure(status));
    assert.equal(auto.ambiguous, undefined, `automatic ${status} is a definite refusal`);
  }
  // The automatic 413 fallback: the narrow route's own answer decides.
  const too = async () => failure(413);
  assert.equal((await persistAiCompletion(UNIT_REPORT(), SUMMARY(), 1, too, async () => failure(0))).ambiguous, true, "413 -> narrow route lost");
  assert.equal((await persistAiCompletion(UNIT_REPORT(), SUMMARY(), 1, too, async () => failure(502))).ambiguous, true, "413 -> narrow route 5xx");
  assert.equal((await persistAiCompletion(UNIT_REPORT(), SUMMARY(), 1, too, async () => failure(400))).ambiguous, undefined, "413 -> narrow route 400");
  // An unexpected throw: the outcome is unknown.
  assert.equal((await persistAiRetryResult(UNIT_REPORT(), SUMMARY(), async () => { throw new Error("boom"); })).ambiguous, true);
  assert.equal((await persistAiCompletion(UNIT_REPORT(), SUMMARY(), 1, async () => { throw new Error("boom"); })).ambiguous, true);
  // Nothing sent (not a terminal status) is definite.
  assert.equal((await persistAiRetryResult(UNIT_REPORT(), SUMMARY({ aiStatus: "processing" }), async () => failure(0))).ambiguous, undefined);
  // Success is unchanged: exactly { ok: true, summary }.
  const summary = SUMMARY();
  assert.deepEqual(await persistAiRetryResult(UNIT_REPORT(), summary, async () => ({ ok: true })), { ok: true, summary });
  assert.deepEqual(await persistAiCompletion(UNIT_REPORT(), summary, 1, async () => ({ ok: true })), { ok: true, summary });
});

test("UNIT: reconciledAiSaveOccupant adopts ONLY a server answer that says THIS report's AI is ready", () => {
  assert.equal(typeof roomShell.reconciledAiSaveOccupant, "function", "the reconciliation decision is exported for tests");
  const report = (id, extra = {}) => ({ ...SUMMARY({ id }), ...extra });
  const ok = (status, id) => ({ ok: true, contents: { status, report: report(id), cycleEndsAt: "2026-09-28T00:00:00.000Z" } });
  assert.deepEqual(roomShell.reconciledAiSaveOccupant(ok("ready", "r1"), "r1"), ok("ready", "r1").contents);
  for (const status of ["processing", "failed"]) assert.equal(roomShell.reconciledAiSaveOccupant(ok(status, "r1"), "r1"), null, status);
  assert.equal(roomShell.reconciledAiSaveOccupant({ ok: true, contents: { status: "empty", report: null, cycleEndsAt: null } }, "r1"), null, "empty");
  assert.equal(roomShell.reconciledAiSaveOccupant(ok("ready", "other"), "r1"), null, "another report in the room");
  assert.equal(roomShell.reconciledAiSaveOccupant({ ok: false, status: null }, "r1"), null, "the read itself failed");
  assert.equal(roomShell.reconciledAiSaveOccupant({ ok: false, status: 503 }, "r1"), null, "the read was refused");
  // Similarity pending on the server does not block adopting a ready AI half (the poll then continues for similarity).
  const pendingSimilarity = { ok: true, contents: { status: "ready", report: report("r1", { similarityStatus: "pending" }), cycleEndsAt: "x" } };
  assert.equal(roomShell.reconciledAiSaveOccupant(pendingSimilarity, "r1"), pendingSimilarity.contents);
});
