import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity, canonicalSha256 } from "../lib/document-identity.ts";
import { indexDocumentSubmissionIntoCorpus } from "../lib/user-submission-corpus.ts";
import { runCorpusAdmissionPromotionSweep } from "../lib/corpus-admission-promotion.ts";
import { deactivateAcceptedRepresentation, reactivateAcceptedRepresentation } from "../lib/corpus-admission-admin-actions.ts";
import { getOrComputeHistoricalMatchSnapshot, getCurrentCorpusMatchGeneration } from "../lib/report-historical-match.ts";
import { matureCorpusBackings } from "./helpers/corpus-maturity.mjs";

/**
 * Cache correctness for report_historical_match_snapshots across every
 * eligibility-change direction (see lib/report-historical-match.ts's own
 * header comment for the authoritative account):
 *   - EVERY eligibility change — added (promotion indexed, reactivate) or
 *     removed (deactivate) — bumps a GLOBAL generation counter, the actual
 *     correctness mechanism uniformly. Targeted, per-representation
 *     deletion (deactivate only) is layered on top purely as an immediate-
 *     effect optimization for the non-racing common case, never relied on
 *     alone.
 *   - Why targeted deletion alone is wrong for BOTH directions, for
 *     different reasons: added eligibility can match a report that never
 *     referenced the representation at all (a search over stored rows can
 *     never find what's missing — proven by the two end-to-end DISCOVERY
 *     tests below); removed eligibility has a genuine race — a concurrent
 *     computation can read a representation while still eligible and not
 *     write its own snapshot until AFTER a deactivation's targeted DELETE
 *     has already committed and found nothing, leaving the late write
 *     stale with nothing left to ever invalidate it (proven by the BARRIER
 *     test below, which reproduces exactly this ordering deterministically
 *     via a test-only pause hook rather than hoping to catch a real race).
 * Every fixture is synthetic.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_report_historical_match_invalidation.db");
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

function withEnv(name, value, fn) {
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return Promise.resolve(fn()).finally(() => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  });
}

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
  // Phase A: this suite tests generation-based snapshot invalidation, not the
  // 7-day activation gate — age the just-indexed backing so it is matchable "now".
  await matureCorpusBackings(client);
  return identity;
}

async function insertDecision(hash) {
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
      id, null, `invalidation-test-${randomUUID()}`, "v1", "ACCEPT", "[]", 1, "[]",
      "txt", 50, "English", 0.95, hash, "v1", null, 80, "v1",
      "{}", "{}", "v1", 0.9, "v1", "NONE", null, null,
      JSON.stringify({ kind: "PER_USER_CONSENT", consented: true }), 0,
    ],
  });
  return id;
}

/** Seeds an admin-accepted decision for `text` without promoting it yet — returns decisionId so the caller controls when (or whether) promotion happens. */
async function seedAcceptedDecision(text) {
  const hash = canonicalSha256(text);
  const decisionId = await insertDecision(hash);
  await client.execute({
    sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version, revoked_at, created_at)
          VALUES (?,?,?,?,?,NULL,CURRENT_TIMESTAMP)`,
    args: [randomUUID(), decisionId, hash, 50, "v1"],
  });
  await client.execute({
    sql: `INSERT INTO corpus_admission_content_store (id, decision_id, canonical_sha256, canonical_text, extractor_version, retention_basis, stored_at)
          VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [randomUUID(), decisionId, hash, text, "v1", "LICENSED_REUSE"],
  });
  return decisionId;
}

async function promote(decisionId) {
  const sweep = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  const outcome = sweep.results.find((r) => r.decisionId === decisionId);
  assert.equal(outcome?.outcome, "indexed", "test setup sanity: promotion must succeed");
  // Phase A: age the just-promoted backing so it is matchable "now" (this
  // suite exercises generation-based staleness, not the 7-day gate).
  await matureCorpusBackings(client);
  return outcome.representationId;
}

/** Seeds and promotes in one step — for fixtures that don't need control over the gap between accept and promote. */
async function seedActivePromotedSource(text) {
  const decisionId = await seedAcceptedDecision(text);
  const representationId = await promote(decisionId);
  return { decisionId, representationId };
}

let reportCounter = 0;
/** Directly inserts a cached MATCHED snapshot referencing representationId — controlled, bypasses full computation. Current generation is stamped so the row starts out NOT stale. */
async function insertCachedSnapshot(representationId) {
  reportCounter += 1;
  const reportDeviceKey = `invalidation-test-device-${reportCounter}`;
  const reportId = `invalidation-test-report-${reportCounter}`;
  const resultJson = JSON.stringify([
    {
      relationshipType: "TURNITPLUS_CORPUS_SOURCE",
      matchedRepresentationId: representationId,
      matchType: "EXACT_CANONICAL_MATCH",
      containment: 1,
      matchedWordCount: 50,
      passageCount: 1,
      longestMatchWords: 50,
      passages: [{ submittedText: "excerpt", submittedWordStart: 0, submittedWordEnd: 50, matchedWordCount: 50 }],
      historicalSubmissionCount: 0,
    },
  ]);
  const generation = await getCurrentCorpusMatchGeneration(client);
  await client.execute({
    sql: `INSERT INTO report_historical_match_snapshots
          (report_device_key, report_id, status, matcher_version, fingerprint_version, canonicalization_version, result_json, candidate_count, processing_duration_ms, error_message, computed_at, is_partial, corpus_generation, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [reportDeviceKey, reportId, "MATCHED", "v", "v", "v", resultJson, 1, 10, null, new Date().toISOString(), 0, generation],
  });
  return { reportDeviceKey, reportId };
}

async function snapshotExists(reportDeviceKey, reportId) {
  const result = await client.execute({
    sql: "SELECT 1 AS present FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?",
    args: [reportDeviceKey, reportId],
  });
  return result.rows.length > 0;
}

test("CACHED-MATCH DEACTIVATION: deactivating the decision backing a promoted representation deletes every cached snapshot referencing it, in the same transaction", async () => {
  const { decisionId, representationId } = await seedActivePromotedSource("Deactivation-invalidation fixture text, distinctive and long enough on its own.");
  const snapshot = await insertCachedSnapshot(representationId);
  assert.ok(await snapshotExists(snapshot.reportDeviceKey, snapshot.reportId), "test setup sanity");

  const outcome = await deactivateAcceptedRepresentation({ decisionId, adminUserId: "admin-test", reason: "test", openConnection });
  assert.equal(outcome.outcome, "deactivated");

  assert.ok(!(await snapshotExists(snapshot.reportDeviceKey, snapshot.reportId)), "the cached snapshot must be gone immediately after deactivation, not left stale until a later view");
});

test("deactivate/reactivate on a decision with NO promotion at all is a safe no-op for invalidation (nothing to invalidate, no error)", async () => {
  const decisionId = await insertDecision(canonicalSha256("Never promoted fixture text."));
  await client.execute({
    sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version, revoked_at, created_at)
          VALUES (?,?,?,?,?,NULL,CURRENT_TIMESTAMP)`,
    args: [randomUUID(), decisionId, canonicalSha256("Never promoted fixture text."), 10, "v1"],
  });
  const outcome = await deactivateAcceptedRepresentation({ decisionId, adminUserId: "admin-test", reason: "test", openConnection });
  assert.equal(outcome.outcome, "deactivated");
});

// Two genuinely different, non-overlapping passages, ~60 distinctive words
// each — BLOCK_B becomes its own promoted corpus source; the full report
// text is BLOCK_A + BLOCK_B, submitted separately by a real account, so
// each candidate is an independently real, textually-detected match, not a
// synthetic fixture.
const BLOCK_A =
  "Ornithologists tracking migratory songbirds fitted with miniature geolocators documented a previously unrecorded " +
  "stopover site in a coastal wetland reserve, where birds gained significantly more body mass per day than at three " +
  "other established stopover locations nearby, likely driven by the reserve's dense insect populations.";
const BLOCK_B =
  "Marine biologists surveying deep-sea hydrothermal vent communities catalogued several previously undescribed " +
  "chemosynthetic bacterial mats supporting dense populations of tube worms, whose symbiotic relationship with the " +
  "bacteria allows them to thrive without sunlight in an otherwise inhospitable high-pressure environment.";
const REPORT_TEXT = `${BLOCK_A} ${BLOCK_B}`;

test("NEW-PROMOTION DISCOVERY (end-to-end): a report cached against ONE representation gains a match to a completely unrelated, newly-promoted representation it never referenced", async () => {
  // A real submission by another account backs BLOCK_A + BLOCK_B in full —
  // this is the ONLY match that exists when the report is first cached.
  await indexSubmission("existing-submitter", "Existing submission", REPORT_TEXT);

  const reportDeviceKey = "new-promotion-discovery-device";
  const reportId = "new-promotion-discovery-report";
  const before = await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", () =>
    getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey, reportId, accountId: "viewing-account", rawText: REPORT_TEXT }));
  assert.equal(before.status, "MATCHED");
  assert.equal(before.matches.length, 1);
  assert.equal(before.matches[0].relationshipType, "PRIOR_SUBMISSION");

  const beforeRow = await client.execute({ sql: "SELECT corpus_generation FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?", args: [reportDeviceKey, reportId] });
  const stampedGeneration = Number(beforeRow.rows[0].corpus_generation);

  // BLOCK_B on its own, promoted from an admin-accepted decision — no
  // account, no submission reference. This report's cached snapshot has
  // NEVER referenced this representation (it didn't exist yet), so a
  // targeted, per-representation search could never find this report.
  const promotedDecisionId = await seedAcceptedDecision(BLOCK_B);
  const promotedRepresentationId = await promote(promotedDecisionId);

  const currentGeneration = await getCurrentCorpusMatchGeneration(client);
  assert.ok(currentGeneration > stampedGeneration, "test setup sanity: promotion must have bumped the generation past what this report's cached row was stamped with");

  const after = await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", () =>
    getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey, reportId, accountId: "viewing-account", rawText: REPORT_TEXT }));
  assert.equal(after.status, "MATCHED");
  assert.equal(after.matches.length, 2, "must now find BOTH the original real submission AND the newly-promoted, previously-unreferenced representation");
  const relationshipTypes = after.matches.map((m) => m.relationshipType).sort();
  assert.deepEqual(relationshipTypes, ["PRIOR_SUBMISSION", "TURNITPLUS_CORPUS_SOURCE"].sort());
  assert.ok(after.matches.some((m) => m.matchedRepresentationId === promotedRepresentationId), "the newly-promoted representation must actually be the discovered corpus-source match");
});

// Deliberately fresh, unrelated topics — not BLOCK_A/BLOCK_B variants. This
// file's earlier fixtures already promoted BLOCK_B as its own standalone
// representation; a suffixed BLOCK_B variant would still shingle-overlap it
// heavily and contaminate this test's own candidate count (matches
// matchAgainstUserSubmissionCorpus does a real GLOBAL shingle search across
// everything stored in this file's shared DB).
const BLOCK_C =
  "Glaciologists analyzing ice core samples from a remote Antarctic drilling site identified distinct chemical " +
  "signatures corresponding to volcanic eruptions spanning several hundred thousand years, providing a detailed " +
  "timeline of past climate events that predates any existing written or instrumental historical record.";
const BLOCK_D =
  "Entomologists studying leaf-cutter ant colonies observed a previously undocumented division of labor pattern " +
  "among worker castes, where smaller ants specialized in fungal garden maintenance while larger foragers handled " +
  "material transport, suggesting a more complex caste hierarchy than earlier field studies had proposed.";

test("REACTIVATION DISCOVERY (end-to-end): a report cached before a source was reactivated gains that match once reactivation bumps the generation", async () => {
  const blockA2 = BLOCK_C;
  const blockB2 = BLOCK_D;
  const reportText = `${blockA2} ${blockB2}`;

  await indexSubmission("existing-submitter-2", "Existing submission 2", reportText);

  // BLOCK_B is promoted but immediately deactivated — ineligible from the
  // start, so it must NOT show up when the report is first cached.
  const decisionId = await seedAcceptedDecision(blockB2);
  await promote(decisionId);
  const deactivateOutcome = await deactivateAcceptedRepresentation({ decisionId, adminUserId: "admin-test", reason: "test", openConnection });
  assert.equal(deactivateOutcome.outcome, "deactivated");

  const reportDeviceKey = "reactivation-discovery-device";
  const reportId = "reactivation-discovery-report";
  const before = await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", () =>
    getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey, reportId, accountId: "viewing-account-2", rawText: reportText }));
  assert.equal(before.status, "MATCHED");
  assert.equal(before.matches.length, 1, "the deactivated source must not appear — only the real submission");
  assert.equal(before.matches[0].relationshipType, "PRIOR_SUBMISSION");

  const beforeRow = await client.execute({ sql: "SELECT corpus_generation FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?", args: [reportDeviceKey, reportId] });
  const stampedGeneration = Number(beforeRow.rows[0].corpus_generation);

  const reactivateOutcome = await reactivateAcceptedRepresentation({ decisionId, adminUserId: "admin-test", reason: "test", openConnection });
  assert.equal(reactivateOutcome.outcome, "reactivated");

  const currentGeneration = await getCurrentCorpusMatchGeneration(client);
  assert.ok(currentGeneration > stampedGeneration, "test setup sanity: reactivation must have bumped the generation past what this report's cached row was stamped with");

  const after = await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", () =>
    getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey, reportId, accountId: "viewing-account-2", rawText: reportText }));
  assert.equal(after.status, "MATCHED");
  assert.equal(after.matches.length, 2, "reactivation must make the report gain the match it never had cached, not just leave the stale 1-entry cache in place");
  const relationshipTypes = after.matches.map((m) => m.relationshipType).sort();
  assert.deepEqual(relationshipTypes, ["PRIOR_SUBMISSION", "TURNITPLUS_CORPUS_SOURCE"].sort());
});

// Fresh, unrelated topic — this file's earlier fixtures already promoted
// BLOCK_B/BLOCK_C/BLOCK_D as their own representations; reusing any of them
// would shingle-overlap and contaminate this test's own candidate count.
const BLOCK_E =
  "Volcanologists monitoring seismic activity beneath a dormant stratovolcano detected a gradual increase in " +
  "low-frequency tremors over an eighteen-month period, correlating with slow ground deformation measurements that " +
  "together suggested magma accumulation deep within the chamber without any imminent eruption risk.";

test("BARRIER (race): a computation that reads a representation as eligible, then a deactivation commits DURING the gap before that computation writes, is still correctly rejected on the next view", async () => {
  const { decisionId, representationId } = await seedActivePromotedSource(BLOCK_E);

  const reportDeviceKey = "barrier-race-device";
  const reportId = "barrier-race-report";

  let deactivateOutcome;
  // The exact ordering this test reproduces deterministically, rather than
  // hoping to hit it under real concurrency:
  //   1. getOrComputeHistoricalMatchSnapshot reads currentGeneration, then
  //      candidates (BLOCK_E's representation is still active) — all BEFORE
  //      this pause callback runs.
  //   2. The pause callback runs a REAL deactivation to completion —
  //      revoked_at set, targeted DELETE (finds nothing — this snapshot row
  //      does not exist yet), generation bump — all committed.
  //   3. Control returns to getOrComputeHistoricalMatchSnapshot, which
  //      WRITES its snapshot — built from step 1's now-stale read — stamped
  //      with the generation captured in step 1, already older than what
  //      step 2 just bumped to.
  const first = await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", () =>
    getOrComputeHistoricalMatchSnapshot(client, {
      reportDeviceKey,
      reportId,
      accountId: "barrier-viewing-account",
      rawText: BLOCK_E,
      testOnlyPauseBeforeWrite: async () => {
        deactivateOutcome = await deactivateAcceptedRepresentation({ decisionId, adminUserId: "admin-test", reason: "test", openConnection });
      },
    }));

  assert.equal(deactivateOutcome?.outcome, "deactivated", "test setup sanity: the deactivation inside the pause must have actually committed");
  assert.equal(first.status, "MATCHED", "the racing computation itself legitimately saw pre-deactivation state — this is the write that becomes stale, not a bug in this one call");
  assert.equal(first.matches[0].matchedRepresentationId, representationId);

  // The write landed AFTER deactivation committed, so — unlike every other
  // test in this file — the targeted DELETE ran too early to catch it: the
  // stale row genuinely exists in storage right now.
  const stored = await client.execute({
    sql: "SELECT corpus_generation FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?",
    args: [reportDeviceKey, reportId],
  });
  assert.equal(stored.rows.length, 1, "test setup sanity: the targeted DELETE must NOT have caught this write — it ran before the write existed, exactly reproducing the race");
  const currentGeneration = await getCurrentCorpusMatchGeneration(client);
  assert.ok(
    Number(stored.rows[0].corpus_generation) < currentGeneration,
    "the stale row must be stamped with a generation older than current — this is what the next view checks, independent of exactly when the write landed",
  );

  // The actual fix: the NEXT view (no pause, nothing special) must reject
  // this stale row on its own corpus_generation column and recompute,
  // never serving the now-incorrect cached match.
  const second = await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", () =>
    getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey, reportId, accountId: "barrier-viewing-account", rawText: BLOCK_E }));
  assert.equal(second.status, "NO_HISTORICAL_MATCH", "the next view must recompute and correctly find the now-deactivated representation ineligible, not keep serving the stale cached match");
});
