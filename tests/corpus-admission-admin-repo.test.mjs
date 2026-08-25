import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { listCorpusAdmissionDecisions, getCorpusAdmissionDecisionDetail } from "../lib/corpus-admission-admin-repo.ts";

/**
 * lib/corpus-admission-admin-repo.ts: list filtering/pagination (incl. the
 * server-enforced max page size), derived-status computation across every
 * combination, and detail-bundle assembly with and without a surviving job
 * row (accepted content survives report deletion — see
 * lib/corpus-admission-report-integration.ts). Fixtures are seeded directly
 * via SQL rather than through the full admission gate — this file tests the
 * admin read layer's own logic, not extraction/scoring, which is already
 * covered elsewhere. Every fixture is synthetic.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_corpus_admission_admin_repo.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

let userCounter = 0;
async function ensureUser() {
  userCounter += 1;
  const accountId = `admin-repo-account-${userCounter}`;
  await client.execute({
    sql: "INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
    args: [accountId, `${accountId}@example.test`, accountId, "not-a-real-hash"],
  });
  return accountId;
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
      id, null, overrides.sourceRef, "v1", overrides.decision, JSON.stringify(overrides.reasonCodes ?? []),
      1, JSON.stringify([]), "txt", overrides.wordCount ?? 3300, overrides.language ?? "English", 0.95,
      overrides.canonicalSha256 ?? randomUUID(), "v1", null, overrides.qualityScore ?? 80, "v1",
      JSON.stringify({ linguisticQuality: 80 }), JSON.stringify({}), "v1", 0.9, "v1", "NONE", null, null,
      JSON.stringify({ kind: "PER_USER_CONSENT", consented: true }), 0,
    ],
  });
  return id;
}

async function insertJob(overrides) {
  const id = overrides.id ?? randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_report_jobs
          (id, source_ref, account_id, device_key, report_id, status, decision_id, claimed_at, attempt_count, last_error, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    args: [id, overrides.sourceRef, overrides.accountId, overrides.deviceKey ?? "dk", overrides.reportId ?? "rid", overrides.status, overrides.decisionId ?? null, null, overrides.attemptCount ?? 1, overrides.lastError ?? null],
  });
  return id;
}

async function insertContentStore(decisionId, canonicalSha256, text) {
  const id = randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_content_store (id, decision_id, canonical_sha256, canonical_text, extractor_version, retention_basis, stored_at)
          VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [id, decisionId, canonicalSha256, text, "v1", "LICENSED_REUSE"],
  });
  return id;
}

async function insertAcceptedRepresentation(decisionId, canonicalSha256, revokedAt = null) {
  const id = randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version, revoked_at, created_at)
          VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [id, decisionId, canonicalSha256, 3300, "v1", revokedAt],
  });
  return id;
}

// --- derived status across every combination -----------------------------

test("derived status: pending/failed/cancelled (job-only, no decision)", async () => {
  const accountId = await ensureUser();
  const pendingJob = await insertJob({ sourceRef: `sr-pending-${randomUUID()}`, accountId, status: "pending" });
  const failedJob = await insertJob({ sourceRef: `sr-failed-${randomUUID()}`, accountId, status: "failed", lastError: "boom" });
  const cancelledJob = await insertJob({ sourceRef: `sr-cancelled-${randomUUID()}`, accountId, status: "cancelled" });

  const pendingDetail = await getCorpusAdmissionDecisionDetail(client, `job:${pendingJob}`);
  assert.equal(pendingDetail.status, "pending");
  const failedDetail = await getCorpusAdmissionDecisionDetail(client, `job:${failedJob}`);
  assert.equal(failedDetail.status, "failed");
  assert.equal(failedDetail.lastError, "boom");
  const cancelledDetail = await getCorpusAdmissionDecisionDetail(client, `job:${cancelledJob}`);
  assert.equal(cancelledDetail.status, "cancelled");
});

test("derived status: accepted/review/rejected (decision-driven)", async () => {
  const accountId = await ensureUser();

  const acceptSourceRef = `sr-accept-${randomUUID()}`;
  const acceptDecisionId = await insertDecision({ sourceRef: acceptSourceRef, decision: "ACCEPT" });
  await insertJob({ sourceRef: acceptSourceRef, accountId, status: "succeeded", decisionId: acceptDecisionId });
  const acceptHash = randomUUID();
  await client.execute({ sql: "UPDATE corpus_admission_decisions SET canonical_sha256 = ? WHERE id = ?", args: [acceptHash, acceptDecisionId] });
  await insertContentStore(acceptDecisionId, acceptHash, "full retained text here");
  await insertAcceptedRepresentation(acceptDecisionId, acceptHash);

  const reviewSourceRef = `sr-review-${randomUUID()}`;
  const reviewDecisionId = await insertDecision({ sourceRef: reviewSourceRef, decision: "REVIEW" });
  await insertJob({ sourceRef: reviewSourceRef, accountId, status: "succeeded", decisionId: reviewDecisionId });

  const rejectSourceRef = `sr-reject-${randomUUID()}`;
  const rejectDecisionId = await insertDecision({ sourceRef: rejectSourceRef, decision: "REJECT" });
  await insertJob({ sourceRef: rejectSourceRef, accountId, status: "succeeded", decisionId: rejectDecisionId });

  const acceptDetail = await getCorpusAdmissionDecisionDetail(client, `decision:${acceptDecisionId}`);
  assert.equal(acceptDetail.status, "accepted");
  assert.equal(acceptDetail.hasRetainedText, true);
  assert.equal(acceptDetail.acceptedRepresentationActive, true);

  const reviewDetail = await getCorpusAdmissionDecisionDetail(client, `decision:${reviewDecisionId}`);
  assert.equal(reviewDetail.status, "review");
  assert.equal(reviewDetail.hasRetainedText, false);

  const rejectDetail = await getCorpusAdmissionDecisionDetail(client, `decision:${rejectDecisionId}`);
  assert.equal(rejectDetail.status, "rejected");
});

test("detail: an ACCEPTed decision whose job row was removed (report deleted) still resolves — content survives, source report is reported as gone", async () => {
  const acceptSourceRef = `sr-orphan-${randomUUID()}`;
  const decisionId = await insertDecision({ sourceRef: acceptSourceRef, decision: "ACCEPT" });
  const hash = randomUUID();
  await client.execute({ sql: "UPDATE corpus_admission_decisions SET canonical_sha256 = ? WHERE id = ?", args: [hash, decisionId] });
  await insertContentStore(decisionId, hash, "orphaned retained text");
  await insertAcceptedRepresentation(decisionId, hash);
  // Deliberately no job row inserted — simulates report/job deletion after ACCEPT.

  const detail = await getCorpusAdmissionDecisionDetail(client, `decision:${decisionId}`);
  assert.equal(detail.status, "accepted");
  assert.equal(detail.hasRetainedText, true);
  assert.equal(detail.jobId, null);
  assert.equal(detail.accountId, null);
  assert.equal(detail.reportStillExists, false);
});

test("getCorpusAdmissionDecisionDetail returns null for a nonexistent or malformed row id", async () => {
  assert.equal(await getCorpusAdmissionDecisionDetail(client, `decision:${randomUUID()}`), null);
  assert.equal(await getCorpusAdmissionDecisionDetail(client, `job:${randomUUID()}`), null);
  assert.equal(await getCorpusAdmissionDecisionDetail(client, "not-a-valid-prefix:abc"), null);
  assert.equal(await getCorpusAdmissionDecisionDetail(client, "decision:"), null);
});

// --- list: acceptedRepresentationId/acceptedRepresentationActive ----------
// Drives the admin dashboard's Remove ("active") vs Removed ("deactivated")
// affordance beside Inspect — see components/admin/corpus-search.tsx.

test("listCorpusAdmissionDecisions: acceptedRepresentationActive is true for an active fingerprint, false once deactivated, and null when no fingerprint exists at all", async () => {
  const accountId = await ensureUser();
  const marker = randomUUID();

  const acceptSourceRef = `remove-ui-active-${marker}`;
  const acceptDecisionId = await insertDecision({ sourceRef: acceptSourceRef, decision: "ACCEPT" });
  await insertJob({ sourceRef: acceptSourceRef, accountId, status: "succeeded", decisionId: acceptDecisionId });
  const acceptedRepresentationId = await insertAcceptedRepresentation(acceptDecisionId, randomUUID());

  const rejectSourceRef = `remove-ui-reject-${marker}`;
  const rejectDecisionId = await insertDecision({ sourceRef: rejectSourceRef, decision: "REJECT" });
  await insertJob({ sourceRef: rejectSourceRef, accountId, status: "succeeded", decisionId: rejectDecisionId });

  const pendingJobId = await insertJob({ sourceRef: `remove-ui-pending-${marker}`, accountId, status: "pending" });

  const beforeDeactivate = await listCorpusAdmissionDecisions(client, { q: marker });
  const rowsById = Object.fromEntries(beforeDeactivate.rows.map((r) => [r.rowId, r]));

  const activeRow = rowsById[`decision:${acceptDecisionId}`];
  assert.equal(activeRow.acceptedRepresentationId, acceptedRepresentationId);
  assert.equal(activeRow.acceptedRepresentationActive, true);

  const rejectedRow = rowsById[`decision:${rejectDecisionId}`];
  assert.equal(rejectedRow.acceptedRepresentationId, null);
  assert.equal(rejectedRow.acceptedRepresentationActive, null);

  const pendingRow = rowsById[`job:${pendingJobId}`];
  assert.equal(pendingRow.acceptedRepresentationId, null);
  assert.equal(pendingRow.acceptedRepresentationActive, null);

  await client.execute({
    sql: "UPDATE corpus_admission_accepted_representations SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?",
    args: [acceptedRepresentationId],
  });

  const afterDeactivate = await listCorpusAdmissionDecisions(client, { q: marker });
  const deactivatedRow = afterDeactivate.rows.find((r) => r.rowId === `decision:${acceptDecisionId}`);
  assert.equal(deactivatedRow.acceptedRepresentationId, acceptedRepresentationId, "the row must remain in the list, still carrying its (now inactive) fingerprint id");
  assert.equal(deactivatedRow.acceptedRepresentationActive, false);
});

// --- list: filtering, search, pagination, max page size -------------------

test("listCorpusAdmissionDecisions: status filter returns only matching rows", async () => {
  const accountId = await ensureUser();
  const marker = randomUUID();
  const pendingJob = await insertJob({ sourceRef: `filter-pending-${marker}`, accountId, status: "pending" });
  const acceptedSourceRef = `filter-accepted-${marker}`;
  const acceptedDecisionId = await insertDecision({ sourceRef: acceptedSourceRef, decision: "ACCEPT" });
  await insertJob({ sourceRef: acceptedSourceRef, accountId, status: "succeeded", decisionId: acceptedDecisionId });

  const pendingResult = await listCorpusAdmissionDecisions(client, { status: "pending", q: marker });
  assert.equal(pendingResult.rows.length, 1);
  assert.equal(pendingResult.rows[0].rowId, `job:${pendingJob}`);

  const acceptedResult = await listCorpusAdmissionDecisions(client, { status: "accepted", q: marker });
  assert.equal(acceptedResult.rows.length, 1);
  assert.equal(acceptedResult.rows[0].rowId, `decision:${acceptedDecisionId}`);
});

test("listCorpusAdmissionDecisions: language filter", async () => {
  const marker = randomUUID();
  const enSourceRef = `lang-en-${marker}`;
  const enDecisionId = await insertDecision({ sourceRef: enSourceRef, decision: "REJECT", language: "English" });
  const frSourceRef = `lang-fr-${marker}`;
  await insertDecision({ sourceRef: frSourceRef, decision: "REJECT", language: "French" });

  const result = await listCorpusAdmissionDecisions(client, { language: "English", q: marker });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].rowId, `decision:${enDecisionId}`);
});

test("listCorpusAdmissionDecisions: free-text search matches source_ref and last_error", async () => {
  const accountId = await ensureUser();
  const marker = randomUUID();
  const failedJob = await insertJob({ sourceRef: `search-target-${marker}`, accountId, status: "failed", lastError: `unique failure token ${marker}` });
  await insertJob({ sourceRef: `unrelated-${randomUUID()}`, accountId, status: "failed", lastError: "some other error" });

  const bySourceRef = await listCorpusAdmissionDecisions(client, { q: `search-target-${marker}` });
  assert.equal(bySourceRef.rows.length, 1);
  assert.equal(bySourceRef.rows[0].rowId, `job:${failedJob}`);

  const byError = await listCorpusAdmissionDecisions(client, { q: `unique failure token ${marker}` });
  assert.equal(byError.rows.length, 1);
  assert.equal(byError.rows[0].rowId, `job:${failedJob}`);
});

test("listCorpusAdmissionDecisions: pagination — page/pageSize are honored and totalCount reflects the full filtered set", async () => {
  const accountId = await ensureUser();
  const marker = randomUUID();
  const ids = [];
  for (let i = 0; i < 5; i += 1) {
    ids.push(await insertJob({ sourceRef: `page-${marker}-${i}`, accountId, status: "pending" }));
  }

  const page1 = await listCorpusAdmissionDecisions(client, { q: marker, page: 1, pageSize: 2 });
  assert.equal(page1.rows.length, 2);
  assert.equal(page1.totalCount, 5);
  assert.equal(page1.page, 1);
  assert.equal(page1.pageSize, 2);

  const page2 = await listCorpusAdmissionDecisions(client, { q: marker, page: 2, pageSize: 2 });
  assert.equal(page2.rows.length, 2);

  const page3 = await listCorpusAdmissionDecisions(client, { q: marker, page: 3, pageSize: 2 });
  assert.equal(page3.rows.length, 1);

  const allRowIds = [...page1.rows, ...page2.rows, ...page3.rows].map((r) => r.rowId);
  assert.equal(new Set(allRowIds).size, 5, "pagination must never repeat or skip a row across pages");
});

test("PAGINATION-LIMIT: a requested pageSize far beyond the server maximum is clamped, never honored as-is", async () => {
  const result = await listCorpusAdmissionDecisions(client, { pageSize: 100000 });
  assert.ok(result.pageSize <= 100, `pageSize must be server-clamped to a bounded maximum, got ${result.pageSize}`);
});

test("PAGINATION-LIMIT: a non-positive or missing page/pageSize falls back to a safe default, never 0 or negative", async () => {
  const result = await listCorpusAdmissionDecisions(client, { page: -5, pageSize: -5 });
  assert.ok(result.page >= 1);
  assert.ok(result.pageSize >= 1);
});
