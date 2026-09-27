import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import React from "react";
import { createMemoryIndexedDb, createMemoryLocalStorage } from "./helpers/memory-indexeddb.mjs";
import * as fx from "./helpers/large-report-retry-fixture.mjs";
import { sha, num } from "./helpers/ai-compact-integration-kit.mjs";
import { synthProse } from "./helpers/real-ai-windows.mjs";
import * as aiRetryRoute from "../app/api/reports/[id]/ai-retry/route.ts";
import { saveReportRemote } from "../lib/reports-remote.ts";
import { persistAiCompletion } from "../lib/report-ai-completion.ts";
import { accountLocalReportOwner, storeReportBestEffort, getStoredReportById } from "../lib/report-store.ts";
import { buildReportSummary } from "../lib/report-types.ts";
import { findRoomOccupant } from "../lib/reports-repo.ts";
import { isCompactAiAnalysis, validateCompactAiAnalysis } from "../lib/ai-passage-table.ts";
import { AI_SIZE_UNAVAILABLE_MESSAGE, AI_UNAVAILABLE_REASON_REPORT_SIZE } from "../lib/ai-unavailable-state.ts";
import { MAX_REPORT_SAVE_REQUEST_BYTES } from "../lib/report-transport-limits.ts";

register("./helpers/ssr-next-hooks.mjs", import.meta.url);

/**
 * AI manual-Retry DOUBLE FAILURE — the room's "Retry analysis" could fail, and then keep failing, without ever re-running.
 *
 * THE DEFECT (reproduced on 584cef6). Both AI-save paths — the automatic post-upload pass (saveEnrichedAiResult) and the manual
 * Retry (saveRetriedAiResult) — write the AI-enriched report to this browser's local IndexedDB copy BEFORE the server confirms
 * the save (by design: tests/report-ai-retry-large-report.test.mjs and tests/report-local-ownership-isolation.test.mjs pin that
 * order). retryAiCheck then preferred that local copy and refused to run when it said `aiAnalysis.status === "complete"` — a
 * guard documented as "checked against freshly-fetched data", but in fact reading a cache that can hold a result the server never
 * persisted. So:
 *
 *   room failed → Retry #1: model succeeds, the ai-retry save fails ("Could not save the updated AI result. Please try again.")
 *               → Retry #2: local copy says complete → "AI analysis for this report is already complete." — no model run, no save
 *               → the room stays failed, and every later Retry in this browser ends the same way.
 *
 * The automatic path's own failed save ("AI analysis finished but could not be saved. Retry analysis once it settles…") lands in
 * the same trap: the room stays processing, and the Retry it points to refuses.
 *
 * THE FIX (retryAiCheck only): a local copy that claims a complete AI result is not trusted for that claim — the server's copy is
 * loaded and decides. Everything else is unchanged: a local copy that does not claim completion is still used as-is, the
 * no-local-copy fallback is the same fetch, both save functions and the automatic pass are untouched, the ai-retry route is
 * untouched.
 *
 * HOW. The REAL RoomPageShell is rendered by a minimal hook host (useState/useRef/useEffect — the only hooks it uses, see
 * mountRoom) so the REAL retryAiCheck closure runs from the REAL "Retry analysis" button's onClick. Everything behind it is real:
 * lib/report-store.ts on an in-memory IndexedDB, the client helpers, and the route handlers on a throwaway migrated SQLite DB
 * (fetch routed to them). Only the browser Worker is scripted (FakeWorker: "complete" | "error" per model run), and faults are
 * injected at the fetch boundary. A trigger on saved_reports records every COMMITTED update, so persistence transitions are
 * counted exactly.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Browser surroundings — set up EVERYTHING before the first test() is registered.
// ---------------------------------------------------------------------------------------------------------------------

const idb = createMemoryIndexedDb();
globalThis.indexedDB = idb.factory;

/** window with localStorage and a virtual clock for window.setTimeout (the poll, the toast clear). */
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

/** Runs due window timers in order (awaiting async callbacks such as the poll) until `until()` or `max` timers ran. */
async function runTimers({ until = () => false, max = 200 } = {}) {
  for (let i = 0; i < max && !until(); i += 1) {
    const next = [...clock.timers.entries()].sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
    if (!next) return;
    clock.timers.delete(next[0]);
    clock.now = Math.max(clock.now, next[1].due);
    await next[1].fn();
    await settle();
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** The model Worker: each postMessage consumes one scripted behaviour. Everything else about the AI path is real. */
const worker = { script: [], runs: [] };
class FakeWorker {
  constructor() { this.listeners = new Set(); }
  addEventListener(type, fn) { if (type === "message") this.listeners.add(fn); }
  removeEventListener(type, fn) { this.listeners.delete(fn); }
  terminate() {}
  postMessage({ id, text }) {
    const behaviour = worker.script.shift() ?? "unscripted";
    worker.runs.push(behaviour);
    setImmediate(() => {
      const emit = (data) => { for (const fn of [...this.listeners]) fn({ data }); };
      emit({ type: "prep", stage: "analyzing" });
      if (behaviour === "complete") emit({ id, ok: true, result: fx.syntheticAiAnalysis(text, { seed: 4242 }) });
      else if (behaviour === "oversized") emit({ id, ok: true, result: oversizedAnalysis() });
      else emit({ id, ok: false, error: `Injected model failure (${behaviour})` });
    });
  }
}
globalThis.Worker = FakeWorker;

/** A structurally valid complete result whose request fits the ceiling but which cannot be stored beside the report. */
function oversizedAnalysis() {
  return {
    status: "complete", score: 0.41, model: "synthetic-test-model", engine: null, threshold: 0.7, eligibleWordCount: 900, analyzedWordCount: 900,
    passages: [{ start: 0, end: 10, score: 0.41, text: "o".repeat(MAX_REPORT_SAVE_REQUEST_BYTES - 2_000) }],
  };
}

const env = await fx.createFixtureEnvironment("ai_retry_double_failure");
process.env.TURSO_DATABASE_URL = `file:${env.dbFile}`;
const restoreC2 = fx.pinCompactWrites(undefined);
const restoreAi = fx.pinAiCompactWrites(undefined);

// Every COMMITTED update of a report row (a rolled-back tentative write takes its log row with it).
await env.client.execute(`CREATE TABLE test_ai_write_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, report_id TEXT, ai_status TEXT, ai_analysis_status TEXT, unavailable_reason TEXT)`);
await env.client.execute(`CREATE TRIGGER test_ai_write_log_trg AFTER UPDATE ON saved_reports BEGIN
  INSERT INTO test_ai_write_log (report_id, ai_status, ai_analysis_status, unavailable_reason)
  VALUES (NEW.id, NEW.ai_status, json_extract(NEW.payload_json, '$.aiAnalysis.status'), json_extract(NEW.payload_json, '$.aiAnalysis.unavailableReason'));
END`);

const roomShell = await import("../app/reports/rooms/[room]/room-page-shell.tsx");

test.after(() => {
  restoreAi();
  restoreC2();
  env.dispose();
});

// ---------------------------------------------------------------------------------------------------------------------
// The hook host: renders the real component function with a dispatcher that implements exactly the hooks it uses.
// Updates are batched and flushed in a microtask (React 18+ automatic batching; a click's own update is flushed before
// the handler's first await resumes, as React's discrete-event flush does), then passive effects run.
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
/** The notify() toast: the status message rendered directly inside the page container (room-page-shell.tsx: {toast && …}). */
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

/** Clicks the room's real "Retry analysis" button and waits for the whole retry to finish. */
async function clickRetry(host) {
  const button = retryButtonOf(host.tree);
  assert.ok(button, "the room offers Retry analysis");
  assert.equal(button.props.disabled, false, "Retry is enabled before the click");
  await button.props.onClick();
  await settle();
}

// ---------------------------------------------------------------------------------------------------------------------
// Server/local state — seeded with the exact calls runCheck and saveEnrichedAiResult make, in their order.
// ---------------------------------------------------------------------------------------------------------------------

let nextId = 1_758_000_000_000;
const TEXT = synthProse(24_000, { seed: 77, messiness: 0.01 });

function browser(account) {
  window.localStorage.setItem("tp_device_key_v1", account.deviceKey);
  const route = fx.installRouteFetch(account, { "POST /api/reports/:id/ai-retry": aiRetryRoute.POST });
  const routedFetch = globalThis.fetch;
  const faults = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, "http://localhost");
    const key = `${String(init.method ?? "GET").toUpperCase()} ${url.pathname.replace(/^\/api\/reports\/\d+/, "/api/reports/:id")}`;
    const at = faults.findIndex((f) => f.key === key);
    if (at >= 0) {
      const [fault] = faults.splice(at, 1);
      if (fault.mode === "drop-after-commit") {
        const response = await routedFetch(input, init);
        route.requests.at(-1).status = `${response.status}-RESPONSE-LOST`;
        throw new TypeError("network connection lost after the request was sent");
      }
      route.requests.push({ method: key.split(" ")[0], path: url.pathname, status: `FAULT:${fault.mode}` });
      if (fault.mode === "500") return new Response(JSON.stringify({ error: "Unable to save the AI result. Please try again." }), { status: 500 });
      if (fault.mode === "network") throw new TypeError("Failed to fetch");
    }
    return routedFetch(input, init);
  };
  return {
    route,
    owner: accountLocalReportOwner(account.email),
    /** One-shot fault on the next matching request: "500" | "network" (neither reaches the server) | "drop-after-commit". */
    fault(key, mode) { faults.push({ key, mode }); },
    restore() { route.restore(); },
  };
}

async function seedRoom(account, b, { room, analysis }) {
  const id = nextId++;
  const body = fx.buildFirstSaveBody({ deviceKey: account.deviceKey, id: String(id), text: TEXT, room });
  const report = { ...body.payload, id }; // lib/document-check-pipeline.ts: SimilarityReport.id is Date.now() — a number
  // runCheck: the local copy, then the first save ("processing").
  await storeReportBestEffort(report, b.owner);
  assert.equal((await saveReportRemote(report, { ...buildReportSummary(report), aiStatus: "processing", similarityStatus: "pending" }, undefined, room)).ok, true);
  // saveEnrichedAiResult for the automatic pass's own result: the local copy, then persistAiCompletion.
  const aiResult = analysis === "failed" ? roomShell.aiAnalysisErrorResult(new Error("worker crashed"), "analyzing") : { aiScore: 0.33, aiAnalysis: fx.syntheticAiAnalysis(TEXT, { seed: 7 }) };
  const enriched = { ...report, ...aiResult };
  const summary = { ...buildReportSummary(enriched), aiStatus: aiResult.aiAnalysis.status === "complete" ? "ready" : "failed", similarityStatus: "pending" };
  await storeReportBestEffort(enriched, b.owner);
  if (analysis === "complete-save-failed") b.fault("POST /api/reports", "500");
  const saved = await persistAiCompletion(enriched, summary, room);
  assert.equal(saved.ok, analysis !== "complete-save-failed", "fixture sanity: the automatic AI resave outcome");
  await env.client.execute("DELETE FROM test_ai_write_log");
  return String(id);
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
    aiAnalysis: aiAnalysis ?? null,
    rawAiScore: aiScore ?? null,
    text: payload.text,
    similarity: sha(JSON.stringify([similarityHalf, flat])),
  };
}

async function writesFor(id) {
  const rows = (await env.client.execute({ sql: "SELECT ai_status, ai_analysis_status, unavailable_reason FROM test_ai_write_log WHERE report_id = ? ORDER BY seq", args: [id] })).rows;
  return rows.map((r) => `${r.ai_status}/${r.ai_analysis_status}${r.unavailable_reason ? `/${r.unavailable_reason}` : ""}`);
}

const retryPosts = (b, id) => b.route.requests.filter((r) => r.path === `/api/reports/${id}/ai-retry`).map((r) => r.status);

let roomCounter = 0;
async function scenario(fn) {
  const account = await env.signUpAccount();
  const b = browser(account);
  worker.script.length = 0;
  worker.runs.length = 0;
  try {
    return await fn({ account, b, room: roomCounter++ % 10 });
  } finally {
    b.restore();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. The starting state
// ---------------------------------------------------------------------------------------------------------------------

test("STARTING STATE: a room whose automatic AI pass failed is terminal 'failed', similarity resolved, and offers Retry", async () => {
  await scenario(async ({ account, b, room }) => {
    const id = await seedRoom(account, b, { room, analysis: "failed" });
    const occupant = await findRoomOccupant(env.client, account.userId, room);
    assert.equal(occupant.status, "failed");
    assert.equal(occupant.report.id, id);
    assert.equal(roomShell.isFullyRevealed(occupant), true, "the failed branch (not the poll-exhausted one) renders");
    const host = await mount(account, room);
    assert.ok(retryButtonOf(host.tree), "Retry analysis is offered");
    assert.equal((await getStoredReportById(id, b.owner)).aiAnalysis.status, "error", "this browser's local copy holds the failed result");
    host.unmount();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. THE DOUBLE FAILURE — Retry's own save fails once; the next Retry must recover
// ---------------------------------------------------------------------------------------------------------------------

for (const mode of ["500", "network"]) {
  test(`DOUBLE FAILURE (${mode}): after a Retry whose model run succeeded but whose save failed, the NEXT Retry re-runs and persists — it never stops at a stale "already complete"`, async (t) => {
    await scenario(async ({ account, b, room }) => {
      const id = await seedRoom(account, b, { room, analysis: "failed" });
      const before = await serverState(id);
      const host = await mount(account, room);
      const trace = [`start server=${before.aiStatus} local=${(await getStoredReportById(id, b.owner)).aiAnalysis.status} room=failed`];

      // Retry #1: the model succeeds, the ai-retry save fails before it reaches the server.
      worker.script.push("complete");
      b.fault("POST /api/reports/:id/ai-retry", mode);
      await clickRetry(host);
      const afterFirst = await serverState(id);
      trace.push(`retry#1 runs=${worker.runs.length} posts=${retryPosts(b, id)} toast="${host.toasts.at(-1)}" server=${afterFirst.aiStatus} local=${(await getStoredReportById(id, b.owner)).aiAnalysis.status}`);
      assert.equal(worker.runs.length, 1, "Retry #1: exactly one model run");
      assert.deepEqual(retryPosts(b, id), [`FAULT:${mode}`], "Retry #1: exactly one save attempt");
      assert.equal(host.toasts.at(-1), "Could not save the updated AI result. Please try again.");
      assert.equal(afterFirst.aiStatus, "failed", "nothing reached the server");
      assert.deepEqual(await writesFor(id), [], "no persistence transition from the failed save");
      assert.ok(retryButtonOf(host.tree), "the room is still failed and still offers Retry");

      // Retry #2 — the customer does what the toast says.
      worker.script.push("complete");
      await clickRetry(host);
      const afterSecond = await serverState(id);
      trace.push(`retry#2 runs=${worker.runs.length} posts=${retryPosts(b, id)} toast="${host.toasts.at(-1)}" server=${afterSecond.aiStatus} writes=${JSON.stringify(await writesFor(id))}`);
      t.diagnostic(trace.join(" | "));

      assert.notEqual(host.toasts.at(-1), "AI analysis for this report is already complete.", "Retry #2 must not trust the unsaved local result");
      assert.equal(worker.runs.length, 2, "Retry #2: exactly one model run of its own");
      assert.deepEqual(retryPosts(b, id), [`FAULT:${mode}`, 200], "Retry #2: exactly one save, accepted");
      assert.deepEqual(await writesFor(id), ["ready/complete"], "exactly ONE persistence transition across both Retries: failed -> ready");
      assert.equal(host.toasts.at(-1), "AI analysis complete.");
      assert.equal(afterSecond.aiStatus, "ready");
      assert.equal(afterSecond.aiAnalysis.status, "complete");
      assert.deepEqual(afterSecond.aiAnalysis.passages, fx.syntheticAiAnalysis(TEXT, { seed: 4242 }).passages, "the model's passages are persisted as produced");
      assert.equal(afterSecond.rawAiScore, fx.syntheticAiAnalysis(TEXT, { seed: 4242 }).score, "the model's own score is persisted");
      assert.equal(afterSecond.similarity, before.similarity, "similarity half byte-identical");
      assert.equal(afterSecond.text, before.text, "the manuscript is untouched (no truncation)");
      assert.equal(retryButtonOf(host.tree), null, "the room is ready: no Retry");
      const occupant = await findRoomOccupant(env.client, account.userId, room);
      assert.equal(occupant.status, "ready", "a fresh server read agrees");
      host.unmount();
    });
  });
}

test("AUTOMATIC SAVE FAILED: the Retry that the automatic pass points to ('Retry analysis once it settles') re-runs and persists — the automatic pass itself is unchanged", async (t) => {
  await scenario(async ({ account, b, room }) => {
    // The automatic pass's model run succeeded, its resave failed: server 'processing', local copy 'complete' (saveEnrichedAiResult's order).
    const id = await seedRoom(account, b, { room, analysis: "complete-save-failed" });
    const before = await serverState(id);
    assert.equal(before.aiStatus, "processing");
    assert.equal((await getStoredReportById(id, b.owner)).aiAnalysis.status, "complete");
    const host = await mount(account, room);
    assert.equal(retryButtonOf(host.tree), null, "no Retry while the room is still polling");
    await runTimers({ until: () => retryButtonOf(host.tree) !== null });
    assert.ok(retryButtonOf(host.tree), "the bounded poll gives up and offers Retry (room still processing)");

    worker.script.push("complete");
    await clickRetry(host);
    const after = await serverState(id);
    t.diagnostic(`runs=${worker.runs.length} posts=${retryPosts(b, id)} toast="${host.toasts.at(-1)}" server=${after.aiStatus}`);
    assert.notEqual(host.toasts.at(-1), "AI analysis for this report is already complete.");
    assert.equal(worker.runs.length, 1, "exactly one model run");
    assert.deepEqual(retryPosts(b, id), [200], "exactly one save");
    assert.deepEqual(await writesFor(id), ["ready/complete"], "exactly one persistence transition: processing -> ready");
    assert.equal(after.aiStatus, "ready");
    assert.equal(after.similarity, before.similarity, "similarity half byte-identical");
    assert.equal(host.toasts.at(-1), "AI analysis complete.");
    host.unmount();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. The ordinary lifecycles are unchanged
// ---------------------------------------------------------------------------------------------------------------------

test("RETRY SUCCEEDS: one model run, one save, one transition to ready; the local copy follows; Retry is gone", async () => {
  await scenario(async ({ account, b, room }) => {
    const id = await seedRoom(account, b, { room, analysis: "failed" });
    const before = await serverState(id);
    const host = await mount(account, room);
    worker.script.push("complete");
    await clickRetry(host);
    const after = await serverState(id);
    assert.equal(worker.runs.length, 1);
    assert.deepEqual(retryPosts(b, id), [200]);
    assert.deepEqual(await writesFor(id), ["ready/complete"]);
    assert.equal(after.aiStatus, "ready");
    assert.equal(after.similarity, before.similarity);
    assert.equal(host.toasts.at(-1), "AI analysis complete.");
    assert.equal((await getStoredReportById(id, b.owner)).aiAnalysis.status, "complete");
    assert.equal(retryButtonOf(host.tree), null);
    host.unmount();
  });
});

test("RETRY GENUINELY FAILS (model throws before a result): one model run, one save of the failed state, no second attempt, Retry still offered; a later Retry recovers", async () => {
  await scenario(async ({ account, b, room }) => {
    const id = await seedRoom(account, b, { room, analysis: "failed" });
    const before = await serverState(id);
    const host = await mount(account, room);
    worker.script.push("error");
    await clickRetry(host);
    await runTimers({ max: 5 }); // nothing scheduled by the retry may start another run or save
    assert.equal(worker.runs.length, 1, "exactly one model run");
    assert.deepEqual(retryPosts(b, id), [200], "exactly one save");
    assert.deepEqual(await writesFor(id), ["failed/error"], "exactly one persistence transition (failed -> failed)");
    assert.equal(host.toasts.at(-1), "AI analysis is still unavailable for this document.");
    const failed = await serverState(id);
    assert.equal(failed.aiStatus, "failed");
    assert.equal(failed.similarity, before.similarity);
    assert.ok(retryButtonOf(host.tree), "an ordinary failure stays retryable");

    // Repeated Retry after a genuine failure.
    worker.script.push("complete");
    await clickRetry(host);
    assert.equal(worker.runs.length, 2);
    assert.deepEqual(retryPosts(b, id), [200, 200]);
    assert.deepEqual(await writesFor(id), ["failed/error", "ready/complete"]);
    const ready = await serverState(id);
    assert.equal(ready.aiStatus, "ready");
    assert.equal(ready.similarity, before.similarity);
    host.unmount();
  });
});

test("SAVE COMMITTED BUT THE RESPONSE WAS LOST: the persisted ready result is never re-run or overwritten — the next Retry is told it is complete, from the server's copy", async () => {
  await scenario(async ({ account, b, room }) => {
    const id = await seedRoom(account, b, { room, analysis: "failed" });
    const before = await serverState(id);
    const host = await mount(account, room);
    worker.script.push("complete");
    b.fault("POST /api/reports/:id/ai-retry", "drop-after-commit");
    await clickRetry(host);
    assert.equal(host.toasts.at(-1), "Could not save the updated AI result. Please try again.");
    assert.deepEqual(await writesFor(id), ["ready/complete"], "the server committed exactly once");
    const committed = await serverState(id);

    worker.script.push("error"); // would be a stale failure if it ever ran
    await clickRetry(host);
    assert.equal(host.toasts.at(-1), "AI analysis for this report is already complete.");
    assert.equal(worker.runs.length, 1, "no second model run");
    assert.deepEqual(retryPosts(b, id), ["200-RESPONSE-LOST"], "no second save");
    assert.deepEqual(await writesFor(id), ["ready/complete"], "still exactly one persistence transition");
    const after = await serverState(id);
    assert.deepEqual(after, committed, "the ready result is exactly as committed");
    assert.equal(after.similarity, before.similarity);
    host.unmount();
  });
});

test("STALE FAILURE CANNOT OVERWRITE SUCCESS: a second tab still showing 'failed' (other browser profile, or the same one) cannot re-run or replace a ready result", async () => {
  await scenario(async ({ account, b, room }) => {
    const id = await seedRoom(account, b, { room, analysis: "failed" });
    const staleOccupant = await findRoomOccupant(env.client, account.userId, room);
    const tabA = await mount(account, room);
    const tabB = await mount(account, room); // same browser profile (shared IndexedDB), rendered before A's Retry
    worker.script.push("complete");
    await clickRetry(tabA);
    const ready = await serverState(id);
    assert.equal(ready.aiStatus, "ready");

    worker.script.push("error");
    await clickRetry(tabB);
    assert.equal(tabB.toasts.at(-1), "AI analysis for this report is already complete.");
    // A different browser profile whose local copy still says 'error' — the ordinary server-side protection still holds.
    const idbBefore = globalThis.indexedDB;
    globalThis.indexedDB = createMemoryIndexedDb().factory;
    try {
      const tabC = mountRoom({ room, accountEmail: account.email, initialOccupant: staleOccupant });
      await clickRetry(tabC);
      assert.equal(tabC.toasts.at(-1), "AI analysis for this report is already complete.");
      tabC.unmount();
    } finally {
      globalThis.indexedDB = idbBefore;
    }
    assert.equal(worker.runs.length, 1, "only tab A's Retry ever ran the model");
    assert.deepEqual(await writesFor(id), ["ready/complete"]);
    assert.deepEqual(await serverState(id), ready);
    tabA.unmount();
    tabB.unmount();
  });
});

test("DOUBLE CLICK: the busy guard still admits exactly one Retry — the re-rendered button is disabled and its handler is a no-op", async () => {
  await scenario(async ({ account, b, room }) => {
    const id = await seedRoom(account, b, { room, analysis: "failed" });
    const host = await mount(account, room);
    worker.script.push("complete", "complete");
    const first = retryButtonOf(host.tree).props.onClick();
    await Promise.resolve(); // the click's own update is flushed before the handler resumes
    const second = retryButtonOf(host.tree);
    assert.equal(second.props.disabled, true, "Retry is disabled while one is running");
    assert.match(textOf(second.props.children), /Checking…/);
    await second.props.onClick();
    await first;
    await settle();
    assert.equal(worker.runs.length, 1, "exactly one model run");
    assert.deepEqual(retryPosts(b, id), [200], "exactly one save");
    assert.deepEqual(await writesFor(id), ["ready/complete"]);
    host.unmount();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. Terminal size policy and compact persistence are unchanged
// ---------------------------------------------------------------------------------------------------------------------

test("TERMINAL OVERSIZED: an unstorable result still ends in the server-authored terminal state once, Retry disappears and stays gone after a fresh read", async () => {
  await scenario(async ({ account, b, room }) => {
    const id = await seedRoom(account, b, { room, analysis: "failed" });
    const before = await serverState(id);
    const host = await mount(account, room);
    worker.script.push("oversized");
    await clickRetry(host);
    assert.equal(worker.runs.length, 1);
    assert.deepEqual(retryPosts(b, id), [200]);
    assert.deepEqual(await writesFor(id), ["ready/complete", `failed/error/${AI_UNAVAILABLE_REASON_REPORT_SIZE}`], "one transaction: tentative candidate, then the marker (committed together)");
    const after = await serverState(id);
    assert.equal(after.aiStatus, "failed");
    assert.equal(after.aiAnalysis.unavailableReason, AI_UNAVAILABLE_REASON_REPORT_SIZE);
    assert.equal(after.similarity, before.similarity);
    assert.equal(host.toasts.at(-1), AI_SIZE_UNAVAILABLE_MESSAGE);
    assert.equal(retryButtonOf(host.tree), null, "no Retry for the terminal state");
    host.unmount();
    const reopened = await mount(account, room);
    assert.equal(retryButtonOf(reopened.tree), null, "still no Retry after a fresh server read");
    reopened.unmount();
  });
});

test("COMPACT AI PERSISTENCE: with the ai-compact-v1 writer on, the recovering Retry persists a compact table valid for the stored manuscript", async () => {
  await fx.withAiCompactWrites("true", () => scenario(async ({ account, b, room }) => {
    const id = await seedRoom(account, b, { room, analysis: "failed" });
    const before = await serverState(id);
    const host = await mount(account, room);
    worker.script.push("complete");
    b.fault("POST /api/reports/:id/ai-retry", "500");
    await clickRetry(host);
    worker.script.push("complete");
    await clickRetry(host);
    const after = await serverState(id);
    assert.equal(after.aiStatus, "ready");
    assert.equal(isCompactAiAnalysis(after.aiAnalysis), true, "persisted as a compact table");
    assert.equal(validateCompactAiAnalysis(after.aiAnalysis, { text: after.text }).ok, true, "valid against the stored manuscript");
    assert.deepEqual(await writesFor(id), ["ready/complete"]);
    assert.equal(after.similarity, before.similarity);
    host.unmount();
  }));
});
