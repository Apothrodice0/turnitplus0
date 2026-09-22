import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import * as fx from "./helpers/large-report-retry-fixture.mjs";
import * as aiRetryRoute from "../app/api/reports/[id]/ai-retry/route.ts";
import { saveReportRemote, fetchRemoteReport, fetchReportRoomContents, saveAiRetryResultRemote } from "../lib/reports-remote.ts";
import { persistAiCompletion, persistAiRetryResult } from "../lib/report-ai-completion.ts";
import { buildReportSummary } from "../lib/report-types.ts";
import { MAX_REPORT_SAVE_REQUEST_BYTES } from "../lib/report-transport-limits.ts";
import { resolveCompactPersistenceWrites } from "../lib/report-compact-persistence-flag.ts";
import { prepareAiAnalysisForTransport } from "../lib/ai-passage-table.ts";

/**
 * G2 — a manual AI RETRY must not require the browser to echo the whole (GET-expanded) similarity report back to
 * the server. The reproduced failure: a large report saves (compact persisted form under the 2,000,000-byte ceiling),
 * opens (GET expands it), and then Retry — with no local IndexedDB copy — POSTs the EXPANDED report through the
 * ordinary save route: a deterministic 413. The fix is POST /api/reports/[id]/ai-retry (see that route's header), fed by
 * persistAiRetryResult, which sends only the AI result and changes only the AI half of the saved report.
 *
 * Everything drives the REAL route handlers against a real, throwaway, migrated SQLite DB through the REAL client
 * helpers (fetch is routed to the handlers, with an explicit content-length as a browser sends). All text is synthetic.
 * The compact-write flag (default OFF) is pinned ON only while a fixture report is SAVED, and is back at its default
 * for every retry — so each retry below also proves a valid compact row can be retried with the write flag OFF.
 *
 * The AI result these tests carry is REALISTIC (tests/helpers/large-report-retry-fixture.mjs syntheticAiAnalysis: the real
 * overlapping 240/120-token windows, ~2.4x the manuscript — the original fixture was a non-overlapping ~1.18x stand-in, half
 * the real size). At that size a very large report's AI result alone no longer fits beside its evidence, so — exactly as in
 * production once the fix is rolled out — this file runs with the ai-compact-v1 WRITER gate ON (lib/ai-passage-table.ts): the
 * AI result leaves the browser as a compact table, and that is what these retries send and the route persists. The two places
 * that deliberately reproduce the PRE-fix / legacy behaviour (the whole-report echo, the ordinary resave) pin the gate OFF.
 * tests/ai-compact-passages-integration.test.mjs owns the compact-vs-legacy comparison, the size ladder and the gate itself.
 */

// Set up EVERYTHING before the first test() is registered (node:test starts a test the moment it is registered).
const env = await fx.createFixtureEnvironment("g2_ai_retry");
// tests/database-isolation.test.mjs: a file that drives DB-backed routes must override this itself.
process.env.TURSO_DATABASE_URL = `file:${env.dbFile}`;

const PASSAGE_WORDS = 9000;
const SIZE_WORDS = { small: 1500, g2: 6200, veryLarge: 9000 };
const corpus = fx.buildCorpusPassages(PASSAGE_WORDS);
for (const passage of corpus) await env.promoteDocumentIntoCorpus(passage);
const prefixWords = (text, n) => text.split(/\s+/).slice(0, n).join(" ");
const manuscript = Object.fromEntries(Object.entries(SIZE_WORDS).map(([name, words]) => [name, fx.buildMatchedManuscript(corpus.map((p) => prefixWords(p, words)))]));

const accounts = {};
for (const name of ["main", "large", "guard", "other", "r2", "stale", "misc"]) accounts[name] = await env.signUpAccount();

// The compact-write flag is DEFAULT OFF; make this file independent of whatever the ambient shell has set.
const restoreAmbientCompactFlag = fx.pinCompactWrites(undefined);
// The ai-compact-v1 writer gate: ON for this file (see the header) — individual tests pin it OFF where they reproduce the legacy path.
const restoreAmbientAiCompactFlag = fx.pinAiCompactWrites("true");
test.after(() => {
  restoreAmbientAiCompactFlag();
  restoreAmbientCompactFlag();
  env.dispose();
});

// ----------------------------------------------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------------------------------------------

const AI_RETRY_ROUTES = { "POST /api/reports/:id/ai-retry": aiRetryRoute.POST };
const sha = (value) => createHash("sha256").update(String(value)).digest("hex");
const byteLength = (value) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
const num = (value) => (typeof value === "bigint" ? Number(value) : value);

/** Runs `fn` as a browser signed in as `account`: a window (device key) + fetch routed to the real handlers. */
async function asBrowser(account, fn) {
  const restoreWindow = fx.stubBrowserWindow();
  const route = fx.installRouteFetch(account, AI_RETRY_ROUTES);
  try {
    return await fn(route);
  } finally {
    route.restore();
    restoreWindow();
  }
}

/** Saves a fixture report exactly as the room page does (first save, then the first AI pass), the compact-write flag pinned ON for the save only. */
async function seedReport(account, { id, room, text, aiStage = "failed" }) {
  const restoreCompact = fx.pinCompactWrites("true");
  try {
    const report = fx.buildFirstSaveBody({ deviceKey: account.deviceKey, id, text, room }).payload;
    const processing = { ...buildReportSummary(report), aiStatus: "processing", similarityStatus: "pending" };
    const saved = await saveReportRemote(report, processing, undefined, room);
    assert.equal(saved.ok, true, "fixture sanity: the initial save must succeed");
    const aiResult = aiStage === "ready"
      ? { aiScore: 7, aiAnalysis: fx.syntheticAiAnalysis(text, { status: "complete" }) }
      : { aiScore: null, aiAnalysis: fx.syntheticAiAnalysis(text, { status: "error" }) };
    const enriched = { ...report, ...aiResult };
    const summary = { ...buildReportSummary(enriched), aiStatus: aiStage === "ready" ? "ready" : "failed", similarityStatus: "pending" };
    const persisted = await persistAiCompletion(enriched, summary, room);
    assert.equal(persisted.ok, true, "fixture sanity: the first AI pass save must succeed");
    return { id, room, report };
  } finally {
    restoreCompact();
  }
}

/** The retry's own work, as retryAiCheck does it (minus the browser-only Worker): enrich `full` with a fresh AI result and derive its summary. */
function enrichForRetry(full, text, status = "complete") {
  const aiResult = { aiScore: status === "complete" ? 7 : null, aiAnalysis: fx.syntheticAiAnalysis(text, { status }) };
  const enriched = { ...full, ...aiResult };
  const summary = { ...buildReportSummary(enriched), aiStatus: status === "complete" ? "ready" : "failed", similarityStatus: "pending" };
  return { aiResult, enriched, summary };
}

async function readRow(id) {
  const result = await env.client.execute({
    sql: `SELECT id, device_key, user_id, room_number, submission_id, title, report_created_at, word_count, archive_score, score_band,
                 ai_score, ai_tone, ai_status, payload_json FROM saved_reports WHERE id = ?`,
    args: [id],
  });
  return result.rows[0] ?? null;
}

const SCALAR_COLUMNS = ["id", "device_key", "user_id", "room_number", "submission_id", "title", "report_created_at", "word_count", "archive_score", "score_band"];
const scalarsOf = (row) => Object.fromEntries(SCALAR_COLUMNS.map((column) => [column, num(row[column])]));
const aiColumnsOf = (row) => ({ ai_score: num(row.ai_score), ai_tone: row.ai_tone, ai_status: row.ai_status });
const payloadOf = (row) => JSON.parse(String(row.payload_json));
const withoutAiFields = (payload) => {
  const { aiAnalysis: _aiAnalysis, aiScore: _aiScore, ...rest } = payload;
  return rest;
};

/** The persisted similarity / explanation subtrees as SQLite renders them — byte comparison across a retry. */
async function rawSubtrees(id) {
  const result = await env.client.execute({
    sql: `SELECT json_extract(payload_json, '$.unifiedSimilarity') AS us, json_extract(payload_json, '$.evidenceInterpretation') AS ei,
                 json_extract(payload_json, '$.reportCompletion') AS rc, json_extract(payload_json, '$.unifiedSimilarityGeneration') AS gen
          FROM saved_reports WHERE id = ?`,
    args: [id],
  });
  const row = result.rows[0];
  return { us: String(row.us), ei: String(row.ei), rc: String(row.rc), gen: num(row.gen) };
}

let directCalls = 0;
/** Calls the retry route directly (no client helper) — for auth / validation / failure cases. */
async function callRetryRoute(id, { body, rawBody, cookie, contentLength } = {}) {
  directCalls += 1;
  const ip = `g2-direct-${directCalls}`;
  await fx.resetRateForTest(ip);
  const text = rawBody ?? JSON.stringify(body);
  const response = await aiRetryRoute.POST(
    new Request(`http://localhost/api/reports/${encodeURIComponent(id)}/ai-retry`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": ip,
        "content-length": String(contentLength ?? Buffer.byteLength(text, "utf8")),
        ...(cookie ? { cookie: `tp_session_v1=${cookie}` } : {}),
      },
      body: text,
    }),
    { params: Promise.resolve({ id }) },
  );
  const bodyText = await response.text();
  let json = null;
  try { json = JSON.parse(bodyText); } catch { /* not JSON */ }
  return { status: response.status, bodyText, json };
}

const retryBody = (text, status = "complete") => ({
  aiStatus: status === "complete" ? "ready" : "failed",
  aiScore: status === "complete" ? 7 : null,
  aiTone: status === "complete" ? "low" : null,
  payload: { aiScore: status === "complete" ? 7 : null, aiAnalysis: fx.syntheticAiAnalysis(text, { status }) },
});

/** The exact bytes saveAiRetryResultRemote sends for this AI result — independent of any similarity data. */
const expectedRetryRequestBytes = ({ aiStatus, aiScore, aiTone, rawAiScore, aiAnalysis }) =>
  byteLength({ aiStatus, aiScore, aiTone, payload: { aiScore: rawAiScore, aiAnalysis } });

/** The AI result as it LEAVES the browser: persistAiRetryResult sends the compact table when the writer gate is on (it is, in this file). */
const wireAi = (aiAnalysis, text) => prepareAiAnalysisForTransport(aiAnalysis, text);

const measured = {};

// ----------------------------------------------------------------------------------------------------------------
// 1. THE HEADLINE — G2 reproduced, then fixed, on the same report (remote-fallback retry, no local copy)
// ----------------------------------------------------------------------------------------------------------------

test("G2 REMOTE FALLBACK: a large report that saves and opens no longer 413s on Retry — the ordinary save path still rejects the expanded echo (guard unchanged), the retry route accepts a tiny AI-only request", async () => {
  const account = accounts.main;
  const id = "g2-remote-fallback";
  await asBrowser(account, async (route) => {
    await seedReport(account, { id, room: 0, text: manuscript.g2 });
    const before = await readRow(id);
    assert.equal(before.ai_status, "failed", "fixture sanity: the room is in the failed-AI state that offers Retry");
    const persistedChars = String(before.payload_json).length;
    assert.ok(persistedChars < MAX_REPORT_SAVE_REQUEST_BYTES, "fixture sanity: the compact persisted form fits under the ceiling");
    assert.equal(payloadOf(before).evidenceInterpretation?.format, "compact", "fixture sanity: the row really was written in the compact form");

    // No local copy in this browser -> Retry falls back to the remote, GET-EXPANDED report.
    const roomBefore = await fetchReportRoomContents(0);
    assert.equal(roomBefore.ok && roomBefore.contents.status, "failed");
    const full = await fetchRemoteReport(id);
    assert.ok(full, "GET must succeed");
    const { aiResult, enriched, summary } = enrichForRetry(full, manuscript.g2);

    // (a) The pre-fix mechanism is still what it was: re-POSTing that expanded report is refused 413 — and the row is untouched. The guard was NOT raised.
    // (Reproduced with the writer gate OFF: this is the legacy whole-report echo carrying the full, uncompacted AI result.)
    // (The ORDINARY SAVE ROUTE itself, called directly: persistAiCompletion now answers a size 413 with a fallback to the narrow
    // AI-result route — the G2 size policy, owned by tests/ai-size-unavailable-policy.test.mjs — so it no longer ends here.)
    const oldPath = await fx.withAiCompactWrites(undefined, () => saveReportRemote(enriched, summary, undefined, 0));
    const oldRequest = route.requests.filter((r) => r.method === "POST" && r.path === "/api/reports").at(-1);
    assert.ok(oldRequest.bytes > MAX_REPORT_SAVE_REQUEST_BYTES, `fixture sanity: the old echo (${oldRequest.bytes} bytes) must exceed the ${MAX_REPORT_SAVE_REQUEST_BYTES}-byte ceiling to reproduce G2`);
    assert.equal(oldRequest.status, 413);
    assert.equal(oldPath.ok, false);
    const afterRejected = await readRow(id);
    assert.equal(sha(afterRejected.payload_json), sha(before.payload_json), "the rejected echo left the saved report byte-identical");
    assert.equal(MAX_REPORT_SAVE_REQUEST_BYTES, 2_000_000, "the request ceiling constant is unchanged");

    // (b) The fix: the retry route — only the AI result travels.
    const subtreesBefore = await rawSubtrees(id);
    const retried = await persistAiRetryResult(enriched, summary);
    assert.equal(retried.ok, true, "the retry must succeed");
    const retryRequest = route.requests.filter((r) => r.method === "POST" && r.path === `/api/reports/${id}/ai-retry`).at(-1);
    assert.equal(retryRequest.status, 200, "no 413");
    assert.ok(retryRequest.bytes < MAX_REPORT_SAVE_REQUEST_BYTES, "the retry request is under the ceiling");
    assert.ok(retryRequest.bytes < oldRequest.bytes * 0.5, `the retry request (${retryRequest.bytes}) is far smaller than the old echo (${oldRequest.bytes})`);
    assert.equal(retryRequest.bytes, expectedRetryRequestBytes({ aiStatus: "ready", aiScore: summary.aiScore, aiTone: summary.aiTone, rawAiScore: aiResult.aiScore, aiAnalysis: wireAi(aiResult.aiAnalysis, manuscript.g2) }), "the retry request is exactly the AI result (in its compact wire form) — nothing of the report rides along");
    measured.g2 = { words: fx.wordCountOf(manuscript.g2), oldEchoBytes: oldRequest.bytes, retryBytes: retryRequest.bytes, getExpandedBytes: byteLength(full), persistedChars };

    // The AI half changed ...
    const after = await readRow(id);
    assert.deepEqual(aiColumnsOf(after), { ai_score: num(summary.aiScore), ai_tone: summary.aiTone, ai_status: "ready" });
    assert.equal(payloadOf(after).aiAnalysis.status, "complete");
    assert.equal(payloadOf(after).aiScore, aiResult.aiScore);
    // ... and NOTHING else did: identity, ownership, room, every scalar, and every similarity / evidence / completion field.
    assert.deepEqual(scalarsOf(after), scalarsOf(before));
    assert.deepEqual(withoutAiFields(payloadOf(after)), withoutAiFields(payloadOf(before)), "the persisted payload differs only in the AI fields");
    assert.deepEqual(await rawSubtrees(id), subtreesBefore, "unifiedSimilarity / evidenceInterpretation / reportCompletion / generation are byte-identical");
    assert.equal(payloadOf(after).evidenceInterpretation.format, "compact", "the compact interpretation is untouched (compact writes are OFF now)");
    assert.equal(fx.COMPACT_GATE in process.env, false, "the compact-write flag was not left set");

    // The customer-visible report is unchanged apart from the AI result, and the room poll reflects the retry.
    const fullAfter = await fetchRemoteReport(id);
    assert.deepEqual(fullAfter.unifiedSimilarity, full.unifiedSimilarity, "unifiedSimilarity (expanded) unchanged");
    assert.deepEqual(fullAfter.evidenceInterpretation, full.evidenceInterpretation, "evidenceInterpretation (cards, passages, highlights) unchanged");
    assert.deepEqual(fullAfter.reportCompletion, full.reportCompletion);
    assert.equal(fullAfter.aiAnalysis.status, "complete");
    const roomAfter = await fetchReportRoomContents(0);
    assert.equal(roomAfter.ok && roomAfter.contents.status, "ready", "the room poll now reports the retry's result");
    assert.equal(roomAfter.contents.report.similarityStatus, "resolved");
    assert.equal(roomAfter.contents.report.primaryScore, roomBefore.contents.report.primaryScore, "the displayed similarity score did not change");
    assert.equal(roomAfter.contents.report.aiScore, summary.aiScore);
    // Customer privacy: nothing about the compact form, decoders or provenance is in the retry response or the room summary.
    assert.doesNotMatch(JSON.stringify(roomAfter), /compact|formatVersion|contributions|provenance/i);
  });
});

test("G2 LOCAL COPY: with the browser's own small local report the retry sends the identical request and succeeds — the fix does not depend on which copy the browser holds", async () => {
  const account = accounts.main;
  const id = "g2-local-copy";
  await asBrowser(account, async (route) => {
    const { report } = await seedReport(account, { id, room: 1, text: manuscript.g2 });
    const before = await readRow(id);
    const { aiResult, enriched, summary } = enrichForRetry(report, manuscript.g2);
    const retried = await persistAiRetryResult(enriched, summary);
    assert.equal(retried.ok, true);
    const request = route.requests.filter((r) => r.path === `/api/reports/${id}/ai-retry`).at(-1);
    assert.equal(request.status, 200);
    assert.equal(request.bytes, expectedRetryRequestBytes({ aiStatus: "ready", aiScore: summary.aiScore, aiTone: summary.aiTone, rawAiScore: aiResult.aiScore, aiAnalysis: wireAi(aiResult.aiAnalysis, manuscript.g2) }));
    assert.equal(request.bytes, measured.g2.retryBytes, "the request is byte-for-byte the same size whether the retry started from the remote or the local copy");
    const after = await readRow(id);
    assert.deepEqual(withoutAiFields(payloadOf(after)), withoutAiFields(payloadOf(before)));
    assert.equal(after.ai_status, "ready");
  });
});

// ----------------------------------------------------------------------------------------------------------------
// 2. Size behaviour: small / large / very large valid
// ----------------------------------------------------------------------------------------------------------------

test("REQUEST SIZE follows the AI result, not the similarity evidence: small / G2 / very large valid reports (the very large one's old echo is ~1.35x the ceiling; its retry request is under half of it)", async () => {
  const account = accounts.large;
  await asBrowser(account, async (route) => {
    for (const [index, name] of ["small", "g2", "veryLarge"].entries()) {
      const id = `g2-size-${name}`;
      const text = manuscript[name];
      await seedReport(account, { id, room: index, text });
      const before = await readRow(id);
      const full = await fetchRemoteReport(id);
      const getExpandedBytes = byteLength(full);
      const { aiResult, enriched, summary } = enrichForRetry(full, text);
      const oldEchoBytes = byteLength({ deviceKey: account.deviceKey, ...summary, payload: enriched, academicSearchDiagnosticsId: null, room: index });

      const retried = await persistAiRetryResult(enriched, summary);
      assert.equal(retried.ok, true, `${name}: the retry succeeds`);
      const request = route.requests.filter((r) => r.path === `/api/reports/${id}/ai-retry`).at(-1);
      assert.equal(request.status, 200, `${name}: not a 413`);
      assert.ok(request.bytes < MAX_REPORT_SAVE_REQUEST_BYTES, `${name}: retry request under the ceiling`);
      const expected = expectedRetryRequestBytes({ aiStatus: "ready", aiScore: summary.aiScore, aiTone: summary.aiTone, rawAiScore: aiResult.aiScore, aiAnalysis: wireAi(aiResult.aiAnalysis, text) });
      assert.equal(request.bytes, expected, `${name}: the request is exactly the AI result (compact wire form) — its size cannot depend on evidenceInterpretation`);
      const after = await readRow(id);
      assert.ok(String(after.payload_json).length <= MAX_REPORT_SAVE_REQUEST_BYTES, `${name}: the persisted payload stays within the persistence ceiling`);
      assert.deepEqual(withoutAiFields(payloadOf(after)), withoutAiFields(payloadOf(before)), `${name}: similarity state unchanged`);
      measured[name] = { words: fx.wordCountOf(text), chars: text.length, persistedCharsBefore: String(before.payload_json).length, getExpandedBytes, oldEchoBytes, retryBytes: request.bytes, legacyAiAnalysisBytes: byteLength(aiResult.aiAnalysis), aiAnalysisBytes: byteLength(wireAi(aiResult.aiAnalysis, text)), persistedCharsAfter: String(after.payload_json).length };
    }
  });
  const { small, g2, veryLarge } = measured;
  // The fixture is REALISTIC now (real overlapping windows): the legacy AI result is ~2.4x the manuscript, the compact wire form ~0.08x.
  assert.ok(veryLarge.legacyAiAnalysisBytes / veryLarge.chars > 2.0, `the legacy AI result is ~2.4x the manuscript (${(veryLarge.legacyAiAnalysisBytes / veryLarge.chars).toFixed(2)}x)`);
  assert.ok(veryLarge.aiAnalysisBytes / veryLarge.chars < 0.11, `the compact wire form is ~0.08x the manuscript (${(veryLarge.aiAnalysisBytes / veryLarge.chars).toFixed(3)}x)`);
  // ... and that is exactly why the very large report needs it: beside its own evidence the legacy AI result would not have fit.
  assert.ok(veryLarge.persistedCharsBefore + veryLarge.legacyAiAnalysisBytes > MAX_REPORT_SAVE_REQUEST_BYTES, "without compaction the very large report's Retry could not have been persisted (legacy AI + its evidence > the ceiling)");
  assert.ok(g2.oldEchoBytes > MAX_REPORT_SAVE_REQUEST_BYTES, "the G2-size report's old echo exceeds the ceiling");
  // (The matcher caps evidence per source, so the GET-expanded form of even this ~90k-word report saturates just under the ceiling; what the
  // browser would have to echo is that PLUS the fresh AI result and the summary envelope — well over it.)
  assert.ok(veryLarge.getExpandedBytes > MAX_REPORT_SAVE_REQUEST_BYTES * 0.9, `the very large report's GET-expanded form alone (${veryLarge.getExpandedBytes}) is already at the ceiling`);
  assert.ok(veryLarge.oldEchoBytes > MAX_REPORT_SAVE_REQUEST_BYTES * 1.3, `so its old echo (${veryLarge.oldEchoBytes}) is far over the ceiling — the browser could never re-POST it`);
  assert.ok(veryLarge.retryBytes < MAX_REPORT_SAVE_REQUEST_BYTES * 0.45, "yet its retry request is comfortably under the ceiling");
  // Scaling: the retry request tracks the AI analysis (≈ the manuscript), far below what the evidence-bearing echo needs.
  assert.ok(small.retryBytes < g2.retryBytes && g2.retryBytes < veryLarge.retryBytes, "retry size tracks the manuscript length (its AI passages), monotonically");
  assert.ok(g2.retryBytes / g2.oldEchoBytes < 0.3 && veryLarge.retryBytes / veryLarge.oldEchoBytes < 0.3, "the retry request is under 30% of the echo it replaces at scale");
  console.log("[g2-ai-retry] measured:", JSON.stringify(measured));
});

// ----------------------------------------------------------------------------------------------------------------
// 3. Trust boundary / authorization
// ----------------------------------------------------------------------------------------------------------------

test("AUTHORIZATION: no session -> 401; another account's report -> the same generic 404, untouched; missing id -> 404; a legacy anonymous row is neither retried nor claimed", async () => {
  const owner = accounts.guard;
  const other = accounts.other;
  const id = "g2-auth-target";
  await asBrowser(owner, async () => { await seedReport(owner, { id, room: 0, text: manuscript.small }); });
  const before = await readRow(id);
  const body = retryBody(manuscript.small);

  const anonymous = await callRetryRoute(id, { body });
  assert.equal(anonymous.status, 401);
  const crossAccount = await callRetryRoute(id, { body, cookie: other.cookie });
  assert.equal(crossAccount.status, 404);
  assert.deepEqual(crossAccount.json, { error: "Report not found" }, "a report someone else owns is indistinguishable from a missing one");
  const missing = await callRetryRoute("does-not-exist", { body, cookie: owner.cookie });
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json, crossAccount.json);
  const untouched = await readRow(id);
  assert.equal(sha(untouched.payload_json), sha(before.payload_json));
  assert.deepEqual(aiColumnsOf(untouched), aiColumnsOf(before));

  // A legacy anonymous row (user_id NULL): retry-by-id is authenticated-owner only — no claim-by-retry (unlike a full resave).
  await env.client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, ai_score, ai_tone, ai_status, payload_json, user_id, room_number, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: ["g2-legacy-anon", "legacy-device", "sub-legacy", "Legacy", new Date().toISOString(), 10, 0, "Low", null, null, "failed", JSON.stringify({ id: "g2-legacy-anon", text: "legacy text" }), null, null],
  });
  const legacy = await callRetryRoute("g2-legacy-anon", { body, cookie: owner.cookie });
  assert.equal(legacy.status, 404);
  const legacyRow = await readRow("g2-legacy-anon");
  assert.equal(legacyRow.user_id, null, "the anonymous row was not claimed");
  assert.equal(legacyRow.ai_status, "failed");
});

test("TRUST BOUNDARY: everything in the body except the five AI values is ignored — forged device key, owner, room, text, scores, similarity and interpretation change nothing", async () => {
  const account = accounts.guard;
  const id = "g2-forged-fields";
  await asBrowser(account, async () => { await seedReport(account, { id, room: 1, text: manuscript.small }); });
  const before = await readRow(id);
  const subtreesBefore = await rawSubtrees(id);
  const forged = {
    ...retryBody(manuscript.small),
    deviceKey: "attacker-device", userId: "attacker", user_id: "attacker", room: 9, id: "other-report", title: "Hijacked", wordCount: 1, archiveScore: 100, scoreBand: "High",
    unifiedSimilarity: { unifiedScore: 100 }, evidenceInterpretation: { format: "forged" }, reportCompletion: { forged: true }, text: "forged text",
    payload: { ...retryBody(manuscript.small).payload, unifiedSimilarity: { unifiedScore: 100 }, evidenceInterpretation: { format: "forged" }, text: "forged text", externalAcademicEvidence: [{ forged: true }], userSuppliedReferenceEvidence: [{ forged: true }] },
  };
  const result = await callRetryRoute(id, { body: forged, cookie: account.cookie });
  assert.equal(result.status, 200);
  const after = await readRow(id);
  assert.deepEqual(scalarsOf(after), scalarsOf(before));
  assert.deepEqual(withoutAiFields(payloadOf(after)), withoutAiFields(payloadOf(before)));
  assert.deepEqual(await rawSubtrees(id), subtreesBefore);
  assert.equal(after.ai_status, "ready");
  assert.equal(await readRow("other-report"), null, "no other report id was created or touched");
});

test("VALIDATION: malformed or inconsistent AI results are rejected 400 and write nothing", async () => {
  const account = accounts.guard;
  const id = "g2-validation";
  await asBrowser(account, async () => { await seedReport(account, { id, room: 2, text: manuscript.small }); });
  const before = await readRow(id);
  const good = retryBody(manuscript.small);
  const bad = [
    ["not JSON", { rawBody: "{nope" }],
    ["array body", { body: [] }],
    ["bad aiStatus", { body: { ...good, aiStatus: "processing" } }],
    ["non-numeric aiScore", { body: { ...good, aiScore: "7" } }],
    ["NaN-ish aiScore (null-serialised is fine, string is not)", { body: { ...good, aiScore: "NaN" } }],
    ["oversized aiTone", { body: { ...good, aiTone: "x".repeat(65) } }],
    ["missing payload", { body: { aiStatus: "ready", aiScore: 7, aiTone: "low" } }],
    ["missing aiAnalysis", { body: { ...good, payload: { aiScore: 7 } } }],
    ["aiAnalysis is an array", { body: { ...good, payload: { aiScore: 7, aiAnalysis: [] } } }],
    ["unknown analysis status", { body: { ...good, payload: { aiScore: 7, aiAnalysis: { status: "great" } } } }],
    ["passages not an array", { body: { ...good, payload: { aiScore: 7, aiAnalysis: { status: "complete", passages: "x" } } } }],
    ["ready but analysis not complete", { body: { ...good, payload: { aiScore: 7, aiAnalysis: { status: "error", passages: [] } } } }],
    ["failed but analysis complete", { body: { ...good, aiStatus: "failed" } }],
  ];
  for (const [label, input] of bad) {
    const result = await callRetryRoute(id, { ...input, cookie: account.cookie });
    assert.equal(result.status, 400, `${label} -> 400`);
  }
  const after = await readRow(id);
  assert.equal(sha(after.payload_json), sha(before.payload_json));
  assert.deepEqual(aiColumnsOf(after), aiColumnsOf(before));
});

test("TRANSPORT GUARDS apply to the retry route too: a Content-Length over the ceiling, or a body over it without a Content-Length, is 413 and writes nothing — the ceiling itself is unchanged", async () => {
  const account = accounts.guard;
  const id = "g2-transport";
  await asBrowser(account, async () => { await seedReport(account, { id, room: 3, text: manuscript.small }); });
  const before = await readRow(id);
  const declared = await callRetryRoute(id, { body: retryBody(manuscript.small), cookie: account.cookie, contentLength: MAX_REPORT_SAVE_REQUEST_BYTES + 1 });
  assert.equal(declared.status, 413);
  const huge = JSON.stringify({ ...retryBody(manuscript.small), padding: "x".repeat(MAX_REPORT_SAVE_REQUEST_BYTES) });
  const undeclared = await callRetryRoute(id, { rawBody: huge, cookie: account.cookie, contentLength: 1 });
  assert.equal(undeclared.status, 413, "a client that lies about (or omits) Content-Length still cannot get past the body-size check");
  assert.equal(sha((await readRow(id)).payload_json), sha(before.payload_json));
});

test("PERSISTENCE CEILING is not raised: an AI result that would push the saved payload past MAX_REPORT_SAVE_REQUEST_BYTES is never persisted (G2 size policy — the server writes its own tiny terminal 'AI unavailable' state instead of the old bare 413; the real result and the saved report's other fields are untouched); just under it succeeds", async () => {
  const account = accounts.guard;
  const insertRow = async (id, paddingChars, room) => {
    await env.client.execute({
      sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, ai_score, ai_tone, ai_status, payload_json, user_id, room_number, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
      args: [id, account.deviceKey, `sub-${id}`, "Padded", new Date().toISOString(), 10, 0, "Low", null, null, "failed", JSON.stringify({ id, text: "t", padding: "p".repeat(paddingChars) }), account.userId, room],
    });
  };
  const body = retryBody(manuscript.small);
  const aiChars = JSON.stringify(body.payload.aiAnalysis).length;
  await insertRow("g2-ceiling-over", MAX_REPORT_SAVE_REQUEST_BYTES - aiChars + 500, 8);
  const beforeOver = await readRow("g2-ceiling-over");
  const over = await callRetryRoute("g2-ceiling-over", { body, cookie: account.cookie });
  // G2 size policy (POLICY_B_KEEP_REPORT_AI_UNAVAILABLE_FOR_SIZE, tests/ai-size-unavailable-policy.test.mjs): the real result is
  // still refused — never persisted, the ceiling is unchanged — but the report is not left processing/retrying behind a
  // deterministic 413: the SERVER records the terminal, non-retryable "AI unavailable for this document" state and says so.
  assert.equal(over.status, 200);
  assert.deepEqual(over.json, { ok: true, aiOutcome: "SIZE_UNAVAILABLE" });
  const afterOver = await readRow("g2-ceiling-over");
  assert.equal(afterOver.ai_status, "failed");
  assert.equal(afterOver.ai_score, null, "no AI score is persisted for the terminal state");
  const overPayload = payloadOf(afterOver);
  assert.equal(overPayload.aiAnalysis.unavailableReason, "REPORT_SIZE");
  assert.deepEqual(overPayload.aiAnalysis.passages, [], "none of the oversized result's passages were persisted");
  assert.ok(String(afterOver.payload_json).length <= MAX_REPORT_SAVE_REQUEST_BYTES, "and the saved report still fits the (unchanged) ceiling");
  const { aiAnalysis: _overAi, aiScore: _overScore, ...overRest } = overPayload;
  const { aiAnalysis: _beforeAi, aiScore: _beforeScore, ...beforeRest } = payloadOf(beforeOver);
  assert.deepEqual(overRest, beforeRest, "every other field of the saved report is untouched");

  await insertRow("g2-ceiling-under", MAX_REPORT_SAVE_REQUEST_BYTES - aiChars - 500, 9);
  const under = await callRetryRoute("g2-ceiling-under", { body, cookie: account.cookie });
  assert.equal(under.status, 200);
  assert.ok(String((await readRow("g2-ceiling-under")).payload_json).length <= MAX_REPORT_SAVE_REQUEST_BYTES);
});

test("SERVER FAILURE is bounded and generic: an infrastructure error yields a fixed 500 body — no internal message, path or driver text reaches the customer", async () => {
  const account = accounts.guard;
  const previousUrl = process.env.TURSO_DATABASE_URL;
  const previousToken = process.env.TURSO_AUTH_TOKEN;
  const ip = "g2-server-failure";
  await fx.resetRateForTest(ip); // before the environment is broken — the test helper itself needs the DB
  process.env.TURSO_DATABASE_URL = "libsql://unreachable.invalid"; // remote URL with no token: getReportsDbClient() throws inside the route
  delete process.env.TURSO_AUTH_TOKEN;
  try {
    const text = JSON.stringify(retryBody(manuscript.small));
    const response = await aiRetryRoute.POST(
      new Request("http://localhost/api/reports/g2-any/ai-retry", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip, "content-length": String(Buffer.byteLength(text)), cookie: `tp_session_v1=${account.cookie}` },
        body: text,
      }),
      { params: Promise.resolve({ id: "g2-any" }) },
    );
    const bodyText = await response.text();
    assert.equal(response.status, 500);
    assert.deepEqual(JSON.parse(bodyText), { error: "Unable to save the AI result. Please try again." });
    assert.doesNotMatch(bodyText, /TURSO|token|libsql|invalid|sqlite/i);
  } finally {
    process.env.TURSO_DATABASE_URL = previousUrl;
    if (previousToken !== undefined) process.env.TURSO_AUTH_TOKEN = previousToken;
  }
});

// ----------------------------------------------------------------------------------------------------------------
// 4. R2 read safety, compact rows, stale clients
// ----------------------------------------------------------------------------------------------------------------

test("R2: a report whose persisted explanation cannot be decoded is REFUSED (the same generic 503 GET returns) and left byte-identical — a retry can never repair it from the browser's copy", async () => {
  const account = accounts.r2;
  const cases = [
    ["unknown format", "g2-r2-unknown-format", (payload) => { payload.evidenceInterpretation = { format: "future-compact/9", formatVersion: 9 }; }],
    ["corrupt compact table", "g2-r2-corrupt", (payload) => {
      const kinds = Object.keys(payload.evidenceInterpretation.countsByKind);
      payload.evidenceInterpretation.countsByKind[kinds[0]] += 1;
    }],
  ];
  await asBrowser(account, async (route) => {
    for (const [index, [label, id, corrupt]] of cases.entries()) {
      const { report } = await seedReport(account, { id, room: index, text: manuscript.small });
      const payload = payloadOf(await readRow(id));
      corrupt(payload);
      await env.client.execute({ sql: "UPDATE saved_reports SET payload_json = ? WHERE id = ?", args: [JSON.stringify(payload), id] });
      const before = await readRow(id);

      assert.equal(await fetchRemoteReport(id), null, `${label}: fixture sanity — GET refuses this row`);

      // The browser still holds a perfectly readable LOCAL copy — the case the old resave "repaired" by recomputing from it.
      const { enriched, summary } = enrichForRetry(report, manuscript.small);
      const retried = await persistAiRetryResult(enriched, summary);
      assert.equal(retried.ok, false, `${label}: refused`);
      const request = route.requests.filter((r) => r.path === `/api/reports/${id}/ai-retry`).at(-1);
      assert.equal(request.status, 503);
      const after = await readRow(id);
      assert.equal(sha(after.payload_json), sha(before.payload_json), `${label}: the persisted report is byte-identical`);
      assert.deepEqual(aiColumnsOf(after), aiColumnsOf(before), `${label}: AI columns untouched too`);
    }
  });
  // Direct route response: generic, no decoder internals, no report data.
  const direct = await callRetryRoute("g2-r2-corrupt", { body: retryBody(manuscript.small), cookie: account.cookie });
  assert.equal(direct.status, 503);
  assert.deepEqual(direct.json, { error: "Report temporarily unavailable", code: "REPORT_TEMPORARILY_UNAVAILABLE" });
  assert.doesNotMatch(direct.bodyText, /UNSUPPORTED|COUNT_MISMATCH|compact|format|countsByKind/i);
});

test("STALE CLIENT: a browser holding an OLDER report (fetched before the server's similarity moved on) cannot overwrite the newer similarity — the retry carries no similarity at all", async () => {
  const account = accounts.stale;
  const id = "g2-stale";
  // The manuscript contains a passage that is NOT in the corpus yet.
  const lateExtended = fx.buildLateSourcePassage(2500);
  const text = `${manuscript.small} ${lateExtended}`;
  await asBrowser(account, async (route) => {
    await seedReport(account, { id, room: 0, text });
    const stale = await fetchRemoteReport(id);            // version A, what the (stale) browser holds
    const rowA = await readRow(id);
    const generationA = payloadOf(rowA).unifiedSimilarityGeneration;

    // The server moves on: the corpus gains that passage, and the report is re-finalized against it (version B).
    await env.promoteDocumentIntoCorpus(lateExtended);
    const restoreCompact = fx.pinCompactWrites("true");
    try {
      const clientReport = fx.buildFirstSaveBody({ deviceKey: account.deviceKey, id, text, room: 0 }).payload;
      const resave = await saveReportRemote(clientReport, { ...buildReportSummary(clientReport), aiStatus: "failed", similarityStatus: "pending" }, undefined, 0);
      assert.equal(resave.ok, true);
    } finally {
      restoreCompact();
    }
    const rowB = await readRow(id);
    const subtreesB = await rawSubtrees(id);
    assert.ok(subtreesB.gen > generationA, "fixture sanity: the server's similarity generation advanced");
    assert.notEqual(payloadOf(rowB).unifiedSimilarity.unifiedScore + ":" + payloadOf(rowB).unifiedSimilarity.uniqueMatchedWords, stale.unifiedSimilarity.unifiedScore + ":" + stale.unifiedSimilarity.uniqueMatchedWords, "fixture sanity: version B genuinely differs from version A");

    // Retry from the STALE copy.
    const { enriched, summary } = enrichForRetry(stale, text);
    const retried = await persistAiRetryResult(enriched, summary);
    assert.equal(retried.ok, true);
    const request = route.requests.filter((r) => r.path === `/api/reports/${id}/ai-retry`).at(-1);
    assert.equal(request.status, 200);

    assert.deepEqual(await rawSubtrees(id), subtreesB, "the NEWER similarity / evidence / generation survived byte-for-byte");
    console.log("[g2-ai-retry] stale:", JSON.stringify({
      generationA, generationB: subtreesB.gen,
      scoreA: stale.unifiedSimilarity.unifiedScore, wordsA: stale.unifiedSimilarity.uniqueMatchedWords,
      scoreB: payloadOf(rowB).unifiedSimilarity.unifiedScore, wordsB: payloadOf(rowB).unifiedSimilarity.uniqueMatchedWords,
      subtreesAfterRetryEqualB: true, retryRequestBytes: request.bytes,
    }));
    const after = await readRow(id);
    assert.deepEqual(withoutAiFields(payloadOf(after)), withoutAiFields(payloadOf(rowB)));
    assert.equal(after.ai_status, "ready", "and the AI result did land");
    // Structurally: nothing in the request could carry the stale similarity.
    const captured = JSON.stringify({ aiStatus: "ready", aiScore: summary.aiScore, aiTone: summary.aiTone, payload: { aiScore: enriched.aiScore, aiAnalysis: enriched.aiAnalysis } });
    assert.ok(!captured.includes("unifiedSimilarity") && !captured.includes("evidenceInterpretation"));
  });
});

test("AI-COLUMN SEMANTICS match SAVE_REPORT_SQL: 'ready' is sticky against a late 'failed'; a retry that still cannot complete records 'failed'; a retry that completes records 'ready'", async () => {
  const account = accounts.misc;
  await asBrowser(account, async (route) => {
    // failed -> failed (AI still unavailable): terminal failed, similarity untouched, room poll says failed.
    await seedReport(account, { id: "g2-ai-failed-again", room: 0, text: manuscript.small });
    const before = await readRow("g2-ai-failed-again");
    const full = await fetchRemoteReport("g2-ai-failed-again");
    const stillFailing = enrichForRetry(full, manuscript.small, "error");
    assert.equal((await persistAiRetryResult(stillFailing.enriched, stillFailing.summary)).ok, true);
    const afterFailed = await readRow("g2-ai-failed-again");
    assert.equal(afterFailed.ai_status, "failed");
    assert.equal(payloadOf(afterFailed).aiAnalysis.status, "error");
    assert.deepEqual(withoutAiFields(payloadOf(afterFailed)), withoutAiFields(payloadOf(before)));
    const room = await fetchReportRoomContents(0);
    assert.equal(room.ok && room.contents.status, "failed");
    assert.equal(room.contents.report.similarityStatus, "resolved");

    // failed -> ready.
    const recovered = enrichForRetry(full, manuscript.small, "complete");
    assert.equal((await persistAiRetryResult(recovered.enriched, recovered.summary)).ok, true);
    assert.equal((await readRow("g2-ai-failed-again")).ai_status, "ready");

    // ready -> late failed: LIFECYCLE-02 parity — the genuine ready result is not displaced.
    const readyRow = await readRow("g2-ai-failed-again");
    const late = enrichForRetry(full, manuscript.small, "error");
    assert.equal((await persistAiRetryResult(late.enriched, late.summary)).ok, true, "accepted (200) but a no-op, exactly like the resave path");
    const afterLate = await readRow("g2-ai-failed-again");
    assert.equal(sha(afterLate.payload_json), sha(readyRow.payload_json));
    assert.deepEqual(aiColumnsOf(afterLate), aiColumnsOf(readyRow));
    void route;
  });
});

// ----------------------------------------------------------------------------------------------------------------
// 5. Normal save / resave must be unchanged; client helpers; structure
// ----------------------------------------------------------------------------------------------------------------

test("NORMAL SAVE / NON-RETRY RESAVE UNCHANGED: the first save and the automatic post-upload AI resave still go through POST /api/reports with the whole report, are re-finalized server-side, and keep their request-ceiling guard", async () => {
  const account = accounts.misc;
  const id = "g2-normal-save";
  await asBrowser(account, async (route) => {
    const restoreCompact = fx.pinCompactWrites("true");
    try {
      const report = fx.buildFirstSaveBody({ deviceKey: account.deviceKey, id, text: manuscript.small, room: 1 }).payload;
      const processing = { ...buildReportSummary(report), aiStatus: "processing", similarityStatus: "pending" };
      assert.equal((await saveReportRemote(report, processing, undefined, 1)).ok, true);
      const firstSave = route.requests.filter((r) => r.path === "/api/reports" && r.method === "POST").at(-1);
      assert.ok(firstSave.bytes > byteLength(report), "the first save carries the whole report (plus its envelope)");
      const afterFirst = payloadOf(await readRow(id));
      assert.ok(afterFirst.unifiedSimilarity, "the server finalized similarity on the first save");
      assert.equal(afterFirst.evidenceInterpretation.format, "compact", "and persisted it compact only because the write flag was ON");

      // The automatic post-upload AI pass: an ordinary resave of the client's own report. (Writer gate OFF — this test pins
      // the LEGACY, default behaviour; the gate-ON automatic save is proved in tests/ai-compact-passages-integration.test.mjs.)
      const aiResult = { aiScore: 7, aiAnalysis: fx.syntheticAiAnalysis(manuscript.small, { status: "complete" }) };
      const enriched = { ...report, ...aiResult };
      const summary = { ...buildReportSummary(enriched), aiStatus: "ready", similarityStatus: "pending" };
      assert.equal((await fx.withAiCompactWrites(undefined, () => persistAiCompletion(enriched, summary, 1))).ok, true);
      const resave = route.requests.filter((r) => r.path === "/api/reports" && r.method === "POST").at(-1);
      assert.ok(resave.bytes > byteLength(aiResult.aiAnalysis), "the resave path still ships the whole enriched report");
      assert.equal((await readRow(id)).ai_status, "ready");
    } finally {
      restoreCompact();
    }
    // The request-ceiling guard on the ordinary save path is exactly as before.
    const oversized = fx.buildFirstSaveBody({ deviceKey: account.deviceKey, id: "g2-normal-oversized", text: "word ".repeat(450_000), room: 2 });
    const rejected = await saveReportRemote(oversized.payload, { ...buildReportSummary(oversized.payload), aiStatus: "processing" }, undefined, 2);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.status, 413);
    assert.equal(await readRow("g2-normal-oversized"), null, "nothing persisted");
  });
});

test("COMPACT WRITE FLAG stays default OFF and untouched by the retry path; the retry route decodes compact rows regardless of it", () => {
  assert.equal(fx.COMPACT_GATE in process.env, false, "the flag is not set anywhere in this process");
  assert.equal(resolveCompactPersistenceWrites(), false, "default OFF");
  return Promise.all([
    readFile(new URL("../lib/report-compact-persistence-flag.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/reports/[id]/ai-retry/route.ts", import.meta.url), "utf8"),
  ]).then(([flagSource, routeSource]) => {
    assert.match(flagSource, /process\.env\.REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED === "true"/, "flag semantics unchanged");
    assert.doesNotMatch(routeSource, /REPORT_COMPACT_PERSISTENCE_WRITE|encodeReportForPersistence|resolveCompactPersistenceWrites/, "the retry route never encodes/compacts anything, so it has no write-flag dependency");
  });
});

test("CLIENT HELPERS: saveAiRetryResultRemote sends exactly the five AI values and shares saveReportRemote's failure shape; persistAiRetryResult never throws, writes the local cache best-effort, and refuses non-terminal input", async () => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push({ url: String(url), init }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); };
  try {
    const ok = await saveAiRetryResultRemote({ id: "r/1", aiStatus: "ready", aiScore: 3, aiTone: "low", rawAiScore: 4, aiAnalysis: { status: "complete", passages: [] } });
    assert.deepEqual(ok, { ok: true });
    assert.equal(seen[0].url, "/api/reports/r%2F1/ai-retry");
    assert.equal(seen[0].init.method, "POST");
    assert.deepEqual(JSON.parse(seen[0].init.body), { aiStatus: "ready", aiScore: 3, aiTone: "low", payload: { aiScore: 4, aiAnalysis: { status: "complete", passages: [] } } });
    assert.equal("deviceKey" in JSON.parse(seen[0].init.body), false, "no device key, room or owner is sent");

    globalThis.fetch = async () => new Response(JSON.stringify({ error: "nope" }), { status: 413 });
    assert.deepEqual(await saveAiRetryResultRemote({ id: "1", aiStatus: "failed", aiScore: null, aiTone: null, rawAiScore: null, aiAnalysis: { status: "error" } }), { ok: false, status: 413, quotaExceeded: false, roomOccupied: false, roomReuseNotReady: false, error: "nope" });
    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    assert.deepEqual(await saveAiRetryResultRemote({ id: "1", aiStatus: "failed", aiScore: null, aiTone: null, rawAiScore: null, aiAnalysis: { status: "error" } }), { ok: false, status: 0, quotaExceeded: false, roomOccupied: false, roomReuseNotReady: false });
  } finally {
    globalThis.fetch = original;
  }

  const summary = { id: "9", submissionId: "s", title: "t", createdAt: new Date().toISOString(), wordCount: 1, archiveScore: 0, scoreBand: "Low", aiScore: 5, aiTone: "low", aiStatus: "ready" };
  const report = { id: 9, aiScore: 6, aiAnalysis: { status: "complete" } };
  let captured = null;
  const okRemote = async (input) => { captured = input; return { ok: true }; };
  assert.deepEqual(await persistAiRetryResult(report, summary, okRemote), { ok: true, summary });
  assert.deepEqual(captured, { id: "9", aiStatus: "ready", aiScore: 5, aiTone: "low", rawAiScore: 6, aiAnalysis: { status: "complete" } });
  assert.equal((await persistAiRetryResult(report, summary, async () => ({ ok: false, status: 503 }))).ok, false);
  await assert.doesNotReject(persistAiRetryResult(report, summary, async () => { throw new Error("boom"); }));
  assert.equal((await persistAiRetryResult(report, summary, async () => { throw new Error("boom"); })).ok, false);
  captured = null;
  assert.equal((await persistAiRetryResult(report, { ...summary, aiStatus: "processing" }, okRemote)).ok, false, "a non-terminal AI state is never sent");
  assert.equal((await persistAiRetryResult({ id: 9 }, summary, okRemote)).ok, false, "a report with no aiAnalysis is never sent");
  assert.equal(captured, null);
});

test("STRUCTURE: retryAiCheck persists through saveRetriedAiResult and can never re-POST the report; the automatic post-upload pass and the anonymous flow still use the ordinary resave; saveReportRemote still posts the whole report", async () => {
  const shell = await readFile(new URL("../app/reports/rooms/[room]/room-page-shell.tsx", import.meta.url), "utf8");
  const remote = await readFile(new URL("../lib/reports-remote.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  const retryFn = shell.match(/async function retryAiCheck\(reportId: string\) \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(retryFn, "retryAiCheck found");
  // The retry lifecycle: in-flight guard, "retrying" state on, model run, save, terminal state off.
  assert.match(retryFn, /if \(retryingAi\) return;\s*\n\s*setRetryingAi\(true\);/);
  assert.match(retryFn, /finally \{\s*\n\s*setRetryingAi\(false\);/);
  assert.match(retryFn, /await saveRetriedAiResult\(full, aiResult\)/);
  assert.doesNotMatch(retryFn, /saveEnrichedAiResult\(|persistAiCompletion\(|saveReportRemote\(/, "retry never calls the whole-report save path");
  // The local-copy-first / remote-fallback load is unchanged, and both feed the same safe save.
  assert.match(retryFn, /getStoredReportById<SimilarityReport>\(reportId\)/);
  assert.match(retryFn, /fetchRemoteReport<SimilarityReport>\(reportId\)/);

  const retrySave = shell.match(/async function saveRetriedAiResult\([\s\S]*?\n {2}\}/)?.[0] ?? "";
  const enrichedSave = shell.match(/async function saveEnrichedAiResult\([\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(retrySave && enrichedSave);
  assert.match(retrySave, /await persistAiRetryResult\(enriched, enrichedSummary\)/);
  assert.doesNotMatch(retrySave, /persistAiCompletion\(|saveReportRemote\(/);
  // The two AI-save paths must never disagree on when a room is 'ready'/'failed': identical summary derivation and identical room transition.
  const tail = (source) => source.slice(source.indexOf("const enriched")).replace(/persistAi(Completion|RetryResult)\([^)]*\)/, "PERSIST()").replace(/(enrichedSaveResult|retrySaveResult)/g, "R");
  assert.equal(tail(retrySave), tail(enrichedSave), "saveRetriedAiResult == saveEnrichedAiResult apart from the persistence call");

  assert.match(shell, /completeAiAnalysisWithRecovery\(aiAnalysisPromise, \(aiResult\) => saveEnrichedAiResult\(report, aiResult\)\)/, "the automatic post-upload pass is unchanged");
  assert.match(page, /await persistAiCompletion\(enriched, enrichedSummary\);/, "the anonymous flow's AI resave is unchanged");
  // saveReportRemote still posts the whole report to the ordinary save route — its payload differs from the client's report
  // only by the ai-compact-v1 transport step (a no-op unless the writer gate is on and the report carries an AI result).
  const saveRemoteFn = remote.match(/export async function saveReportRemote[\s\S]*?\n\}\r?\n/)?.[0] ?? "";
  assert.ok(saveRemoteFn.length > 500, "saveReportRemote found");
  assert.match(saveRemoteFn, /fetch\("\/api\/reports", \{/);
  assert.match(saveRemoteFn, /payload: prepareReportForTransport\(report\),/);
  assert.match(remote, /import \{ prepareReportForTransport \} from "\.\/ai-passage-table";/);
  assert.doesNotMatch(saveRemoteFn, /ai-retry/);
});
