import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { canonicalSha256 } from "../lib/document-identity.ts";
import { runCorpusAdmissionPromotionSweep } from "../lib/corpus-admission-promotion.ts";

/**
 * lib/corpus-admission-promotion.ts: ACCEPT-only promotion, idempotent
 * indexing, canonical-hash dedup (reused vs. newly-created representation),
 * the permanent 'skipped' outcome for a decision with no retained text, a
 * corrupted-fixture hash mismatch surfacing as a visible 'failed' (never an
 * uncaught throw), and identity non-disclosure. Concurrency, multi-source
 * matching eligibility, and admin-dashboard visibility are covered by
 * tests/corpus-admission-promotion-sweep.test.mjs and
 * tests/corpus-admission-promotion-admin-visibility.test.mjs. Every fixture
 * is synthetic.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_corpus_admission_promotion.db");
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
      id, null, overrides.sourceRef ?? `promotion-test-${randomUUID()}`, "v1", overrides.decision, JSON.stringify([]),
      1, JSON.stringify([]), "txt", overrides.wordCount ?? 50, overrides.language ?? "English", 0.95,
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
  const id = randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_content_store (id, decision_id, canonical_sha256, canonical_text, extractor_version, retention_basis, stored_at)
          VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [id, decisionId, hash, text, "v1", "LICENSED_REUSE"],
  });
  return id;
}

/** A real, internally-consistent ACCEPT fixture: decision + accepted_representation + content_store, all keyed on TEXT's real canonicalSha256 — required for processCorpusAdmissionPromotion's own integrity check to pass. */
async function seedAcceptedDecision(text, overrides = {}) {
  const hash = canonicalSha256(text);
  const decisionId = await insertDecision({ decision: "ACCEPT", canonicalSha256: hash, ...overrides });
  const acceptedRepresentationId = await insertAcceptedRepresentation(decisionId, hash);
  await insertContentStore(decisionId, hash, text);
  return { decisionId, acceptedRepresentationId, hash };
}

async function countRows(sql, args = []) {
  const result = await client.execute({ sql, args });
  return Number(result.rows[0].c);
}

test("ACCEPT-only: the sweep never creates a promotions row for a REVIEW or REJECT decision", async () => {
  const { decisionId: acceptId } = await seedAcceptedDecision("Accept-only fixture text for the ACCEPT-only promotion test.");
  const reviewId = await insertDecision({ decision: "REVIEW" });
  const rejectId = await insertDecision({ decision: "REJECT" });

  const sweep = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });

  const promotedDecisionIds = sweep.results.map((r) => r.decisionId);
  assert.ok(promotedDecisionIds.includes(acceptId));
  assert.ok(!promotedDecisionIds.includes(reviewId));
  assert.ok(!promotedDecisionIds.includes(rejectId));

  const reviewRow = await client.execute({ sql: "SELECT 1 AS present FROM corpus_admission_promotions WHERE decision_id = ?", args: [reviewId] });
  assert.equal(reviewRow.rows.length, 0);
  const rejectRow = await client.execute({ sql: "SELECT 1 AS present FROM corpus_admission_promotions WHERE decision_id = ?", args: [rejectId] });
  assert.equal(rejectRow.rows.length, 0);
});

test("idempotent: a second sweep over an already-indexed decision creates no new representation, shingle rows, or promotion attempt", async () => {
  const text = "Idempotency fixture text — running the sweep twice must not duplicate anything.";
  const { decisionId, hash } = await seedAcceptedDecision(text);

  const first = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  const firstOutcome = first.results.find((r) => r.decisionId === decisionId);
  assert.equal(firstOutcome.outcome, "indexed");

  const repCountAfterFirst = await countRows("SELECT COUNT(*) AS c FROM corpus_document_representations WHERE canonical_sha256 = ?", [hash]);
  const shingleCountAfterFirst = await countRows("SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE representation_id = ?", [firstOutcome.representationId]);
  const attemptsAfterFirst = await countRows("SELECT attempt_count AS c FROM corpus_admission_promotions WHERE decision_id = ?", [decisionId]);

  const second = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  assert.ok(!second.claimedPromotionIds.length || !second.results.some((r) => r.decisionId === decisionId), "an already-'indexed' promotion must never be reclaimed by a later sweep");

  const repCountAfterSecond = await countRows("SELECT COUNT(*) AS c FROM corpus_document_representations WHERE canonical_sha256 = ?", [hash]);
  const shingleCountAfterSecond = await countRows("SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE representation_id = ?", [firstOutcome.representationId]);
  const attemptsAfterSecond = await countRows("SELECT attempt_count AS c FROM corpus_admission_promotions WHERE decision_id = ?", [decisionId]);

  assert.equal(repCountAfterSecond, repCountAfterFirst);
  assert.equal(shingleCountAfterSecond, shingleCountAfterFirst);
  assert.equal(attemptsAfterSecond, attemptsAfterFirst);
});

test("reused representation: two accepted decisions with identical canonical text share one representation, tagged NEW_CONTENT_REPRESENTATION then EXACT_CANONICAL_DUPLICATE", async () => {
  const text = "Shared-content fixture: two different accepted decisions, byte-identical text, one representation.";
  const first = await seedAcceptedDecision(text);
  // corpus_admission_accepted_representations only allows ONE active row per
  // canonical hash at a time (a real partial UNIQUE index) — a second
  // decision over the same content is only insertable once the first is
  // revoked, the same REPLACEMENT-ADMISSION sequence
  // lib/corpus-admission-admin-actions.ts's own reactivate conflict check is
  // built around. Revoking it has no bearing on what THIS test checks
  // (representation/shingle reuse, not eligibility — see
  // tests/corpus-admission-promotion-sweep.test.mjs for eligibility).
  await client.execute({ sql: "UPDATE corpus_admission_accepted_representations SET revoked_at = CURRENT_TIMESTAMP WHERE decision_id = ?", args: [first.decisionId] });
  const second = await seedAcceptedDecision(text);
  assert.equal(first.hash, second.hash, "test setup sanity: both fixtures must hash identically");

  const sweep = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  const firstOutcome = sweep.results.find((r) => r.decisionId === first.decisionId);
  const secondOutcome = sweep.results.find((r) => r.decisionId === second.decisionId);
  assert.equal(firstOutcome.outcome, "indexed");
  assert.equal(secondOutcome.outcome, "indexed");
  assert.equal(firstOutcome.representationId, secondOutcome.representationId, "both decisions must resolve to the SAME representation");

  const linkTypes = [firstOutcome.linkType, secondOutcome.linkType].sort();
  assert.deepEqual(linkTypes, ["EXACT_CANONICAL_DUPLICATE", "NEW_CONTENT_REPRESENTATION"].sort());

  const repCount = await countRows("SELECT COUNT(*) AS c FROM corpus_document_representations WHERE canonical_sha256 = ?", [first.hash]);
  assert.equal(repCount, 1, "must never create a second representation row for the same canonical hash");
});

test("missing retained text: permanently 'skipped', never reclaimed by a later sweep", async () => {
  const hash = canonicalSha256("Never actually stored anywhere — this decision has no corpus_admission_content_store row.");
  const decisionId = await insertDecision({ decision: "ACCEPT", canonicalSha256: hash });
  await insertAcceptedRepresentation(decisionId, hash);
  // Deliberately no insertContentStore call.

  const first = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  const outcome = first.results.find((r) => r.decisionId === decisionId);
  assert.equal(outcome.outcome, "skipped");

  const row = await client.execute({ sql: "SELECT status, attempt_count FROM corpus_admission_promotions WHERE decision_id = ?", args: [decisionId] });
  assert.equal(row.rows[0].status, "skipped");
  const attemptsAfterFirst = Number(row.rows[0].attempt_count);

  const second = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  assert.ok(!second.results.some((r) => r.decisionId === decisionId), "'skipped' must never be reclaimed the way 'failed' is");

  const rowAfterSecond = await client.execute({ sql: "SELECT status, attempt_count FROM corpus_admission_promotions WHERE decision_id = ?", args: [decisionId] });
  assert.equal(rowAfterSecond.rows[0].status, "skipped");
  assert.equal(Number(rowAfterSecond.rows[0].attempt_count), attemptsAfterFirst, "attempt_count must not keep climbing for a terminal outcome");
});

test("canonical-hash mismatch is a visible 'failed' outcome, not an uncaught throw, and creates no representation", async () => {
  const storedHash = canonicalSha256("What the accepted_representations row claims the hash is.");
  const actualText = "What was actually stored in content_store — deliberately different text, a corrupted fixture.";
  const decisionId = await insertDecision({ decision: "ACCEPT", canonicalSha256: storedHash });
  await insertAcceptedRepresentation(decisionId, storedHash);
  await insertContentStore(decisionId, storedHash, actualText);

  const sweep = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  const outcome = sweep.results.find((r) => r.decisionId === decisionId);
  assert.equal(outcome.outcome, "failed");
  assert.match(outcome.error, /does not match/);

  const actualHash = canonicalSha256(actualText);
  const repCount = await countRows("SELECT COUNT(*) AS c FROM corpus_document_representations WHERE canonical_sha256 IN (?, ?)", [storedHash, actualHash]);
  assert.equal(repCount, 0, "a hash-mismatched decision must never produce a representation under either hash");
});

test("identity non-disclosure: outcome objects and the promotions row itself carry no account/report-shaped field", async () => {
  const { decisionId } = await seedAcceptedDecision("Identity non-disclosure fixture text.");
  const sweep = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  const outcome = sweep.results.find((r) => r.decisionId === decisionId);

  const forbiddenKeys = ["accountId", "account_id", "deviceKey", "device_key", "reportId", "report_id", "sourceRef", "source_ref", "email"];
  for (const key of forbiddenKeys) {
    assert.ok(!(key in outcome), `promotion outcome must never carry a ${key} field`);
  }

  const columns = await client.execute("PRAGMA table_info(corpus_admission_promotions)");
  const columnNames = columns.rows.map((r) => r.name);
  for (const forbidden of ["account_id", "device_key", "report_id", "source_ref", "email"]) {
    assert.ok(!columnNames.includes(forbidden), `corpus_admission_promotions must never gain a ${forbidden} column`);
  }
});
