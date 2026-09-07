import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
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
 * Phase B2a — freshness / reuse / FAILED-retry. Direct calls so the freshness
 * keys (corpus generation, snapshot computedAt) can be moved precisely.
 */

const repoRoot = path.resolve(".");
const dbFile = path.join(repoRoot, "test_corpus_duplicate_suppression_shadow_retry.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, path.join(repoRoot, "drizzle"));
test.after(() => {
  client.close();
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
});

const TEXT = "Freshness fixture paragraph for the corpus-duplicate suppression shadow retry and reuse coverage.";
let n = 0;
const uniq = (p) => `${p}-${++n}`;

async function run(client, { deviceKey, reportId, accountId, production, authoritative, generation }) {
  await runShadowEval(client, {
    reportDeviceKey: deviceKey, reportId, accountId, rawText: TEXT,
    productionResult: production, authoritativeUnifiedSimilarity: authoritative,
    effectiveDeviceSelfRepresentationIds: [], authoritativeCorpusGeneration: generation,
  });
}

test("OK row is reused while generation + snapshot computedAt + versions are unchanged", async () => {
  const deviceKey = uniq("dk"); const reportId = uniq("r"); const accountId = uniq("acct");
  const repId = await seedPromotedRepresentation(client, { sourceAccountId: uniq("source") });
  const production = matchedResult([corpusMatch({ repId, matchedWordCount: 100 })]);
  const authoritative = authoritativeFor({ wordCount: 100, historicalSubmissionMatch: production });
  await seedSavedReport(client, { deviceKey, reportId, accountId, text: TEXT });

  await run(client, { deviceKey, reportId, accountId, production, authoritative, generation: 5 });
  const first = await readShadowRow(client, deviceKey, reportId);
  assert.equal(String(first.status), "OK");
  const firstComputedAt = String(first.computed_at);

  // second run with identical freshness keys -> reused (computed_at unchanged)
  await new Promise((r) => setTimeout(r, 1100)); // guarantee a different wall clock second
  await run(client, { deviceKey, reportId, accountId, production, authoritative, generation: 5 });
  const second = await readShadowRow(client, deviceKey, reportId);
  assert.equal(String(second.computed_at), firstComputedAt, "reused — not recomputed");
});

test("a corpus-generation bump forces re-evaluation", async () => {
  const deviceKey = uniq("dk"); const reportId = uniq("r"); const accountId = uniq("acct");
  const repId = await seedPromotedRepresentation(client, { sourceAccountId: uniq("source") });
  const production = matchedResult([corpusMatch({ repId, matchedWordCount: 100 })]);
  const authoritative = authoritativeFor({ wordCount: 100, historicalSubmissionMatch: production });
  await seedSavedReport(client, { deviceKey, reportId, accountId, text: TEXT });

  await run(client, { deviceKey, reportId, accountId, production, authoritative, generation: 5 });
  const first = await readShadowRow(client, deviceKey, reportId);
  await new Promise((r) => setTimeout(r, 1100));
  await run(client, { deviceKey, reportId, accountId, production, authoritative, generation: 6 });
  const second = await readShadowRow(client, deviceKey, reportId);
  assert.notEqual(String(second.computed_at), String(first.computed_at), "generation changed -> recomputed");
  assert.equal(Number(second.authoritative_corpus_generation), 6);
});

test("Phase-A maturity crossing (snapshot computedAt advances) transitions SKIPPED_NOT_MATCHED -> re-evaluated OK", async () => {
  const deviceKey = uniq("dk"); const reportId = uniq("r"); const accountId = uniq("acct");
  const repId = await seedPromotedRepresentation(client, { sourceAccountId: uniq("source") });
  await seedSavedReport(client, { deviceKey, reportId, accountId, text: TEXT });

  // 1) immature source -> production NO_HISTORICAL_MATCH -> B2 SKIPPED_NOT_MATCHED
  const immatureProd = noHistoricalMatch({ computedAt: "2026-01-01T00:00:00.000Z" });
  const immatureAuth = authoritativeFor({ wordCount: 100 });
  await run(client, { deviceKey, reportId, accountId, production: immatureProd, authoritative: immatureAuth, generation: 5 });
  const skipped = await readShadowRow(client, deviceKey, reportId);
  assert.equal(String(skipped.status), "SKIPPED_NOT_MATCHED");
  assert.equal(String(skipped.authoritative_snapshot_computed_at), immatureProd.computedAt);
  assert.equal(Number(skipped.candidate_count), 0);

  // 2) maturity crossing: the historical snapshot recomputes -> a NEW computedAt,
  //    and now the source matches -> B2 must re-evaluate (same generation!)
  const matureProd = matchedResult([corpusMatch({ repId, matchedWordCount: 100 })], { computedAt: "2026-02-01T00:00:00.000Z" });
  const matureAuth = authoritativeFor({ wordCount: 100, historicalSubmissionMatch: matureProd });
  await run(client, { deviceKey, reportId, accountId, production: matureProd, authoritative: matureAuth, generation: 5 });
  const now = await readShadowRow(client, deviceKey, reportId);
  assert.equal(String(now.status), "OK", "re-evaluated on the maturity-driven computedAt change, at equal generation");
  assert.equal(Number(now.candidate_count), 1);
  assert.equal(String(now.authoritative_snapshot_computed_at), matureProd.computedAt);
});

test("SKIPPED_NOT_MATCHED is reused while generation + computedAt unchanged", async () => {
  const deviceKey = uniq("dk"); const reportId = uniq("r"); const accountId = uniq("acct");
  await seedSavedReport(client, { deviceKey, reportId, accountId, text: TEXT });
  const prod = noHistoricalMatch({ computedAt: "2026-03-01T00:00:00.000Z" });
  const auth = authoritativeFor({ wordCount: 100 });
  await run(client, { deviceKey, reportId, accountId, production: prod, authoritative: auth, generation: 5 });
  const first = await readShadowRow(client, deviceKey, reportId);
  await new Promise((r) => setTimeout(r, 1100));
  await run(client, { deviceKey, reportId, accountId, production: prod, authoritative: auth, generation: 5 });
  const second = await readShadowRow(client, deviceKey, reportId);
  assert.equal(String(second.computed_at), String(first.computed_at), "SKIPPED_NOT_MATCHED reused");
});

test("FAILED is reused within the 15-minute cooldown, then retried after it elapses", async () => {
  const deviceKey = uniq("dk"); const reportId = uniq("r"); const accountId = uniq("acct");
  await seedSavedReport(client, { deviceKey, reportId, accountId, text: TEXT });
  // Seed a FAILED row directly, computed_at just now.
  await client.execute({
    sql: `INSERT INTO corpus_duplicate_suppression_shadow_evaluations
          (report_device_key, report_id, status, error_code, policy_version, rule_version, unified_similarity_version, counterfactual_version, evaluation_truncated, computed_at)
          VALUES (?,?,?,?,?,?,?,?,0,?)`,
    args: [deviceKey, reportId, "FAILED", "UNEXPECTED", SHADOW_POLICY,
      "document-local-corpus-duplicate-policy-v1", "unified-similarity-v1", "corpus-duplicate-counterfactual-v1",
      new Date().toISOString().replace("T", " ").slice(0, 19)],
  });

  const prod = noHistoricalMatch();
  const auth = authoritativeFor({ wordCount: 100 });
  // within cooldown -> not retried (still FAILED, no measurement written)
  await run(client, { deviceKey, reportId, accountId, production: prod, authoritative: auth, generation: 5 });
  let row = await readShadowRow(client, deviceKey, reportId);
  assert.equal(String(row.status), "FAILED", "reused within cooldown");
  assert.equal(row.authoritative_corpus_generation, null);

  // back-date computed_at past the cooldown -> retried
  await client.execute({
    sql: "UPDATE corpus_duplicate_suppression_shadow_evaluations SET computed_at = datetime('now','-20 minutes') WHERE report_device_key = ? AND report_id = ?",
    args: [deviceKey, reportId],
  });
  await run(client, { deviceKey, reportId, accountId, production: prod, authoritative: auth, generation: 5 });
  row = await readShadowRow(client, deviceKey, reportId);
  assert.equal(String(row.status), "SKIPPED_NOT_MATCHED", "retried after cooldown -> resolved to the real state");
});

test("SKIPPED_NO_AUTHORITATIVE is reused while authoritative stays unavailable; re-evaluated once it appears", async () => {
  const deviceKey = uniq("dk"); const reportId = uniq("r"); const accountId = uniq("acct");
  const repId = await seedPromotedRepresentation(client, { sourceAccountId: uniq("source") });
  await seedSavedReport(client, { deviceKey, reportId, accountId, text: TEXT });
  const prod = matchedResult([corpusMatch({ repId, matchedWordCount: 100 })]);

  await run(client, { deviceKey, reportId, accountId, production: prod, authoritative: null, generation: 5 });
  const first = await readShadowRow(client, deviceKey, reportId);
  assert.equal(String(first.status), "SKIPPED_NO_AUTHORITATIVE");
  await new Promise((r) => setTimeout(r, 1100));
  await run(client, { deviceKey, reportId, accountId, production: prod, authoritative: null, generation: 5 });
  assert.equal(String((await readShadowRow(client, deviceKey, reportId)).computed_at), String(first.computed_at), "reused while still unavailable");

  const auth = authoritativeFor({ wordCount: 100, historicalSubmissionMatch: prod });
  await run(client, { deviceKey, reportId, accountId, production: prod, authoritative: auth, generation: 5 });
  const now = await readShadowRow(client, deviceKey, reportId);
  assert.equal(String(now.status), "OK", "re-evaluated once the authoritative result became available");
  assert.equal(Number(now.candidate_count), 1);
});

test("a version-tag change (unified_similarity_version) forces recompute of an OK row", async () => {
  const deviceKey = uniq("dk"); const reportId = uniq("r"); const accountId = uniq("acct");
  const repId = await seedPromotedRepresentation(client, { sourceAccountId: uniq("source") });
  const production = matchedResult([corpusMatch({ repId, matchedWordCount: 100 })]);
  const authoritative = authoritativeFor({ wordCount: 100, historicalSubmissionMatch: production });
  await seedSavedReport(client, { deviceKey, reportId, accountId, text: TEXT });
  await run(client, { deviceKey, reportId, accountId, production, authoritative, generation: 5 });
  // simulate a stored row from a previous unified-similarity version
  await client.execute({
    sql: "UPDATE corpus_duplicate_suppression_shadow_evaluations SET unified_similarity_version = 'unified-similarity-v0', computed_at = datetime('now','-1 hour') WHERE report_device_key = ? AND report_id = ?",
    args: [deviceKey, reportId],
  });
  const before = String((await readShadowRow(client, deviceKey, reportId)).computed_at);
  await run(client, { deviceKey, reportId, accountId, production, authoritative, generation: 5 });
  const after = await readShadowRow(client, deviceKey, reportId);
  assert.notEqual(String(after.computed_at), before, "recomputed on a version mismatch");
  assert.equal(String(after.unified_similarity_version), "unified-similarity-v1");
});

// --- item 4: checker-account side signal FAILED is independently retried ----
// A checker-probe failure never fails the core evaluation (status stays
// OK/BOUNDED); the row is flagged checker_accounts_status = 'FAILED'. Its own
// 15-minute cooldown then governs a checker-only retry — a full evaluator
// recompute, which leaves the core score / counterfactual identical because
// their inputs are unchanged.

const CHECKER_PROBE_RE = /SELECT DISTINCT account_id/i;
function checkerFailingSpy(real) {
  return {
    execute: async (stmt) => {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      if (CHECKER_PROBE_RE.test(sql)) throw new Error("simulated checker probe outage");
      return real.execute(stmt);
    },
    batch: (...a) => real.batch(...a),
    close: () => {},
  };
}

async function seedCandidate(deviceKey, reportId, accountId) {
  const repId = await seedPromotedRepresentation(client, { sourceAccountId: uniq("source") });
  const production = matchedResult([corpusMatch({ repId, matchedWordCount: 100 })]);
  const authoritative = authoritativeFor({ wordCount: 100, historicalSubmissionMatch: production });
  await seedSavedReport(client, { deviceKey, reportId, accountId, text: TEXT, unifiedSimilarity: authoritative });
  return { production, authoritative };
}

test("item 4: checker FAILED is NOT retried within the 15-minute cooldown", async () => {
  const deviceKey = uniq("dk"); const reportId = uniq("r"); const accountId = uniq("acct");
  const { production, authoritative } = await seedCandidate(deviceKey, reportId, accountId);

  await runShadowEval(checkerFailingSpy(client), {
    reportDeviceKey: deviceKey, reportId, accountId, rawText: TEXT,
    productionResult: production, authoritativeUnifiedSimilarity: authoritative,
    effectiveDeviceSelfRepresentationIds: [], authoritativeCorpusGeneration: 5,
  });
  const first = await readShadowRow(client, deviceKey, reportId);
  assert.equal(String(first.status), "OK");
  assert.equal(String(first.checker_accounts_status), "FAILED");
  assert.equal(first.distinct_checker_accounts_bucket, null);
  const firstComputedAt = String(first.computed_at);

  // A working client, but still inside the cooldown -> the whole row is reused.
  await new Promise((r) => setTimeout(r, 1100));
  await run(client, { deviceKey, reportId, accountId, production, authoritative, generation: 5 });
  const second = await readShadowRow(client, deviceKey, reportId);
  assert.equal(String(second.computed_at), firstComputedAt, "reused — checker cooldown not elapsed");
  assert.equal(String(second.checker_accounts_status), "FAILED");
});

test("item 4: checker FAILED IS retried once its cooldown elapses -> transitions to OK + a real bucket", async () => {
  const deviceKey = uniq("dk"); const reportId = uniq("r"); const accountId = uniq("acct");
  const { production, authoritative } = await seedCandidate(deviceKey, reportId, accountId);
  // one OTHER account has run a check on this exact text -> bucket resolves to "1"
  await seedCheckerIdentity(client, uniq("checker"), TEXT);

  await runShadowEval(checkerFailingSpy(client), {
    reportDeviceKey: deviceKey, reportId, accountId, rawText: TEXT,
    productionResult: production, authoritativeUnifiedSimilarity: authoritative,
    effectiveDeviceSelfRepresentationIds: [], authoritativeCorpusGeneration: 5,
  });
  assert.equal(String((await readShadowRow(client, deviceKey, reportId)).checker_accounts_status), "FAILED");

  // back-date the row past the 15-minute checker cooldown
  await client.execute({
    sql: "UPDATE corpus_duplicate_suppression_shadow_evaluations SET computed_at = datetime('now','-20 minutes') WHERE report_device_key = ? AND report_id = ?",
    args: [deviceKey, reportId],
  });
  await run(client, { deviceKey, reportId, accountId, production, authoritative, generation: 5 });
  const recovered = await readShadowRow(client, deviceKey, reportId);
  assert.equal(String(recovered.status), "OK");
  assert.equal(String(recovered.checker_accounts_status), "OK", "checker probe reran on the working client");
  assert.equal(String(recovered.distinct_checker_accounts_bucket), "1");
});

test("item 4: the core score / counterfactual is byte-identical across a checker-only recovery", async () => {
  const deviceKey = uniq("dk"); const reportId = uniq("r"); const accountId = uniq("acct");
  const { production, authoritative } = await seedCandidate(deviceKey, reportId, accountId);

  await runShadowEval(checkerFailingSpy(client), {
    reportDeviceKey: deviceKey, reportId, accountId, rawText: TEXT,
    productionResult: production, authoritativeUnifiedSimilarity: authoritative,
    effectiveDeviceSelfRepresentationIds: [], authoritativeCorpusGeneration: 5,
  });
  const failed = await readShadowRow(client, deviceKey, reportId);
  assert.equal(String(failed.checker_accounts_status), "FAILED");

  await client.execute({
    sql: "UPDATE corpus_duplicate_suppression_shadow_evaluations SET computed_at = datetime('now','-20 minutes') WHERE report_device_key = ? AND report_id = ?",
    args: [deviceKey, reportId],
  });
  await run(client, { deviceKey, reportId, accountId, production, authoritative, generation: 5 });
  const recovered = await readShadowRow(client, deviceKey, reportId);

  assert.equal(String(recovered.checker_accounts_status), "OK", "checker recovered");
  for (const col of [
    "status", "authoritative_score", "hypothetical_score", "score_delta",
    "authoritative_unique_matched_words", "hypothetical_unique_matched_words",
    "unique_matched_words_removed", "candidate_matched_words", "candidates_excluded",
    "archive_only_words_surviving", "live_academic_only_words_surviving",
    "previous_upload_only_words_surviving", "overlap_words_surviving",
    "candidate_count", "measurement_category", "origin_confidence", "multi_origin_evidence",
    "candidate_admitted_promotion_backing_count", "candidate_submission_reference_backing_count",
    "authoritative_corpus_generation", "authoritative_snapshot_computed_at",
  ]) {
    assert.equal(String(recovered[col]), String(failed[col]), `${col} unchanged by the checker-only recovery`);
  }
});
