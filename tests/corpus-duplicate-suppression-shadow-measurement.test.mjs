import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { resetRateForTest, resetReadRateForTest, resetAuthRateForTest } from "../lib/rate-limit.ts";
import {
  summarizeCorpusDuplicateSuppressionShadowMeasurement,
  SHADOW_POLICY_VERSION,
  DEFAULT_RECENT_CANDIDATE_LIMIT,
  MAX_RECENT_CANDIDATE_LIMIT,
} from "../lib/corpus-duplicate-suppression-shadow-measurement.ts";
import { CORPUS_DUPLICATE_SUPPRESSION_SHADOW_POLICY_VERSION } from "../lib/corpus-duplicate-suppression-shadow.ts";
import * as signupRoute from "../app/api/auth/signup/route.ts";
import * as loginRoute from "../app/api/auth/login/route.ts";
import * as cdShadowRoute from "../app/api/developer/corpus-duplicate-suppression-shadow/route.ts";
import { withTestIdentity, grantTestAdmin } from './helpers/test-signup.mjs';

/**
 * Phase B2b — ADMIN-ONLY corpus-duplicate suppression shadow measurement
 * summary (lib/corpus-duplicate-suppression-shadow-measurement.ts + the
 * app/api/developer/corpus-duplicate-suppression-shadow route).
 *
 * Covers: SELECT-only / no-scoring-import containment, admin-only access,
 * non-admin invisibility, real-measurement statistics filtered to
 * status IN ('OK','BOUNDED'), FAILED / SKIPPED never landing in the 0-delta
 * bucket, candidate frequency, delta buckets, 100->0 and 100->partial counts,
 * checker OK/FAILED aggregation, error_code aggregation, recentLimit
 * default/cap, no prohibited identity/provenance value in the output, and a
 * plain 404 for a non-admin.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_corpus_duplicate_suppression_shadow_measurement.db");
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.ADMIN_EMAIL = "cdsm-admin@example.com";

const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.ADMIN_EMAIL;
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
  }
});

let seq = 0;
const uniq = (p) => `${p}-${++seq}`;

const COLS = [
  "report_device_key", "report_id", "status", "error_code",
  "checker_accounts_status", "distinct_checker_accounts_bucket",
  "policy_version", "rule_version", "unified_similarity_version", "counterfactual_version",
  "authoritative_corpus_generation", "authoritative_snapshot_computed_at", "submitted_word_count",
  "authoritative_score", "hypothetical_score", "score_delta",
  "authoritative_unique_matched_words", "hypothetical_unique_matched_words", "unique_matched_words_removed",
  "candidate_matched_words", "candidates_excluded",
  "archive_only_words_surviving", "live_academic_only_words_surviving",
  "previous_upload_only_words_surviving", "overlap_words_surviving",
  "candidate_count", "measurement_category", "origin_confidence", "multi_origin_evidence",
  "candidate_admitted_promotion_backing_count", "candidate_submission_reference_backing_count",
  "candidate_independent_backing_count", "candidate_same_device_backing_count",
  "same_passport_category", "cross_account_category", "evaluation_truncated", "total_runtime_ms", "computed_at",
];

async function seedRow(overrides = {}) {
  const row = {
    report_device_key: uniq("dk"), report_id: uniq("r"), status: "OK", error_code: null,
    checker_accounts_status: "NOT_APPLICABLE", distinct_checker_accounts_bucket: null,
    policy_version: SHADOW_POLICY_VERSION, rule_version: "document-local-corpus-duplicate-policy-v1",
    unified_similarity_version: "unified-similarity-vX", counterfactual_version: "corpus-duplicate-counterfactual-v1",
    authoritative_corpus_generation: null, authoritative_snapshot_computed_at: null, submitted_word_count: null,
    authoritative_score: null, hypothetical_score: null, score_delta: null,
    authoritative_unique_matched_words: null, hypothetical_unique_matched_words: null, unique_matched_words_removed: null,
    candidate_matched_words: null, candidates_excluded: null,
    archive_only_words_surviving: null, live_academic_only_words_surviving: null,
    previous_upload_only_words_surviving: null, overlap_words_surviving: null,
    candidate_count: null, measurement_category: null, origin_confidence: null, multi_origin_evidence: null,
    candidate_admitted_promotion_backing_count: null, candidate_submission_reference_backing_count: null,
    candidate_independent_backing_count: null, candidate_same_device_backing_count: null,
    same_passport_category: null, cross_account_category: null, evaluation_truncated: 0, total_runtime_ms: null,
    computed_at: "2026-09-03 00:00:00",
    ...overrides,
  };
  await client.execute({
    sql: `INSERT INTO corpus_duplicate_suppression_shadow_evaluations (${COLS.join(", ")})
          VALUES (${COLS.map(() => "?").join(", ")})`,
    args: COLS.map((c) => row[c]),
  });
  return { deviceKey: row.report_device_key, reportId: row.report_id };
}

// ---------------------------------------------------------------------------
// STRUCTURAL — SELECT-only, no scoring/counterfactual imports, no secret names
// ---------------------------------------------------------------------------

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
function importLines(src) {
  return src.split(/\r?\n/).filter((l) => /^\s*(?:import|export)\b.*\bfrom\b/.test(l)).join("\n");
}
const MODULE_SRC = fs.readFileSync(path.join(repoRoot, "lib/corpus-duplicate-suppression-shadow-measurement.ts"), "utf8");
const ROUTE_SRC = fs.readFileSync(path.join(repoRoot, "app/api/developer/corpus-duplicate-suppression-shadow/route.ts"), "utf8");

test("drift-guard: SHADOW_POLICY_VERSION is pinned to the evaluator's own constant", () => {
  assert.equal(SHADOW_POLICY_VERSION, CORPUS_DUPLICATE_SUPPRESSION_SHADOW_POLICY_VERSION);
});

test("structural: the measurement module issues no write statement and no DDL", () => {
  const code = stripComments(MODULE_SRC);
  assert.doesNotMatch(code, /\bINSERT\s+INTO\b/i, "no INSERT");
  assert.doesNotMatch(code, /\bUPDATE\s+\w+\s+SET\b/i, "no UPDATE");
  assert.doesNotMatch(code, /\bDELETE\s+FROM\b/i, "no DELETE");
  assert.doesNotMatch(code, /\b(CREATE|ALTER|DROP)\s+(TABLE|TRIGGER|INDEX)\b/i, "no DDL");
  assert.doesNotMatch(code, /\bUPSERT\b|ON\s+CONFLICT/i, "no upsert");
  // every client.execute is a SELECT
  for (const m of code.matchAll(/sql:\s*`([\s\S]*?)`/g)) {
    assert.match(m[1].trim(), /^SELECT\b/i, `every embedded SQL statement must be a SELECT — got: ${m[1].slice(0, 40)}`);
  }
});

test("structural: the measurement module imports nothing on the scoring / counterfactual / matcher path", () => {
  assert.doesNotMatch(
    importLines(MODULE_SRC),
    /unified-similarity|report-primary-similarity|user-submission-matching|report-historical-match|similarity-core|similarity-worker|corpus-duplicate-counterfactual|corpus-duplicate-suppression-policy|corpus-duplicate-suppression-shadow|device-self-scoring|report-shadow-evaluations/,
    "no scoring / counterfactual / policy / matcher / evaluator import",
  );
  // the ONLY import is the libsql Client type
  const imports = importLines(MODULE_SRC).split(/\r?\n/).filter(Boolean);
  assert.equal(imports.length, 1, `expected exactly one import line, got:\n${imports.join("\n")}`);
  assert.match(imports[0], /from\s+["']@libsql\/client["']/);
  const code = stripComments(MODULE_SRC);
  assert.doesNotMatch(code, /\bcomputeUnifiedSimilarity\b|\bcomputeCorpusDuplicateCounterfactual\b|\bclassifyDocumentLocalCorpusDuplicate\b/);
  assert.doesNotMatch(code, /hypotheticalExcludedRepresentationIds/, "must never name the shadow exclusion token");
});

test("structural: the measurement module reads only corpus_duplicate_suppression_shadow_evaluations", () => {
  const code = stripComments(MODULE_SRC);
  const tables = [...code.matchAll(/\bFROM\s+([a-z_0-9]+)/gi)].map((m) => m[1]);
  assert.ok(tables.length > 0, "expected at least one FROM clause");
  for (const t of tables) {
    assert.equal(t, "corpus_duplicate_suppression_shadow_evaluations", `reads an unexpected table: ${t}`);
  }
  for (const forbidden of ["saved_reports", "document_identities", "users", "historical_match_shadow_evaluations", "device_passports", "corpus_submission_references", "corpus_admission_decisions"]) {
    assert.equal(code.includes(forbidden), false, `must not reference ${forbidden}`);
  }
});

test("structural: no prohibited identity / provenance column name appears in the module", () => {
  const code = stripComments(MODULE_SRC);
  // NB: `same_passport_category` / `samePassportCategory` is an ALLOWED bounded
  // relationship-category boolean (0/1) from drizzle/0044 — it is not a
  // device-passport identifier. The forbidden patterns below target ids / keys
  // / fingerprints / raw provenance, never that bounded category flag.
  for (const forbidden of [
    /device_passport/i, /passport_?id/i, /passport.*fingerprint/i, /public_?key/i, /\bspki\b/i,
    /\bemail\b/i, /account_id/i, /\bhmac\b/i, /source_ref/i, /canonical_sha/i, /filename/i,
    /\braw_?text\b/i, /representation_id/i, /document_identity_id/i, /_json\b/i, /proposed_evidence/i,
  ]) {
    assert.doesNotMatch(code, forbidden, `measurement module must not reference ${forbidden}`);
  }
});

test("structural: the route is admin-gated and 404s (never 401/403) for a non-admin", () => {
  assert.match(ROUTE_SRC, /getAdminSessionUser/);
  assert.match(ROUTE_SRC, /checkRate/);
  assert.match(ROUTE_SRC, /status:\s*404/);
  assert.doesNotMatch(ROUTE_SRC, /status:\s*40[13]/, "must never return 401/403");
});

test("structural: the route's error path leaks a caught exception NOWHERE — not the response, not the log", () => {
  const code = stripComments(ROUTE_SRC);
  // the 500 body is the single constant string marker (no template / interpolation)
  assert.match(code, /error:\s*'measurement_unavailable'/);
  assert.match(code, /status:\s*500/);
  // bare `catch {` — the caught exception is never bound, so it can never be
  // read, coerced, narrowed, or serialised anywhere downstream.
  assert.match(code, /\}\s*catch\s*\{/, "must use a bare `catch {`");
  assert.doesNotMatch(code, /\bcatch\s*\(/, "the caught exception must NOT be bound (`catch (err)` is forbidden)");
  assert.doesNotMatch(code, /err\.message|error\.message|\.stack\b/i, "no .message / .stack of a caught value");
  assert.doesNotMatch(code, /String\s*\(\s*(err|error|e)\b/i, "no String(err) coercion of a caught value");
  assert.doesNotMatch(code, /\binstanceof\s+Error\b/, "no `instanceof Error` narrowing of a caught value");
  assert.doesNotMatch(code, /JSON\.stringify\s*\(\s*(err|error|e)\b/i, "no caught object serialised into the response");
  // console.error is called exactly once, and only ever with the constant
  // operational marker string — never a variable, object, or second argument.
  const logCalls = [...code.matchAll(/console\.error\s*\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.deepEqual(logCalls, ["'corpus-duplicate-suppression-shadow measurement unavailable'"], "console.error must be the constant marker only");
});

// ---------------------------------------------------------------------------
// EMPTY TABLE (runs before any seeding)
// ---------------------------------------------------------------------------

test("empty table: every metric is zero / empty, recent is [], no throw", async () => {
  const s = await summarizeCorpusDuplicateSuppressionShadowMeasurement(client);
  assert.equal(s.policyVersion, SHADOW_POLICY_VERSION);
  assert.equal(s.totals.evaluations, 0);
  assert.equal(s.totals.ok, 0);
  assert.equal(s.totals.bounded, 0);
  assert.equal(s.totals.failed, 0);
  assert.equal(s.totals.skipped, 0);
  assert.equal(s.totals.realMeasurementRows, 0);
  assert.equal(s.totals.candidatePositive, 0);
  assert.equal(s.candidateFrequency, 0);
  assert.deepEqual(s.candidateCountDistribution, { zero: 0, one: 0, twoPlus: 0 });
  assert.deepEqual(s.measurementCategoryDistribution, {});
  assert.deepEqual(s.originConfidenceDistribution, {});
  assert.deepEqual(s.multiOriginEvidenceDistribution, {});
  assert.deepEqual(s.scoreDeltaBuckets, { zero: 0, d1to9: 0, d10to24: 0, d25to49: 0, d50to99: 0, d100: 0 });
  assert.equal(s.averageScoreDelta, null);
  assert.equal(s.averageScoreDeltaWhereCandidate, null);
  assert.equal(s.authoritative100Hypothetical0Count, 0);
  assert.equal(s.authoritative100HypotheticalPartialCount, 0);
  assert.deepEqual(s.checkerAccountsStatusDistribution, {});
  assert.deepEqual(s.distinctCheckerAccountsBucketDistribution, {});
  assert.deepEqual(s.errorCodeDistribution, {});
  assert.deepEqual(s.reconciliation, { checkedRows: 0, reconciledRows: 0 });
  assert.deepEqual(s.recentCandidates, []);
  assert.equal(s.recentCandidatesLimit, DEFAULT_RECENT_CANDIDATE_LIMIT);
});

// ---------------------------------------------------------------------------
// AGGREGATION CORRECTNESS against a hand-computed A–H fixture
// ---------------------------------------------------------------------------

async function seedFixture() {
  // A — OK candidate, authoritative 100 -> hypothetical 0 (delta 100)
  await seedRow({
    report_id: "FX-A", status: "OK", computed_at: "2026-09-03 01:00:01",
    checker_accounts_status: "OK", distinct_checker_accounts_bucket: "2",
    authoritative_score: 100, hypothetical_score: 0, score_delta: 100,
    authoritative_unique_matched_words: 100, hypothetical_unique_matched_words: 0, unique_matched_words_removed: 100,
    candidate_matched_words: 100, candidates_excluded: 1,
    archive_only_words_surviving: 0, live_academic_only_words_surviving: 0,
    previous_upload_only_words_surviving: 0, overlap_words_surviving: 0,
    candidate_count: 1, measurement_category: "CROSS_ACCOUNT_EXACT_CANONICAL",
    origin_confidence: "SINGLE_BACKING_NO_MULTI_ORIGIN_EVIDENCE", multi_origin_evidence: "MULTI_ORIGIN_NOT_PROVEN",
    same_passport_category: 0, cross_account_category: 1,
  });
  // B — OK candidate, authoritative 100 -> hypothetical 40 (delta 60); external evidence survives
  await seedRow({
    report_id: "FX-B", status: "OK", computed_at: "2026-09-03 01:00:02",
    checker_accounts_status: "OK", distinct_checker_accounts_bucket: "1",
    authoritative_score: 100, hypothetical_score: 40, score_delta: 60,
    authoritative_unique_matched_words: 100, hypothetical_unique_matched_words: 40, unique_matched_words_removed: 60,
    candidate_matched_words: 60, candidates_excluded: 1,
    archive_only_words_surviving: 20, live_academic_only_words_surviving: 10,
    previous_upload_only_words_surviving: 5, overlap_words_surviving: 5,
    candidate_count: 1, measurement_category: "CROSS_ACCOUNT_EXACT_CANONICAL",
    origin_confidence: "SINGLE_BACKING_NO_MULTI_ORIGIN_EVIDENCE", multi_origin_evidence: "MULTI_ORIGIN_NOT_PROVEN",
    same_passport_category: 0, cross_account_category: 1,
  });
  // C — BOUNDED candidate (defensive cap hit), delta 5, checker probe FAILED
  await seedRow({
    report_id: "FX-C", status: "BOUNDED", computed_at: "2026-09-03 01:00:03",
    checker_accounts_status: "FAILED", distinct_checker_accounts_bucket: null,
    authoritative_score: 50, hypothetical_score: 45, score_delta: 5,
    authoritative_unique_matched_words: 50, hypothetical_unique_matched_words: 45, unique_matched_words_removed: 5,
    candidate_matched_words: 8, candidates_excluded: 2,
    archive_only_words_surviving: 30, live_academic_only_words_surviving: 0,
    previous_upload_only_words_surviving: 10, overlap_words_surviving: 5,
    candidate_count: 2, measurement_category: "CROSS_ACCOUNT_EXACT_CANONICAL",
    origin_confidence: "SINGLE_BACKING_NO_MULTI_ORIGIN_EVIDENCE", multi_origin_evidence: "MULTI_ORIGIN_NOT_PROVEN",
    same_passport_category: 0, cross_account_category: 1, evaluation_truncated: 1,
  });
  // D — OK, no candidate, delta 0 (a real 0, must land in the zero bucket)
  await seedRow({
    report_id: "FX-D", status: "OK", computed_at: "2026-09-03 01:00:04",
    checker_accounts_status: "NOT_APPLICABLE",
    authoritative_score: 12, hypothetical_score: 12, score_delta: 0,
    authoritative_unique_matched_words: 12, hypothetical_unique_matched_words: 12, unique_matched_words_removed: 0,
    candidate_matched_words: 0, candidates_excluded: 0,
    archive_only_words_surviving: 12, live_academic_only_words_surviving: 0,
    previous_upload_only_words_surviving: 0, overlap_words_surviving: 0,
    candidate_count: 0, measurement_category: "NOT_EXACT_CANONICAL",
    origin_confidence: "NOT_EVALUATED", multi_origin_evidence: "N/A",
    same_passport_category: 0, cross_account_category: 0,
  });
  // E — FAILED, PROVENANCE_QUERY_FAILED (every measurement column NULL)
  await seedRow({ report_id: "FX-E", status: "FAILED", error_code: "PROVENANCE_QUERY_FAILED", computed_at: "2026-09-03 01:00:05" });
  // F — FAILED, COUNTERFACTUAL_INVARIANT
  await seedRow({ report_id: "FX-F", status: "FAILED", error_code: "COUNTERFACTUAL_INVARIANT", computed_at: "2026-09-03 01:00:06" });
  // G — SKIPPED_NOT_MATCHED (candidate_count is a real 0; score columns NULL)
  await seedRow({
    report_id: "FX-G", status: "SKIPPED_NOT_MATCHED", computed_at: "2026-09-03 01:00:07",
    submitted_word_count: 500, candidate_count: 0, measurement_category: "NOT_MATCHED",
    origin_confidence: "NOT_EVALUATED", multi_origin_evidence: "N/A",
  });
  // H — SKIPPED_NO_AUTHORITATIVE (everything NULL)
  await seedRow({ report_id: "FX-H", status: "SKIPPED_NO_AUTHORITATIVE", computed_at: "2026-09-03 01:00:08" });
  // X — a DIFFERENT policy_version row that must be ignored entirely
  await seedRow({
    report_id: "FX-X", policy_version: "some-other-corpus-policy-v9", status: "OK", computed_at: "2026-09-03 01:00:09",
    authoritative_score: 100, hypothetical_score: 0, score_delta: 100, candidate_count: 5,
    measurement_category: "CROSS_ACCOUNT_EXACT_CANONICAL", origin_confidence: "SINGLE_BACKING_NO_MULTI_ORIGIN_EVIDENCE",
    multi_origin_evidence: "MULTI_ORIGIN_NOT_PROVEN", checker_accounts_status: "OK", distinct_checker_accounts_bucket: "6+",
  });
}

test("aggregation correctness against the hand-computed A–H fixture (foreign-policy row X ignored)", async () => {
  await seedFixture();
  const s = await summarizeCorpusDuplicateSuppressionShadowMeasurement(client, { recentLimit: 50 });

  // policy isolation
  assert.equal(s.totals.evaluations, 8, "exactly the 8 shadow-v1 rows; X is a different policy");

  // status tallies
  assert.equal(s.totals.ok, 3);
  assert.equal(s.totals.bounded, 1);
  assert.equal(s.totals.failed, 2);
  assert.equal(s.totals.skippedNotMatched, 1);
  assert.equal(s.totals.skippedNoAuthoritative, 1);
  assert.equal(s.totals.skipped, 2);
  assert.equal(s.totals.realMeasurementRows, 4, "OK + BOUNDED");
  assert.equal(s.totals.candidatePositive, 3, "A, B, C");

  // candidate frequency
  assert.equal(s.candidateFrequency, 0.75, "3 candidate rows / 4 real-measurement rows");

  // candidate_count distribution (OK/BOUNDED/SKIPPED_NOT_MATCHED = A,B,C,D,G)
  assert.deepEqual(s.candidateCountDistribution, { zero: 2, one: 2, twoPlus: 1 });

  // OK/BOUNDED-scoped enum distributions
  assert.deepEqual(s.measurementCategoryDistribution, { CROSS_ACCOUNT_EXACT_CANONICAL: 3, NOT_EXACT_CANONICAL: 1 });
  assert.deepEqual(s.originConfidenceDistribution, { SINGLE_BACKING_NO_MULTI_ORIGIN_EVIDENCE: 3, NOT_EVALUATED: 1 });
  assert.deepEqual(s.multiOriginEvidenceDistribution, { MULTI_ORIGIN_NOT_PROVEN: 3, "N/A": 1 });

  // score_delta buckets — FAILED (E,F) and SKIPPED (G,H) never appear here
  assert.deepEqual(s.scoreDeltaBuckets, { zero: 1, d1to9: 1, d10to24: 0, d25to49: 0, d50to99: 1, d100: 1 });

  // averages
  assert.equal(s.averageScoreDelta, (100 + 60 + 5 + 0) / 4);
  assert.equal(s.averageScoreDeltaWhereCandidate, (100 + 60 + 5) / 3);

  // 100 -> 0 and 100 -> partial
  assert.equal(s.authoritative100Hypothetical0Count, 1, "A");
  assert.equal(s.authoritative100HypotheticalPartialCount, 1, "B (100 -> 40)");

  // checker aggregation
  assert.deepEqual(s.checkerAccountsStatusDistribution, { OK: 2, FAILED: 1, NOT_APPLICABLE: 5 });
  assert.deepEqual(s.distinctCheckerAccountsBucketDistribution, { "1": 1, "2": 1 });

  // error_code (FAILED rows only)
  assert.deepEqual(s.errorCodeDistribution, { PROVENANCE_QUERY_FAILED: 1, COUNTERFACTUAL_INVARIANT: 1 });

  // surviving-word reconciliation — all four OK/BOUNDED rows reconcile
  assert.deepEqual(s.reconciliation, { checkedRows: 4, reconciledRows: 4 });

  // recent CANDIDATE rows only — status IN ('OK','BOUNDED') AND candidate_count > 0,
  // newest computed_at first. D (candidate_count 0), E/F (FAILED), G
  // (SKIPPED_NOT_MATCHED), H (SKIPPED_NO_AUTHORITATIVE) are all excluded.
  assert.deepEqual(s.recentCandidates.map((r) => r.reportId), ["FX-C", "FX-B", "FX-A"]);
  for (const excluded of ["FX-D", "FX-E", "FX-F", "FX-G", "FX-H"]) {
    assert.equal(s.recentCandidates.some((r) => r.reportId === excluded), false, `${excluded} is not a genuine candidate`);
  }
  const byId = Object.fromEntries(s.recentCandidates.map((r) => [r.reportId, r]));
  assert.equal(byId["FX-A"].scoreDelta, 100);
  assert.equal(byId["FX-A"].hypotheticalScore, 0);
  assert.equal(byId["FX-A"].crossAccountCategory, true);
  assert.equal(byId["FX-A"].samePassportCategory, false);
  assert.equal(byId["FX-C"].status, "BOUNDED");
  assert.equal(byId["FX-C"].evaluationTruncated, true);
  assert.equal(byId["FX-C"].distinctCheckerAccountsBucket, null, "a real NULL is preserved on a candidate row, never coerced to 0");
});

test("recent candidates are genuinely candidate-only: newer FAILED / SKIPPED / candidate_count=0 rows never appear or displace an older genuine candidate", async () => {
  // All NEWER than the FX fixture (01:00:0x). Only FILLER-OKCAND is a genuine candidate.
  await seedRow({
    report_id: "FILLER-OKCAND", status: "OK", computed_at: "2026-09-03 05:00:01",
    checker_accounts_status: "OK", distinct_checker_accounts_bucket: "1",
    authoritative_score: 80, hypothetical_score: 30, score_delta: 50,
    authoritative_unique_matched_words: 80, hypothetical_unique_matched_words: 30, unique_matched_words_removed: 50,
    archive_only_words_surviving: 30, live_academic_only_words_surviving: 0,
    previous_upload_only_words_surviving: 0, overlap_words_surviving: 0,
    candidate_count: 1, measurement_category: "CROSS_ACCOUNT_EXACT_CANONICAL",
    origin_confidence: "SINGLE_BACKING_NO_MULTI_ORIGIN_EVIDENCE", multi_origin_evidence: "MULTI_ORIGIN_NOT_PROVEN",
    same_passport_category: 0, cross_account_category: 1,
  });
  await seedRow({ report_id: "FILLER-FAILED", status: "FAILED", error_code: "UNEXPECTED", computed_at: "2026-09-03 05:00:02" });
  await seedRow({
    report_id: "FILLER-SKIP", status: "SKIPPED_NOT_MATCHED", computed_at: "2026-09-03 05:00:03",
    candidate_count: 0, measurement_category: "NOT_MATCHED", origin_confidence: "NOT_EVALUATED", multi_origin_evidence: "N/A",
  });
  await seedRow({
    report_id: "FILLER-OK0", status: "OK", computed_at: "2026-09-03 05:00:04",
    authoritative_score: 5, hypothetical_score: 5, score_delta: 0,
    authoritative_unique_matched_words: 5, hypothetical_unique_matched_words: 5, unique_matched_words_removed: 0,
    archive_only_words_surviving: 5, live_academic_only_words_surviving: 0,
    previous_upload_only_words_surviving: 0, overlap_words_surviving: 0,
    candidate_count: 0, measurement_category: "NOT_EXACT_CANONICAL", origin_confidence: "NOT_EVALUATED", multi_origin_evidence: "N/A",
  });

  const s = await summarizeCorpusDuplicateSuppressionShadowMeasurement(client, { recentLimit: 100 });
  // newest genuine candidate first — the three newer non-candidate rows do not lead
  assert.equal(s.recentCandidates[0].reportId, "FILLER-OKCAND");
  for (const excluded of ["FILLER-FAILED", "FILLER-SKIP", "FILLER-OK0"]) {
    assert.equal(s.recentCandidates.some((r) => r.reportId === excluded), false, `${excluded} must never appear in the candidate-only recent list`);
  }
  // the older genuine candidates are still present, not displaced by the newer non-candidates
  for (const kept of ["FX-A", "FX-B", "FX-C"]) {
    assert.equal(s.recentCandidates.some((r) => r.reportId === kept), true, `${kept} must not be displaced`);
  }
  assert.deepEqual(s.recentCandidates.map((r) => r.reportId), ["FILLER-OKCAND", "FX-C", "FX-B", "FX-A"]);
  // and with a tight window the newer non-candidates still cannot squeeze in
  const tight = await summarizeCorpusDuplicateSuppressionShadowMeasurement(client, { recentLimit: 1 });
  assert.deepEqual(tight.recentCandidates.map((r) => r.reportId), ["FILLER-OKCAND"]);
});

test("recentLimit: default applied, hard cap enforced, explicit small honoured", async () => {
  const capped = await summarizeCorpusDuplicateSuppressionShadowMeasurement(client, { recentLimit: 9999 });
  assert.ok(capped.recentCandidatesLimit <= MAX_RECENT_CANDIDATE_LIMIT);
  const dflt = await summarizeCorpusDuplicateSuppressionShadowMeasurement(client);
  assert.equal(dflt.recentCandidatesLimit, DEFAULT_RECENT_CANDIDATE_LIMIT);
  const small = await summarizeCorpusDuplicateSuppressionShadowMeasurement(client, { recentLimit: 2 });
  assert.equal(small.recentCandidates.length, 2);
  assert.equal(small.recentCandidatesLimit, 2);
  const zeroish = await summarizeCorpusDuplicateSuppressionShadowMeasurement(client, { recentLimit: 0 });
  assert.equal(zeroish.recentCandidatesLimit, DEFAULT_RECENT_CANDIDATE_LIMIT, "0 / NaN falls back to default");
});

test("reconciliation: a mis-summing OK row is checked but not reconciled (order-independent delta)", async () => {
  const before = (await summarizeCorpusDuplicateSuppressionShadowMeasurement(client)).reconciliation;
  await seedRow({
    report_id: "RECON-BAD", status: "OK", computed_at: "2026-09-03 02:00:00",
    authoritative_score: 90, hypothetical_score: 50, score_delta: 40,
    authoritative_unique_matched_words: 90, hypothetical_unique_matched_words: 100, unique_matched_words_removed: 40,
    archive_only_words_surviving: 10, live_academic_only_words_surviving: 0,
    previous_upload_only_words_surviving: 0, overlap_words_surviving: 0, // sum 10 != 100
    candidate_count: 1, measurement_category: "CROSS_ACCOUNT_EXACT_CANONICAL",
    origin_confidence: "SINGLE_BACKING_NO_MULTI_ORIGIN_EVIDENCE", multi_origin_evidence: "MULTI_ORIGIN_NOT_PROVEN",
  });
  const after = (await summarizeCorpusDuplicateSuppressionShadowMeasurement(client)).reconciliation;
  assert.equal(after.checkedRows, before.checkedRows + 1, "RECON-BAD has a non-NULL hypothetical_unique_matched_words -> checked");
  assert.equal(after.reconciledRows, before.reconciledRows, "RECON-BAD sum 10 != 100 -> not reconciled");
});

test("reconciliation: a NULL surviving-evidence field on an OK row is an integrity failure (checked, NOT reconciled, no COALESCE)", async () => {
  const before = (await summarizeCorpusDuplicateSuppressionShadowMeasurement(client)).reconciliation;
  await seedRow({
    report_id: "RECON-NULL", status: "OK", computed_at: "2026-09-03 02:00:01",
    authoritative_score: 70, hypothetical_score: 50, score_delta: 20,
    authoritative_unique_matched_words: 70, hypothetical_unique_matched_words: 50, unique_matched_words_removed: 20,
    // archive 50 + academic NULL + prev 0 + overlap 0 — a NULL channel, NOT a zero.
    archive_only_words_surviving: 50, live_academic_only_words_surviving: null,
    previous_upload_only_words_surviving: 0, overlap_words_surviving: 0,
    candidate_count: 1, measurement_category: "CROSS_ACCOUNT_EXACT_CANONICAL",
    origin_confidence: "SINGLE_BACKING_NO_MULTI_ORIGIN_EVIDENCE", multi_origin_evidence: "MULTI_ORIGIN_NOT_PROVEN",
  });
  const after = (await summarizeCorpusDuplicateSuppressionShadowMeasurement(client)).reconciliation;
  assert.equal(after.checkedRows, before.checkedRows + 1, "hypothetical_unique_matched_words is present -> the row is checked");
  assert.equal(
    after.reconciledRows, before.reconciledRows,
    "a NULL surviving channel must NOT be coalesced to 0 — the row fails the integrity check",
  );
});

// ---------------------------------------------------------------------------
// PRIVACY — the output serialises no identity / provenance value or key name
// ---------------------------------------------------------------------------

test("privacy: the serialised summary carries only bounded telemetry + report_id / report_device_key", async () => {
  const s = await summarizeCorpusDuplicateSuppressionShadowMeasurement(client, { recentLimit: 100 });
  const raw = JSON.stringify(s);
  for (const forbidden of [
    /@[a-z0-9.-]+\.[a-z]{2,}/i,          // an email address
    /device_passport/i, /passport_?id/i, /\bhmac\b/i, /source_ref/i, /public_?key/i, /\bspki\b/i,
    /canonical_sha/i, /representation_id/i, /document_identity_id/i,
    /"?text"?\s*:/i, /passage/i, /_json\b/i, /proposed_evidence/i,
  ]) {
    assert.doesNotMatch(raw, forbidden, `summary output must not contain ${forbidden}`);
  }
  // the only per-row identifiers are the routing handle
  for (const row of s.recentCandidates) {
    assert.deepEqual(
      Object.keys(row).filter((k) => /id$|key$/i.test(k)).sort(),
      ["reportDeviceKey", "reportId"],
      "no id/key field beyond the report routing handle",
    );
  }
});

test("score invariance: summarising mutates no row in the shadow table", async () => {
  const snap = async () => JSON.stringify((await client.execute("SELECT * FROM corpus_duplicate_suppression_shadow_evaluations ORDER BY id")).rows);
  const before = await snap();
  await summarizeCorpusDuplicateSuppressionShadowMeasurement(client, { recentLimit: 100 });
  await summarizeCorpusDuplicateSuppressionShadowMeasurement(client);
  assert.equal(await snap(), before, "no row changed");
});

// ---------------------------------------------------------------------------
// ADMIN-ONLY ACCESS via the real route
// ---------------------------------------------------------------------------

function extractCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return null;
  const m = setCookie.match(/tp_session_v1=([^;]*)/);
  return m ? m[1] : null;
}
async function signup(email, deviceKey, tag) {
  await resetAuthRateForTest(tag);
  const res = await signupRoute.POST(new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": tag },
    body: JSON.stringify(withTestIdentity({ email, password: "cdsm-password-1", username: tag.replace(/[^a-z0-9]/gi, ""), deviceKey })),
  }));
  assert.equal(res.status, 201, `signup ${email}`);
  return extractCookie(res);
}
async function login(email, deviceKey, tag) {
  await resetAuthRateForTest(tag);
  const res = await loginRoute.POST(new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": tag },
    body: JSON.stringify({ email, password: "cdsm-password-1", deviceKey }),
  }));
  assert.equal(res.status, 200);
  return extractCookie(res);
}
async function callRoute(cookie, tag, qs = "") {
  await resetReadRateForTest(tag);
  await resetRateForTest(tag);
  const headers = { "x-forwarded-for": tag };
  if (cookie) headers.cookie = `tp_session_v1=${cookie}`;
  return cdShadowRoute.GET(new Request(`http://localhost/api/developer/corpus-duplicate-suppression-shadow${qs}`, { headers }));
}

test("admin-only access: no session -> 404, non-admin -> 404 (no body), admin -> 200 with the measurement", async () => {
  const adminCookie = await signup("cdsm-admin@example.com", "cdsm-admin-dev", "cdsm-admin-1");
  await grantTestAdmin(dbFile, "cdsm-admin@example.com");
  const plainCookie = await signup("cdsm-ordinary@example.com", "cdsm-ordinary-dev", "cdsm-ordinary-1");

  const noSession = await callRoute(null, "cdsm-nosess");
  assert.equal(noSession.status, 404, "no session must be a plain 404");
  assert.equal((await noSession.text()).length, 0, "no body for a non-admin");

  const nonAdmin = await callRoute(plainCookie, "cdsm-nonadmin");
  assert.equal(nonAdmin.status, 404, "a signed-in non-admin is indistinguishable from no session");
  assert.equal((await nonAdmin.text()).length, 0);

  const adminRes = await callRoute(adminCookie, "cdsm-admin-get");
  assert.equal(adminRes.status, 200);
  const body = await adminRes.json();
  assert.equal(body.policyVersion, SHADOW_POLICY_VERSION);
  assert.equal(typeof body.totals.evaluations, "number");
  assert.ok(Array.isArray(body.recentCandidates));
  const raw = JSON.stringify(body);
  assert.doesNotMatch(raw, /proposed_evidence|public_?key|spki|device_passport/i);

  const limitedRes = await callRoute(adminCookie, "cdsm-admin-limit", "?recentLimit=1");
  const limitedBody = await limitedRes.json();
  assert.ok(limitedBody.recentCandidates.length <= 1);
});

test("a re-login non-admin still cannot reach the route after admin data exists", async () => {
  const plainCookie = await login("cdsm-ordinary@example.com", "cdsm-ordinary-dev", "cdsm-ord-relogin");
  const res = await callRoute(plainCookie, "cdsm-ord-recheck");
  assert.equal(res.status, 404);
});

test("sanitized 500: an internal measurement failure returns a constant bounded body, leaking no SQL / table name / stack / exception text", async () => {
  const adminCookie = await login("cdsm-admin@example.com", "cdsm-admin-dev", "cdsm-admin-relogin");
  // Force a real internal failure whose native error message carries the table
  // name and SQL keyword ("SQLITE_ERROR: no such table: ...") — then prove none
  // of it reaches the client. Renamed back immediately after so nothing else is
  // disturbed.
  await client.execute("ALTER TABLE corpus_duplicate_suppression_shadow_evaluations RENAME TO _cdsm_hidden_for_test");
  let res;
  try {
    res = await callRoute(adminCookie, "cdsm-admin-500");
  } finally {
    await client.execute("ALTER TABLE _cdsm_hidden_for_test RENAME TO corpus_duplicate_suppression_shadow_evaluations");
  }

  assert.equal(res.status, 500);
  const bodyText = await res.text();
  const body = JSON.parse(bodyText);
  assert.deepEqual(body, { error: "measurement_unavailable" }, "the 500 body is a single constant marker only");
  for (const leak of [
    /no such table/i, /SQLITE/i, /LibsqlError/i, /SqlError/i, /corpus_duplicate_suppression_shadow_evaluations/i,
    /_cdsm_hidden_for_test/i, /\bSELECT\b/i, /\bFROM\b/i, /\.ts\b/i, /\.mjs\b/i, /node_modules/i, /at Object\./i, /\/lib\//i, /\\lib\\/i,
  ]) {
    assert.doesNotMatch(bodyText, leak, `the sanitized 500 body must not leak ${leak}`);
  }

  // recovery: the route works again once the table is back
  const ok = await callRoute(adminCookie, "cdsm-admin-recovered");
  assert.equal(ok.status, 200);
});

console.log("corpus-duplicate-suppression-shadow-measurement: structural + empty + aggregation + candidate-only recent + reconciliation (+NULL integrity) + recentLimit + privacy + score-invariance + admin-only access + sanitized 500 passed");
