import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { canonicalSha256 } from "../lib/document-identity.ts";
import { runCorpusAdmissionPromotionSweep, MAX_PROMOTION_ATTEMPTS } from "../lib/corpus-admission-promotion.ts";
import { listCorpusAdmissionDecisions, getCorpusAdmissionDecisionDetail } from "../lib/corpus-admission-admin-repo.ts";

/**
 * The admin dashboard's own read layer must surface promotion status
 * (staged/indexed/failed/skipped), attempts, last error, and representation
 * id — see lib/corpus-admission-admin-repo.ts's listCorpusAdmissionDecisions
 * and getCorpusAdmissionDecisionDetail. Every fixture is synthetic.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_corpus_admission_promotion_admin_visibility.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);
const openConnection = () => createClient({ url: `file:${dbFile}` });

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

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
      id, null, overrides.sourceRef ?? `promotion-visibility-test-${randomUUID()}`, "v1", overrides.decision, JSON.stringify([]),
      1, JSON.stringify([]), "txt", 50, "English", 0.95,
      overrides.canonicalSha256 ?? randomUUID(), "v1", null, 80, "v1",
      JSON.stringify({}), JSON.stringify({}), "v1", 0.9, "v1", "NONE", null, null,
      JSON.stringify({ kind: "PER_USER_CONSENT", consented: true }), 0,
    ],
  });
  return id;
}

async function insertAcceptedRepresentation(decisionId, hash) {
  const id = randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version, revoked_at, created_at)
          VALUES (?,?,?,?,?,NULL,CURRENT_TIMESTAMP)`,
    args: [id, decisionId, hash, 50, "v1"],
  });
  return id;
}

async function insertContentStore(decisionId, hash, text) {
  await client.execute({
    sql: `INSERT INTO corpus_admission_content_store (id, decision_id, canonical_sha256, canonical_text, extractor_version, retention_basis, stored_at)
          VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [randomUUID(), decisionId, hash, text, "v1", "LICENSED_REUSE"],
  });
}

async function seedAcceptedDecision(text) {
  const hash = canonicalSha256(text);
  const decisionId = await insertDecision({ decision: "ACCEPT", canonicalSha256: hash });
  await insertAcceptedRepresentation(decisionId, hash);
  await insertContentStore(decisionId, hash, text);
  return { decisionId, hash };
}

test("list view surfaces promotionStatus for an indexed decision, and null for a decision with no promotion at all", async () => {
  const { decisionId } = await seedAcceptedDecision("Admin list visibility fixture text.");
  const reviewId = await insertDecision({ decision: "REVIEW" });

  const sweep = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  assert.ok(sweep.results.some((r) => r.decisionId === decisionId && r.outcome === "indexed"));

  const list = await listCorpusAdmissionDecisions(client, { pageSize: 50 });
  const indexedRow = list.rows.find((r) => r.rowId === `decision:${decisionId}`);
  const reviewRow = list.rows.find((r) => r.rowId === `decision:${reviewId}`);

  assert.ok(indexedRow, "expected the promoted decision to appear in the list");
  assert.equal(indexedRow.promotionStatus, "indexed");
  assert.ok(reviewRow, "expected the REVIEW decision to appear in the list");
  assert.equal(reviewRow.promotionStatus, null, "a decision that was never ACCEPTed must show no promotion status at all");
});

test("detail view surfaces status, attempt count, last error, and representation id", async () => {
  const { decisionId } = await seedAcceptedDecision("Admin detail visibility fixture text.");
  const sweep = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  const outcome = sweep.results.find((r) => r.decisionId === decisionId);
  assert.equal(outcome.outcome, "indexed");

  const detail = await getCorpusAdmissionDecisionDetail(client, `decision:${decisionId}`);
  assert.ok(detail);
  assert.equal(detail.promotionStatus, "indexed");
  assert.equal(detail.promotionAttemptCount, 1);
  assert.equal(detail.promotionLastError, null);
  assert.equal(detail.promotionRepresentationId, outcome.representationId);
});

test("detail view surfaces a failed promotion's last error and null representation id", async () => {
  // A hash-mismatched fixture: guaranteed to fail, exercising the 'failed' + last_error path end to end through the admin repo.
  const storedHash = canonicalSha256("What accepted_representations claims.");
  const decisionId = await insertDecision({ decision: "ACCEPT", canonicalSha256: storedHash });
  await insertAcceptedRepresentation(decisionId, storedHash);
  await insertContentStore(decisionId, storedHash, "What content_store actually has — deliberately different.");

  const sweep = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  const outcome = sweep.results.find((r) => r.decisionId === decisionId);
  assert.equal(outcome.outcome, "failed");

  const detail = await getCorpusAdmissionDecisionDetail(client, `decision:${decisionId}`);
  assert.equal(detail.promotionStatus, "failed");
  assert.ok(detail.promotionLastError && detail.promotionLastError.length > 0);
  assert.equal(detail.promotionRepresentationId, null);

  const list = await listCorpusAdmissionDecisions(client, { pageSize: 50 });
  const row = list.rows.find((r) => r.rowId === `decision:${decisionId}`);
  assert.equal(row.promotionStatus, "failed");
});

test("B1C: list and detail views distinguish a retryable 'failed' promotion (attempt N/MAX) from a terminal 'dead_lettered' one (exhausted MAX/MAX), and both surface the final error admin-only", async () => {
  const storedHash = canonicalSha256("B1C admin-visibility dead-letter fixture stored hash.");
  const decisionId = await insertDecision({ decision: "ACCEPT", canonicalSha256: storedHash });
  await insertAcceptedRepresentation(decisionId, storedHash);
  await insertContentStore(decisionId, storedHash, "B1C admin-visibility dead-letter fixture: deliberately mismatched retained text.");

  let lastOutcome;
  for (let i = 1; i <= MAX_PROMOTION_ATTEMPTS; i += 1) {
    const sweep = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
    lastOutcome = sweep.results.find((r) => r.decisionId === decisionId);
    if (i < MAX_PROMOTION_ATTEMPTS) {
      const midDetail = await getCorpusAdmissionDecisionDetail(client, `decision:${decisionId}`);
      assert.equal(midDetail.promotionStatus, "failed", `attempt ${i} must still surface as retryable 'failed'`);
      assert.equal(midDetail.promotionAttemptCount, i, `attempt count must reflect exactly ${i} completed attempts`);
    }
  }
  assert.equal(lastOutcome.outcome, "dead_lettered");

  const detail = await getCorpusAdmissionDecisionDetail(client, `decision:${decisionId}`);
  assert.equal(detail.promotionStatus, "dead_lettered", "REQUIRED: the exhausted promotion must surface as 'dead_lettered', not 'failed'");
  assert.equal(detail.promotionAttemptCount, MAX_PROMOTION_ATTEMPTS, "REQUIRED: attempt count must show exhausted MAX/MAX");
  assert.ok(detail.promotionLastError && detail.promotionLastError.length > 0, "the final error must remain visible in the admin-only detail view");
  assert.equal(detail.promotionRepresentationId, null, "a dead-lettered promotion never produced a representation");

  const list = await listCorpusAdmissionDecisions(client, { pageSize: 50 });
  const row = list.rows.find((r) => r.rowId === `decision:${decisionId}`);
  assert.equal(row.promotionStatus, "dead_lettered", "REQUIRED: the list view must also distinguish dead_lettered from failed");
  assert.equal(row.promotionAttemptCount, MAX_PROMOTION_ATTEMPTS, "REQUIRED: the list view must also surface the exhausted attempt count");
});
