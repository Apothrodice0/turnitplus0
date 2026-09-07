import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { MAX_SHADOW_CANDIDATE_REPRESENTATIONS } from "../lib/corpus-duplicate-suppression-shadow.ts";
import {
  seedPromotedRepresentation,
  seedSavedReport,
  seedCheckerIdentity,
  matchedResult,
  noHistoricalMatch,
  corpusMatch,
  authoritativeFor,
  readShadowRow,
  runShadowEval,
  SHADOW_POLICY,
} from "./helpers/corpus-duplicate-shadow.mjs";

/**
 * Phase B2a — the core shadow evaluator. Direct calls with controlled inputs
 * (a real DB for provenance / persistence, a synthetic already-computed
 * production result). No HTTP — the POST/GET wiring is
 * tests/corpus-duplicate-suppression-shadow-trigger.test.mjs.
 */

const repoRoot = path.resolve(".");
const dbFile = path.join(repoRoot, "test_corpus_duplicate_suppression_shadow.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, path.join(repoRoot, "drizzle"));
test.after(() => {
  client.close();
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
});

const TEXT = "A distinctive fixture paragraph about corpus duplicate shadow measurement, long enough that its canonical hash is stable across the test suite and unlikely to collide with anything else.";
let n = 0;
const uniq = (p) => `${p}-${++n}`;

// --- P1: a qualifying cross-account exact-canonical candidate ---------------

test("P1: TURNITPLUS_CORPUS_SOURCE + EXACT_CANONICAL_MATCH + single-admission backing + authenticated -> OK row, CROSS_ACCOUNT_EXACT_CANONICAL, score_delta ~ authoritative", async () => {
  const deviceKey = uniq("dk");
  const reportId = uniq("r");
  const accountId = uniq("acct");
  const repId = await seedPromotedRepresentation(client, { sourceAccountId: uniq("source") });
  const production = matchedResult([corpusMatch({ repId, matchedWordCount: 100 })]);
  const authoritative = authoritativeFor({ wordCount: 100, historicalSubmissionMatch: production });
  await seedSavedReport(client, { deviceKey, reportId, accountId, text: TEXT, unifiedSimilarity: authoritative });

  await runShadowEval(client, {
    reportDeviceKey: deviceKey, reportId, accountId, rawText: TEXT,
    productionResult: production, authoritativeUnifiedSimilarity: authoritative,
    effectiveDeviceSelfRepresentationIds: [], authoritativeCorpusGeneration: 7,
  });

  const row = await readShadowRow(client, deviceKey, reportId);
  assert.ok(row, "a shadow row was written");
  assert.equal(String(row.status), "OK");
  assert.equal(Number(row.candidate_count), 1);
  assert.equal(String(row.measurement_category), "CROSS_ACCOUNT_EXACT_CANONICAL");
  assert.equal(String(row.origin_confidence), "SINGLE_BACKING_NO_MULTI_ORIGIN_EVIDENCE");
  assert.equal(String(row.multi_origin_evidence), "MULTI_ORIGIN_NOT_PROVEN");
  assert.equal(Number(row.authoritative_score), 100);
  assert.equal(Number(row.hypothetical_score), 0, "excluding the only exact-canonical corpus source with no other evidence -> 0");
  assert.equal(Number(row.score_delta), 100);
  assert.equal(Number(row.candidate_matched_words), 100);
  assert.equal(Number(row.candidates_excluded), 1);
  assert.equal(Number(row.candidate_admitted_promotion_backing_count), 1);
  assert.equal(Number(row.candidate_submission_reference_backing_count), 0);
  assert.equal(Number(row.cross_account_category), 1);
  assert.equal(Number(row.same_passport_category), 0);
  assert.equal(String(row.checker_accounts_status), "OK");
  assert.equal(String(row.distinct_checker_accounts_bucket), "0", "no other account has checked this text yet");
  assert.equal(Number(row.authoritative_corpus_generation), 7);
  assert.equal(String(row.authoritative_snapshot_computed_at), production.computedAt);
  assert.equal(Number(row.evaluation_truncated), 0);
  // four surviving-evidence fields reconcile to hypothetical unique matched words
  const sum = Number(row.archive_only_words_surviving) + Number(row.live_academic_only_words_surviving)
    + Number(row.previous_upload_only_words_surviving) + Number(row.overlap_words_surviving);
  assert.equal(sum, Number(row.hypothetical_unique_matched_words));
});

// --- P2 / P3: external evidence survives -----------------------------------

test("P2/P3: archive + scholarly evidence survives the hypothetical exclusion (not 0%)", async () => {
  const deviceKey = uniq("dk");
  const reportId = uniq("r");
  const accountId = uniq("acct");
  const repId = await seedPromotedRepresentation(client, { sourceAccountId: uniq("source") });
  const production = matchedResult([corpusMatch({ repId, matchedWordCount: 100 })]);
  const archive = Array.from({ length: 15 }, (_, i) => i); // 0..14 survive
  const academic = [{ provider: "openaire", providerId: "x", title: "t", authors: null, publication: null, year: null, doi: "10.1/x", url: null, matchedPassages: [{ submittedText: "", submittedWordStart: 70, submittedWordEnd: 79, matchedWordCount: 10 }], similarity: 90 }];
  const authoritative = authoritativeFor({ wordCount: 100, archiveMatchedPositions: archive, externalAcademicEvidence: academic, historicalSubmissionMatch: production });
  await seedSavedReport(client, { deviceKey, reportId, accountId, text: TEXT, unifiedSimilarity: authoritative, archiveMatchedPositions: archive, externalAcademicEvidence: academic });

  await runShadowEval(client, {
    reportDeviceKey: deviceKey, reportId, accountId, rawText: TEXT,
    productionResult: production, authoritativeUnifiedSimilarity: authoritative,
    effectiveDeviceSelfRepresentationIds: [], authoritativeCorpusGeneration: 1,
    archiveMatchedPositions: archive, externalAcademicEvidence: academic,
  });
  const row = await readShadowRow(client, deviceKey, reportId);
  assert.equal(String(row.status), "OK");
  assert.equal(Number(row.authoritative_score), 100);
  assert.equal(Number(row.hypothetical_score), 25, "15 archive + 10 scholarly words survive");
  assert.equal(Number(row.archive_only_words_surviving), 15);
  assert.equal(Number(row.live_academic_only_words_surviving), 10);
  assert.equal(Number(row.previous_upload_only_words_surviving), 0);
  assert.equal(Number(row.candidate_matched_words), 100);
  assert.equal(Number(row.unique_matched_words_removed), 75);
});

// --- item 3: authoritative-scoring-input parity ---------------------------
// The counterfactual must use the archive / live-academic inputs THE
// AUTHORITATIVE REQUEST used (threaded in as params), never a re-read of
// payload_json — a concurrent resave / self-heal between authoritative
// resolution and the deferred B2 run must not be able to move the hypothetical.

test("item 3: a payload_json rewrite after authoritative resolution does NOT change the hypothetical — the passed scoring inputs win", async () => {
  const deviceKey = uniq("dk");
  const reportId = uniq("r");
  const accountId = uniq("acct");
  const repId = await seedPromotedRepresentation(client, { sourceAccountId: uniq("source") });
  const production = matchedResult([corpusMatch({ repId, matchedWordCount: 100 })]);
  // The authoritative request's OWN scoring inputs: 15 archive words + 10
  // scholarly words survive the exclusion -> hypothetical 25 (same as P2/P3).
  const archive = Array.from({ length: 15 }, (_, i) => i);
  const academic = [{ provider: "openaire", providerId: "x", title: "t", authors: null, publication: null, year: null, doi: "10.1/x", url: null, matchedPassages: [{ submittedText: "", submittedWordStart: 70, submittedWordEnd: 79, matchedWordCount: 10 }], similarity: 90 }];
  const authoritative = authoritativeFor({ wordCount: 100, archiveMatchedPositions: archive, externalAcademicEvidence: academic, historicalSubmissionMatch: production });
  await seedSavedReport(client, { deviceKey, reportId, accountId, text: TEXT, unifiedSimilarity: authoritative, archiveMatchedPositions: archive, externalAcademicEvidence: academic });

  // Simulate a concurrent resave / self-heal landing between authoritative
  // resolution and the deferred B2 run: rewrite payload_json with a MUCH larger
  // archive + academic set (would push the hypothetical far above 25) — and, in
  // a second pass, outright corrupt it. Neither may reach the counterfactual.
  const bogusArchive = Array.from({ length: 60 }, (_, i) => i);
  const bogusAcademic = [
    { provider: "openaire", providerId: "y", title: "t", authors: null, publication: null, year: null, doi: "10.2/y", url: null, matchedPassages: [{ submittedText: "", submittedWordStart: 0, submittedWordEnd: 39, matchedWordCount: 40 }], similarity: 99 },
  ];
  await client.execute({
    sql: "UPDATE saved_reports SET payload_json = ? WHERE device_key = ? AND id = ?",
    args: [
      JSON.stringify({ version: 11, id: 1, submissionId: "sub", title: "t", author: "", assignment: "", created: new Date().toISOString(), score: 0, archiveScore: 0, wordCount: 100, scoreBand: "Low", matchedWordCount: 0, sources: [], repeats: [], text: TEXT, archiveMatchedPositions: bogusArchive, externalAcademicEvidence: bogusAcademic }),
      deviceKey, reportId,
    ],
  });

  // Pass the AUTHORITATIVE request's captured inputs (what the route threads in).
  await runShadowEval(client, {
    reportDeviceKey: deviceKey, reportId, accountId, rawText: TEXT,
    productionResult: production, authoritativeUnifiedSimilarity: authoritative,
    effectiveDeviceSelfRepresentationIds: [], authoritativeCorpusGeneration: 1,
    archiveMatchedPositions: archive, externalAcademicEvidence: academic,
  });
  let row = await readShadowRow(client, deviceKey, reportId);
  assert.equal(String(row.status), "OK");
  assert.equal(Number(row.authoritative_score), 100);
  assert.equal(Number(row.hypothetical_score), 25, "the mutated (larger) payload_json archive/academic was ignored");
  assert.equal(Number(row.archive_only_words_surviving), 15);
  assert.equal(Number(row.live_academic_only_words_surviving), 10);

  // Now corrupt payload_json entirely and re-run at a fresh generation — the
  // evaluator never parses it, so the row is still the same clean measurement.
  await client.execute({
    sql: "UPDATE saved_reports SET payload_json = ? WHERE device_key = ? AND id = ?",
    args: ["this is not valid json {{{{", deviceKey, reportId],
  });
  await runShadowEval(client, {
    reportDeviceKey: deviceKey, reportId, accountId, rawText: TEXT,
    productionResult: production, authoritativeUnifiedSimilarity: authoritative,
    effectiveDeviceSelfRepresentationIds: [], authoritativeCorpusGeneration: 2,
    archiveMatchedPositions: archive, externalAcademicEvidence: academic,
  });
  row = await readShadowRow(client, deviceKey, reportId);
  assert.equal(String(row.status), "OK", "corrupt payload_json never reaches the counterfactual");
  assert.equal(Number(row.hypothetical_score), 25);
  assert.equal(Number(row.archive_only_words_surviving), 15);
  assert.equal(Number(row.live_academic_only_words_surviving), 10);
});

// --- exact-canonical only: STRONG_TEXT_MATCH is not a candidate ------------

test("STRONG_TEXT_MATCH corpus source -> NOT a candidate (NOT_EXACT_CANONICAL), OK row, delta 0", async () => {
  const deviceKey = uniq("dk"); const reportId = uniq("r"); const accountId = uniq("acct");
  const repId = await seedPromotedRepresentation(client, { sourceAccountId: uniq("source") });
  const production = matchedResult([corpusMatch({ repId, matchType: "STRONG_TEXT_MATCH", matchedWordCount: 60, passages: [{ submittedText: "", submittedWordStart: 0, submittedWordEnd: 59, matchedWordCount: 60 }] })]);
  const authoritative = authoritativeFor({ wordCount: 100, historicalSubmissionMatch: production });
  await seedSavedReport(client, { deviceKey, reportId, accountId, text: TEXT, unifiedSimilarity: authoritative });
  await runShadowEval(client, {
    reportDeviceKey: deviceKey, reportId, accountId, rawText: TEXT,
    productionResult: production, authoritativeUnifiedSimilarity: authoritative,
    effectiveDeviceSelfRepresentationIds: [], authoritativeCorpusGeneration: 1,
  });
  const row = await readShadowRow(client, deviceKey, reportId);
  assert.equal(String(row.status), "OK");
  assert.equal(Number(row.candidate_count), 0);
  assert.equal(String(row.measurement_category), "NOT_EXACT_CANONICAL");
  assert.equal(Number(row.score_delta), 0);
  assert.equal(Number(row.cross_account_category), 0);
  // no provenance query ran for a STRONG match -> backing counts NULL
  assert.equal(row.candidate_admitted_promotion_backing_count, null);
  assert.equal(String(row.checker_accounts_status), "NOT_APPLICABLE");
});

// --- unsupported backing shape -------------------------------------------

test("revoked accepted representation -> BACKING_SHAPE_UNSUPPORTED, OK row, delta 0, not a candidate", async () => {
  const deviceKey = uniq("dk"); const reportId = uniq("r"); const accountId = uniq("acct");
  const repId = await seedPromotedRepresentation(client, { sourceAccountId: uniq("source"), backingShape: "revoked" });
  const production = matchedResult([corpusMatch({ repId, matchedWordCount: 100 })]);
  const authoritative = authoritativeFor({ wordCount: 100, historicalSubmissionMatch: production });
  await seedSavedReport(client, { deviceKey, reportId, accountId, text: TEXT, unifiedSimilarity: authoritative });
  await runShadowEval(client, {
    reportDeviceKey: deviceKey, reportId, accountId, rawText: TEXT,
    productionResult: production, authoritativeUnifiedSimilarity: authoritative,
    effectiveDeviceSelfRepresentationIds: [], authoritativeCorpusGeneration: 1,
  });
  const row = await readShadowRow(client, deviceKey, reportId);
  assert.equal(String(row.status), "OK");
  assert.equal(Number(row.candidate_count), 0);
  assert.equal(String(row.measurement_category), "BACKING_SHAPE_UNSUPPORTED");
  assert.equal(String(row.origin_confidence), "BACKING_SHAPE_UNSUPPORTED");
  assert.equal(Number(row.score_delta), 0);
  assert.equal(Number(row.candidate_admitted_promotion_backing_count), 0, "the revoked accepted representation is not counted");
});

// --- same-Passport already excluded -------------------------------------

test("matched rep in effectiveDeviceSelfRepresentationIds -> ALREADY_EFFECTIVE_DEVICE_SELF, same_passport_category=1, no double count", async () => {
  const deviceKey = uniq("dk"); const reportId = uniq("r"); const accountId = uniq("acct");
  const repId = await seedPromotedRepresentation(client, { sourceAccountId: uniq("source") });
  const production = matchedResult([corpusMatch({ repId, matchedWordCount: 100 })]);
  // authoritative already excludes it as an effective device SELF
  const authoritative = authoritativeFor({ wordCount: 100, historicalSubmissionMatch: production, effectiveDeviceSelfRepresentationIds: [repId] });
  await seedSavedReport(client, { deviceKey, reportId, accountId, text: TEXT, unifiedSimilarity: authoritative });
  await runShadowEval(client, {
    reportDeviceKey: deviceKey, reportId, accountId, rawText: TEXT,
    productionResult: production, authoritativeUnifiedSimilarity: authoritative,
    effectiveDeviceSelfRepresentationIds: [repId], authoritativeCorpusGeneration: 1,
  });
  const row = await readShadowRow(client, deviceKey, reportId);
  assert.equal(String(row.status), "OK");
  assert.equal(Number(row.candidate_count), 0);
  assert.equal(String(row.measurement_category), "ALREADY_EFFECTIVE_DEVICE_SELF");
  assert.equal(Number(row.same_passport_category), 1);
  assert.equal(Number(row.score_delta), 0, "already excluded authoritatively -> no additional suppression");
});

// --- anonymous ---------------------------------------------------------

test("anonymous report -> ANONYMOUS, not a candidate, checker NOT_APPLICABLE", async () => {
  const deviceKey = uniq("dk"); const reportId = uniq("r");
  const repId = await seedPromotedRepresentation(client, { sourceAccountId: uniq("source") });
  const production = matchedResult([corpusMatch({ repId, matchedWordCount: 100 })]);
  const authoritative = authoritativeFor({ wordCount: 100, historicalSubmissionMatch: production });
  await seedSavedReport(client, { deviceKey, reportId, accountId: null, text: TEXT, unifiedSimilarity: authoritative });
  await runShadowEval(client, {
    reportDeviceKey: deviceKey, reportId, accountId: null, rawText: TEXT,
    productionResult: production, authoritativeUnifiedSimilarity: authoritative,
    effectiveDeviceSelfRepresentationIds: [], authoritativeCorpusGeneration: 1,
  });
  const row = await readShadowRow(client, deviceKey, reportId);
  assert.equal(String(row.status), "OK");
  assert.equal(Number(row.candidate_count), 0);
  assert.equal(String(row.measurement_category), "ANONYMOUS");
  assert.equal(String(row.checker_accounts_status), "NOT_APPLICABLE");
  assert.equal(row.distinct_checker_accounts_bucket, null);
});

// --- nullable status contract ----------------------------------------

test("UNAVAILABLE production result -> NO row written", async () => {
  const deviceKey = uniq("dk"); const reportId = uniq("r");
  await seedSavedReport(client, { deviceKey, reportId, accountId: null, text: TEXT });
  await runShadowEval(client, {
    reportDeviceKey: deviceKey, reportId, accountId: null, rawText: TEXT,
    productionResult: { status: "UNAVAILABLE", computedAt: new Date().toISOString(), matcherVersion: "x", fingerprintVersion: "x", canonicalizationVersion: "x" },
    authoritativeUnifiedSimilarity: authoritativeFor({ wordCount: 10 }),
    effectiveDeviceSelfRepresentationIds: [], authoritativeCorpusGeneration: 1,
  });
  assert.equal(await readShadowRow(client, deviceKey, reportId), null);
});

test("SKIPPED_NO_AUTHORITATIVE -> generation/computedAt/word count NULL; all measurement NULL", async () => {
  const deviceKey = uniq("dk"); const reportId = uniq("r"); const accountId = uniq("acct");
  await seedSavedReport(client, { deviceKey, reportId, accountId, text: TEXT });
  await runShadowEval(client, {
    reportDeviceKey: deviceKey, reportId, accountId, rawText: TEXT,
    productionResult: matchedResult([]), authoritativeUnifiedSimilarity: null,
    effectiveDeviceSelfRepresentationIds: [], authoritativeCorpusGeneration: 3,
  });
  const row = await readShadowRow(client, deviceKey, reportId);
  assert.equal(String(row.status), "SKIPPED_NO_AUTHORITATIVE");
  assert.equal(row.authoritative_corpus_generation, null);
  assert.equal(row.authoritative_snapshot_computed_at, null);
  assert.equal(row.submitted_word_count, null);
  assert.equal(row.candidate_count, null);
  assert.equal(row.authoritative_score, null);
  assert.equal(row.score_delta, null);
});

test("SKIPPED_NOT_MATCHED -> keeps real generation + snapshot computedAt + candidate_count 0; score fields NULL", async () => {
  const deviceKey = uniq("dk"); const reportId = uniq("r"); const accountId = uniq("acct");
  const production = noHistoricalMatch();
  const authoritative = authoritativeFor({ wordCount: 42 });
  await seedSavedReport(client, { deviceKey, reportId, accountId, text: TEXT, unifiedSimilarity: authoritative });
  await runShadowEval(client, {
    reportDeviceKey: deviceKey, reportId, accountId, rawText: TEXT,
    productionResult: production, authoritativeUnifiedSimilarity: authoritative,
    effectiveDeviceSelfRepresentationIds: [], authoritativeCorpusGeneration: 9,
  });
  const row = await readShadowRow(client, deviceKey, reportId);
  assert.equal(String(row.status), "SKIPPED_NOT_MATCHED");
  assert.equal(Number(row.authoritative_corpus_generation), 9);
  assert.equal(String(row.authoritative_snapshot_computed_at), production.computedAt);
  assert.equal(Number(row.submitted_word_count), 42);
  assert.equal(Number(row.candidate_count), 0);
  assert.equal(String(row.measurement_category), "NOT_MATCHED");
  assert.equal(String(row.origin_confidence), "NOT_EVALUATED");
  assert.equal(String(row.multi_origin_evidence), "N/A");
  assert.equal(row.authoritative_score, null);
  assert.equal(row.score_delta, null);
  assert.equal(row.archive_only_words_surviving, null);
});

// --- checker success / failure independence -------------------------------

test("checker query succeeds -> checker_accounts_status OK + a bucket; a second checker account -> bucket '1'", async () => {
  const deviceKey = uniq("dk"); const reportId = uniq("r"); const accountId = uniq("acct");
  await seedCheckerIdentity(client, uniq("other-checker"), TEXT);
  const repId = await seedPromotedRepresentation(client, { sourceAccountId: uniq("source") });
  const production = matchedResult([corpusMatch({ repId, matchedWordCount: 100 })]);
  const authoritative = authoritativeFor({ wordCount: 100, historicalSubmissionMatch: production });
  await seedSavedReport(client, { deviceKey, reportId, accountId, text: TEXT, unifiedSimilarity: authoritative });
  await runShadowEval(client, {
    reportDeviceKey: deviceKey, reportId, accountId, rawText: TEXT,
    productionResult: production, authoritativeUnifiedSimilarity: authoritative,
    effectiveDeviceSelfRepresentationIds: [], authoritativeCorpusGeneration: 1,
  });
  const row = await readShadowRow(client, deviceKey, reportId);
  assert.equal(String(row.status), "OK");
  assert.equal(String(row.checker_accounts_status), "OK");
  assert.equal(String(row.distinct_checker_accounts_bucket), "1");
});

test("a checker-query failure does NOT fail the core evaluation — core status stays OK, checker_accounts_status FAILED", async () => {
  const deviceKey = uniq("dk"); const reportId = uniq("r"); const accountId = uniq("acct");
  const repId = await seedPromotedRepresentation(client, { sourceAccountId: uniq("source") });
  const production = matchedResult([corpusMatch({ repId, matchedWordCount: 100 })]);
  const authoritative = authoritativeFor({ wordCount: 100, historicalSubmissionMatch: production });
  await seedSavedReport(client, { deviceKey, reportId, accountId, text: TEXT, unifiedSimilarity: authoritative });

  // Wrap the client so ONLY the checker probe (a SELECT ... FROM ( SELECT DISTINCT account_id ...)) throws.
  const spy = {
    execute: async (stmt) => {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      if (/SELECT DISTINCT account_id/i.test(sql)) throw new Error("simulated checker probe outage");
      return client.execute(stmt);
    },
    batch: (...a) => client.batch(...a),
    close: () => {},
  };
  await runShadowEval(spy, {
    reportDeviceKey: deviceKey, reportId, accountId, rawText: TEXT,
    productionResult: production, authoritativeUnifiedSimilarity: authoritative,
    effectiveDeviceSelfRepresentationIds: [], authoritativeCorpusGeneration: 1,
  });
  const row = await readShadowRow(client, deviceKey, reportId);
  assert.equal(String(row.status), "OK", "the counterfactual is still valid");
  assert.equal(Number(row.candidate_count), 1);
  assert.equal(Number(row.score_delta), 100);
  assert.equal(String(row.checker_accounts_status), "FAILED");
  assert.equal(row.distinct_checker_accounts_bucket, null);
});

// --- monotonicity -> FAILED ---------------------------------------------

test("an impossible authoritative input (hypothetical would exceed it) -> status FAILED, error_code COUNTERFACTUAL_INVARIANT, all measurement NULL, no exception text", async () => {
  const deviceKey = uniq("dk"); const reportId = uniq("r"); const accountId = uniq("acct");
  const repId = await seedPromotedRepresentation(client, { sourceAccountId: uniq("source") });
  const production = matchedResult([corpusMatch({ repId, matchedWordCount: 100 })]);
  // 30 archive words survive the exclusion of R1 -> real hypothetical score/unique = 30.
  const archive = Array.from({ length: 30 }, (_, i) => i);
  const real = authoritativeFor({ wordCount: 100, archiveMatchedPositions: archive, historicalSubmissionMatch: production });
  // Corrupt the authoritative result DOWNWARD (below 30) so the real hypothetical exceeds it.
  const impossible = { ...real, unifiedScore: 5, uniqueMatchedWords: 3 };
  await seedSavedReport(client, { deviceKey, reportId, accountId, text: TEXT, unifiedSimilarity: real, archiveMatchedPositions: archive });
  await runShadowEval(client, {
    reportDeviceKey: deviceKey, reportId, accountId, rawText: TEXT,
    productionResult: production, authoritativeUnifiedSimilarity: impossible,
    effectiveDeviceSelfRepresentationIds: [], authoritativeCorpusGeneration: 1,
    archiveMatchedPositions: archive,
  });
  const row = await readShadowRow(client, deviceKey, reportId);
  assert.equal(String(row.status), "FAILED");
  assert.equal(String(row.error_code), "COUNTERFACTUAL_INVARIANT");
  assert.equal(row.error_detail, null);
  assert.equal(row.authoritative_score, null);
  assert.equal(row.score_delta, null);
  assert.equal(row.candidate_count, null);
  assert.equal(String(row.checker_accounts_status), "NOT_APPLICABLE");
});

test("a provenance-query failure -> status FAILED, error_code PROVENANCE_QUERY_FAILED", async () => {
  const deviceKey = uniq("dk"); const reportId = uniq("r"); const accountId = uniq("acct");
  const repId = await seedPromotedRepresentation(client, { sourceAccountId: uniq("source") });
  const production = matchedResult([corpusMatch({ repId, matchedWordCount: 100 })]);
  const authoritative = authoritativeFor({ wordCount: 100, historicalSubmissionMatch: production });
  await seedSavedReport(client, { deviceKey, reportId, accountId, text: TEXT, unifiedSimilarity: authoritative });
  const spy = {
    execute: async (stmt) => {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      if (/corpus_admission_promotions p/i.test(sql)) throw new Error("simulated provenance outage");
      return client.execute(stmt);
    },
    batch: (...a) => client.batch(...a),
    close: () => {},
  };
  await runShadowEval(spy, {
    reportDeviceKey: deviceKey, reportId, accountId, rawText: TEXT,
    productionResult: production, authoritativeUnifiedSimilarity: authoritative,
    effectiveDeviceSelfRepresentationIds: [], authoritativeCorpusGeneration: 1,
  });
  const row = await readShadowRow(client, deviceKey, reportId);
  assert.equal(String(row.status), "FAILED");
  assert.equal(String(row.error_code), "PROVENANCE_QUERY_FAILED");
});

// --- candidate cap -> BOUNDED -----------------------------------------

test("more distinct exact-canonical corpus reps than the cap -> status BOUNDED, evaluation_truncated 1, at most cap evaluated", async () => {
  const deviceKey = uniq("dk"); const reportId = uniq("r"); const accountId = uniq("acct");
  const over = MAX_SHADOW_CANDIDATE_REPRESENTATIONS + 3;
  const matches = [];
  for (let i = 0; i < over; i += 1) {
    const t = `${TEXT} variant ${i} keeping the shingle set distinct enough per representation.`;
    const repId = await seedPromotedRepresentation(client, { sourceAccountId: uniq("source") });
    matches.push(corpusMatch({ repId, matchType: i === 0 ? "EXACT_CANONICAL_MATCH" : "STRONG_TEXT_MATCH", matchedWordCount: 100, passages: [{ submittedText: "", submittedWordStart: 0, submittedWordEnd: 99, matchedWordCount: 100 }] }));
  }
  const production = matchedResult(matches);
  const authoritative = authoritativeFor({ wordCount: 100, historicalSubmissionMatch: production });
  await seedSavedReport(client, { deviceKey, reportId, accountId, text: TEXT, unifiedSimilarity: authoritative });
  await runShadowEval(client, {
    reportDeviceKey: deviceKey, reportId, accountId, rawText: TEXT,
    productionResult: production, authoritativeUnifiedSimilarity: authoritative,
    effectiveDeviceSelfRepresentationIds: [], authoritativeCorpusGeneration: 1,
  });
  const row = await readShadowRow(client, deviceKey, reportId);
  assert.equal(String(row.status), "BOUNDED");
  assert.equal(Number(row.evaluation_truncated), 1);
});

// --- guarded UPSERT: no saved_reports row -> no write ---------------------

test("guarded UPSERT: with no saved_reports row for (device_key, id), the evaluator writes nothing", async () => {
  const deviceKey = uniq("dk-missing"); const reportId = uniq("r-missing"); const accountId = uniq("acct");
  const repId = await seedPromotedRepresentation(client, { sourceAccountId: uniq("source") });
  const production = matchedResult([corpusMatch({ repId, matchedWordCount: 100 })]);
  const authoritative = authoritativeFor({ wordCount: 100, historicalSubmissionMatch: production });
  // NOTE: deliberately NO seedSavedReport
  await runShadowEval(client, {
    reportDeviceKey: deviceKey, reportId, accountId, rawText: TEXT,
    productionResult: production, authoritativeUnifiedSimilarity: authoritative,
    effectiveDeviceSelfRepresentationIds: [], authoritativeCorpusGeneration: 1,
  });
  assert.equal(await readShadowRow(client, deviceKey, reportId), null, "no report -> no shadow row");
});

test("guarded UPSERT: a SKIPPED_NO_AUTHORITATIVE write is also EXISTS-guarded (report gone -> no row)", async () => {
  const deviceKey = uniq("dk-missing2"); const reportId = uniq("r-missing2"); const accountId = uniq("acct");
  await runShadowEval(client, {
    reportDeviceKey: deviceKey, reportId, accountId, rawText: TEXT,
    productionResult: matchedResult([]), authoritativeUnifiedSimilarity: null,
    effectiveDeviceSelfRepresentationIds: [], authoritativeCorpusGeneration: 1,
  });
  assert.equal(await readShadowRow(client, deviceKey, reportId), null);
});

// --- structural: privacy / no blob / B1 helper only ---------------------

// Every column drizzle/0044 is permitted to declare — bounded count / enum /
// boolean / version string / timestamp / routing handle. A migration that adds
// a column not on this list fails this test on purpose.
const ALLOWED_0044_COLUMNS = new Set([
  "id", "report_device_key", "report_id",
  "status", "error_code", "error_detail",
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
  "same_passport_category", "cross_account_category",
  "evaluation_truncated", "total_runtime_ms", "computed_at", "created_at",
]);

test("SCHEMA PRIVACY: drizzle/0044 declares only the reviewed bounded columns — no prohibited identifier, no blob", () => {
  const sql = fs.readFileSync(path.join(repoRoot, "drizzle/0044_corpus_duplicate_suppression_shadow_evaluations.sql"), "utf8");
  const createTable = sql.slice(sql.indexOf("CREATE TABLE"), sql.indexOf(");", sql.indexOf("CREATE TABLE")));
  const cols = [...createTable.matchAll(/^\s{2}([a-z_0-9]+)\s+(TEXT|INTEGER)\b/gm)].map((m) => m[1]);
  assert.ok(cols.length >= 40, `expected the full column list, parsed ${cols.length}`);
  for (const c of cols) {
    assert.ok(ALLOWED_0044_COLUMNS.has(c), `0044 declares an unreviewed column "${c}" — add it to ALLOWED_0044_COLUMNS only after a privacy review`);
  }
  // no generic blob / payload / evidence-blob / metadata column
  for (const c of cols) {
    assert.doesNotMatch(c, /_json$|^payload|^metadata|proposed_evidence|_blob$/, `0044 column "${c}" is blob-shaped`);
  }
});

test("STRUCTURAL: the evaluator persists no prohibited value and no JSON blob into the UPSERT", () => {
  const src = fs.readFileSync(path.join(repoRoot, "lib/corpus-duplicate-suppression-shadow.ts"), "utf8");
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  // No JSON blob is ever built for persistence.
  assert.doesNotMatch(stripped, /JSON\.stringify/, "no JSON blob is ever persisted (unlike device-provenance-shadow's proposed_evidence)");
  // error_detail is only ever assigned `null` in B2a (populating it would require parsing an exception string).
  for (const m of stripped.matchAll(/error_detail:\s*([^,\n}]+)/g)) {
    assert.equal(m[1].trim(), "null", `error_detail was assigned "${m[1].trim()}" — B2a only ever writes null`);
  }
  // No caught exception text is routed toward a persisted column.
  assert.doesNotMatch(stripped, /(error_code|error_detail)\s*[:=][^;\n]*\.(message|stack)\b/, "no exception text into a persisted column");
  // error_code enum is exactly the three reviewed values.
  const codes = new Set([...stripped.matchAll(/ShadowErrorCode\s*=\s*([^;]+);/g)][0]?.[1].match(/"[A-Z_]+"/g)?.map((s) => s.replace(/"/g, "")) ?? []);
  assert.deepEqual([...codes].sort(), ["COUNTERFACTUAL_INVARIANT", "PROVENANCE_QUERY_FAILED", "UNEXPECTED"]);
  assert.doesNotMatch(stripped, /UPSERT_FAILED|UNIFIED_SIMILARITY_THREW/, "dropped error codes must not appear");
});

test("CONTAINMENT: the evaluator goes through the B1 helper only — no computeUnifiedSimilarity, no matcher rerun, no hypotheticalExcludedRepresentationIds token", () => {
  const src = fs.readFileSync(path.join(repoRoot, "lib/corpus-duplicate-suppression-shadow.ts"), "utf8");
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  // The only permitted unified-similarity symbols are the version constant and the type.
  assert.doesNotMatch(stripped, /\bcomputeUnifiedSimilarity\b/, "must never call or import computeUnifiedSimilarity — the ONLY hypothetical computation goes through computeCorpusDuplicateCounterfactual");
  assert.doesNotMatch(stripped, /hypotheticalExcludedRepresentationIds/, "the shadow evaluator must never name the hypothetical exclusion token");
  assert.doesNotMatch(stripped, /matchAgainstUserSubmissionCorpus|getOrComputeHistoricalMatchSnapshot/, "must never re-run the historical matcher");
  assert.match(stripped, /computeCorpusDuplicateCounterfactual/, "the ONLY hypothetical computation goes through the B1 helper");
  assert.match(stripped, /classifyDocumentLocalCorpusDuplicate/, "candidate classification reuses the B1 policy verbatim");
});
