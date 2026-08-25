import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createSession, SESSION_COOKIE_NAME } from "../lib/auth-session.ts";
import { resetAuthRateForTest } from "../lib/rate-limit.js";
import * as sweepRoute from "../app/api/internal/corpus-admission-sweep/route.ts";
import { runCorpusAdmissionRetentionSweep, isCorpusRetentionEnabled, CORPUS_RETENTION_DAYS } from "../lib/corpus-admission-retention-sweep.ts";

/**
 * Task B1B: lib/corpus-admission-retention-sweep.ts (the pure sweep logic)
 * and its wiring into the EXISTING app/api/internal/corpus-admission-sweep/
 * route.ts cron trigger — no new route, no new cron entry. Every fixture is
 * synthetic.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_corpus_admission_retention_sweep.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
const dbUrl = `file:${dbFile}`;
process.env.TURSO_DATABASE_URL = dbUrl;

const client = createClient({ url: dbUrl });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

const originalRetentionFlag = process.env.CORPUS_RETENTION_ENABLED;
const originalAdmissionFlag = process.env.CORPUS_ADMISSION_ENABLED;
const originalCronSecret = process.env.CRON_SECRET;
test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
  if (originalRetentionFlag === undefined) delete process.env.CORPUS_RETENTION_ENABLED; else process.env.CORPUS_RETENTION_ENABLED = originalRetentionFlag;
  if (originalAdmissionFlag === undefined) delete process.env.CORPUS_ADMISSION_ENABLED; else process.env.CORPUS_ADMISSION_ENABLED = originalAdmissionFlag;
  if (originalCronSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = originalCronSecret;
});

function openConnection() {
  return createClient({ url: dbUrl });
}

let counter = 0;
function uniq(label) {
  counter += 1;
  return `retention-${label}-${counter}-${randomUUID()}`;
}

async function insertDecision(overrides) {
  const id = overrides.id ?? randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_decisions
          (id, run_id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes,
           detected_format, extracted_word_count, detected_language, language_confidence, canonical_sha256, extractor_version,
           content_store_id, quality_score, quality_model_version, component_scores, feature_vector, feature_vector_version,
           corpus_value_score, corpus_value_model_version, family_relation, family_matched_source_ref, family_containment,
           consent_metadata, dry_run, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [
      id, overrides.runId ?? `run-${uniq("batch")}`, overrides.sourceRef ?? uniq("source"), "v1", overrides.decision,
      JSON.stringify(overrides.reasonCodes ?? []), 1, JSON.stringify([]),
      "txt", 500, "English", 0.95, overrides.canonicalSha256 ?? randomUUID(), "v1",
      overrides.contentStoreId ?? null, overrides.qualityScore ?? 40, "v1", "{}", "{}", "v1", 0.1, "v1", "NONE", null, null,
      JSON.stringify({ kind: "PER_USER_CONSENT", consented: true }), 0,
    ],
  });
  return id;
}

async function backdateDecision(id, days) {
  await client.execute({ sql: "UPDATE corpus_admission_decisions SET created_at = datetime('now', ?) WHERE id = ?", args: [`-${days} days`, id] });
}

async function insertJob(overrides) {
  const id = overrides.id ?? randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_report_jobs (id, source_ref, account_id, device_key, report_id, status, decision_id, claimed_at, attempt_count, last_error, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,NULL,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    args: [id, overrides.sourceRef ?? uniq("job-source"), overrides.accountId ?? uniq("account"), overrides.deviceKey ?? "dk", overrides.reportId ?? "rid", overrides.status, overrides.decisionId ?? null, overrides.attemptCount ?? 1, overrides.lastError ?? null],
  });
  return id;
}

async function backdateJob(id, days) {
  await client.execute({ sql: "UPDATE corpus_admission_report_jobs SET updated_at = datetime('now', ?) WHERE id = ?", args: [`-${days} days`, id] });
}

async function insertContentStore(decisionId, canonicalSha256) {
  const id = randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_content_store (id, decision_id, canonical_sha256, canonical_text, extractor_version, retention_basis, stored_at)
          VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [id, decisionId, canonicalSha256, "retained text fixture", "v1", "LICENSED_REUSE"],
  });
  await client.execute({ sql: "UPDATE corpus_admission_decisions SET content_store_id = ? WHERE id = ?", args: [id, decisionId] });
  return id;
}

async function insertAcceptedRepresentation(decisionId, canonicalSha256) {
  const id = randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version, revoked_at, created_at)
          VALUES (?,?,?,?,?,NULL,CURRENT_TIMESTAMP)`,
    args: [id, decisionId, canonicalSha256, 500, "v1"],
  });
  return id;
}

async function insertPromotion(decisionId, acceptedRepresentationId, status) {
  const id = randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_promotions (id, decision_id, accepted_representation_id, status, attempt_count, created_at, updated_at)
          VALUES (?,?,?,?,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    args: [id, decisionId, acceptedRepresentationId, status],
  });
  return id;
}

async function auditLogRows() {
  const result = await client.execute("SELECT * FROM corpus_admission_admin_audit_log");
  return result.rows;
}

// ============================================================================
// Core deletion rules (lib-level, direct calls)
// ============================================================================

test("younger than 30 days survives — an old-enough-looking REJECT with no dependency is untouched while inside the retention window", async () => {
  const id = await insertDecision({ decision: "REJECT" });
  // No backdate — created_at stays "now", well inside the 30-day window.
  const result = await runCorpusAdmissionRetentionSweep(client, { openConnection });
  assert.equal(result.decisionsDeleted, 0);

  const row = await client.execute({ sql: "SELECT id FROM corpus_admission_decisions WHERE id = ?", args: [id] });
  assert.equal(row.rows.length, 1, "a fresh REJECT decision must never be deleted");
});

test("old REJECT/REVIEW with no accepted content and no job dependency is removed", async () => {
  const rejectId = await insertDecision({ decision: "REJECT" });
  await backdateDecision(rejectId, CORPUS_RETENTION_DAYS + 1);
  const reviewId = await insertDecision({ decision: "REVIEW" });
  await backdateDecision(reviewId, CORPUS_RETENTION_DAYS + 1);

  const result = await runCorpusAdmissionRetentionSweep(client, { openConnection });
  assert.equal(result.decisionsDeleted, 2);
  assert.equal(result.skippedProtected, 0);

  const remaining = await client.execute({ sql: "SELECT id FROM corpus_admission_decisions WHERE id IN (?,?)", args: [rejectId, reviewId] });
  assert.equal(remaining.rows.length, 0, "both the old REJECT and old REVIEW decisions must be gone");
});

test("old failed/cancelled jobs are removed; a fresh job in the same states survives", async () => {
  const failedOld = await insertJob({ status: "failed" });
  await backdateJob(failedOld, CORPUS_RETENTION_DAYS + 1);
  const cancelledOld = await insertJob({ status: "cancelled" });
  await backdateJob(cancelledOld, CORPUS_RETENTION_DAYS + 1);
  const failedFresh = await insertJob({ status: "failed" }); // not backdated

  const result = await runCorpusAdmissionRetentionSweep(client, { openConnection });
  assert.equal(result.jobsDeleted, 2);

  const gone = await client.execute({ sql: "SELECT id FROM corpus_admission_report_jobs WHERE id IN (?,?)", args: [failedOld, cancelledOld] });
  assert.equal(gone.rows.length, 0);
  const survives = await client.execute({ sql: "SELECT id FROM corpus_admission_report_jobs WHERE id = ?", args: [failedFresh] });
  assert.equal(survives.rows.length, 1, "a fresh failed job must survive even though the batch also had old ones");
});

test("PROTECTED: accepted content — an old ACCEPTed decision, its retained text, its fingerprint, and its promotion are all completely untouched", async () => {
  const decisionId = await insertDecision({ decision: "ACCEPT" });
  await backdateDecision(decisionId, CORPUS_RETENTION_DAYS + 5);
  const hash = randomUUID();
  const contentStoreId = await insertContentStore(decisionId, hash);
  const acceptedRepId = await insertAcceptedRepresentation(decisionId, hash);
  const promotionId = await insertPromotion(decisionId, acceptedRepId, "indexed");

  const result = await runCorpusAdmissionRetentionSweep(client, { openConnection });
  assert.equal(result.decisionsDeleted, 0, "an ACCEPT decision must never be selected at all — the query is scoped to REJECT/REVIEW");

  const decisionRow = await client.execute({ sql: "SELECT id FROM corpus_admission_decisions WHERE id = ?", args: [decisionId] });
  assert.equal(decisionRow.rows.length, 1);
  const contentRow = await client.execute({ sql: "SELECT id FROM corpus_admission_content_store WHERE id = ?", args: [contentStoreId] });
  assert.equal(contentRow.rows.length, 1);
  const repRow = await client.execute({ sql: "SELECT id FROM corpus_admission_accepted_representations WHERE id = ?", args: [acceptedRepId] });
  assert.equal(repRow.rows.length, 1);
  const promoRow = await client.execute({ sql: "SELECT id FROM corpus_admission_promotions WHERE id = ?", args: [promotionId] });
  assert.equal(promoRow.rows.length, 1);
});

test("PROTECTED: a decision with a live job dependency survives even though it is old, REJECT, and has no retained content", async () => {
  const decisionId = await insertDecision({ decision: "REJECT" });
  await backdateDecision(decisionId, CORPUS_RETENTION_DAYS + 1);
  await insertJob({ status: "succeeded", decisionId }); // the live report-upload shape: a succeeded job still points at this decision

  const result = await runCorpusAdmissionRetentionSweep(client, { openConnection });
  assert.equal(result.decisionsDeleted, 0);
  assert.equal(result.skippedProtected, 1, "the age+type candidate must be counted as protected, not silently ignored");

  const row = await client.execute({ sql: "SELECT id FROM corpus_admission_decisions WHERE id = ?", args: [decisionId] });
  assert.equal(row.rows.length, 1, "deleting this decision would orphan the succeeded job's decision_id and break the admin dashboard's status derivation");

  // This decision is permanently protected by design (its job never
  // expires) — clean it up explicitly so it doesn't keep showing up as a
  // "skippedProtected" candidate in every later test's own sweep call in
  // this shared-DB test file.
  await client.execute({ sql: "DELETE FROM corpus_admission_report_jobs WHERE decision_id = ?", args: [decisionId] });
  await client.execute({ sql: "DELETE FROM corpus_admission_decisions WHERE id = ?", args: [decisionId] });
});

test("PROTECTED (defensive, structurally unreachable in production): a REJECT/REVIEW row that somehow carries a content_store_id survives", async () => {
  const decisionId = await insertDecision({ decision: "REVIEW" });
  await backdateDecision(decisionId, CORPUS_RETENTION_DAYS + 1);
  await insertContentStore(decisionId, randomUUID());

  const result = await runCorpusAdmissionRetentionSweep(client, { openConnection });
  assert.equal(result.decisionsDeleted, 0);

  const row = await client.execute({ sql: "SELECT id FROM corpus_admission_decisions WHERE id = ?", args: [decisionId] });
  assert.equal(row.rows.length, 1);

  // Same isolation cleanup as the previous PROTECTED test — see its own comment.
  await client.execute({ sql: "DELETE FROM corpus_admission_content_store WHERE decision_id = ?", args: [decisionId] });
  await client.execute({ sql: "DELETE FROM corpus_admission_decisions WHERE id = ?", args: [decisionId] });
});

// ============================================================================
// Race safety: a row that became ineligible while the sweep was running
// ============================================================================

test("RECHECK: a job that transitioned failed -> succeeded (gaining a decision_id) before the sweep's own delete runs survives, and is never counted as deleted", async () => {
  const decisionId = await insertDecision({ decision: "ACCEPT" });
  const jobId = await insertJob({ status: "failed" });
  await backdateJob(jobId, CORPUS_RETENTION_DAYS + 1);

  // Simulates runReportAdmissionRetrySweep (the sibling operation in the
  // SAME cron route) successfully retrying this exact job between when a
  // sweep would have first observed it as a stale 'failed' row and when its
  // own delete actually executes.
  await client.execute({
    sql: "UPDATE corpus_admission_report_jobs SET status = 'succeeded', decision_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    args: [decisionId, jobId],
  });

  const result = await runCorpusAdmissionRetentionSweep(client, { openConnection });
  assert.equal(result.jobsDeleted, 0, "a job that is no longer failed/cancelled by the time the sweep runs must never be counted as deleted");

  const row = await client.execute({ sql: "SELECT status FROM corpus_admission_report_jobs WHERE id = ?", args: [jobId] });
  assert.equal(row.rows[0].status, "succeeded");
});

test("RECHECK: genuine concurrency — a retry-success write racing the retention sweep never results in a deleted-but-still-succeeded job", async () => {
  const decisionId = await insertDecision({ decision: "ACCEPT" });
  const jobId = await insertJob({ status: "failed" });
  await backdateJob(jobId, CORPUS_RETENTION_DAYS + 1);

  const raceUpdate = async () => {
    const raceClient = openConnection();
    try {
      return await raceClient.execute({
        sql: "UPDATE corpus_admission_report_jobs SET status = 'succeeded', decision_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        args: [decisionId, jobId],
      });
    } finally {
      raceClient.close();
    }
  };

  const [sweepResult, updateResult] = await Promise.all([
    runCorpusAdmissionRetentionSweep(client, { openConnection }),
    raceUpdate(),
  ]);

  const finalRow = await client.execute({ sql: "SELECT status FROM corpus_admission_report_jobs WHERE id = ?", args: [jobId] });
  if (finalRow.rows.length === 0) {
    // The sweep's transaction won the race and committed the delete before
    // the update's write lock could be acquired — correct: the row really
    // was still 'failed' at that moment, and the update then legitimately
    // found nothing left to update.
    assert.equal(updateResult.rowsAffected, 0);
    assert.equal(sweepResult.jobsDeleted, 1);
  } else {
    // The update won the race — the row is 'succeeded', and the sweep must
    // never have counted it as deleted.
    assert.equal(finalRow.rows[0].status, "succeeded");
    assert.equal(sweepResult.jobsDeleted, 0);
  }
});

// ============================================================================
// Idempotency
// ============================================================================

test("IDEMPOTENT: running the sweep twice in a row only deletes once — the second run finds nothing left to do", async () => {
  const decisionId = await insertDecision({ decision: "REJECT" });
  await backdateDecision(decisionId, CORPUS_RETENTION_DAYS + 1);
  const jobId = await insertJob({ status: "cancelled" });
  await backdateJob(jobId, CORPUS_RETENTION_DAYS + 1);

  const first = await runCorpusAdmissionRetentionSweep(client, { openConnection });
  assert.equal(first.decisionsDeleted, 1);
  assert.equal(first.jobsDeleted, 1);

  const second = await runCorpusAdmissionRetentionSweep(client, { openConnection });
  assert.equal(second.decisionsDeleted, 0);
  assert.equal(second.jobsDeleted, 0);
  assert.equal(second.skippedProtected, 0);
});

// ============================================================================
// Unrelated data + audit log untouched
// ============================================================================

test("UNRELATED DATA UNCHANGED: users, saved_reports, and the admin audit log are byte-identical after a sweep that deletes real candidates", async () => {
  const ownerId = uniq("owner");
  await client.execute({
    sql: "INSERT INTO users (id, email, username, password_hash, role) VALUES (?,?,?,?,?)",
    args: [ownerId, `${ownerId}@example.test`, ownerId, "not-a-real-hash", "user"],
  });
  const deviceKey = uniq("device");
  const reportId = uniq("report");
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, user_id, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, saved_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    args: [reportId, deviceKey, ownerId, uniq("sub"), "unrelated.txt", new Date().toISOString(), 400, 3, "Low", JSON.stringify({ text: "unrelated report" })],
  });
  await client.execute({
    sql: "INSERT INTO corpus_admission_admin_audit_log (id, admin_user_id, action, decision_id, accepted_representation_id, reason, created_at) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)",
    args: [randomUUID(), uniq("admin"), "deactivate", randomUUID(), null, "unrelated prior action"],
  });

  const beforeUser = await client.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [ownerId] });
  const beforeReport = await client.execute({ sql: "SELECT * FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, reportId] });
  const beforeAudit = await auditLogRows();

  const staleDecision = await insertDecision({ decision: "REJECT" });
  await backdateDecision(staleDecision, CORPUS_RETENTION_DAYS + 1);
  const staleJob = await insertJob({ status: "failed" });
  await backdateJob(staleJob, CORPUS_RETENTION_DAYS + 1);

  const result = await runCorpusAdmissionRetentionSweep(client, { openConnection });
  assert.ok(result.decisionsDeleted >= 1 && result.jobsDeleted >= 1, "sanity: the sweep must have actually deleted something for this test to be meaningful");

  const afterUser = await client.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [ownerId] });
  const afterReport = await client.execute({ sql: "SELECT * FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, reportId] });
  const afterAudit = await auditLogRows();

  for (const column of ["id", "email", "username", "password_hash", "role"]) {
    assert.equal(afterUser.rows[0][column], beforeUser.rows[0][column], `users.${column} must be unchanged`);
  }
  for (const column of ["id", "device_key", "user_id", "payload_json", "title"]) {
    assert.equal(afterReport.rows[0][column], beforeReport.rows[0][column], `saved_reports.${column} must be unchanged`);
  }
  assert.equal(afterAudit.length, beforeAudit.length, "the retention sweep must never write to, or remove from, the admin audit log");
});

// ============================================================================
// The route: flag off = no changes; response contains counts only
// ============================================================================

const REAL_SECRET = "retention-route-test-secret-1a2b3c4d5e6f";
let ipCounter = 0;
async function callSweepRoute(headers) {
  ipCounter += 1;
  const ip = `retention-route-test-${ipCounter}`;
  await resetAuthRateForTest(ip);
  return sweepRoute.GET(new Request("http://localhost/api/internal/corpus-admission-sweep", { headers: { "x-forwarded-for": ip, ...headers } }));
}

test("FLAG OFF: with CORPUS_RETENTION_ENABLED unset, an eligible old REJECT decision is left completely untouched by a real route call", async () => {
  process.env.CRON_SECRET = REAL_SECRET;
  delete process.env.CORPUS_RETENTION_ENABLED;
  delete process.env.CORPUS_ADMISSION_ENABLED;
  assert.equal(isCorpusRetentionEnabled(), false);

  const decisionId = await insertDecision({ decision: "REJECT" });
  await backdateDecision(decisionId, CORPUS_RETENTION_DAYS + 1);

  const res = await callSweepRoute({ authorization: `Bearer ${REAL_SECRET}` });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.retention, { enabled: false, decisionsDeleted: 0, jobsDeleted: 0, skippedProtected: 0, failedPromotionsRetryable: 0 });

  const row = await client.execute({ sql: "SELECT id FROM corpus_admission_decisions WHERE id = ?", args: [decisionId] });
  assert.equal(row.rows.length, 1, "the flag being off must mean literally no row is touched, not just an unreported no-op");

  // This row is deliberately left eligible-but-undeleted to prove the point
  // above; clean it up so a LATER test that turns the flag back on doesn't
  // also (correctly, but confusingly for that test's own count) sweep it up.
  await client.execute({ sql: "DELETE FROM corpus_admission_decisions WHERE id = ?", args: [decisionId] });
});

test("RESPONSE SHAPE: retention enabled — the response carries counts only, never an account id, email, report id, or content hash", async () => {
  process.env.CRON_SECRET = REAL_SECRET;
  process.env.CORPUS_RETENTION_ENABLED = "true";
  delete process.env.CORPUS_ADMISSION_ENABLED;

  const secretAccountId = uniq("secret-account");
  const secretEmail = `${secretAccountId}@example.test`;
  const secretReportId = uniq("secret-report");
  const secretHash = randomUUID();

  const decisionId = await insertDecision({ decision: "REJECT", canonicalSha256: secretHash });
  await backdateDecision(decisionId, CORPUS_RETENTION_DAYS + 1);
  const jobId = await insertJob({ status: "failed", accountId: secretAccountId, reportId: secretReportId });
  await backdateJob(jobId, CORPUS_RETENTION_DAYS + 1);

  const res = await callSweepRoute({ authorization: `Bearer ${REAL_SECRET}` });
  assert.equal(res.status, 200);
  const rawBody = await res.text();
  const body = JSON.parse(rawBody);

  assert.equal(body.retention.enabled, true);
  assert.equal(body.retention.decisionsDeleted, 1);
  assert.equal(body.retention.jobsDeleted, 1);
  assert.deepEqual(Object.keys(body.retention).sort(), ["decisionsDeleted", "enabled", "failedPromotionsRetryable", "jobsDeleted", "skippedProtected"].sort());

  for (const secret of [secretAccountId, secretEmail, secretReportId, secretHash]) {
    assert.doesNotMatch(rawBody, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `the sweep response must never contain ${secret}`);
  }
});

test("RESPONSE SHAPE: failedPromotionsRetryable reports failed promotions without ever deleting them", async () => {
  process.env.CRON_SECRET = REAL_SECRET;
  process.env.CORPUS_RETENTION_ENABLED = "true";

  const decisionId = await insertDecision({ decision: "ACCEPT" });
  const hash = randomUUID();
  await insertContentStore(decisionId, hash);
  const acceptedRepId = await insertAcceptedRepresentation(decisionId, hash);
  const promotionId = await insertPromotion(decisionId, acceptedRepId, "failed");

  const result = await runCorpusAdmissionRetentionSweep(client, { openConnection });
  assert.ok(result.failedPromotionsRetryable >= 1);

  const stillThere = await client.execute({ sql: "SELECT status FROM corpus_admission_promotions WHERE id = ?", args: [promotionId] });
  assert.equal(stillThere.rows.length, 1);
  assert.equal(stillThere.rows[0].status, "failed", "a failed promotion must remain exactly as-is — retryable by the existing promotion sweep, never expired here");
});
