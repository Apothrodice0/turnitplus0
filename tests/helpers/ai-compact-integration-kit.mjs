import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fx from "./large-report-retry-fixture.mjs";
import * as aiRetryRoute from "../../app/api/reports/[id]/ai-retry/route.ts";
import { saveReportRemote } from "../../lib/reports-remote.ts";
import { persistAiCompletion } from "../../lib/report-ai-completion.ts";
import { buildReportSummary } from "../../lib/report-types.ts";
import { MAX_REPORT_SAVE_REQUEST_BYTES } from "../../lib/report-transport-limits.ts";

/**
 * Shared harness for the ai-compact-v1 END-TO-END suites (tests/ai-compact-passages-integration.test.mjs,
 * ai-compact-passages-size-ladder.test.mjs, ai-retry-busy-concurrency.test.mjs): the REAL route handlers and REAL client
 * helpers against a throwaway migrated SQLite DB, with fetch routed to the handlers and an explicit content-length as a
 * browser sends. The suites are separate files on purpose — the size ladder is heavy and the concurrency suite opens many
 * native libsql connections, so a load-related native teardown flake in one (a known, pre-existing pattern in this repo's
 * DB-backed suites) cannot take the others down with it.
 */
export const CEILING = MAX_REPORT_SAVE_REQUEST_BYTES;
export const ON = "true";
export const OFF = undefined;

export const sha = (value) => createHash("sha256").update(String(value)).digest("hex");
export const bytesOf = (value) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
export const num = (value) => (typeof value === "bigint" ? Number(value) : value);
export const payloadOf = (row) => JSON.parse(String(row.payload_json));
export const lastPost = (route, predicate = (r) => r.path === "/api/reports") => route.requests.filter((r) => r.method === "POST" && predicate(r)).at(-1);

let directCalls = 0;

/** Everything a suite needs, bound to its own fixture environment `env` (see createFixtureEnvironment). */
export function createKit(env) {
  const AI_ROUTES = { "POST /api/reports/:id/ai-retry": aiRetryRoute.POST };

  /** Runs `fn` as a browser signed in as `account`: a window (device key) + fetch routed to the real handlers. */
  async function asBrowser(account, fn) {
    const restoreWindow = fx.stubBrowserWindow();
    const route = fx.installRouteFetch(account, AI_ROUTES);
    try {
      return await fn(route);
    } finally {
      route.restore();
      restoreWindow();
    }
  }

  async function readRow(id) {
    const result = await env.client.execute({
      sql: "SELECT id, device_key, user_id, ai_score, ai_tone, ai_status, length(payload_json) AS chars, payload_json FROM saved_reports WHERE id = ?",
      args: [id],
    });
    return result.rows[0] ?? null;
  }

  /** The first save the room page performs (the state a report is in while its AI check is still running). */
  async function firstSave(account, id, text, room) {
    const report = fx.buildFirstSaveBody({ deviceKey: account.deviceKey, id, text, room }).payload;
    const processing = { ...buildReportSummary(report), aiStatus: "processing", similarityStatus: "pending" };
    const saved = await saveReportRemote(report, processing, undefined, room);
    assert.equal(saved.ok, true, `fixture sanity: the first save of ${id} must succeed`);
    return report;
  }

  /** A report whose first AI pass FAILED (the state that offers Retry): first save, then the failed-AI resave. */
  async function seedFailedReport(account, id, text, room) {
    const report = await firstSave(account, id, text, room);
    const aiResult = { aiScore: null, aiAnalysis: fx.syntheticAiAnalysis(text, { status: "error" }) };
    const enriched = { ...report, ...aiResult };
    const summary = { ...buildReportSummary(enriched), aiStatus: "failed", similarityStatus: "pending" };
    assert.equal((await persistAiCompletion(enriched, summary, room)).ok, true, "fixture sanity: the failed-AI resave must succeed");
    return report;
  }

  /** `report` enriched with a completed AI result, plus the summary the room page derives for it. */
  function readyEnrichment(report, aiAnalysis, aiScore = 7) {
    const enriched = { ...report, aiScore, aiAnalysis };
    const summary = { ...buildReportSummary(enriched), aiStatus: "ready", similarityStatus: "pending" };
    return { enriched, summary };
  }

  /** Calls the retry route directly (no client helper) — for validation and failure cases. */
  async function callRetryRoute(id, { body, cookie }) {
    directCalls += 1;
    const ip = `aic-direct-${directCalls}`;
    await fx.resetRateForTest(ip);
    const raw = JSON.stringify(body);
    const response = await aiRetryRoute.POST(
      new Request(`http://localhost/api/reports/${encodeURIComponent(id)}/ai-retry`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip, "content-length": String(Buffer.byteLength(raw)), cookie: `tp_session_v1=${cookie}` },
        body: raw,
      }),
      { params: Promise.resolve({ id }) },
    );
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, json, text };
  }

  const retryBodyFor = (aiAnalysis) => ({ aiStatus: "ready", aiScore: 7, aiTone: "low", payload: { aiScore: 5, aiAnalysis } });

  return { asBrowser, readRow, firstSave, seedFailedReport, readyEnrichment, callRetryRoute, retryBodyFor };
}
