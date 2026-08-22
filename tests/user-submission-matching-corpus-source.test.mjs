import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity, canonicalSha256 } from "../lib/document-identity.ts";
import { indexDocumentSubmissionIntoCorpus } from "../lib/user-submission-corpus.ts";
import { matchAgainstUserSubmissionCorpus } from "../lib/user-submission-matching.ts";
import { runCorpusAdmissionPromotionSweep } from "../lib/corpus-admission-promotion.ts";

/**
 * The TURNITPLUS_CORPUS_SOURCE classification branch in
 * matchAgainstUserSubmissionCorpus: a candidate with zero real submission
 * ownership but an active promotion is reported (not dropped/UNKNOWN), for
 * both signed-in and anonymous submitters, gated by
 * CORPUS_SOURCE_MATCHING_ENABLED, and never overrides a real SELF/
 * PRIOR_SUBMISSION classification. Every fixture is synthetic.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_user_submission_matching_corpus_source.db");
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

const knownUsers = new Set();
async function ensureUser(accountId) {
  if (accountId === null || knownUsers.has(accountId)) return;
  knownUsers.add(accountId);
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
    args: [accountId, `${accountId}@example.test`, accountId, "not-a-real-hash"],
  });
}

async function indexSubmission(accountId, title, rawText) {
  await ensureUser(accountId);
  const identity = await createDocumentIdentity(client, { accountId, title, author: null, rawText });
  await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  return identity;
}

async function insertDecision(overrides) {
  const id = randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_decisions
          (id, run_id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes,
           detected_format, extracted_word_count, detected_language, language_confidence, canonical_sha256, extractor_version,
           content_store_id, quality_score, quality_model_version, component_scores, feature_vector, feature_vector_version,
           corpus_value_score, corpus_value_model_version, family_relation, family_matched_source_ref, family_containment,
           consent_metadata, dry_run, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [
      id, null, `corpus-source-test-${randomUUID()}`, "v1", "ACCEPT", "[]", 1, "[]",
      "txt", 50, "English", 0.95, overrides.canonicalSha256, "v1", null, 80, "v1",
      "{}", "{}", "v1", 0.9, "v1", "NONE", null, null,
      JSON.stringify({ kind: "PER_USER_CONSENT", consented: true }), 0,
    ],
  });
  return id;
}

/** Seeds and promotes an admin-accepted decision for `text` — no account, no submission reference, ever. Returns once its promotion is 'indexed'. */
async function seedActivePromotedSource(text) {
  const hash = canonicalSha256(text);
  const decisionId = await insertDecision({ canonicalSha256: hash });
  const acceptedRepId = randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version, revoked_at, created_at)
          VALUES (?,?,?,?,?,NULL,CURRENT_TIMESTAMP)`,
    args: [acceptedRepId, decisionId, hash, 50, "v1"],
  });
  await client.execute({
    sql: `INSERT INTO corpus_admission_content_store (id, decision_id, canonical_sha256, canonical_text, extractor_version, retention_basis, stored_at)
          VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [randomUUID(), decisionId, hash, text, "v1", "LICENSED_REUSE"],
  });
  const sweep = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  const outcome = sweep.results.find((r) => r.decisionId === decisionId);
  assert.equal(outcome?.outcome, "indexed", "test setup sanity: promotion must succeed");
  return { decisionId, hash };
}

function withEnv(name, value, fn) {
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return fn().finally(() => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  });
}

// Deliberately unrelated topics per test, not shared-prefix variants of one
// string — matchAgainstUserSubmissionCorpus does a real global shingle
// search across everything stored in this file's shared DB, so two
// fixtures with a long common prefix would cross-contaminate each other's
// candidate results.
const TEXT_A =
  "Ornithologists tracking migratory songbirds fitted with miniature geolocators documented a previously unrecorded " +
  "stopover site in a coastal wetland reserve, where birds gained significantly more body mass per day than at three " +
  "other established stopover locations nearby, likely driven by the reserve's dense insect populations.";
const TEXT_B =
  "Marine biologists surveying deep-sea hydrothermal vent communities catalogued several previously undescribed " +
  "chemosynthetic bacterial mats supporting dense populations of tube worms, whose symbiotic relationship with the " +
  "bacteria allows them to thrive without sunlight in an otherwise inhospitable high-pressure environment.";
const TEXT_C =
  "Glaciologists analyzing ice core samples from a remote Antarctic drilling site identified distinct chemical " +
  "signatures corresponding to volcanic eruptions spanning several hundred thousand years, providing a detailed " +
  "timeline of past climate events that predates any existing written or instrumental historical record.";
const TEXT_D =
  "Entomologists studying leaf-cutter ant colonies observed a previously undocumented division of labor pattern " +
  "among worker castes, where smaller ants specialized in fungal garden maintenance while larger foragers handled " +
  "material transport, suggesting a more complex caste hierarchy than earlier field studies had proposed.";
const TEXT_E =
  "Volcanologists monitoring seismic activity beneath a dormant stratovolcano detected a gradual increase in " +
  "low-frequency tremors over an eighteen-month period, correlating with slow ground deformation measurements that " +
  "together suggested magma accumulation deep within the chamber without any imminent eruption risk.";

test("signed-in account: a promoted-only candidate is reported as TURNITPLUS_CORPUS_SOURCE, not silently dropped, when the flag is on", async () => {
  await seedActivePromotedSource(TEXT_A);
  await ensureUser("signed-in-account-1");
  const result = await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", () =>
    matchAgainstUserSubmissionCorpus(client, { accountId: "signed-in-account-1", canonicalText: TEXT_A }));
  assert.equal(result.status, "MATCHED");
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].relationshipType, "TURNITPLUS_CORPUS_SOURCE");
  assert.equal(result.matches[0].historicalSubmissionCount, 0);
});

test("anonymous submitter: a promoted-only candidate is ALSO TURNITPLUS_CORPUS_SOURCE, not generic UNKNOWN_RELATIONSHIP, when the flag is on", async () => {
  await seedActivePromotedSource(TEXT_B);
  const result = await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", () =>
    matchAgainstUserSubmissionCorpus(client, { accountId: null, canonicalText: TEXT_B }));
  assert.equal(result.status, "MATCHED");
  assert.equal(result.matches[0].relationshipType, "TURNITPLUS_CORPUS_SOURCE");
});

test("flag off: matcher falls back to today's exact prior behavior — dropped for signed-in, UNKNOWN_RELATIONSHIP for anonymous", async () => {
  await seedActivePromotedSource(TEXT_C);
  await ensureUser("signed-in-account-2");

  const signedInResult = await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", undefined, () =>
    matchAgainstUserSubmissionCorpus(client, { accountId: "signed-in-account-2", canonicalText: TEXT_C }));
  assert.equal(signedInResult.status, "NO_HISTORICAL_MATCH", "must be dropped entirely for a signed-in account, exactly like before this feature existed");

  const anonymousResult = await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", undefined, () =>
    matchAgainstUserSubmissionCorpus(client, { accountId: null, canonicalText: TEXT_C }));
  assert.equal(anonymousResult.status, "MATCHED");
  assert.equal(anonymousResult.matches[0].relationshipType, "UNKNOWN_RELATIONSHIP");
});

test("SELF/PRIOR_SUBMISSION priority: real ownership from ANOTHER account wins over the corpus-source label, even when the representation is also actively promoted", async () => {
  const text = TEXT_D;
  await seedActivePromotedSource(text);
  const identityA = await indexSubmission("dual-backed-account-a", "Dual backed A", text);
  await indexSubmission("dual-backed-account-b", "Dual backed B", text);

  // Account A queries with its OWN just-indexed reference excluded (the
  // standard E8D pattern) — Account B's real reference still counts, so
  // this must resolve as PRIOR_SUBMISSION, never TURNITPLUS_CORPUS_SOURCE,
  // even though the representation is also actively promoted.
  const resultA = await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", () =>
    matchAgainstUserSubmissionCorpus(client, { accountId: "dual-backed-account-a", documentIdentityId: identityA.id, canonicalText: text }));
  assert.equal(resultA.status, "MATCHED");
  assert.equal(resultA.matches.length, 1, "must never double-list the same representation under two relationship types");
  assert.equal(resultA.matches[0].relationshipType, "PRIOR_SUBMISSION", "real ownership must win over the corpus-source label");

  const otherAccountResult = await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", () =>
    matchAgainstUserSubmissionCorpus(client, { accountId: "some-other-account", canonicalText: text }));
  assert.equal(otherAccountResult.status, "MATCHED");
  assert.equal(otherAccountResult.matches[0].relationshipType, "PRIOR_SUBMISSION");
});

test("a promoted representation whose ONLY real reference is the current submitter's own excluded one correctly surfaces as TURNITPLUS_CORPUS_SOURCE, not a silent drop", async () => {
  const text = TEXT_E;
  await seedActivePromotedSource(text);
  const identity = await indexSubmission("solo-account", "Solo", text);

  const result = await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", () =>
    matchAgainstUserSubmissionCorpus(client, { accountId: "solo-account", documentIdentityId: identity.id, canonicalText: text }));
  assert.equal(result.status, "MATCHED", "before this fix, zero remaining ownership meant an unconditional drop for a signed-in account — that must no longer swallow an actively-promoted representation");
  assert.equal(result.matches[0].relationshipType, "TURNITPLUS_CORPUS_SOURCE");
});
