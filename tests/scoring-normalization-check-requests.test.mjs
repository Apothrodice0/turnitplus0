import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";

import { applyMigrationsLibsql } from "../lib/ingest.js";
import { seedArchiveDocument } from "../lib/archive-corpus-seed.ts";
import { rebuildArchiveScalableIndex } from "../lib/archive-index-build.ts";
import { resetRateForTest, resetAuthRateForTest } from "../lib/rate-limit.ts";
import { withTestIdentity } from "./helpers/test-signup.mjs";
import {
  ACTIVE_SCORING_NORMALIZATION_VERSION,
  reportScoringNormalizationVersion,
  tokensForScoringNormalization,
} from "../lib/similarity-core.ts";
import { canonicalSha256 } from "../lib/document-identity.ts";
import { academicEvidenceSubmissionBinding } from "../lib/academic-search-diagnostics-repo.ts";
import { snapshotMatcherVersion } from "../lib/report-historical-match.ts";
import { analyzeArchive, __resetArchiveEngineForTests } from "../lib/archive-analysis-runtime.ts";
import { analyzeAcademicEvidence, analyzeText, attachEvidenceInterpretation, attachUnifiedSimilarity, enrichReportWithAcademicEvidence } from "../lib/document-check-pipeline.ts";
import { saveReportRemote } from "../lib/reports-remote.ts";
import { buildReportSummary } from "../lib/report-types.ts";
import { buildReportV2ViewModel } from "../lib/report-v2-view.ts";
import { decodeReportFromPersistence } from "../lib/report-persistence.ts";

/**
 * The check-time half of the scoring-normalization protocol: what a browser
 * bundle sends when it runs a check, and what the two check-time routes do
 * with it — then one whole ordinary check, client code against the real
 * routes.
 *
 * ACTIVE_SCORING_NORMALIZATION_VERSION is the contract THIS BUILD computes a
 * new check under. Exactly one assertion below pins its value; everything
 * else is written in terms of it and holds for either value.
 */

const cp = (n) => String.fromCodePoint(n);
const ACTIVE = ACTIVE_SCORING_NORMALIZATION_VERSION;
const OTHER = ACTIVE === 1 ? 2 : 1;

// ── THE PIN ───────────────────────────────────────────────────────────────
test("THIS BUILD computes a new check under scoring normalization v2", () => {
  assert.equal(ACTIVE_SCORING_NORMALIZATION_VERSION, 2);
});

// A manuscript both contracts read differently: three in-word invisible characters in the copied sentence.
const SENTENCES = [
  `The constitutional court exa${cp(0x00ad)}mined whether the legis${cp(0x2060)}lative amendment affected the indepen${cp(0x200f)}dence of the judiciary and the effective separation of powers.`,
  "Its reasoning emphasised that meaningful oversight requires sufficient financial autonomy, transparent appointment procedures, and a reliable mechanism for reviewing official conduct.",
  "The judges further observed that the office of the prosecutor had repeatedly failed to publish its annual reports, which undermined public confidence in criminal proceedings.",
  "Affluent districts reshuffled their budgets while poorer municipalities struggled with difficult staffing conflicts and baffling administrative requirements.",
];
const TEXT = SENTENCES.join(" ");
const WORDS = { 1: tokensForScoringNormalization(TEXT, 1).length, 2: tokensForScoringNormalization(TEXT, 2).length };
const MEMBER = new RegExp(`[${cp(0x00ad)}${cp(0x2060)}${cp(0x200f)}]`, "u");

test("FIXTURE: the two contracts count this manuscript's words differently", () => {
  assert.equal(WORDS[1], WORDS[2] + 3);
});

// ── database, a small server-side archive, the routes ─────────────────────
const repo = path.resolve(".");
const dbFile = path.join(repo, "test_scoring_normalization_check_requests.db");
for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + s); } catch { /* ignore */ } }
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.ARCHIVE_SERVER_SIDE_ENABLED = "true";
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";
delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
delete process.env.SELECTIVE_CORPUS_AUTHORITATIVE_ENABLED;
delete process.env.IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH;

const dbClient = createClient({ url: `file:${dbFile}` });
await dbClient.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(dbClient, path.join(repo, "drizzle"));
const uniq = (ns, i) => `zq${ns}x${i.toString(36)}w`;
const distinctive = (ns, n) => Array.from({ length: n }, (_, i) => uniq(ns, i)).join(" ");
for (const [order, doc] of [
  { id: "snq-a", title: "Unrelated archive source A", body: distinctive(1, 500) },
  { id: "snq-b", title: "Unrelated archive source B", body: distinctive(2, 500) },
].entries()) {
  const seeded = await seedArchiveDocument(
    dbClient,
    { archiveArticleId: doc.id, title: doc.title, originalSimilarity: null, text: doc.body, archiveOrder: order },
    { corpusVersion: "check-requests-test-v1", firstSeenAt: "2020-01-01 00:00:00" },
  );
  assert.equal(seeded.status, "SEEDED");
}
await rebuildArchiveScalableIndex(dbClient);

const archiveMatchRoute = await import("../app/api/archive/match/route.ts");
const academicEvidenceRoute = await import("../app/api/academic-evidence/route.ts");
const reportsRoute = await import("../app/api/reports/route.ts");
const signupRoute = await import("../app/api/auth/signup/route.ts");

const realFetch = globalThis.fetch;
const realWindow = globalThis.window;
test.after(() => {
  globalThis.fetch = realFetch;
  globalThis.window = realWindow;
  __resetArchiveEngineForTests();
  dbClient.close();
  delete process.env.ARCHIVE_SERVER_SIDE_ENABLED;
  delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + s); } catch { /* ignore */ } }
});

let ipCounter = 0;
function request(url, method, body, cookie) {
  ipCounter += 1;
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `snq-ip-${ipCounter}`, ...(cookie ? { cookie: `tp_session_v1=${cookie}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
/** An external academic provider that is reachable and finds nothing — the scholarly matcher still runs and builds its queries. */
const emptyProviderResponse = () => new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
const withProviders = async (work) => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => emptyProviderResponse();
  try { return await work(); } finally { globalThis.fetch = previous; }
};
async function diagnosticsRow(id) {
  const row = (await dbClient.execute({ sql: "SELECT submission_canonical_sha256, queries_json, evidence_json FROM academic_search_run_diagnostics WHERE id = ?", args: [id] })).rows[0];
  return { binding: String(row.submission_canonical_sha256), queries: row.queries_json ? JSON.parse(String(row.queries_json)) : [], evidence: row.evidence_json };
}

// ══ POST /api/archive/match ═══════════════════════════════════════════════
test("POST /api/archive/match computes under the contract the request declares — absent is v1 — and says which one it was", async () => {
  for (const [declared, version] of [[undefined, 1], [null, 1], [1, 1], [2, 2]]) {
    const res = await archiveMatchRoute.POST(request("/api/archive/match", "POST", { text: TEXT, ...(declared === undefined ? {} : { scoringNormalization: declared }) }));
    assert.equal(res.status, 200, String(declared));
    const body = await res.json();
    assert.equal(body.scoringNormalization, version, String(declared));
    assert.equal(body.result.wordCount, WORDS[version], `declared ${String(declared)}: the word count is the v${version} count`);
    assert.deepEqual(Object.keys(body).sort(), ["result", "scoringNormalization"], "the contract sits beside the frozen result shape, not inside it");
    assert.equal("scoringNormalization" in body.result, false);
  }
  for (const bad of [0, 3, "2", true, {}]) {
    const res = await archiveMatchRoute.POST(request("/api/archive/match", "POST", { text: TEXT, scoringNormalization: bad }));
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.deepEqual(await res.json(), { error: "scoringNormalization must be 1 or 2" });
  }
});

// ══ POST /api/academic-evidence ═══════════════════════════════════════════
test("POST /api/academic-evidence runs the scholarly matcher under the declared contract — absent is v1 — and binds the stored row to it", async () => {
  const hash = canonicalSha256(TEXT);
  for (const [declared, version] of [[undefined, 1], [1, 1], [2, 2]]) {
    const res = await withProviders(() => academicEvidenceRoute.POST(request("/api/academic-evidence", "POST", { text: TEXT, ...(declared === undefined ? {} : { scoringNormalization: declared }) })));
    assert.equal(res.status, 200, String(declared));
    const body = await res.json();
    assert.equal(typeof body.academicSearchDiagnosticsId, "number", `declared ${String(declared)}: the run was recorded`);
    const row = await diagnosticsRow(body.academicSearchDiagnosticsId);
    assert.equal(row.binding, academicEvidenceSubmissionBinding(hash, version), `declared ${String(declared)}: the row is bound to v${version}`);
    assert.equal(row.binding === hash, version === 1, "a v1 row stores the plain canonical hash, as every earlier row does");
    // The matcher really ran under that contract: its discovery queries are built from the text as that contract reads it.
    assert.ok(row.queries.length > 0);
    const leaked = row.queries.some((query) => MEMBER.test(query.queryText));
    assert.equal(leaked, version === 1, version === 1 ? "v1 discovery is unchanged: the invisible characters still reach its queries" : "v2 discovery queries carry no invisible character");
  }
  for (const bad of [0, 3, "1", false, []]) {
    const res = await withProviders(() => academicEvidenceRoute.POST(request("/api/academic-evidence", "POST", { text: TEXT, scoringNormalization: bad })));
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
});

// ══ what the client code sends ════════════════════════════════════════════
test("the archive check declares the bundle's own contract, and refuses a result computed under any other", async () => {
  const frozenResult = { wordCount: WORDS[ACTIVE], databaseSize: 2, excludedDocuments: 0, matchedWordCount: 0, archiveMatchedPositions: [], score: 0, scoreBand: "Low", riskStatus: "Lower", riskTarget: 0, riskCutoff: 0, riskCalibration: { auc: 0, precision: 0, recall: 0, sampleSize: 0 }, features: {}, corpusVersion: "x", sources: [], repeats: [] };
  const run = async (serverEcho) => {
    const sent = [];
    __resetArchiveEngineForTests();
    globalThis.fetch = async (input, init = {}) => {
      if ((init.method ?? "GET") === "GET") return new Response(JSON.stringify({ archiveServerSide: true }), { status: 200 });
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ result: frozenResult, ...(serverEcho === undefined ? {} : { scoringNormalization: serverEcho }) }), { status: 200 });
    };
    try {
      return { result: await analyzeArchive(TEXT, "m.txt", () => undefined), sent };
    } finally {
      globalThis.fetch = realFetch;
      __resetArchiveEngineForTests();
    }
  };
  const honoured = await run(ACTIVE);
  assert.deepEqual(honoured.sent, [{ text: TEXT, scoringNormalization: ACTIVE }]);
  assert.deepEqual(honoured.result, frozenResult);
  await assert.rejects(() => run(OTHER), /different scoring normalization/);
  // A server that does not say (one older than the declaration) computed v1: usable by a v1 bundle only.
  if (ACTIVE === 1) assert.deepEqual((await run(undefined)).result, frozenResult);
  else await assert.rejects(() => run(undefined), /different scoring normalization/);
});

test("the scholarly check declares the bundle's own contract", async () => {
  const sent = [];
  globalThis.fetch = async (input, init = {}) => {
    sent.push({ url: String(input), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ evidence: [], status: "COMPLETE_NO_MATCHES", academicSearchDiagnosticsId: 7 }), { status: 200 });
  };
  try {
    const result = await analyzeAcademicEvidence(TEXT);
    assert.equal(result.academicSearchDiagnosticsId, 7);
    assert.deepEqual(sent, [{ url: "/api/academic-evidence", body: { text: TEXT, scoringNormalization: ACTIVE } }]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a save declares THE REPORT's contract — never the saving bundle's: an unstamped report is declared 1 and a stamped one 2, by any build", async () => {
  const store = new Map();
  globalThis.window = { localStorage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => { store.set(key, value); } } };
  const sent = [];
  globalThis.fetch = async (input, init = {}) => {
    if (String(input) === "/api/reports") sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const base = { version: 11, id: 501, submissionId: "s501", title: "t", author: "", assignment: "", created: "2026-10-01T00:00:00.000Z", score: 0, archiveScore: 0, wordCount: 10, scoreBand: "Low", matchedWordCount: 0, archiveMatchedPositions: [], sources: [], repeats: [], text: "some words here" };
    for (const [report, declared] of [
      [base, 1],
      [{ ...base, id: 502, scoringNormalizationVersion: 2 }, 2],
      // Not exactly 2 is not a v2 report.
      [{ ...base, id: 503, scoringNormalizationVersion: "2" }, 1],
      [{ ...base, id: 504, scoringNormalizationVersion: 1 }, 1],
    ]) {
      sent.length = 0;
      const result = await saveReportRemote(report, buildReportSummary(report), null, 0);
      assert.deepEqual(result, { ok: true });
      assert.equal(sent.length, 1);
      assert.equal(sent[0].scoringNormalization, declared, `report ${report.id}`);
      // A sibling of the payload — and the payload is sent as the report is.
      assert.equal(sent[0].payload.scoringNormalizationVersion, report.scoringNormalizationVersion);
      assert.equal("scoringNormalization" in sent[0].payload, false);
    }
  } finally {
    globalThis.fetch = realFetch;
    globalThis.window = realWindow;
  }
});

// ══ one whole ordinary check, client code against the real routes ═════════
const cookieOf = (res) => (res.headers.get("set-cookie")?.match(/tp_session_v1=([^;]*)/) ?? [])[1] ?? null;
async function account(tag) {
  await resetAuthRateForTest(`snq-signup-${tag}`);
  const res = await signupRoute.POST(new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `snq-signup-${tag}` },
    body: JSON.stringify(withTestIdentity({ email: `snq-${tag}@example.test`, password: "snq-pw-123456", username: `snqu${tag}`, deviceKey: `snq-dev-${tag}` })),
  }));
  assert.equal(res.status, 201);
  return { cookie: cookieOf(res), deviceKey: `snq-dev-${tag}` };
}

test("AN ORDINARY CHECK on this build — archive, scholarly and save, the real client code against the real routes — is one report wholly in the build's own contract", async () => {
  const acc = await account("e2e");
  const store = new Map([["tp_device_key_v1", acc.deviceKey]]);
  globalThis.window = { localStorage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => { store.set(key, value); } } };
  const requests = [];
  __resetArchiveEngineForTests();
  // The browser's fetch, wired to the route handlers; anything else is an external academic provider.
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = init.method ?? "GET";
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
    if (url === "/api/archive/match") {
      requests.push({ url, method, declared: body?.scoringNormalization });
      await resetRateForTest(`snq-ip-${ipCounter + 1}`);
      return method === "GET" ? archiveMatchRoute.GET() : archiveMatchRoute.POST(request(url, method, body));
    }
    if (url === "/api/academic-evidence") {
      requests.push({ url, method, declared: body?.scoringNormalization });
      return academicEvidenceRoute.POST(request(url, method, body));
    }
    if (url === "/api/reports") {
      requests.push({ url, method, declared: body?.scoringNormalization });
      return reportsRoute.POST(request(url, method, body, acc.cookie));
    }
    if (url.startsWith("/api/")) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    return emptyProviderResponse();
  };
  try {
    // generateReport() / runCheck(), in order.
    const academicPromise = analyzeAcademicEvidence(TEXT);
    let report = await analyzeText(TEXT, "ordinary-check.txt", TEXT.length, () => undefined, "author@example.test");
    const academic = await academicPromise;
    report = attachEvidenceInterpretation(attachUnifiedSimilarity(enrichReportWithAcademicEvidence(report, academic)));

    // The report object the browser now holds.
    assert.equal(reportScoringNormalizationVersion(report), ACTIVE);
    assert.equal("scoringNormalizationVersion" in report, ACTIVE === 2, "v1 is the absent field");
    assert.equal(report.wordCount, WORDS[ACTIVE]);
    assert.equal(typeof academic.academicSearchDiagnosticsId, "number");

    const saved = await saveReportRemote({ ...report, aiAnalysis: undefined }, { ...buildReportSummary(report), aiStatus: "processing" }, academic.academicSearchDiagnosticsId, 0);
    assert.deepEqual(saved, { ok: true });

    // Every request of the check declared the same contract — the build's.
    assert.deepEqual(
      requests.filter((entry) => entry.method === "POST").map((entry) => [entry.url, entry.declared]).sort(),
      [["/api/academic-evidence", ACTIVE], ["/api/archive/match", ACTIVE], ["/api/reports", ACTIVE]],
    );

    // What the server persisted.
    const row = (await dbClient.execute({ sql: "SELECT payload_json, word_count FROM saved_reports WHERE device_key = ? AND id = ?", args: [acc.deviceKey, String(report.id)] })).rows[0];
    assert.ok(row, "the report was saved");
    const payload = JSON.parse(String(row.payload_json));
    const decoded = decodeReportFromPersistence(payload);
    assert.equal("scoringNormalizationVersion" in payload, ACTIVE === 2);
    assert.equal(reportScoringNormalizationVersion(decoded), ACTIVE);
    assert.equal(decoded.wordCount, WORDS[ACTIVE]);
    assert.equal(Number(row.word_count), WORDS[ACTIVE]);
    assert.ok(decoded.unifiedSimilarity, "the server finalized the similarity at write time");
    assert.ok(decoded.unifiedSimilarity.matchedPositions.every((position) => position < WORDS[ACTIVE]));
    const snapshot = (await dbClient.execute({ sql: "SELECT matcher_version FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?", args: [acc.deviceKey, String(report.id)] })).rows[0];
    assert.equal(String(snapshot.matcher_version), snapshotMatcherVersion(ACTIVE));
    const diagnostics = await diagnosticsRow(academic.academicSearchDiagnosticsId);
    assert.equal(diagnostics.binding, academicEvidenceSubmissionBinding(canonicalSha256(TEXT), ACTIVE));
    // It renders: the view model builds, and its word count is the report's own.
    assert.ok(buildReportV2ViewModel(decoded));
  } finally {
    globalThis.fetch = realFetch;
    globalThis.window = realWindow;
    __resetArchiveEngineForTests();
  }
});
