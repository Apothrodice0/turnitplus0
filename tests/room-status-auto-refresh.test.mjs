import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import React from "react";
import { createMemoryIndexedDb, createMemoryLocalStorage } from "./helpers/memory-indexeddb.mjs";
import * as fx from "./helpers/large-report-retry-fixture.mjs";
import { synthProse } from "./helpers/real-ai-windows.mjs";
import * as aiRetryRoute from "../app/api/reports/[id]/ai-retry/route.ts";
import * as archiveMatchRoute from "../app/api/archive/match/route.ts";
import { seedArchiveDocument } from "../lib/archive-corpus-seed.ts";
import { rebuildArchiveScalableIndex } from "../lib/archive-index-build.ts";
import { accountLocalReportOwner } from "../lib/report-store.ts";
import { findRoomOccupant } from "../lib/reports-repo.ts";

register("./helpers/ssr-next-hooks.mjs", import.meta.url);

/**
 * ROOM STATUS AUTO-REFRESH (Preview Room 8, 2026-10-09).
 *
 * THE DEFECT. On the live 597-unit Preview, Room 8 (submission 1549043485) stayed at "AI 0% · Similarity Calculating… ·
 * Receipt Preparing…" although the server row was complete (23 %, AI ready) — only a full reload showed it. The Preview request
 * log: first save 12:30:42; the bounded completion poll (10 x 3 s) ran out at 12:31:26 while the in-browser model was still
 * downloading; two "Check again" clicks bought two more 10-read budgets (12:33:46 -> 12:35:01), each spent on "processing"
 * answers; the AI save landed at 12:35:07 — five seconds after the last budget ran out — and set the room to AI ready with
 * similarity forced to "pending" (only a fresh server read may resolve it). Nothing read the server again: zero room reads until
 * the reload at 12:36:38. A manual "Retry analysis" pressed while waiting also ran the model a second time (an ai-retry save
 * 12 ms after the automatic one).
 *
 * THE FIX (room-page-shell.tsx). Every AI-result save starts a fresh completion-poll lifecycle whose first read is immediate;
 * a "processing" answer still carries the server's own similarity for the same report; Retry is busy while this tab's own
 * automatic pass runs; a room whose poll gave up gets one fresh lifecycle when the tab becomes visible again. (Caching was ruled out: every
 * Preview room read was a 200 cache MISS that reached the function; the room read stays a plain GET.)
 *
 * HOW. The REAL RoomPageShell under a minimal hook host, the REAL upload (runCheck), real routes on a throwaway migrated SQLite
 * DB (the harness of tests/ai-save-lost-response-reconciliation.test.mjs). Only the AI Worker is scripted ("-held" lets the
 * test decide WHEN the model finishes) and the clock is virtual. A server whose similarity is still being finalized is
 * simulated at the fetch boundary only (the room read's similarityStatus rewritten to "pending" while `server.similarityPending`).
 */

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

/** A minimal document for the return-to-tab path: visibilityState plus visibilitychange listeners. */
const visibility = { state: "visible", listeners: new Set() };
globalThis.document = {
  get visibilityState() { return visibility.state; },
  addEventListener(type, fn) { if (type === "visibilitychange") visibility.listeners.add(fn); },
  removeEventListener(type, fn) { if (type === "visibilitychange") visibility.listeners.delete(fn); },
};
function setVisibility(state) {
  visibility.state = state;
  for (const fn of [...visibility.listeners]) fn();
}

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

const env = await fx.createFixtureEnvironment("room_status_auto_refresh");
process.env.TURSO_DATABASE_URL = `file:${env.dbFile}`;
const restoreC2 = fx.pinCompactWrites(undefined);
const restoreAi = fx.pinAiCompactWrites(undefined);
const archiveFlagBefore = process.env.ARCHIVE_SERVER_SIDE_ENABLED;
process.env.ARCHIVE_SERVER_SIDE_ENABLED = "true";
{
  const distinctive = (ns, n) => Array.from({ length: n }, (_, i) => `zq${ns}x${i.toString(36)}w`).join(" ");
  const seeded = await seedArchiveDocument(
    env.client,
    { archiveArticleId: "auto-refresh-a", title: "Auto Refresh Archive A", originalSimilarity: null, text: distinctive(1, 600), archiveOrder: 0 },
    { corpusVersion: "auto-refresh-v1", firstSeenAt: "2020-01-01 00:00:00" },
  );
  assert.equal(seeded.status, "SEEDED");
  await rebuildArchiveScalableIndex(env.client);
}

const roomShell = await import("../app/reports/rooms/[room]/room-page-shell.tsx");

test.after(() => {
  if (archiveFlagBefore === undefined) delete process.env.ARCHIVE_SERVER_SIDE_ENABLED;
  else process.env.ARCHIVE_SERVER_SIDE_ENABLED = archiveFlagBefore;
  delete globalThis.document;
  restoreAi();
  restoreC2();
  env.dispose();
});

// --- the hook host (tests/ai-save-lost-response-reconciliation.test.mjs) ---------------------------------------------------

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
const buttonOf = (tree, pattern) => {
  for (const el of walk(tree)) if (el.type === "button" && pattern.test(textOf(el.props.children))) return el;
  return null;
};
function uploadPanelOf(tree) {
  for (const el of walk(tree)) if (typeof el.props.onGenerate === "function") return el;
  return null;
}
/** What the customer sees: status line, the three tiles, the exhausted notice, Check again, Retry. */
function uiOf(host) {
  const ui = { statusLine: null, aiTile: null, similarityTile: null, receiptTile: null, receiptEnabled: null, exhausted: false };
  for (const node of walk(host.tree)) {
    // SimilarityMetricTile is a child component the hook host does not render: render it (a pure function of its props) here.
    const el = node.type === roomShell.SimilarityMetricTile ? node.type(node.props) : node;
    const cls = el.props.className;
    const text = textOf(el.props.children);
    if (cls === "room-page-status") ui.statusLine = text;
    if (typeof cls === "string" && /^room-metric( |$)/.test(cls)) {
      if (ui.aiTile === null && text.startsWith("AI Detection")) ui.aiTile = text.slice("AI Detection".length);
      if (ui.similarityTile === null && text.startsWith("Similarity")) ui.similarityTile = text.slice("Similarity".length);
      if (ui.receiptTile === null && text.startsWith("Receipt")) { ui.receiptTile = text.slice("Receipt".length); ui.receiptEnabled = el.type === "button" && !el.props.disabled; }
    }
    if (el.type === "p" && text === "Analysis is taking longer than usual.") ui.exhausted = true;
  }
  ui.checkAgain = buttonOf(host.tree, /^Check again$/) !== null;
  const retry = buttonOf(host.tree, /Retry analysis|Checking…/);
  ui.retry = retry ? `${textOf(retry.props.children)}${retry.props.disabled ? " (disabled)" : ""}` : null;
  return ui;
}
const isReadyUi = (ui) => /^Report ready · Last checked/.test(ui.statusLine ?? "") && /^\d+%/.test(ui.aiTile ?? "") && /^\d+%/.test(ui.similarityTile ?? "") && ui.receiptTile === "Download" && ui.receiptEnabled === true;

// --- the browser's network: real routes; the server can be made to report similarity as still being finalized --------------

let roomCounter = 0;
const TEXT = synthProse(12_000, { seed: 77, messiness: 0.01 });

function browser(account) {
  window.localStorage.setItem("tp_device_key_v1", account.deviceKey);
  const route = fx.installRouteFetch(account, {
    "POST /api/reports/:id/ai-retry": aiRetryRoute.POST,
    "GET /api/archive/match": archiveMatchRoute.GET,
    "POST /api/archive/match": archiveMatchRoute.POST,
  });
  const routedFetch = globalThis.fetch;
  const server = { similarityPending: false };
  const faults = [];
  const log = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, "http://localhost");
    const method = String(init.method ?? "GET").toUpperCase();
    const roomRead = method === "GET" && url.pathname === "/api/reports" && url.searchParams.has("room");
    const key = `${method} ${url.pathname.replace(/^\/api\/reports\/\d+/, "/api/reports/:id")}${roomRead ? "?room" : ""}`;
    const entry = { key, at: clock.now, outcome: "pending", cache: init.cache ?? null };
    log.push(entry);
    const at = faults.findIndex((f) => f === key);
    if (at >= 0) {
      faults.splice(at, 1);
      entry.outcome = "FAULT:network";
      throw new TypeError("Failed to fetch");
    }
    const response = await routedFetch(input, init);
    entry.outcome = response.status;
    if (roomRead && server.similarityPending && response.ok) {
      const body = await response.json();
      if (body.report) body.report = { ...body.report, similarityStatus: "pending" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    return response;
  };
  return {
    log,
    server,
    owner: accountLocalReportOwner(account.email),
    fault(key) { faults.push(key); },
    roomReads(mark = 0) { return log.slice(mark).filter((e) => e.key === "GET /api/reports?room"); },
    aiSaves(mark = 0) { return log.slice(mark).filter((e) => e.key === "POST /api/reports" || e.key === "POST /api/reports/:id/ai-retry"); },
    restore() { route.restore(); },
  };
}

async function upload(host, account, ai) {
  worker.script.push(ai);
  uploadPanelOf(host.tree).props.onChooseFile(new File([TEXT], "auto-refresh-report.txt", { type: "text/plain" }));
  await settle();
  let finished = false;
  const running = uploadPanelOf(host.tree).props.onGenerate().then(() => { finished = true; });
  for (let i = 0; i < 4000 && !finished; i += 1) {
    await realDelay(3);
    if (!finished && i % 4 === 3) await runNextTimer();
  }
  await running;
  const rows = (await env.client.execute({ sql: "SELECT id FROM saved_reports WHERE user_id = ?", args: [account.userId] })).rows;
  assert.equal(rows.length, 1, "the upload saved exactly one report");
  return String(rows[0].id);
}

async function mount(account, room) {
  return mountRoom({ room, accountEmail: account.email, initialOccupant: await findRoomOccupant(env.client, account.userId, room) });
}

/** Releases the held model run and waits until the automatic AI save has updated the room. */
async function finishModel(host) {
  worker.held.shift()();
  await waitFor(() => /^\d+%/.test(uiOf(host).aiTile ?? ""), "the automatic AI save to land");
}

async function scenario(fn) {
  const account = await env.signUpAccount();
  const b = browser(account);
  worker.script.length = 0;
  worker.runs.length = 0;
  worker.held.length = 0;
  visibility.state = "visible";
  try {
    return await fn({ account, b, room: roomCounter++ % 10 });
  } finally {
    b.restore();
  }
}

function capture(t, label, data) {
  t.diagnostic(`CAPTURE ${label} ${JSON.stringify(data)}`);
}

const pollTimersPending = () => [...clock.timers.values()].length;

// =================================================================================================================================
// 1. The Room 8 sequence
// =================================================================================================================================

test("ROOM 8 REPRODUCTION: the poll budget runs out while the model is still running; the AI result then lands — the room reveals itself (Report ready, real similarity, Receipt) with NO click and NO reload", async (t) => {
  await scenario(async ({ account, b, room }) => {
    const host = await mount(account, room);
    const id = await upload(host, account, "complete-held");
    await runTimers({ until: () => uiOf(host).exhausted, max: 60 });
    assert.equal(uiOf(host).exhausted, true, "the bounded poll gave up while the model was still running (slow first model download)");
    assert.equal(uiOf(host).aiTile, "···Analyzing…");

    const mark = b.log.length;
    await finishModel(host);
    const afterSave = uiOf(host);
    await runTimers({ until: () => isReadyUi(uiOf(host)), max: 5 });
    const ui = uiOf(host);
    const serverRoom = await findRoomOccupant(env.client, account.userId, room);
    capture(t, "room8", { afterSave, ui, roomReadsAfterAiSave: b.roomReads(mark).length, aiSaves: b.aiSaves(mark).map((e) => e.outcome), modelRuns: worker.runs.length, server: serverRoom.status });

    assert.equal(serverRoom.status, "ready");
    assert.ok(isReadyUi(ui), `revealed without a click or reload: ${JSON.stringify(ui)}`);
    assert.equal(ui.similarityTile.startsWith(`${serverRoom.report.primaryScore ?? serverRoom.report.archiveScore}%`), true, "the server's own similarity");
    assert.equal(b.roomReads(mark).length, 1, "exactly one room read after the AI result landed (immediate, not one interval later)");
    assert.equal(b.roomReads(mark)[0].at, b.aiSaves(mark)[0].at, "the read is issued at once, not POLL_INTERVAL_MS later");
    assert.equal(worker.runs.length, 1, "one model run");
    assert.deepEqual(b.aiSaves(mark).map((e) => e.outcome), [200], "one AI save");

    const reads = b.roomReads().length;
    await runTimers({ max: 50 });
    assert.equal(b.roomReads().length, reads, "polling stops after completion");
    assert.equal(pollTimersPending(), 0, "no poll timer left scheduled");
    assert.ok(id);
    host.unmount();
  });
});

test("SIMILARITY FINISHES BEFORE AI: the server's similarity shows while the model is still running; AI and Receipt stay pending; then AI lands and the room is ready", async (t) => {
  await scenario(async ({ account, b, room }) => {
    const host = await mount(account, room);
    await upload(host, account, "complete-held");
    assert.equal(uiOf(host).similarityTile, "···Calculating…", "right after the first save: the client's own summary is never trusted");
    await runTimers({ until: () => /^\d+%/.test(uiOf(host).similarityTile ?? ""), max: 3 });
    const mid = uiOf(host);
    capture(t, "similarity-first", { mid });
    assert.match(mid.similarityTile, /^\d+%/, "the server's finalized similarity appears without waiting for AI");
    assert.equal(mid.aiTile, "···Analyzing…");
    assert.equal(mid.receiptTile, "Preparing…");
    assert.equal(mid.receiptEnabled, false);
    assert.equal(mid.statusLine, "Analysis in progress");
    await finishModel(host);
    await runTimers({ until: () => isReadyUi(uiOf(host)), max: 5 });
    assert.ok(isReadyUi(uiOf(host)), JSON.stringify(uiOf(host)));
    host.unmount();
  });
});

test("AI FINISHES BEFORE SIMILARITY: AI shows at once; similarity stays Calculating while the server is still finalizing; the room reveals itself as soon as the server resolves it", async (t) => {
  await scenario(async ({ account, b, room }) => {
    const host = await mount(account, room);
    await upload(host, account, "complete-held");
    b.server.similarityPending = true;
    await finishModel(host);
    await runTimers({ max: 3 });
    const mid = uiOf(host);
    capture(t, "ai-first", { mid });
    assert.match(mid.aiTile, /^\d+%/);
    assert.equal(mid.similarityTile, "···Calculating…");
    assert.equal(mid.receiptTile, "Preparing…");
    assert.equal(mid.statusLine, "Analysis in progress");
    assert.equal(mid.exhausted, false);
    b.server.similarityPending = false;
    await runTimers({ until: () => isReadyUi(uiOf(host)), max: 3 });
    assert.ok(isReadyUi(uiOf(host)), JSON.stringify(uiOf(host)));
    host.unmount();
  });
});

test("CHECK AGAIN AFTER A PENDING RESPONSE: a server still finalizing beyond the budget gives a recoverable 'taking longer' state (never endless Calculating); Check again reads the server immediately and reveals", async (t) => {
  await scenario(async ({ account, b, room }) => {
    const host = await mount(account, room);
    await upload(host, account, "complete-held");
    b.server.similarityPending = true;
    await finishModel(host);
    await runTimers({ until: () => uiOf(host).exhausted, max: 60 });
    const stuck = uiOf(host);
    assert.equal(stuck.exhausted, true, "bounded: the poll gives up");
    assert.equal(stuck.checkAgain, true, "Check again is offered");
    assert.equal(stuck.retry, null, "AI is ready: never a Retry for it");
    const reads = b.roomReads().length;
    await runTimers({ max: 20 });
    assert.equal(b.roomReads().length, reads, "no polling while exhausted");

    b.server.similarityPending = false;
    const mark = b.log.length;
    buttonOf(host.tree, /^Check again$/).props.onClick();
    await settle();
    await runTimers({ until: () => isReadyUi(uiOf(host)), max: 1 });
    capture(t, "check-again", { reads: b.roomReads(mark).map((e) => [e.at, e.outcome]), ui: uiOf(host) });
    assert.ok(isReadyUi(uiOf(host)), "one immediate read reveals the room");
    assert.equal(b.roomReads(mark).length, 1);
    host.unmount();
  });
});

test("BACKGROUND TAB: the budget runs out while the tab is hidden; returning to the tab starts exactly one fresh poll lifecycle and the room reveals itself", async (t) => {
  await scenario(async ({ account, b, room }) => {
    const host = await mount(account, room);
    await upload(host, account, "complete-held");
    b.server.similarityPending = true;
    setVisibility("hidden");
    await finishModel(host); // the model finishes in the background
    await runTimers({ until: () => uiOf(host).exhausted, max: 60 });
    assert.equal(uiOf(host).exhausted, true);
    b.server.similarityPending = false;
    setVisibility("hidden"); // a hidden event does nothing
    await settle();
    assert.equal(uiOf(host).exhausted, true);
    const mark = b.log.length;
    setVisibility("visible");
    await settle();
    await runTimers({ until: () => isReadyUi(uiOf(host)), max: 2 });
    capture(t, "background", { reads: b.roomReads(mark).length, ui: uiOf(host), listeners: visibility.listeners.size });
    assert.ok(isReadyUi(uiOf(host)), JSON.stringify(uiOf(host)));
    assert.equal(b.roomReads(mark).length, 1);
    assert.equal(visibility.listeners.size, 0, "the listener is gone once the room is revealed");
    host.unmount();
  });
});

test("TRANSIENT STATUS FAILURE right after the AI result lands: inconclusive, the poll keeps going and reveals on the next read", async (t) => {
  await scenario(async ({ account, b, room }) => {
    const host = await mount(account, room);
    await upload(host, account, "complete-held");
    await runTimers({ until: () => uiOf(host).exhausted, max: 60 });
    b.fault("GET /api/reports?room");
    const mark = b.log.length;
    await finishModel(host);
    await runTimers({ until: () => isReadyUi(uiOf(host)), max: 5 });
    capture(t, "transient", { reads: b.roomReads(mark).map((e) => e.outcome), ui: uiOf(host) });
    assert.deepEqual(b.roomReads(mark).map((e) => e.outcome), ["FAULT:network", 200]);
    assert.ok(isReadyUi(uiOf(host)));
    host.unmount();
  });
});

test("NO DUPLICATE AI RUN: while this tab's own automatic pass is still running, the exhausted view's Retry is busy ('Checking…', disabled) and refuses; one model run, one AI save", async (t) => {
  await scenario(async ({ account, b, room }) => {
    const host = await mount(account, room);
    await upload(host, account, "complete-held");
    await runTimers({ until: () => uiOf(host).exhausted, max: 60 });
    const ui = uiOf(host);
    assert.equal(ui.retry, "Checking… (disabled)", "Retry is busy while the automatic pass runs");
    worker.script.push("complete");
    await buttonOf(host.tree, /Checking…/).props.onClick(); // even a forced click is refused by retryAiCheck's busy guard
    await settle();
    assert.equal(worker.runs.length, 1, "no second model run");
    const mark = b.log.length;
    await finishModel(host);
    await runTimers({ until: () => isReadyUi(uiOf(host)), max: 5 });
    capture(t, "no-duplicate", { modelRuns: worker.runs.length, aiSaves: b.aiSaves(mark).map((e) => e.key) });
    assert.deepEqual(b.aiSaves(mark).map((e) => e.key), ["POST /api/reports"], "one AI save, no ai-retry");
    assert.ok(isReadyUi(uiOf(host)));
    host.unmount();
  });
});

test("AUTOMATIC PASS FAILS TO SAVE: the busy flag is released, Retry is offered again (existing recovery unchanged)", async (t) => {
  await scenario(async ({ account, b, room }) => {
    const host = await mount(account, room);
    await upload(host, account, "complete-held");
    await runTimers({ until: () => uiOf(host).exhausted, max: 60 });
    await env.client.execute({ sql: "DELETE FROM sessions WHERE user_id = ?", args: [account.userId] }); // a definite 401 refusal
    worker.held.shift()();
    await waitFor(() => host.toasts.some((m) => m.startsWith("AI analysis finished but could not be saved")), "the save failure message");
    assert.equal(uiOf(host).retry, "Retry analysis", "Retry is offered again once the automatic pass settled");
    host.unmount();
  });
});

test("NAVIGATION AWAY AND BACK: unmounting clears the poll; the detached AI save still lands; coming back (SSR read) shows the ready room with no polling", async (t) => {
  await scenario(async ({ account, b, room }) => {
    const host = await mount(account, room);
    const id = await upload(host, account, "complete-held");
    await runTimers({ max: 2 });
    host.unmount();
    assert.equal(pollTimersPending(), 0, "no timer survives the unmount");
    worker.held.shift()();
    for (let i = 0; i < 400; i += 1) {
      const row = (await env.client.execute({ sql: "SELECT ai_status FROM saved_reports WHERE id = ?", args: [id] })).rows[0];
      if (row.ai_status === "ready") break;
      await realDelay(3);
    }
    const back = await mount(account, room);
    const reads = b.roomReads().length;
    await runTimers({ max: 20 });
    assert.ok(isReadyUi(uiOf(back)), JSON.stringify(uiOf(back)));
    assert.equal(b.roomReads().length, reads, "a revealed room never polls");
    back.unmount();
  });
});

test("EXISTING COMPLETED REPORT: opens ready, no poll, no room read", async () => {
  await scenario(async ({ account, b, room }) => {
    const host = await mount(account, room);
    await upload(host, account, "complete-held");
    await finishModel(host);
    await runTimers({ until: () => isReadyUi(uiOf(host)), max: 5 });
    host.unmount();
    const reopened = await mount(account, room);
    const reads = b.roomReads().length;
    await runTimers({ max: 20 });
    assert.ok(isReadyUi(uiOf(reopened)));
    assert.equal(b.roomReads().length, reads);
    reopened.unmount();
  });
});

// =================================================================================================================================
// Unit: withServerSimilarity
// =================================================================================================================================

const summary = (o = {}) => ({ id: "r1", submissionId: "s", title: "t", createdAt: "2026-10-09T00:00:00.000Z", wordCount: 10, archiveScore: 6, scoreBand: "Moderate", aiScore: null, aiTone: null, aiStatus: "processing", similarityStatus: "pending", ...o });
const occ = (status, o) => ({ status, report: summary(o), cycleEndsAt: "2026-10-10T00:00:00.000Z" });

test("UNIT withServerSimilarity: takes ONLY the similarity fields of a processing read for the same report; never touches the AI half; same object when nothing changes", () => {
  const { withServerSimilarity } = roomShell;
  const current = occ("processing", { aiScore: null });
  const server = occ("processing", { similarityStatus: "resolved", primaryScore: 23, isUnified: true, archiveScore: 6, scoreBand: "Moderate", aiScore: 99, title: "server title" });
  const merged = withServerSimilarity(current, server);
  assert.notEqual(merged, current);
  assert.equal(merged.status, "processing");
  assert.equal(merged.report.similarityStatus, "resolved");
  assert.equal(merged.report.primaryScore, 23);
  assert.equal(merged.report.isUnified, true);
  assert.equal(merged.report.aiScore, null, "AI half untouched");
  assert.equal(merged.report.title, "t", "nothing but similarity is taken");
  assert.equal(withServerSimilarity(merged, server), merged, "unchanged answer -> same object (no re-render)");
  assert.equal(withServerSimilarity(current, occ("processing", { similarityStatus: "pending" })), current, "a pending server similarity changes nothing");
  assert.equal(withServerSimilarity(current, occ("processing", { id: "other", similarityStatus: "resolved", primaryScore: 1 })), current, "another report: never");
  const ready = occ("ready", { aiScore: 0, aiStatus: "ready" });
  assert.equal(withServerSimilarity(ready, server), ready, "a stale processing read never undoes an AI result the room already holds");
  const withheld = withServerSimilarity(current, occ("processing", { similarityStatus: "failed", archiveScore: null, scoreBand: null }));
  assert.equal(withheld.report.similarityStatus, "failed");
  assert.equal(withheld.report.archiveScore, null, "a withheld (unexplained) similarity stays withheld");
});
