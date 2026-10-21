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
 * UPLOAD PROGRESS (2026-10-20). Production: two uploads showed "100% · Saving your report" for several minutes (Room 4).
 * Root cause: the bar was a timer animated to 95 % over a random 8–15 s, then set to 100 % BEFORE the save request was sent;
 * the save had no limit and no recovery, and an empty room read "Ready for a new check" while a check was running.
 *
 * HOW. The harness of tests/room-status-auto-refresh.test.mjs (copied verbatim): the REAL RoomPageShell under a minimal hook
 * host, the REAL upload (runCheck), real routes on a throwaway migrated SQLite DB, virtual clock. Every render records the upload
 * panel props and the room status line. The save request is controlled at the fetch boundary only: held before or after the real
 * route ran, answered 500, failed at the network, or never answered (until the page aborts it).
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
/** Lets `ms` of virtual time pass: every window timer due by then runs, in order (stops early once `until()` holds). */
async function advance(ms, until = () => false) {
  const target = clock.now + ms;
  for (;;) {
    if (until()) return;
    const next = [...clock.timers.values()].sort((a, b) => a.due - b.due)[0];
    if (!next || next.due > target) break;
    await runNextTimer();
  }
  clock.now = Math.max(clock.now, target);
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

const env = await fx.createFixtureEnvironment("upload_progress_ux");
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
  const renders = [];
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
  // Child components the shell renders (SimilarityMetricTile) are rendered here too, on EVERY render, with React's identity
  // rule: the same component type at the same position in the tree keeps its hook state; anything else mounts fresh.
  const childInstances = new Map();
  const similarityHistory = [];
  function renderChild(node, path, seen) {
    let instance = childInstances.get(path);
    if (!instance || instance.type !== node.type) childInstances.set(path, (instance = { type: node.type, slots: [] }));
    seen.add(path);
    let childCursor = 0;
    const childDispatcher = {
      useRef(initial) { const i = childCursor++; if (!instance.slots[i]) instance.slots[i] = { current: initial }; return instance.slots[i]; },
      useState(initial) { const i = childCursor++; if (!instance.slots[i]) instance.slots[i] = { value: typeof initial === "function" ? initial() : initial }; return [instance.slots[i].value, () => {}]; },
      useEffect() { childCursor++; },
    };
    const previous = internals.H;
    internals.H = childDispatcher;
    try {
      return node.type(node.props);
    } finally {
      internals.H = previous;
    }
  }
  function expand(node, path, seen) {
    if (node === null || node === undefined || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((child, i) => expand(child, `${path}.${i}`, seen));
    if (node.type === roomShell.SimilarityMetricTile) {
      const out = renderChild(node, path, seen);
      similarityHistory.push({ reportId: node.props.report.id, text: textOf(out.props.children).slice("Similarity".length) });
      return out;
    }
    if (!node.props || node.props.children === undefined) return node;
    return { ...node, props: { ...node.props, children: expand(node.props.children, `${path}>`, seen) } };
  }
  function render() {
    cursor = 0;
    const previous = internals.H;
    internals.H = dispatcher;
    try {
      tree = roomShell.RoomPageShell(props);
    } finally {
      internals.H = previous;
    }
    const seen = new Set();
    tree = expand(tree, "root", seen);
    renders.push(snapshotOf(tree));
    for (const path of [...childInstances.keys()]) if (!seen.has(path)) childInstances.delete(path); // unmounted
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
    renders,
    /** The Similarity tile's text on every single render, in order (a flicker lasts exactly one render). */
    similarityHistory,
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
  for (const el of walk(host.tree)) { // host.tree already has SimilarityMetricTile rendered (mountRoom's expand)
    const cls = el.props.className;
    const text = textOf(el.props.children);
    if (cls === "room-page-status") ui.statusLine = text;
    if (typeof cls === "string" && /^room-metric( |$)/.test(cls)) {
      if (ui.aiTile === null && text.startsWith("AI writing score")) ui.aiTile = text.slice("AI writing score".length);
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
const isReadyUi = (ui) => /^Report ready · Last checked/.test(ui.statusLine ?? "") && /^\d+\/100/.test(ui.aiTile ?? "") && /^\d+%/.test(ui.similarityTile ?? "") && ui.receiptTile === "Download" && ui.receiptEnabled === true;

// --- the browser's network: real routes; the server can be made to report similarity as still being finalized --------------

let roomCounter = 0;
const TEXT = synthProse(12_000, { seed: 77, messiness: 0.01 });

import * as up from "../lib/upload-progress.ts";

// --- what each render showed: the upload panel's props and the room status line ------------------------------------------------

function snapshotOf(tree) {
  const panel = uploadPanelOf(tree);
  let status = null;
  for (const el of walk(tree)) if (el.props.className === "room-page-status") status = textOf(el.props.children);
  return {
    at: clock.now,
    status,
    panel: panel
      ? { generating: panel.props.isGeneratingReport, progress: panel.props.progress, label: panel.props.processingLabel, complete: !!panel.props.complete, failure: panel.props.saveFailure?.message ?? null }
      : null,
  };
}
const panelNow = (host) => host.renders.at(-1)?.panel ?? null;

// --- the browser's network: real routes; each save POST can be held, failed or left unanswered ---------------------------------

function browser(account) {
  window.localStorage.setItem("tp_device_key_v1", account.deviceKey);
  const route = fx.installRouteFetch(account, {
    "POST /api/reports/:id/ai-retry": aiRetryRoute.POST,
    "GET /api/archive/match": archiveMatchRoute.GET,
    "POST /api/archive/match": archiveMatchRoute.POST,
  });
  const routedFetch = globalThis.fetch;
  const log = [];
  /** One directive per upcoming POST /api/reports, consumed in order: "fail-500" | "network" | "hang" | { holdBefore } | { holdAfter }. */
  const next = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, "http://localhost");
    const method = String(init.method ?? "GET").toUpperCase();
    const roomRead = method === "GET" && url.pathname === "/api/reports" && url.searchParams.has("room");
    const isSave = method === "POST" && url.pathname === "/api/reports";
    const entry = { key: `${method} ${url.pathname}${roomRead ? "?room" : ""}`, at: clock.now, outcome: "pending", reportId: null };
    if (isSave) { try { entry.reportId = String(JSON.parse(init.body).id); } catch { entry.reportId = null; } }
    log.push(entry);
    const directive = isSave ? next.shift() : undefined;
    if (directive === "fail-500") {
      entry.outcome = 500;
      return new Response(JSON.stringify({ error: "Unable to save report. Please try again." }), { status: 500, headers: { "content-type": "application/json" } });
    }
    if (directive === "network") { entry.outcome = "FAULT:network"; throw new TypeError("Failed to fetch"); }
    if (directive === "hang") {
      entry.outcome = "HANGING";
      return new Promise((_, reject) => init.signal?.addEventListener("abort", () => { entry.outcome = "ABORTED"; reject(new DOMException("The operation was aborted.", "AbortError")); }));
    }
    if (directive?.holdBefore) await directive.holdBefore;
    const response = await routedFetch(input, init);
    entry.outcome = response.status;
    if (directive?.holdAfter) { entry.outcome = `ANSWER_HELD:${response.status}`; await directive.holdAfter; entry.outcome = response.status; }
    return response;
  };
  return {
    log,
    next,
    saves() { return log.filter((e) => e.key === "POST /api/reports"); },
    roomReads() { return log.filter((e) => e.key === "GET /api/reports?room"); },
    restore() { route.restore(); },
  };
}

const gate = () => { let open; const promise = new Promise((resolve) => { open = resolve; }); return { promise, open }; };
const rowsOf = async (account) => (await env.client.execute({ sql: "SELECT id, ai_status FROM saved_reports WHERE user_id = ?", args: [account.userId] })).rows;

/** Starts the real upload; returns a handle whose `finished` turns true when runCheck() returns. Never drives the clock itself. */
async function startUpload(host, ai = "complete") {
  worker.script.push(ai);
  uploadPanelOf(host.tree).props.onChooseFile(new File([TEXT], "upload-progress.txt", { type: "text/plain" }));
  await settle();
  const handle = { finished: false };
  handle.done = uploadPanelOf(host.tree).props.onGenerate().then(() => { handle.finished = true; });
  return handle;
}
/** Real time for the in-process routes, plus small steps of virtual time so the short "Report ready" hold can elapse. */
async function until(condition) {
  for (let i = 0; i < 4000 && !condition(); i += 1) {
    await realDelay(2);
    if (i % 10 === 9) await advance(100, condition);
  }
}
async function finish(handle) {
  await until(() => handle.finished);
  await handle.done;
}
const savingNow = (host) => panelNow(host)?.generating === true && /Saving your report|Still saving/.test(panelNow(host)?.label ?? "");

async function mount(account, room) {
  return mountRoom({ room, accountEmail: account.email, initialOccupant: await findRoomOccupant(env.client, account.userId, room) });
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

/** Invariants that must hold on EVERY render of every scenario. */
function assertHonestProgress(host) {
  for (const r of host.renders) {
    if (r.panel?.generating && !r.panel.complete) assert.ok(r.panel.progress <= up.MAX_PERCENT_BEFORE_CONFIRMED, `never 100 % before confirmed: ${JSON.stringify(r)}`);
    if (r.panel?.generating || r.panel?.failure) assert.notEqual(r.status, "Ready for a new check", `a running or unsaved check is never "Ready for a new check": ${JSON.stringify(r)}`);
  }
}

// =================================================================================================================================

test("HELPERS: one continuous bar — eases toward each stage's ceiling, slows down, never passes 95 % before confirmation; 100 % only for a confirmed check; wording", () => {
  for (const stage of ["reading", "analyzing", "matching", "finishing", "saving", "confirming"]) {
    for (const f of [0, 0.5, 1, 7]) assert.ok(up.checkStagePercent(stage, f) <= up.MAX_PERCENT_BEFORE_CONFIRMED, `${stage} ${f}`);
    assert.ok(up.CHECK_STAGE_CEILING[stage] <= up.MAX_PERCENT_BEFORE_CONFIRMED, `${stage} ceiling`);
  }
  assert.equal(up.MAX_PERCENT_BEFORE_CONFIRMED, 95);
  assert.equal(up.checkStagePercent("complete"), 100);
  assert.equal(up.displayedCheckPercent(100, false), 95);
  assert.equal(up.displayedCheckPercent(100, true), 100);
  // easing: always forward, never past the ceiling, and each step smaller than the one before (it slows down)
  let p = 60, last = Infinity;
  for (let i = 0; i < 400; i += 1) { const next = up.nextCreepValue(p, 95); assert.ok(next >= p && next <= 95); if (next - p > 0.02) { assert.ok(next - p <= last + 1e-9); last = next - p; } p = next; }
  assert.ok(p > 90 && p <= 95, `after 100 s of easing the bar is close to, never past, 95 % (${p})`);
  assert.equal(up.nextCreepValue(95, 95), 95);
  assert.equal(up.nextCreepValue(50, 15), 50, "never backwards");
  assert.deepEqual([10, 30, 70, 90, 95].map((v) => up.progressEncouragement(v, false)), ["Just getting started…", "Making good progress…", "Getting there…", "Almost there…", "Almost there…"]);
  assert.equal(up.progressEncouragement(95, true), "Report saved");
  assert.deepEqual(Object.values(up.CHECK_STAGE_LABELS), ["Reading your document", "Analyzing your document", "Checking for matching passages", "Preparing your report", "Saving your report", "Finalizing your report", "Report saved"]);
  assert.equal(up.roomHoldsReport({ ok: true, contents: { status: "processing", report: { id: "7" }, cycleEndsAt: "x" } }, "7"), true);
  assert.equal(up.roomHoldsReport({ ok: true, contents: { status: "empty", report: null, cycleEndsAt: null } }, "7"), false);
  assert.equal(up.roomHoldsReport({ ok: false, status: 500 }, "7"), false);
});

test("SUCCESS: real stages in order on one bar, 100 % 'Report saved' only once the room holds the report, then the report card; one report", async (t) => {
  await scenario(async ({ account, b, room }) => {
    const host = await mount(account, room);
    await finish(await startUpload(host));
    const labels = [...new Set(host.renders.map((r) => r.panel?.label).filter(Boolean))];
    capture(t, "success", { labels, saves: b.saves().map((e) => e.outcome), roomReads: b.roomReads().length });
    for (const l of ["Reading your document", "Analyzing your document", "Checking for matching passages", "Preparing your report", "Saving your report"]) assert.ok(labels.includes(l), `label ${l}: ${labels}`);
    assert.ok(host.renders.some((r) => r.panel?.generating && !r.panel.complete && r.panel.label === "Saving your report" && r.panel.progress < 100), "the save is shown on the same bar, below 100 %");
    const completeAt = host.renders.findIndex((r) => r.panel?.complete);
    assert.ok(completeAt >= 0, "after the room read confirms the report, the bar shows 100 % 'Report saved' (AI is still running)");
    assert.equal(host.renders[completeAt].panel.label, "Report saved");
    assert.ok(host.renders.slice(0, completeAt).every((r) => !r.panel?.generating || r.panel.progress <= up.MAX_PERCENT_BEFORE_CONFIRMED), "never above 95 % before");
    assert.ok(b.roomReads().length >= 1, "completion was confirmed by reading the room");
    assertHonestProgress(host);
    assert.equal(panelNow(host), null, "the empty-room upload panel is replaced by the report card");
    assert.equal(uiOf(host).statusLine, "Analysis in progress");
    assert.equal((await rowsOf(account)).length, 1, "exactly one report");
    host.unmount();
  });
});

test("DELAYED SAVE: while the server has not saved, the same bar keeps showing the save (never 100 %), one 'taking longer' message after 60 s, then completion when the save lands; one report", async (t) => {
  await scenario(async ({ account, b, room }) => {
    const host = await mount(account, room);
    const hold = gate();
    b.next.push({ holdBefore: hold.promise });
    const upload = await startUpload(host);
    await waitFor(() => savingNow(host), "the saving stage");
    assert.equal(uiOf(host).statusLine, "Check in progress");
    await advance(up.SAVE_SLOW_AFTER_MS + 1);
    assert.equal(panelNow(host).label, up.SLOW_SAVE_LABEL, "one honest 'taking longer' message");
    assert.ok(panelNow(host).progress <= up.MAX_PERCENT_BEFORE_CONFIRMED, "the bar is still below 100 %");
    assert.equal((await rowsOf(account)).length, 0, "nothing saved yet");
    const readsWhileWaiting = b.roomReads().length;
    assert.ok(readsWhileWaiting >= 15 && readsWhileWaiting <= 22, `the room was read only by the existing 3 s check (${readsWhileWaiting} reads in 60 s)`);
    hold.open();
    await finish(upload);
    capture(t, "delayed", { roomReads: readsWhileWaiting, saves: b.saves().map((e) => e.outcome) });
    assertHonestProgress(host);
    assert.equal((await rowsOf(account)).length, 1, "exactly one report");
    assert.equal(uiOf(host).statusLine, "Analysis in progress");
    host.unmount();
  });
});

test("SERVER SAVED, ANSWER LATE: the room read shows the report while the save answer is outstanding — the page proceeds (AI starts, report card) without waiting; the late answer creates nothing", async (t) => {
  await scenario(async ({ account, b, room }) => {
    const host = await mount(account, room);
    const hold = gate();
    b.next.push({ holdAfter: hold.promise });
    const upload = await startUpload(host);
    await waitFor(() => savingNow(host), "the saving stage");
    for (let i = 0; i < 2000 && (await rowsOf(account)).length === 0; i += 1) await realDelay(2);
    assert.equal((await rowsOf(account)).length, 1, "the server has written the report; its answer is held");
    await advance(roomShell.POLL_INTERVAL_MS + 1, () => upload.finished);
    await until(() => upload.finished);
    assert.equal(upload.finished, true, "the check finished without the save answer");
    assert.equal(b.saves()[0].outcome, "ANSWER_HELD:200");
    assert.equal(uiOf(host).statusLine, "Analysis in progress");
    hold.open();
    await realDelay(20);
    capture(t, "late-answer", { saves: b.saves().map((e) => e.outcome) });
    assertHonestProgress(host);
    assert.equal((await rowsOf(account)).length, 1, "exactly one report");
    assert.ok(b.saves().every((e) => e.reportId === b.saves()[0].reportId), "every save request is for the same report");
    host.unmount();
  });
});

test("SAVE FAILURE + RETRY: a rejected save is said plainly (no spinner, no 100 %); 'Try saving again' re-sends the SAME report — no re-analysis, exactly one report", async (t) => {
  await scenario(async ({ account, b, room }) => {
    const host = await mount(account, room);
    b.next.push("fail-500");
    await finish(await startUpload(host));
    assert.equal(panelNow(host).failure, roomShell.SAVE_FAILED_MESSAGE);
    assert.equal(panelNow(host).generating, false, "no endless spinner");
    assert.equal(uiOf(host).statusLine, "Report not saved yet");
    assert.equal((await rowsOf(account)).length, 0);
    const modelRunsBefore = worker.runs.length;
    uploadPanelOf(host.tree).props.saveFailure.onRetry();
    await until(() => panelNow(host) === null);
    assert.equal(panelNow(host), null, "the retried save landed");
    capture(t, "retry", { saves: b.saves().map((e) => `${e.outcome}:${e.reportId}`) });
    assertHonestProgress(host);
    const rows = await rowsOf(account);
    assert.equal(rows.length, 1, "exactly one report");
    assert.equal(String(rows[0].id), b.saves()[0].reportId, "the retry saved the report that failed — not a new one");
    assert.equal(b.saves()[1].reportId, b.saves()[0].reportId);
    assert.equal(worker.runs.length, modelRunsBefore, "nothing was analysed again");
    host.unmount();
  });
});

test("NETWORK FAILURE: no answer and the room does not hold the report -> 'could not confirm' with Try saving again; the retry saves one report", async () => {
  await scenario(async ({ account, b, room }) => {
    const host = await mount(account, room);
    b.next.push("network");
    await finish(await startUpload(host));
    assert.equal(panelNow(host).failure, roomShell.SAVE_UNCONFIRMED_MESSAGE);
    uploadPanelOf(host.tree).props.saveFailure.onRetry();
    await until(() => panelNow(host) === null);
    assert.equal(panelNow(host), null, "the retried save landed");
    assertHonestProgress(host);
    assert.equal((await rowsOf(account)).length, 1);
    host.unmount();
  });
});

test("NO ANSWER AT ALL: after the page's own limit the request is aborted, the room is read once more, and a clear retry replaces the endless 'Saving'; the retry saves one report", async (t) => {
  await scenario(async ({ account, b, room }) => {
    const host = await mount(account, room);
    b.next.push("hang");
    const upload = await startUpload(host);
    await waitFor(() => savingNow(host), "the saving stage");
    await advance(up.SAVE_GIVE_UP_AFTER_MS + 1, () => upload.finished);
    await until(() => upload.finished);
    assert.equal(upload.finished, true);
    assert.equal(b.saves()[0].outcome, "ABORTED");
    assert.equal(panelNow(host).failure, roomShell.SAVE_UNCONFIRMED_MESSAGE);
    assert.equal(uiOf(host).statusLine, "Report not saved yet");
    uploadPanelOf(host.tree).props.saveFailure.onRetry();
    await until(() => panelNow(host) === null);
    assert.equal(panelNow(host), null, "the retried save landed");
    capture(t, "give-up", { saves: b.saves().map((e) => e.outcome), roomReads: b.roomReads().length });
    assertHonestProgress(host);
    assert.equal((await rowsOf(account)).length, 1);
    host.unmount();
  });
});

test("REOPENING AN IN-PROGRESS ROOM: a second view of the room while AI is still running shows 'Analysis in progress' and no upload form — nothing can be uploaded twice into it", async () => {
  await scenario(async ({ account, room }) => {
    const host = await mount(account, room);
    await finish(await startUpload(host, "complete-held"));
    const reopened = await mount(account, room);
    assert.equal(uiOf(reopened).statusLine, "Analysis in progress");
    assert.equal(uploadPanelOf(reopened.tree), null, "no upload form in an occupied room");
    assert.equal((await rowsOf(account)).length, 1);
    reopened.unmount();
    host.unmount();
  });
});
