import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { canonicalSha256 } from "../lib/document-identity.ts";
import { runCorpusAdmissionPromotionSweep, processCorpusAdmissionPromotion, MAX_PROMOTION_ATTEMPTS } from "../lib/corpus-admission-promotion.ts";
import { findCandidateCorpusRepresentations as _findCandidateCorpusRepresentations, corpusShingleHashes } from "../lib/user-submission-corpus.ts";
import { matureCorpusBackings } from "./helpers/corpus-maturity.mjs";

// Phase A safe-by-default maturity: this suite predates the 7-day activation
// clock and asserts promotion/revocation visibility "immediately".
// findCandidateCorpusRepresentations now gates MATCHING callers by default —
// age the just-promoted backings past the window so these tests still measure
// promotion/revocation, not the clock (tests/corpus-activation-7day.test.mjs).
const findCandidateCorpusRepresentations = async (client, hashes, opts) => {
  await matureCorpusBackings(client);
  return _findCandidateCorpusRepresentations(client, hashes, opts);
};
import { deactivateAcceptedRepresentation, reactivateAcceptedRepresentation } from "../lib/corpus-admission-admin-actions.ts";

/**
 * Concurrency/atomicity and matching-eligibility coverage for
 * lib/corpus-admission-promotion.ts + the source-aware eligibility join in
 * lib/user-submission-corpus.ts's findCandidateCorpusRepresentations. Core
 * single-item behavior lives in tests/corpus-admission-promotion.test.mjs.
 * Every fixture is synthetic.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_corpus_admission_promotion_sweep.db");
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
      id, null, overrides.sourceRef ?? `promotion-sweep-test-${randomUUID()}`, "v1", overrides.decision, JSON.stringify([]),
      1, JSON.stringify([]), "txt", overrides.wordCount ?? 50, "English", 0.95,
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

async function insertStagedPromotion(decisionId, acceptedRepresentationId) {
  const id = randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_promotions (id, decision_id, accepted_representation_id, status, attempt_count, created_at, updated_at)
          VALUES (?,?,?,'staged',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    args: [id, decisionId, acceptedRepresentationId],
  });
  return id;
}

async function seedAcceptedDecision(text) {
  const hash = canonicalSha256(text);
  const decisionId = await insertDecision({ decision: "ACCEPT", canonicalSha256: hash });
  const acceptedRepresentationId = await insertAcceptedRepresentation(decisionId, hash);
  await insertContentStore(decisionId, hash, text);
  return { decisionId, acceptedRepresentationId, hash };
}

async function countRows(sql, args = []) {
  const result = await client.execute({ sql, args });
  return Number(result.rows[0].c);
}

/** B1C: a raw promotion-row fixture with an arbitrary status/attempt_count/claimed_at/last_error — used only for the legacy-over-cap and race scenarios below, which need to construct a shape the real pipeline itself would never produce directly (a 'failed' row already at or past MAX_PROMOTION_ATTEMPTS, or a specific pre-set attempt_count to race the deciding attempt against). */
async function insertPromotionRaw(decisionId, acceptedRepresentationId, { status, attemptCount, claimedAt = null, lastError = null }) {
  const id = randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_promotions (id, decision_id, accepted_representation_id, status, attempt_count, claimed_at, last_error, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    args: [id, decisionId, acceptedRepresentationId, status, attemptCount, claimedAt, lastError],
  });
  return id;
}

test("CONCURRENT PROMOTION: two decisions racing on the same canonical hash both end up 'indexed', sharing exactly one representation and one full set of shingles — no orphaned or duplicate row from the loser (proves the race is handled; see the injected-failure test below for late-stage rollback specifically)", async () => {
  const text = "Concurrency fixture: two decisions, identical text, promoted at the exact same time.";
  const a = await seedAcceptedDecision(text);
  // corpus_admission_accepted_representations only allows ONE active row per
  // canonical hash (a real partial UNIQUE index) — revoking A first is
  // required just to make B's own row insertable. It has no bearing on the
  // race under test here, which is entirely on corpus_document_representations'
  // own UNIQUE index — promoteAcceptedDecision indexes regardless of
  // accepted_representations.revoked_at (see lib/corpus-admission-promotion.ts's
  // own header comment).
  await client.execute({ sql: "UPDATE corpus_admission_accepted_representations SET revoked_at = CURRENT_TIMESTAMP WHERE decision_id = ?", args: [a.decisionId] });
  const b = await seedAcceptedDecision(text);
  assert.equal(a.hash, b.hash);
  const promotionIdA = await insertStagedPromotion(a.decisionId, a.acceptedRepresentationId);
  const promotionIdB = await insertStagedPromotion(b.decisionId, b.acceptedRepresentationId);

  const [outcomeA, outcomeB] = await Promise.all([
    processCorpusAdmissionPromotion(client, { promotionId: promotionIdA, openConnection }),
    processCorpusAdmissionPromotion(client, { promotionId: promotionIdB, openConnection }),
  ]);

  assert.equal(outcomeA.outcome, "indexed");
  assert.equal(outcomeB.outcome, "indexed");
  assert.equal(outcomeA.representationId, outcomeB.representationId, "both must resolve to the SAME representation — no duplicate created by the race");

  const linkTypes = [outcomeA.linkType, outcomeB.linkType].sort();
  assert.deepEqual(linkTypes, ["EXACT_CANONICAL_DUPLICATE", "NEW_CONTENT_REPRESENTATION"].sort());

  const repCount = await countRows("SELECT COUNT(*) AS c FROM corpus_document_representations WHERE canonical_sha256 = ?", [a.hash]);
  assert.equal(repCount, 1, "the race's loser must never leave a second, orphaned representation row");

  const expectedShingleCount = corpusShingleHashes(text).size;
  const actualShingleCount = await countRows("SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE representation_id = ?", [outcomeA.representationId]);
  assert.equal(actualShingleCount, expectedShingleCount, "shingles must exist exactly once, never doubled by the concurrent attempt");
});

test("PARTIAL-WRITE ROLLBACK (injected failure): a late-stage failure AFTER representation creation and shingle insertion leaves zero partial rows — a uniqueness race alone does not prove this", async () => {
  const text = "Injected-failure fixture: representation and shingles get written, then the transaction is forced to fail before commit.";
  const { decisionId, acceptedRepresentationId, hash } = await seedAcceptedDecision(text);
  const promotionId = await insertStagedPromotion(decisionId, acceptedRepresentationId);

  const outcome = await processCorpusAdmissionPromotion(client, { promotionId, openConnection, simulateFailureAfterShingles: true });

  assert.equal(outcome.outcome, "failed");
  assert.match(outcome.error, /Simulated failure after representation creation and shingle insertion/);

  const repCount = await countRows("SELECT COUNT(*) AS c FROM corpus_document_representations WHERE canonical_sha256 = ?", [hash]);
  assert.equal(repCount, 0, "the representation created inside the failed transaction must not survive rollback");

  const shingleCount = await countRows(
    "SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE shingle_hash IN (SELECT value FROM json_each(?))",
    [JSON.stringify([...corpusShingleHashes(text)])],
  );
  assert.equal(shingleCount, 0, "shingles inserted inside the failed transaction must not survive rollback either");

  const row = await client.execute({ sql: "SELECT status, representation_id, link_type, fingerprint_version, last_error, attempt_count FROM corpus_admission_promotions WHERE id = ?", args: [promotionId] });
  const promotionRow = row.rows[0];
  assert.equal(promotionRow.status, "failed", "the promotions row's own success write must have rolled back too — it must end up 'failed', not 'indexed'");
  assert.equal(promotionRow.representation_id, null);
  assert.equal(promotionRow.link_type, null);
  assert.equal(promotionRow.fingerprint_version, null);
  assert.match(promotionRow.last_error, /Simulated failure/);
  assert.equal(Number(promotionRow.attempt_count), 1, "exactly one failed attempt — the injected error is neither a busy nor a race condition, so it must not retry internally");

  // Retryable: a later sweep attempt (without the injected fault) can still succeed cleanly.
  const retry = await processCorpusAdmissionPromotion(client, { promotionId, openConnection });
  assert.equal(retry.outcome, "indexed");
  const repCountAfterRetry = await countRows("SELECT COUNT(*) AS c FROM corpus_document_representations WHERE canonical_sha256 = ?", [hash]);
  assert.equal(repCountAfterRetry, 1);
});

test("stale-claim reclaim: an abandoned claim (crashed worker) is reclaimed by a later sweep, a fresh claim is not", async () => {
  const { decisionId, acceptedRepresentationId } = await seedAcceptedDecision("Stale-claim fixture text.");
  const promotionId = await insertStagedPromotion(decisionId, acceptedRepresentationId);

  // Simulate an abandoned claim: claimed 10 minutes ago, still 'staged'.
  await client.execute({
    sql: "UPDATE corpus_admission_promotions SET claimed_at = datetime('now', '-10 minutes') WHERE id = ?",
    args: [promotionId],
  });

  const sweep = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20, staleClaimMs: 5 * 60 * 1000 });
  assert.ok(sweep.claimedPromotionIds.includes(promotionId), "a claim older than staleClaimMs must be reclaimable");
  const outcome = sweep.results.find((r) => r.decisionId === decisionId);
  assert.equal(outcome.outcome, "indexed");
});

test("MULTIPLE PROMOTION SOURCES: deactivating one of two decisions that share a promoted representation never hides it; only deactivating every source does", async () => {
  // corpus_admission_accepted_representations only allows ONE active row per
  // canonical hash at a time (a real partial UNIQUE index), so "two
  // decisions backing the same representation" can only ever arise
  // sequentially — accept A, revoke A, THEN accept B over the same content
  // (the exact REPLACEMENT-ADMISSION sequence
  // lib/corpus-admission-admin-actions.ts's own reactivate conflict check is
  // built around) — never simultaneously. That is exactly what this test
  // exercises: A revoked, B active, both still 'indexed' promotions sharing
  // one representation via EXACT_CANONICAL_DUPLICATE reuse.
  const text = "Multi-source fixture: two accepted decisions, one shared promoted representation.";
  const a = await seedAcceptedDecision(text);
  await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  const deactivateA = await deactivateAcceptedRepresentation({ decisionId: a.decisionId, adminUserId: "admin-test", reason: "test deactivate A", openConnection });
  assert.equal(deactivateA.outcome, "deactivated");

  const b = await seedAcceptedDecision(text);
  const sweepForB = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  const bOutcome = sweepForB.results.find((r) => r.decisionId === b.decisionId);
  assert.equal(bOutcome.outcome, "indexed");
  assert.equal(bOutcome.linkType, "EXACT_CANONICAL_DUPLICATE", "B must reuse A's already-indexed representation, not create a second one");

  const shingles = corpusShingleHashes(text);
  const candidatesWithBActive = await findCandidateCorpusRepresentations(client, shingles);
  assert.ok(
    candidatesWithBActive.some((c) => c.canonicalSha256 === a.hash),
    "A is revoked but B is active — the shared representation must still be a candidate",
  );

  const deactivateB = await deactivateAcceptedRepresentation({ decisionId: b.decisionId, adminUserId: "admin-test", reason: "test deactivate B", openConnection });
  assert.equal(deactivateB.outcome, "deactivated");

  const candidatesWithBothRevoked = await findCandidateCorpusRepresentations(client, shingles);
  assert.ok(
    !candidatesWithBothRevoked.some((c) => c.canonicalSha256 === a.hash),
    "only once EVERY backing source is deactivated must the representation stop being a candidate",
  );

  const reactivateA = await reactivateAcceptedRepresentation({ decisionId: a.decisionId, adminUserId: "admin-test", reason: "test reactivate A", openConnection });
  assert.equal(reactivateA.outcome, "reactivated");

  const candidatesAfterReactivation = await findCandidateCorpusRepresentations(client, shingles);
  assert.ok(
    candidatesAfterReactivation.some((c) => c.canonicalSha256 === a.hash),
    "reactivating either source must restore eligibility immediately, with no separate promotion step",
  );
});

test("LEGACY REPRESENTATION: a pre-existing corpus row with no submission reference and no promotion history of any kind stays eligible forever", async () => {
  // Simulates a built-in/pre-existing corpus_document_representations row
  // seeded some other way (a bulk import, manual seed, anything that
  // predates or bypasses both indexDocumentSubmissionIntoCorpus and
  // lib/corpus-admission-promotion.ts entirely) — no
  // corpus_submission_references row, no corpus_admission_promotions row at
  // all. Nothing in this system has ever "deactivated" it, so it must never
  // become a candidate-search casualty of unrelated promotion/deactivation
  // activity elsewhere.
  const text = "Legacy fixture: a corpus row that exists for reasons entirely outside this system's own write paths.";
  const hash = canonicalSha256(text);
  const representationId = randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_document_representations (id, canonical_sha256, canonical_text, word_count, language, canonicalization_version, extractor_version, first_seen_at, created_at)
          VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    args: [representationId, hash, text, 20, "English", "canonical-text-v1", null],
  });
  const shingleStatements = [...corpusShingleHashes(text)].map((h) => ({
    sql: "INSERT OR IGNORE INTO corpus_document_shingles (representation_id, shingle_hash, fingerprint_version, created_at) VALUES (?,?,?,CURRENT_TIMESTAMP)",
    args: [representationId, h, "corpus-shingle-v1"],
  }));
  if (shingleStatements.length > 0) await client.batch(shingleStatements, "write");

  const shingles = corpusShingleHashes(text);
  const candidates = await findCandidateCorpusRepresentations(client, shingles);
  assert.ok(candidates.some((c) => c.canonicalSha256 === hash), "a legacy row with no promotion/submission history at all must be eligible by default");

  // Unrelated promotion/deactivation activity elsewhere must never affect it.
  const other = await seedAcceptedDecision("An entirely unrelated fixture, deactivated, to prove it has no bearing on the legacy row above.");
  await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  await deactivateAcceptedRepresentation({ decisionId: other.decisionId, adminUserId: "admin-test", reason: "unrelated deactivation", openConnection });

  const candidatesAfterUnrelatedActivity = await findCandidateCorpusRepresentations(client, shingles);
  assert.ok(candidatesAfterUnrelatedActivity.some((c) => c.canonicalSha256 === hash), "the legacy row must remain eligible regardless of unrelated promotion activity");
});

test("a SINGLE promotion-created representation still becomes ineligible once its only source is deactivated (the legacy fallback must not resurrect it)", async () => {
  const text = "Single-source fixture: exactly one promoted decision backs this representation, nothing else.";
  const { decisionId, hash } = await seedAcceptedDecision(text);
  const sweep = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  const outcome = sweep.results.find((r) => r.decisionId === decisionId);
  assert.equal(outcome.outcome, "indexed");
  assert.equal(outcome.linkType, "NEW_CONTENT_REPRESENTATION");

  const shingles = corpusShingleHashes(text);
  const candidatesBefore = await findCandidateCorpusRepresentations(client, shingles);
  assert.ok(candidatesBefore.some((c) => c.canonicalSha256 === hash));

  const deactivate = await deactivateAcceptedRepresentation({ decisionId, adminUserId: "admin-test", reason: "test", openConnection });
  assert.equal(deactivate.outcome, "deactivated");

  const candidatesAfter = await findCandidateCorpusRepresentations(client, shingles);
  assert.ok(
    !candidatesAfter.some((c) => c.canonicalSha256 === hash),
    "a promotion-created representation with its only source deactivated must be hidden — a NEW_CONTENT_REPRESENTATION promotion row DOES exist for it, so the legacy fallback (condition 3) must not apply",
  );
});

test("a representation backed by a real user submission stays eligible even when its only promoted source is deactivated", async () => {
  const text = "Cross-source fixture: one real user submission, one promoted admin-accepted decision, same text.";
  const { decisionId, hash } = await seedAcceptedDecision(text);
  const sweep = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  const outcome = sweep.results.find((r) => r.decisionId === decisionId);
  assert.equal(outcome.outcome, "indexed");

  // Simulate a real user submission independently landing on the exact same
  // representation (corpus_submission_references is the ONLY place
  // account linkage exists — never touched by lib/corpus-admission-promotion.ts).
  const documentIdentityId = randomUUID();
  await client.execute({
    sql: "INSERT INTO document_identities (id, account_id, raw_sha256, canonical_sha256, created_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)",
    args: [documentIdentityId, null, randomUUID(), hash],
  });
  await client.execute({
    sql: "INSERT INTO corpus_submission_references (representation_id, document_identity_id, link_type, created_at) VALUES (?,?,?,CURRENT_TIMESTAMP)",
    args: [outcome.representationId, documentIdentityId, "EXACT_CANONICAL_DUPLICATE"],
  });

  const deactivate = await deactivateAcceptedRepresentation({ decisionId, adminUserId: "admin-test", reason: "test", openConnection });
  assert.equal(deactivate.outcome, "deactivated");

  const shingles = corpusShingleHashes(text);
  const candidates = await findCandidateCorpusRepresentations(client, shingles);
  assert.ok(
    candidates.some((c) => c.canonicalSha256 === hash),
    "a real submission reference must keep the representation eligible regardless of the promoted source's own state",
  );
});

// --- B1C: legacy over-cap normalization, dead-letter permanence, and the boundary race ---

test("B1C NORMALIZATION: a legacy 'failed' row already at attempt_count === MAX_PROMOTION_ATTEMPTS normalizes to 'dead_lettered' on the next sweep — no reprocessing, no attempt_count change, last_error preserved", async () => {
  const { decisionId, acceptedRepresentationId } = await seedAcceptedDecision("Legacy over-cap fixture at exactly the cap.");
  const promotionId = await insertPromotionRaw(decisionId, acceptedRepresentationId, { status: "failed", attemptCount: MAX_PROMOTION_ATTEMPTS, lastError: "legacy pre-cap error" });

  const sweep = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  assert.ok(!sweep.claimedPromotionIds.includes(promotionId), "REQUIRED: a normalized row must transition directly, never through the claim/process pipeline");
  assert.ok(!sweep.results.some((r) => r.promotionId === promotionId), "REQUIRED: no processing outcome must be produced for a normalized row");

  const row = await client.execute({ sql: "SELECT status, attempt_count, claimed_at, last_error FROM corpus_admission_promotions WHERE id = ?", args: [promotionId] });
  assert.equal(row.rows[0].status, "dead_lettered");
  assert.equal(Number(row.rows[0].attempt_count), MAX_PROMOTION_ATTEMPTS, "REQUIRED: normalization must not increment attempt_count");
  assert.equal(row.rows[0].claimed_at, null);
  assert.equal(row.rows[0].last_error, "legacy pre-cap error", "REQUIRED: normalization must preserve the existing final error, never overwrite it");
});

test("B1C NORMALIZATION: a legacy 'failed' row ABOVE MAX_PROMOTION_ATTEMPTS (from before this cap existed) also normalizes, preserving its own count exactly rather than resetting it", async () => {
  const { decisionId, acceptedRepresentationId } = await seedAcceptedDecision("Legacy over-cap fixture above the cap.");
  const promotionId = await insertPromotionRaw(decisionId, acceptedRepresentationId, { status: "failed", attemptCount: MAX_PROMOTION_ATTEMPTS + 2, lastError: "legacy error, well above the cap" });

  await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });

  const row = await client.execute({ sql: "SELECT status, attempt_count FROM corpus_admission_promotions WHERE id = ?", args: [promotionId] });
  assert.equal(row.rows[0].status, "dead_lettered");
  assert.equal(Number(row.rows[0].attempt_count), MAX_PROMOTION_ATTEMPTS + 2, "REQUIRED: normalization must not reset or clamp an above-cap count — it stays exactly as found");
});

test("B1C NORMALIZATION vs claim-safety: a FRESHLY claimed over-cap row is not stolen/normalized out from under its own claimant; once that claim goes stale, it becomes normalizable", async () => {
  const { decisionId, acceptedRepresentationId } = await seedAcceptedDecision("Fresh-vs-stale over-cap claim fixture.");
  const promotionId = await insertPromotionRaw(decisionId, acceptedRepresentationId, { status: "failed", attemptCount: MAX_PROMOTION_ATTEMPTS });
  // Simulate an in-flight worker: claimed right now, same as a real claim would leave it.
  await client.execute({ sql: "UPDATE corpus_admission_promotions SET claimed_at = CURRENT_TIMESTAMP WHERE id = ?", args: [promotionId] });

  const sweepWhileFresh = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20, staleClaimMs: 5 * 60 * 1000 });
  assert.ok(!sweepWhileFresh.claimedPromotionIds.includes(promotionId));
  const rowWhileFresh = await client.execute({ sql: "SELECT status, claimed_at FROM corpus_admission_promotions WHERE id = ?", args: [promotionId] });
  assert.equal(rowWhileFresh.rows[0].status, "failed", "REQUIRED: a freshly claimed over-cap row must not be normalized while its claim is still fresh");
  assert.ok(rowWhileFresh.rows[0].claimed_at !== null, "REQUIRED: the fresh claim marker itself must be left untouched");

  // The claim goes stale (the simulated worker never finished/crashed).
  await client.execute({ sql: "UPDATE corpus_admission_promotions SET claimed_at = datetime('now', '-10 minutes') WHERE id = ?", args: [promotionId] });

  await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20, staleClaimMs: 5 * 60 * 1000 });
  const rowAfterStale = await client.execute({ sql: "SELECT status, claimed_at FROM corpus_admission_promotions WHERE id = ?", args: [promotionId] });
  assert.equal(rowAfterStale.rows[0].status, "dead_lettered", "REQUIRED: once the claim is stale (unchanged 5-minute timeout), the same over-cap row must normalize");
  assert.equal(rowAfterStale.rows[0].claimed_at, null);
});

test("B1C: a dead_lettered row is never selected/claimed by any later sweep, and neither its attempt_count nor its status ever changes again", async () => {
  const { decisionId, acceptedRepresentationId } = await seedAcceptedDecision("Never-reclaimed dead-letter fixture.");
  const promotionId = await insertPromotionRaw(decisionId, acceptedRepresentationId, { status: "dead_lettered", attemptCount: MAX_PROMOTION_ATTEMPTS, lastError: "already terminal" });

  for (let i = 0; i < 3; i += 1) {
    const sweep = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
    assert.ok(!sweep.claimedPromotionIds.includes(promotionId), `sweep tick #${i} must never claim an already-dead_lettered row`);
  }
  const row = await client.execute({ sql: "SELECT status, attempt_count, claimed_at, last_error FROM corpus_admission_promotions WHERE id = ?", args: [promotionId] });
  assert.equal(row.rows[0].status, "dead_lettered");
  assert.equal(Number(row.rows[0].attempt_count), MAX_PROMOTION_ATTEMPTS);
  assert.equal(row.rows[0].claimed_at, null);
  assert.equal(row.rows[0].last_error, "already terminal");
});

test("B1C RACE: two concurrent sweeps racing on a promotion sitting at attempt_count = MAX_PROMOTION_ATTEMPTS-1 ('failed', unclaimed) let exactly one of them make the deciding 5th attempt", async () => {
  const storedHash = canonicalSha256("Race-at-the-boundary fixture stored hash.");
  const actualText = "Race-at-the-boundary fixture: deliberately mismatched text so the deciding attempt fails deterministically, isolating the race itself from indexing success/failure timing.";
  const decisionId = await insertDecision({ decision: "ACCEPT", canonicalSha256: storedHash });
  const acceptedRepresentationId = await insertAcceptedRepresentation(decisionId, storedHash);
  await insertContentStore(decisionId, storedHash, actualText);
  const promotionId = await insertPromotionRaw(decisionId, acceptedRepresentationId, { status: "failed", attemptCount: MAX_PROMOTION_ATTEMPTS - 1 });

  const [sweepA, sweepB] = await Promise.all([
    runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 }),
    runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 }),
  ]);

  const claimedByA = sweepA.claimedPromotionIds.includes(promotionId);
  const claimedByB = sweepB.claimedPromotionIds.includes(promotionId);
  assert.notEqual(claimedByA, claimedByB, "REQUIRED: exactly one of the two racing sweeps must claim/process the deciding 5th attempt — never both, never neither");

  const row = await client.execute({ sql: "SELECT status, attempt_count FROM corpus_admission_promotions WHERE id = ?", args: [promotionId] });
  assert.equal(Number(row.rows[0].attempt_count), MAX_PROMOTION_ATTEMPTS, "REQUIRED: exactly one 5th attempt must ever be recorded — never zero (lost claim), never two (double-processed)");
  assert.equal(row.rows[0].status, "dead_lettered", "the deciding 5th attempt fails deterministically by this fixture's own construction, so the row must dead-letter, not remain 'failed'");
});
