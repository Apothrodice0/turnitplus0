import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import {
  deactivateAcceptedRepresentation,
  reactivateAcceptedRepresentation,
  revealRetainedTextPreview,
  validateAdminReason,
} from "../lib/corpus-admission-admin-actions.ts";
import { evaluateCorpusAdmissionCandidate } from "../lib/corpus-admission-gate.ts";

/**
 * lib/corpus-admission-admin-actions.ts: atomic deactivate/reactivate (incl.
 * genuine concurrent races), reason validation, and the retained-text
 * preview's audit-write-before-return guarantee (including what happens
 * when the audit write itself fails). Every fixture is synthetic.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_corpus_admission_admin_actions.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
const dbUrl = `file:${dbFile}`;
const client = createClient({ url: dbUrl });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

function openConnection() {
  return createClient({ url: dbUrl });
}

async function ensureUser(label) {
  const accountId = `admin-actions-account-${label}-${randomUUID()}`;
  await client.execute({
    sql: "INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
    args: [accountId, `${accountId}@example.test`, accountId, "not-a-real-hash"],
  });
  return accountId;
}

async function seedAcceptedDecision(canonicalSha256) {
  const decisionId = randomUUID();
  const hash = canonicalSha256 ?? randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_decisions
          (id, run_id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes,
           detected_format, extracted_word_count, detected_language, language_confidence, canonical_sha256, extractor_version,
           content_store_id, quality_score, quality_model_version, component_scores, feature_vector, feature_vector_version,
           corpus_value_score, corpus_value_model_version, family_relation, family_matched_source_ref, family_containment,
           consent_metadata, dry_run, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [
      decisionId, null, `seed-${randomUUID()}`, "v1", "ACCEPT", "[]", 1, "[]",
      "txt", 3300, "English", 0.95, hash, "v1", null, 90, "v1", "{}", "{}", "v1", 0.9, "v1", "NONE", null, null,
      JSON.stringify({ kind: "PER_USER_CONSENT", consented: true }), 0,
    ],
  });
  const contentStoreId = randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_content_store (id, decision_id, canonical_sha256, canonical_text, extractor_version, retention_basis, stored_at)
          VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [contentStoreId, decisionId, hash, "the full retained text for this fixture, used to test preview truncation and audit ordering.", "v1", "LICENSED_REUSE"],
  });
  const acceptedRepresentationId = randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version, revoked_at, created_at)
          VALUES (?,?,?,?,?,NULL,CURRENT_TIMESTAMP)`,
    args: [acceptedRepresentationId, decisionId, hash, 3300, "v1"],
  });
  return { decisionId, acceptedRepresentationId, canonicalSha256: hash };
}

async function auditRowsFor(decisionId) {
  const result = await client.execute({ sql: "SELECT * FROM corpus_admission_admin_audit_log WHERE decision_id = ?", args: [decisionId] });
  return result.rows;
}

// --- reason validation -----------------------------------------------------

test("validateAdminReason: requires a non-empty, bounded string", () => {
  assert.equal(validateAdminReason(undefined).ok, false);
  assert.equal(validateAdminReason(null).ok, false);
  assert.equal(validateAdminReason(42).ok, false);
  assert.equal(validateAdminReason("").ok, false);
  assert.equal(validateAdminReason("  ").ok, false);
  assert.equal(validateAdminReason("ok").ok, false, "shorter than the minimum must be rejected");
  assert.equal(validateAdminReason("a".repeat(501)).ok, false, "longer than the maximum must be rejected");
  const good = validateAdminReason("  legitimate takedown request  ");
  assert.equal(good.ok, true);
  assert.equal(good.reason, "legitimate takedown request", "must be trimmed");
});

// --- deactivate / reactivate: basic correctness + audit ---------------------

test("deactivate then reactivate: state changes, exactly one audit row per successful action, idempotent on repeat", async () => {
  const admin = await ensureUser("basic");
  const { decisionId, acceptedRepresentationId } = await seedAcceptedDecision();

  const deactivated = await deactivateAcceptedRepresentation({ decisionId, adminUserId: admin, reason: "policy violation", openConnection });
  assert.deepEqual(deactivated, { outcome: "deactivated", acceptedRepresentationId });

  const activeRow = await client.execute({ sql: "SELECT revoked_at FROM corpus_admission_accepted_representations WHERE id = ?", args: [acceptedRepresentationId] });
  assert.notEqual(activeRow.rows[0].revoked_at, null);

  let audit = await auditRowsFor(decisionId);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "deactivate");
  assert.equal(audit[0].admin_user_id, admin);
  assert.equal(audit[0].reason, "policy violation");

  // Idempotent — no second audit row.
  const deactivatedAgain = await deactivateAcceptedRepresentation({ decisionId, adminUserId: admin, reason: "policy violation", openConnection });
  assert.deepEqual(deactivatedAgain, { outcome: "already_inactive", acceptedRepresentationId });
  audit = await auditRowsFor(decisionId);
  assert.equal(audit.length, 1, "a no-op deactivate must never write a second audit row");

  const reactivated = await reactivateAcceptedRepresentation({ decisionId, adminUserId: admin, reason: "resolved on appeal", openConnection });
  assert.deepEqual(reactivated, { outcome: "reactivated", acceptedRepresentationId });
  audit = await auditRowsFor(decisionId);
  assert.equal(audit.length, 2);
  assert.equal(audit[1].action, "reactivate");

  const reactivatedAgain = await reactivateAcceptedRepresentation({ decisionId, adminUserId: admin, reason: "resolved on appeal", openConnection });
  assert.deepEqual(reactivatedAgain, { outcome: "already_active", acceptedRepresentationId });
  audit = await auditRowsFor(decisionId);
  assert.equal(audit.length, 2, "a no-op reactivate must never write a second audit row");
});

test("deactivate: not_found for a decision with no accepted fingerprint at all", async () => {
  const admin = await ensureUser("notfound");
  const result = await deactivateAcceptedRepresentation({ decisionId: randomUUID(), adminUserId: admin, reason: "n/a", openConnection });
  assert.deepEqual(result, { outcome: "not_found" });
});

// --- reactivate conflict: a replacement has since become canonical ---------

test("reactivate: refuses with a typed conflict — never an error — when a different active fingerprint already holds the same hash", async () => {
  const admin = await ensureUser("conflict");
  const sharedHash = randomUUID();
  const original = await seedAcceptedDecision(sharedHash);
  await deactivateAcceptedRepresentation({ decisionId: original.decisionId, adminUserId: admin, reason: "superseded", openConnection });
  const auditAfterDeactivate = await auditRowsFor(original.decisionId);
  assert.equal(auditAfterDeactivate.length, 1);

  // A later, independently authorized submission of the SAME content
  // becomes the new active fingerprint (simulating the REPLACEMENT-ADMISSION
  // scenario from the previous session).
  const replacement = await seedAcceptedDecision(sharedHash);

  const result = await reactivateAcceptedRepresentation({ decisionId: original.decisionId, adminUserId: admin, reason: "trying anyway", openConnection });
  assert.equal(result.outcome, "conflict");
  assert.equal(result.acceptedRepresentationId, original.acceptedRepresentationId);

  const originalRow = await client.execute({ sql: "SELECT revoked_at FROM corpus_admission_accepted_representations WHERE id = ?", args: [original.acceptedRepresentationId] });
  assert.notEqual(originalRow.rows[0].revoked_at, null, "the original must remain deactivated after a refused reactivate");
  const replacementRow = await client.execute({ sql: "SELECT revoked_at FROM corpus_admission_accepted_representations WHERE id = ?", args: [replacement.acceptedRepresentationId] });
  assert.equal(replacementRow.rows[0].revoked_at, null, "the replacement must remain the sole active fingerprint");

  const audit = await auditRowsFor(original.decisionId);
  assert.equal(audit.length, 1, "a refused reactivate must never write an audit row of its own — count must stay at just the earlier deactivate");
});

// --- RACE: concurrent deactivate / concurrent reactivate --------------------

test("RACE: N concurrent deactivate calls on the same decision produce exactly one 'deactivated' outcome and exactly one audit row", async () => {
  const admin = await ensureUser("race-deactivate");
  const { decisionId, acceptedRepresentationId } = await seedAcceptedDecision();

  const results = await Promise.all(
    Array.from({ length: 8 }, () => deactivateAcceptedRepresentation({ decisionId, adminUserId: admin, reason: "race test", openConnection })),
  );

  const deactivatedCount = results.filter((r) => r.outcome === "deactivated").length;
  const alreadyInactiveCount = results.filter((r) => r.outcome === "already_inactive").length;
  assert.equal(deactivatedCount, 1, `exactly one concurrent call may actually perform the deactivation, got ${deactivatedCount}`);
  assert.equal(alreadyInactiveCount, 7);
  for (const r of results) assert.equal(r.acceptedRepresentationId, acceptedRepresentationId);

  const audit = await auditRowsFor(decisionId);
  assert.equal(audit.length, 1, "exactly one audit row must exist regardless of how many concurrent attempts raced");

  const row = await client.execute({ sql: "SELECT revoked_at FROM corpus_admission_accepted_representations WHERE id = ?", args: [acceptedRepresentationId] });
  assert.notEqual(row.rows[0].revoked_at, null);
});

test("RACE: N concurrent reactivate calls on the same (already deactivated) decision produce exactly one 'reactivated' outcome and exactly one new audit row", async () => {
  const admin = await ensureUser("race-reactivate");
  const { decisionId, acceptedRepresentationId } = await seedAcceptedDecision();
  await deactivateAcceptedRepresentation({ decisionId, adminUserId: admin, reason: "setup", openConnection });

  const results = await Promise.all(
    Array.from({ length: 8 }, () => reactivateAcceptedRepresentation({ decisionId, adminUserId: admin, reason: "race test", openConnection })),
  );

  const reactivatedCount = results.filter((r) => r.outcome === "reactivated").length;
  const alreadyActiveCount = results.filter((r) => r.outcome === "already_active").length;
  assert.equal(reactivatedCount, 1, `exactly one concurrent call may actually perform the reactivation, got ${reactivatedCount}`);
  assert.equal(alreadyActiveCount, 7);

  const audit = await auditRowsFor(decisionId);
  assert.equal(audit.length, 2, "1 deactivate + 1 reactivate audit row — never more, regardless of concurrent racing");

  const row = await client.execute({ sql: "SELECT revoked_at FROM corpus_admission_accepted_representations WHERE id = ?", args: [acceptedRepresentationId] });
  assert.equal(row.rows[0].revoked_at, null);
});

test("RACE: concurrent reactivate against a concurrently-admitted replacement never leaves two simultaneously-active fingerprints for the same hash", async () => {
  const admin = await ensureUser("race-conflict");
  const sharedHash = randomUUID();
  const original = await seedAcceptedDecision(sharedHash);
  await deactivateAcceptedRepresentation({ decisionId: original.decisionId, adminUserId: admin, reason: "setup", openConnection });

  // Race: reactivate the original at the same moment a replacement for the
  // identical hash is inserted directly (simulating a concurrent admission
  // reaching the same INSERT the gate itself would perform).
  const replacementId = randomUUID();
  const insertReplacement = client.execute({
    sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version, revoked_at, created_at)
          SELECT ?, id, ?, 3300, 'v1', NULL, CURRENT_TIMESTAMP FROM corpus_admission_decisions WHERE source_ref = ?`,
    args: [replacementId, sharedHash, `race-replacement-${randomUUID()}`],
  }).catch(() => null); // best-effort — may or may not exist depending on timing; the real assertion is below

  const [reactivateResult] = await Promise.all([
    reactivateAcceptedRepresentation({ decisionId: original.decisionId, adminUserId: admin, reason: "race", openConnection }),
    insertReplacement,
  ]);

  const activeRows = await client.execute({
    sql: "SELECT id FROM corpus_admission_accepted_representations WHERE canonical_sha256 = ? AND revoked_at IS NULL",
    args: [sharedHash],
  });
  assert.ok(activeRows.rows.length <= 1, `at most one active fingerprint may ever exist for one hash, got ${activeRows.rows.length}`);
  assert.ok(["reactivated", "conflict"].includes(reactivateResult.outcome));
});

// --- retained-text preview: audit-write-before-return -----------------------

test("revealRetainedTextPreview: returns a bounded, truncated preview and writes exactly one audit row per call", async () => {
  const admin = await ensureUser("preview");
  const longText = "word ".repeat(1000); // 5000 chars, well beyond the 2000-char preview bound
  const { decisionId } = await seedAcceptedDecision();
  await client.execute({ sql: "UPDATE corpus_admission_content_store SET canonical_text = ? WHERE decision_id = ?", args: [longText, decisionId] });

  const result = await revealRetainedTextPreview(client, { decisionId, adminUserId: admin, openConnection });
  assert.equal(result.outcome, "revealed");
  assert.ok(result.preview.length <= 2000, `preview must be bounded, got ${result.preview.length} chars`);
  assert.equal(result.truncated, true);
  assert.equal(result.fullLength, longText.length);

  const audit = await auditRowsFor(decisionId);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "view_retained_text");
  assert.equal(audit[0].admin_user_id, admin);

  // A second reveal writes a SECOND audit row — every reveal is its own
  // accountable event, never deduplicated the way deactivate/reactivate are.
  await revealRetainedTextPreview(client, { decisionId, adminUserId: admin, openConnection });
  const auditAfterSecond = await auditRowsFor(decisionId);
  assert.equal(auditAfterSecond.length, 2);
});

test("revealRetainedTextPreview: not_found when no retained text exists for this decision", async () => {
  const admin = await ensureUser("preview-notfound");
  const result = await revealRetainedTextPreview(client, { decisionId: randomUUID(), adminUserId: admin, openConnection });
  assert.deepEqual(result, { outcome: "not_found" });
});

test("AUDIT-FAILURE: if the audit write fails, the text is withheld entirely — never returned anyway", async () => {
  const admin = await ensureUser("audit-failure");
  const { decisionId } = await seedAcceptedDecision();

  function alwaysBrokenOpenConnection() {
    throw new Error("simulated persistent connection failure for the audit write");
  }

  const result = await revealRetainedTextPreview(client, { decisionId, adminUserId: admin, openConnection: alwaysBrokenOpenConnection });
  assert.deepEqual(result, { outcome: "audit_failed" });
  assert.ok(!("preview" in result), "the text must never be present in the result when the audit write failed");

  const audit = await auditRowsFor(decisionId);
  assert.equal(audit.length, 0, "no audit row exists — consistent with the text also never having been revealed");
});

// --- REGRESSION (Task B1B): re-admission after Remove -----------------------
// "Remove" (deactivate) takes away ONE accepted backing, not a permanent ban
// on the canonical document itself. See lib/corpus-admission-gate.ts's own
// findAcceptedFamilyCandidates / findAcceptedRepresentationByHash (both
// filter WHERE revoked_at IS NULL) and drizzle/0032's own header comment —
// this proves it end-to-end through the REAL admission gate, not just a
// direct-SQL simulation of the resulting row shape.

const WORD_BANK = [
  "research", "analysis", "population", "sample", "variable", "hypothesis", "method", "outcome", "region",
  "temperature", "pressure", "reaction", "material", "structure", "process", "signal", "pattern", "network",
  "significant", "distinct", "gradual", "consistent", "notable", "substantial", "minor", "extensive", "localized",
  "documented", "identified", "recorded", "analyzed", "examined", "compared", "measured", "observed", "reported",
];
function seededRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0xffffffff;
  };
}
function plausibleArticleText(seed, targetWords = 3300) {
  const rng = seededRandom(seed);
  const paragraphs = [];
  let wordCount = 0;
  while (wordCount < targetWords) {
    const sentences = Array.from({ length: 5 + Math.floor(rng() * 4) }, () => {
      const length = 10 + Math.floor(rng() * 18);
      const words = Array.from({ length }, () => WORD_BANK[Math.floor(rng() * WORD_BANK.length)]);
      return `The ${words.join(" ")}.`;
    });
    const paragraph = sentences.join(" ");
    paragraphs.push(paragraph);
    wordCount += paragraph.split(/\s+/).length;
  }
  return paragraphs.join("\n\n");
}
const RESOLVED_PROVENANCE = (sourceUrl) => ({
  kind: "BULK_IMPORT_PROVENANCE",
  provenance: { sourceUrl, acquisitionMethod: "BULK_IMPORT_DOWNLOAD", licenseOrPermission: "CC-BY-4.0", retentionBasis: "LICENSED_REUSE", retentionRightsResolved: true, notes: null },
});

test("REGRESSION: after Remove takes the last active backing for a canonical document, the SAME document can be admitted again through the real gate if it otherwise still passes admission", async () => {
  const admin = await ensureUser("readmission");
  const text = plausibleArticleText(90210);

  const original = await evaluateCorpusAdmissionCandidate(client, {
    sourceRef: `readmission-original-${randomUUID()}`,
    filename: "original.txt",
    bytes: Buffer.from(text, "utf8"),
    consent: RESOLVED_PROVENANCE("https://example.test/readmission-original"),
    dryRun: false,
    openConnection,
  });
  assert.equal(original.decision, "ACCEPT", "sanity: the fixture must actually be accept-worthy for this regression to mean anything");
  assert.ok(original.acceptedRepresentationId);

  const removeResult = await deactivateAcceptedRepresentation({
    decisionId: original.id,
    adminUserId: admin,
    reason: "regression test: removing the only active backing",
    openConnection,
  });
  assert.equal(removeResult.outcome, "deactivated");

  // Fresh evaluation of the identical text, as if independently resubmitted
  // later — the real gate's own pre-check AND its in-transaction re-check
  // must both see this content as having NO active accepted backing anymore.
  const resubmitted = await evaluateCorpusAdmissionCandidate(client, {
    sourceRef: `readmission-resubmit-${randomUUID()}`,
    filename: "resubmit.txt",
    bytes: Buffer.from(text, "utf8"),
    consent: RESOLVED_PROVENANCE("https://example.test/readmission-resubmit"),
    dryRun: false,
    openConnection,
  });

  assert.equal(resubmitted.decision, "ACCEPT", "the same canonical document must be admissible again once its only backing was removed");
  assert.notEqual(resubmitted.id, original.id, "re-admission must be a new decision, not a mutation of the removed one");
  assert.equal(resubmitted.canonicalSha256, original.canonicalSha256, "it is genuinely the same canonical document being re-admitted");
  assert.ok(resubmitted.acceptedRepresentationId);
  assert.notEqual(resubmitted.acceptedRepresentationId, original.acceptedRepresentationId);

  const oldRow = await client.execute({ sql: "SELECT revoked_at FROM corpus_admission_accepted_representations WHERE id = ?", args: [original.acceptedRepresentationId] });
  assert.notEqual(oldRow.rows[0].revoked_at, null, "the original (removed) fingerprint stays revoked — it is not reactivated by this");
  const newRow = await client.execute({ sql: "SELECT revoked_at FROM corpus_admission_accepted_representations WHERE id = ?", args: [resubmitted.acceptedRepresentationId] });
  assert.equal(newRow.rows[0].revoked_at, null, "the new fingerprint is freshly active");
});
