import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { canonicalSha256 } from "../lib/document-identity.ts";
import { canonicalizeText } from "../lib/canonical-text.ts";
import { tokens } from "../lib/similarity-core.ts";
import { runCorpusAdmissionPromotionSweep } from "../lib/corpus-admission-promotion.ts";
import { bumpCorpusMatchGeneration } from "../lib/corpus-match-generation.ts";
import { matureCorpusBackings } from "./helpers/corpus-maturity.mjs";
import { resetRateForTest, resetReadRateForTest, resetAuthRateForTest } from "../lib/rate-limit.ts";
import { scheduleReportShadowEvaluations } from "../lib/report-shadow-evaluations.ts";
import { SHADOW_POLICY } from "./helpers/corpus-duplicate-shadow.mjs";
import * as reportsRoute from "../app/api/reports/route.ts";
import * as reportIdRoute from "../app/api/reports/[id]/route.ts";
import * as signupRoute from "../app/api/auth/signup/route.ts";

/**
 * Phase B2a — POST + GET both schedule the corpus-duplicate suppression shadow
 * evaluator via the shared lib/report-shadow-evaluations.ts helper; the two
 * converge on ONE row; a failure never affects the response; and no B2 field
 * ever reaches an ordinary user's report payload.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_corpus_duplicate_suppression_shadow_trigger.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";

const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);
const openConnection = () => createClient({ url: `file:${dbFile}` });

test.after(() => {
  client.close();
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
});

let seq = 0;
const uniq = (p) => `${p}-${++seq}`;

const CORPUS_TEXT =
  "Glaciologists drilling a network of shallow firn cores across an ice-sheet divide reconstructed the last two centuries of accumulation and found that a mid-century step change in snowfall, rather than any gradual trend, best explained the divergence between the two flanks, a result they cross-checked against three independent stake networks and a reanalysis of the regional wind field.";

async function promoteDocumentIntoCorpus(text) {
  const hash = canonicalSha256(text);
  const decisionId = randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_decisions
          (id, run_id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes,
           detected_format, extracted_word_count, detected_language, language_confidence, canonical_sha256, extractor_version,
           content_store_id, quality_score, quality_model_version, component_scores, feature_vector, feature_vector_version,
           corpus_value_score, corpus_value_model_version, family_relation, family_matched_source_ref, family_containment,
           consent_metadata, dry_run, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [
      decisionId, null, `cds-${randomUUID()}`, "v1", "ACCEPT", "[]", 1, "[]",
      "txt", 200, "English", 0.95, hash, "v1", null, 80, "v1",
      "{}", "{}", "v1", 0.9, "v1", "NONE", null, null,
      JSON.stringify({ kind: "PER_USER_CONSENT", consented: true }), 0,
    ],
  });
  await client.execute({
    sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version, revoked_at, created_at)
          VALUES (?,?,?,?,?,NULL,CURRENT_TIMESTAMP)`,
    args: [randomUUID(), decisionId, hash, tokens(canonicalizeText(text)).length, "v1"],
  });
  await client.execute({
    sql: `INSERT INTO corpus_admission_content_store (id, decision_id, canonical_sha256, canonical_text, extractor_version, retention_basis, stored_at)
          VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [randomUUID(), decisionId, hash, text, "v1", "LICENSED_REUSE"],
  });
  const sweep = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  assert.equal(sweep.results.find((r) => r.decisionId === decisionId)?.outcome, "indexed", "promotion must succeed");
  await matureCorpusBackings(client);
}

function extractCookie(res) {
  const m = (res.headers.get("set-cookie") || "").match(/tp_session_v1=([^;]*)/);
  return m ? m[1] : null;
}
async function signUp() {
  seq += 1;
  const tag = `cds-signup-${seq}`;
  await resetAuthRateForTest(tag);
  const email = `cds-user-${seq}@example.test`;
  const deviceKey = `cds-device-${seq}`;
  const res = await signupRoute.POST(new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": tag },
    body: JSON.stringify({ email, password: "cds-pw-123456", username: `cds${seq}`, deviceKey }),
  }));
  assert.equal(res.status, 201);
  const row = await client.execute({ sql: "SELECT id FROM users WHERE email = ?", args: [email] });
  return { userId: String(row.rows[0].id), deviceKey, cookie: extractCookie(res), tag: `cds-${seq}` };
}
async function postReport(acc, { id, text }) {
  await resetRateForTest(acc.tag + "-post");
  const wordCount = tokens(canonicalizeText(text)).length;
  return reportsRoute.POST(new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": acc.tag + "-post", cookie: `tp_session_v1=${acc.cookie}` },
    body: JSON.stringify({
      deviceKey: acc.deviceKey, id, submissionId: "sub-" + id, title: "t", createdAt: new Date().toISOString(),
      wordCount, archiveScore: 0, scoreBand: "Low", aiScore: 2, aiTone: "low", aiStatus: "ready", room: 0,
      payload: { version: 11, id: 1, submissionId: "sub-" + id, title: "t", author: "", assignment: "", created: new Date().toISOString(), score: 0, archiveScore: 0, wordCount, scoreBand: "Low", matchedWordCount: 0, sources: [], repeats: [], text },
    }),
  }));
}
async function getReport(acc, id) {
  await resetReadRateForTest(acc.tag + "-get");
  return reportIdRoute.GET(new Request(`http://localhost/api/reports/${id}`, {
    headers: { "x-forwarded-for": acc.tag + "-get", cookie: `tp_session_v1=${acc.cookie}` },
  }), { params: Promise.resolve({ id: String(id) }) });
}
async function b2Row(deviceKey, reportId) {
  const r = await client.execute({
    sql: "SELECT * FROM corpus_duplicate_suppression_shadow_evaluations WHERE report_device_key = ? AND report_id = ? AND policy_version = ?",
    args: [deviceKey, reportId, SHADOW_POLICY],
  });
  return r.rows[0] ? { ...r.rows[0] } : null;
}

test("POST /api/reports schedules the corpus-duplicate shadow — a real promoted-corpus exact match yields an OK CROSS_ACCOUNT_EXACT_CANONICAL row, no GET needed", async () => {
  await promoteDocumentIntoCorpus(CORPUS_TEXT);
  const acc = await signUp();
  const reportId = "cds-post-1";
  assert.equal((await postReport(acc, { id: reportId, text: CORPUS_TEXT })).status, 200);

  const row = await b2Row(acc.deviceKey, reportId);
  assert.ok(row, "B2 row exists purely from the POST lifecycle");
  assert.equal(String(row.status), "OK");
  assert.equal(String(row.measurement_category), "CROSS_ACCOUNT_EXACT_CANONICAL");
  assert.equal(Number(row.candidate_count), 1);
  assert.equal(Number(row.authoritative_score), 100);
  assert.equal(Number(row.hypothetical_score), 0);
  assert.equal(Number(row.score_delta), 100);
  assert.equal(Number(row.candidate_admitted_promotion_backing_count), 1);
});

test("GET /api/reports/[id] schedules it too (fallback) and converges on ONE row with the POST-scheduled run", async () => {
  await promoteDocumentIntoCorpus(CORPUS_TEXT + " Second distinct promoted source.");
  const acc = await signUp();
  const reportId = "cds-postget-1";
  assert.equal((await postReport(acc, { id: reportId, text: CORPUS_TEXT + " Second distinct promoted source." })).status, 200);
  assert.equal((await getReport(acc, reportId)).status, 200);
  assert.equal((await getReport(acc, reportId)).status, 200);

  const count = await client.execute({
    sql: "SELECT COUNT(*) n FROM corpus_duplicate_suppression_shadow_evaluations WHERE report_device_key = ? AND report_id = ?",
    args: [acc.deviceKey, reportId],
  });
  assert.equal(Number(count.rows[0].n), 1, "exactly one B2 row after POST + 2 GETs");
});

test("a real corpus-generation bump between views forces re-evaluation", async () => {
  await promoteDocumentIntoCorpus(CORPUS_TEXT + " Third distinct promoted source.");
  const acc = await signUp();
  const reportId = "cds-gen-1";
  assert.equal((await postReport(acc, { id: reportId, text: CORPUS_TEXT + " Third distinct promoted source." })).status, 200);
  const first = await b2Row(acc.deviceKey, reportId);
  assert.ok(first);
  const gen1 = Number(first.authoritative_corpus_generation);

  await bumpCorpusMatchGeneration(client);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal((await getReport(acc, reportId)).status, 200);

  const second = await b2Row(acc.deviceKey, reportId);
  assert.ok(Number(second.authoritative_corpus_generation) > gen1, "the B2 row picked up the new generation");
  assert.notEqual(String(second.computed_at), String(first.computed_at), "recomputed");
});

test("a deferred shadow failure never rejects out of scheduleReportShadowEvaluations, and no B2 row is written", async () => {
  await assert.doesNotReject(() => scheduleReportShadowEvaluations({
    reportDeviceKey: "cds-fail-dk", reportId: "cds-fail-r", accountId: "acc",
    rawText: "irrelevant.",
    productionResult: { status: "MATCHED", matches: [], computedAt: new Date().toISOString(), matcherVersion: "x", fingerprintVersion: "x", canonicalizationVersion: "x" },
    authoritativeUnifiedSimilarity: null, effectiveDeviceSelfRepresentationIds: [], authoritativeCorpusGeneration: 1,
    authoritativeArchiveMatchedPositions: null, authoritativeExternalAcademicEvidence: null,
    openConnection: () => ({ execute: async () => { throw new Error("simulated shadow DB outage"); }, batch: async () => { throw new Error("outage"); }, close() {} }),
  }));
  assert.equal(await b2Row("cds-fail-dk", "cds-fail-r"), null);
});

test("the ordinary (non-admin) report payload carries NO B2 field", async () => {
  await promoteDocumentIntoCorpus(CORPUS_TEXT + " Fourth distinct promoted source.");
  const acc = await signUp();
  const reportId = "cds-payload-1";
  assert.equal((await postReport(acc, { id: reportId, text: CORPUS_TEXT + " Fourth distinct promoted source." })).status, 200);
  const res = await getReport(acc, reportId);
  assert.equal(res.status, 200);
  const bodyText = await res.text();
  assert.doesNotMatch(bodyText, /corpusDuplicateSuppressionShadow|corpus_duplicate_suppression_shadow|hypotheticalScore|hypothetical_score|scoreDelta|measurementCategory|measurement_category|checker_accounts|SINGLE_BACKING_NO_MULTI_ORIGIN_EVIDENCE|MULTI_ORIGIN_NOT_PROVEN|CROSS_ACCOUNT_EXACT_CANONICAL/);
  const body = JSON.parse(bodyText);
  assert.equal(body.payload.corpusDuplicateSuppressionShadow, undefined);
});

test("the persisted authoritative unified score is unchanged by the B2 shadow scheduling", async () => {
  await promoteDocumentIntoCorpus(CORPUS_TEXT + " Fifth distinct promoted source.");
  const acc = await signUp();
  const reportId = "cds-invariance-1";
  assert.equal((await postReport(acc, { id: reportId, text: CORPUS_TEXT + " Fifth distinct promoted source." })).status, 200);
  const saved1 = await client.execute({ sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [acc.deviceKey, reportId] });
  const score1 = JSON.stringify(JSON.parse(String(saved1.rows[0].payload_json)).unifiedSimilarity);

  await getReport(acc, reportId);
  await getReport(acc, reportId);

  const saved2 = await client.execute({ sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [acc.deviceKey, reportId] });
  const score2 = JSON.stringify(JSON.parse(String(saved2.rows[0].payload_json)).unifiedSimilarity);
  assert.equal(score2, score1, "unifiedSimilarity JSON byte-identical before/after B2 shadow runs");
});

test("item 1: concurrent report finalizations — each B2 row reflects ONLY its own request's captured inputs", async () => {
  // Two concurrent POSTs whose shadow evaluations are CATEGORICALLY different:
  //   A -> a promoted exact-canonical corpus source (OK / CROSS_ACCOUNT / 1 candidate),
  //   B -> plain text that matches nothing            (SKIPPED_NOT_MATCHED / 0 candidates),
  // and with different word counts. Both are fired via Promise.all so their
  // deferred shadow evaluations interleave at every await. The POST route's
  // shadow-input capture is ONE request-local object, set once inside the
  // handler; were it module-scope (shared), whichever deferred evaluator ran
  // second would read the other request's productionResult / unifiedSimilarity
  // and produce a row with the wrong status, candidate shape, or word count.
  const textA = CORPUS_TEXT + " Concurrent source A trailing clause about moraine ridges.";
  const textB = "An entirely unrelated paragraph about municipal water metering and seasonal demand forecasting that is not in the corpus and matches nothing, written with enough distinct words to have its own stable canonical form.";
  await promoteDocumentIntoCorpus(textA);
  const wcA = tokens(canonicalizeText(textA)).length;
  const wcB = tokens(canonicalizeText(textB)).length;
  assert.notEqual(wcA, wcB, "fixture sanity: the two submissions have different word counts");

  const accA = await signUp();
  const accB = await signUp();

  const [ra, rb] = await Promise.all([
    postReport(accA, { id: "cds-conc-a", text: textA }),
    postReport(accB, { id: "cds-conc-b", text: textB }),
  ]);
  assert.equal(ra.status, 200);
  assert.equal(rb.status, 200);

  const rowA = await b2Row(accA.deviceKey, "cds-conc-a");
  const rowB = await b2Row(accB.deviceKey, "cds-conc-b");
  assert.ok(rowA && rowB, "both B2 rows exist purely from the concurrent POST lifecycle");

  // A: its own promoted exact-canonical candidate.
  assert.equal(String(rowA.status), "OK");
  assert.equal(String(rowA.measurement_category), "CROSS_ACCOUNT_EXACT_CANONICAL");
  assert.equal(Number(rowA.candidate_count), 1);
  assert.equal(Number(rowA.authoritative_score), 100);
  assert.equal(Number(rowA.submitted_word_count), wcA);

  // B: matched nothing — never contaminated by A's candidate / score.
  assert.equal(String(rowB.status), "SKIPPED_NOT_MATCHED");
  assert.equal(Number(rowB.candidate_count), 0);
  assert.equal(rowB.authoritative_score, null);
  assert.equal(Number(rowB.submitted_word_count), wcB);
});
