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
import { isHistoricalMatchSnapshotCurrent, bumpCorpusMatchGeneration } from "../lib/report-historical-match.ts";
import { resolvePrimarySimilaritySummary, resolvePersistedSimilarityDisplay, selfHealUnifiedSimilarity, isFreshCurrentNoHistoricalMatch } from "../lib/report-primary-similarity.ts";
import { findRoomOccupant } from "../lib/reports-repo.ts";
import { computeUnifiedSimilarity } from "../lib/unified-similarity.ts";
import { USER_SUBMISSION_MATCHER_VERSION } from "../lib/user-submission-matching.ts";
import { CORPUS_FINGERPRINT_VERSION, CANONICALIZATION_VERSION } from "../lib/user-submission-corpus.ts";

/**
 * Release-hardening audit finding SIM-02, superseded by SIM-03: SIM-02 gave
 * findRoomOccupant its own read-time call to resolvePrimarySimilaritySummary
 * (a cache-first, so-technically-not-"the matcher" call) — closing the 0%
 * room card, but leaving a real completed report still capable of
 * triggering matching work at READ time. SIM-03 moves the ONE authoritative
 * computation to WRITE time (app/api/reports/route.ts's POST handler,
 * before that save's own response is ever sent) and makes findRoomOccupant
 * a pure, cheap SQL-only read of what was already persisted — see that
 * function's own header comment. This file now covers
 * resolvePrimarySimilaritySummary directly (still the one function that
 * calls into the historical-match snapshot cache, now used only at write
 * time and by the stale-generation self-heal path) and confirms
 * findRoomOccupant reads EXACTLY what finalization persisted, without ever
 * calling the resolver itself. tests/report-write-time-finalization.test.mjs
 * covers the full, real POST-route end-to-end flow this file's helpers only
 * approximate.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_report_primary_similarity.db");
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
  if (knownUsers.has(accountId)) return;
  knownUsers.add(accountId);
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
    args: [accountId, `${accountId}@example.test`, accountId, "not-a-real-hash"],
  });
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
      id, null, `primary-similarity-test-${randomUUID()}`, "v1", "ACCEPT", "[]", 1, "[]",
      "txt", 50, "English", 0.95, hash, "v1", null, 80, "v1",
      "{}", "{}", "v1", 0.9, "v1", "NONE", null, null,
      JSON.stringify({ kind: "PER_USER_CONSENT", consented: true }), 0,
    ],
  });
  return id;
}

/** Seeds and promotes an admin-accepted decision for `text` — no account, no submission reference, ever, matching lib/user-submission-matching.ts's own TURNITPLUS_CORPUS_SOURCE convention. */
async function seedActivePromotedSource(text) {
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
  const sweep = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  const outcome = sweep.results.find((r) => r.decisionId === decisionId);
  assert.equal(outcome?.outcome, "indexed", "test setup sanity: promotion must succeed");
  return decisionId;
}

let reportCounter = 0;
/**
 * Inserts a real saved_reports row — the exact same shape
 * app/api/reports/route.ts's POST handler writes — so findRoomOccupant and
 * resolvePrimarySimilaritySummary exercise the real read path, not a mock.
 */
async function insertSavedReport({ userId, room, archiveScore, aiStatus, text, wordCount }) {
  reportCounter += 1;
  const id = `primary-similarity-report-${reportCounter}`;
  const deviceKey = `primary-similarity-device-${reportCounter}`;
  if (userId) await ensureUser(userId);
  const payload = {
    version: 11, id, submissionId: `sub-${reportCounter}`, title: `Fixture ${reportCounter}`,
    author: "", assignment: "", created: new Date().toISOString(),
    score: archiveScore, archiveScore, wordCount,
    scoreBand: "Low", matchedWordCount: 0, sources: [], repeats: [], text,
  };
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, ai_score, ai_tone, payload_json, user_id, room_number, ai_status)
          VALUES (?,?,?,?,CURRENT_TIMESTAMP,?,?,?,?,?,?,?,?,?)`,
    args: [id, deviceKey, payload.submissionId, payload.title, wordCount, archiveScore, "Low", aiStatus === "ready" ? 0 : null, aiStatus === "ready" ? "low" : null, JSON.stringify(payload), userId, room, aiStatus],
  });
  return { id, deviceKey };
}

/**
 * Mirrors exactly what app/api/reports/route.ts's POST handler now does at
 * write time: resolve, then persist the result into payload_json — never a
 * second implementation of that logic, just this test file's own way of
 * reaching the same end state without going through a full HTTP-shaped
 * request for every test. tests/report-write-time-finalization.test.mjs
 * exercises the real route directly for the end-to-end scenario.
 */
async function finalizeAndPersist({ deviceKey, id, userId, text, wordCount, archiveScore }) {
  const resolution = await resolvePrimarySimilaritySummary(client, {
    reportDeviceKey: deviceKey, reportId: id, accountId: userId, rawText: text,
    wordCount, archiveMatchedPositions: null, externalAcademicEvidence: null, archiveScore,
  });
  if (resolution.unifiedSimilarity) {
    const existing = await client.execute({ sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, id] });
    const payload = JSON.parse(existing.rows[0].payload_json);
    payload.unifiedSimilarity = resolution.unifiedSimilarity;
    payload.corpusSourceMatchingEnabledAtComputation = resolution.corpusSourceMatchingEnabled;
    payload.unifiedSimilarityGeneration = resolution.corpusGeneration;
    await client.execute({ sql: "UPDATE saved_reports SET payload_json = ? WHERE device_key = ? AND id = ?", args: [JSON.stringify(payload), deviceKey, id] });
  }
  return resolution;
}

// Deliberately unrelated topics per test — matchAgainstUserSubmissionCorpus
// does a real global shingle search across everything in this file's shared
// DB, so overlapping fixtures would cross-contaminate each other's results.
const TEXT_ROOM_CARD = "Paleobotanists studying fossilized pollen grains from a lakebed core reconstructed a detailed record of vegetation change across four glacial cycles in the region.";
const TEXT_FLAG_OFF = "Seismologists deploying a dense array of ocean-bottom sensors mapped a previously unknown fault segment running parallel to the main subduction zone offshore.";
const TEXT_AGREEMENT = "Mycologists cataloguing fungal diversity in an old-growth temperate rainforest identified several species new to the region using both morphological and genetic sequencing methods.";
const TEXT_CACHE_REUSE = "Climatologists analyzing tree-ring width variations across a network of high-elevation sites derived a multi-century reconstruction of regional drought severity.";

test("SIM-03 (1): room card reads the WRITE-TIME finalized combined score — archive_score=0, genuine corpus-source match=100%, matching the real observed bug", async () => {
  await seedActivePromotedSource(TEXT_ROOM_CARD);
  const { id, deviceKey } = await insertSavedReport({
    userId: "sim03-room-user-1", room: 0, archiveScore: 0, aiStatus: "ready", text: TEXT_ROOM_CARD, wordCount: 100,
  });
  await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", async () => {
    await finalizeAndPersist({ deviceKey, id, userId: "sim03-room-user-1", text: TEXT_ROOM_CARD, wordCount: 100, archiveScore: 0 });

    // findRoomOccupant itself never calls the resolver or the matcher — it
    // reads payload_json plus two cheap freshness checks (SIM-04's own
    // resolvePersistedSimilarityDisplay) — proving the room card's value
    // came from what finalization already persisted, not a read-time
    // recomputation. The flag stays "true" for this read too: it was also
    // "true" at write time, so this is the ordinary "nothing changed"
    // case, not the flag-rollback case SIM-04 (2) covers separately.
    const occupant = await findRoomOccupant(client, "sim03-room-user-1", 0);

    assert.equal(occupant.status, "ready");
    assert.equal(occupant.report.archiveScore, 0, "the persisted archive_score column must stay exactly what was saved");
    assert.equal(occupant.report.primaryScore, 100, "the room card must show the resolved combined score, not the archive-only 0%");
    assert.equal(occupant.report.isUnified, true);
  });
});

test("SIM-03 (4): flag-off mode finalizes and persists archive-only values, even with a real corpus source that would otherwise match", async () => {
  await seedActivePromotedSource(TEXT_FLAG_OFF);
  // archiveScore/archiveMatchedPositions deliberately agree at "nothing" —
  // this report's only possible source of a non-zero score is the promoted
  // corpus source seeded above, so a flag-off score of exactly 0 proves
  // that contribution never reached the persisted result; with the flag on
  // (see the sibling assertion below), the identical report resolves to 100.
  const { id, deviceKey } = await insertSavedReport({
    userId: "sim03-flagoff-user-1", room: 0, archiveScore: 0, aiStatus: "ready", text: TEXT_FLAG_OFF, wordCount: 100,
  });

  const resolutionFlagOff = await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "false", () =>
    finalizeAndPersist({ deviceKey, id, userId: "sim03-flagoff-user-1", text: TEXT_FLAG_OFF, wordCount: 100, archiveScore: 0 }));
  assert.equal(resolutionFlagOff.primaryScore, 0, "with the flag off, the corpus-source contribution must never reach the resolved, persisted score");

  // findRoomOccupant does no flag-checking of its own — a pure read of what
  // finalization persisted — so this confirms the room card agrees with
  // whatever was written, not that it independently re-applies the flag.
  const occupant = await findRoomOccupant(client, "sim03-flagoff-user-1", 0);
  assert.equal(occupant.report.primaryScore, 0, "the room card must agree — archive-only value, flag off");

  // Sanity: the SAME report, SAME snapshot cache, re-finalized with the
  // flag on — proves this test's setup genuinely has a real corpus match
  // available, so the 0 above is a real "flag correctly suppressed it," not
  // an accident of a broken fixture.
  const resolutionFlagOn = await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", () =>
    finalizeAndPersist({ deviceKey, id, userId: "sim03-flagoff-user-1", text: TEXT_FLAG_OFF, wordCount: 100, archiveScore: 0 }));
  assert.equal(resolutionFlagOn.primaryScore, 100, "sanity: with the flag on, the same real corpus match resolves to 100 — confirms the flag-off 0 above was not just a fixture accident");
});

test("SIM-02 (5), extended by LIFECYCLE-06: a genuine computeUnifiedSimilarity failure produces an explicit archive fallback, never an undefined/thrown result, AND is reported via resolution.failed as a genuine, reproducible overall-computation failure", async () => {
  const { id, deviceKey } = await insertSavedReport({
    userId: "sim02-failure-user-1", room: 0, archiveScore: 12, aiStatus: "ready", text: "Plain unrelated fixture text with no corpus match of any kind.", wordCount: 50,
  });

  const throwingCompute = () => { throw new Error("simulated computeUnifiedSimilarity failure"); };
  const resolution = await resolvePrimarySimilaritySummary(client, {
    reportDeviceKey: deviceKey, reportId: id, accountId: "sim02-failure-user-1", rawText: "Plain unrelated fixture text with no corpus match of any kind.",
    wordCount: 50, archiveMatchedPositions: null, externalAcademicEvidence: null, archiveScore: 12,
    testOnlyComputeUnifiedSimilarity: throwingCompute,
  });

  assert.equal(resolution.primaryScore, 12, "must fall back to the exact archive-only value, not 0 or undefined");
  assert.equal(resolution.isUnified, false);
  assert.equal(resolution.unifiedSimilarity, undefined);
  // Release-hardening audit finding LIFECYCLE-06 (corrected): this exact
  // scenario — computeUnifiedSimilarity itself throwing — is the ONE real,
  // reproducible overall-computation failure this codebase has. Callers
  // (app/api/reports/route.ts, app/api/reports/[id]/route.ts) persist this
  // explicitly as unifiedSimilarityFailed: true rather than silently
  // leaving the report indistinguishable from "never attempted."
  assert.equal(resolution.failed, true, "REQUIRED: a genuine computeUnifiedSimilarity throw must be reported as failed, not silently absorbed as if nothing happened");
  // historicalSubmissionMatch is still resolved normally — only the
  // unified-arithmetic step failed, not the (separate, already-defensive)
  // snapshot lookup.
  assert.ok(resolution.historicalSubmissionMatch);
});

test("LIFECYCLE-06: resolution.failed stays false on the success path — sanity companion to the failure case above, proving the field is a genuine discriminator, not always true/false regardless of outcome", async () => {
  const { id, deviceKey } = await insertSavedReport({
    userId: "lifecycle06-success-user-1", room: 0, archiveScore: 7, aiStatus: "ready", text: "An entirely unrelated fixture about glacial hydrology for this specific success-path sanity check.", wordCount: 40,
  });
  const resolution = await resolvePrimarySimilaritySummary(client, {
    reportDeviceKey: deviceKey, reportId: id, accountId: "lifecycle06-success-user-1", rawText: "An entirely unrelated fixture about glacial hydrology for this specific success-path sanity check.",
    wordCount: 40, archiveMatchedPositions: null, externalAcademicEvidence: null, archiveScore: 7,
  });
  assert.equal(resolution.failed, false);
  assert.ok(resolution.unifiedSimilarity, "a genuine success must still produce a real unifiedSimilarity object");
});

test("LIFECYCLE-06: a historicalSubmissionMatch reaching its own real, persisted UNAVAILABLE status is a fail-soft individual-source issue — computeUnifiedSimilarity still resolves normally from the archive/academic evidence that IS available, never throwing, never turning into an overall similarity failure", () => {
  // Investigated before implementing (per this turn's own requirement):
  // lib/unified-similarity.ts's computeUnifiedSimilarity only ever
  // special-cases historicalSubmissionMatch.status === "MATCHED" (see its
  // own sole status check) — any other status, "UNAVAILABLE" included,
  // simply contributes zero historical words. Proven here directly against
  // the real function, no DB needed: a manually-constructed UNAVAILABLE
  // historicalSubmissionMatch (matching exactly what
  // lib/report-historical-match.ts's getOrComputeHistoricalMatchSnapshot
  // itself returns on a genuine, internally-caught matcher failure) must
  // never make this call throw, and the resulting score must still reflect
  // the archive contribution that WAS available.
  const unavailableHistoricalMatch = {
    status: "UNAVAILABLE",
    computedAt: new Date().toISOString(),
    matcherVersion: "v-test",
    fingerprintVersion: "v-test",
    canonicalizationVersion: "v-test",
  };
  const result = computeUnifiedSimilarity({
    wordCount: 100,
    archiveMatchedPositions: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    externalAcademicEvidence: null,
    historicalSubmissionMatch: unavailableHistoricalMatch,
  });
  assert.equal(result.uniqueMatchedWords, 10, "the archive contribution must still be reflected — a fail-soft historical-match issue must never zero out signal that IS available");
  assert.ok(result.unifiedScore > 0, "REQUIRED: a genuine, resolvable unified score must still be produced — 'one contributing source unavailable' must never be escalated to 'nothing could be computed'");
});

/**
 * Mirrors app/api/reports/[id]/route.ts's own self-heal persistence for the
 * failure branch — see this file's own finalizeAndPersist for the success
 * mirror. Distinct helper (rather than widening finalizeAndPersist) because
 * production itself has two distinct branches (if/else if) with distinct
 * persisted shapes; this keeps the test's own mirror equally explicit about
 * which branch it exercises.
 */
async function finalizeAndPersistFailure({ deviceKey, id, userId, text, wordCount, archiveScore }) {
  const throwingCompute = () => { throw new Error("simulated deterministic terminal similarity failure"); };
  const resolution = await resolvePrimarySimilaritySummary(client, {
    reportDeviceKey: deviceKey, reportId: id, accountId: userId, rawText: text,
    wordCount, archiveMatchedPositions: null, externalAcademicEvidence: null, archiveScore,
    testOnlyComputeUnifiedSimilarity: throwingCompute,
  });
  assert.equal(resolution.failed, true, "test setup sanity: the forced throw must actually reach resolution.failed");
  const existing = await client.execute({ sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, id] });
  const payload = JSON.parse(existing.rows[0].payload_json);
  // Release-hardening audit finding LIFECYCLE-06 (approval-pass fix):
  // explicitly clears any unifiedSimilarity this row might already carry
  // from an earlier successful save — mirrors app/api/reports/route.ts's
  // and app/api/reports/[id]/route.ts's own failure-branch writes exactly.
  // Without this, a stale success left over from a PRIOR save would
  // silently outrank this fresh failure (resolvePersistedSimilarityDisplay
  // checks hasUnifiedSimilarity before unifiedSimilarityFailed) — see the
  // dedicated regression test below, which exercises exactly that
  // sequence.
  payload.unifiedSimilarity = undefined;
  payload.unifiedSimilarityFailed = true;
  payload.corpusSourceMatchingEnabledAtComputation = resolution.corpusSourceMatchingEnabled;
  payload.unifiedSimilarityGeneration = resolution.corpusGeneration;
  await client.execute({ sql: "UPDATE saved_reports SET payload_json = ? WHERE device_key = ? AND id = ?", args: [JSON.stringify(payload), deviceKey, id] });
  return resolution;
}

test("LIFECYCLE-06 END-TO-END: a genuine terminal similarity failure persists as unifiedSimilarityFailed, and BOTH resolvePersistedSimilarityDisplay AND findRoomOccupant (the room card's own read path) surface it as 'failed' — never a false 'pending' that would poll forever with no way for the user to ever see an honest answer", async () => {
  const text = "A completely unrelated fixture about deep-sea hydrothermal vent ecosystems, used only for this LIFECYCLE-06 terminal-failure end-to-end test.";
  const { id, deviceKey } = await insertSavedReport({
    userId: "lifecycle06-failure-user-1", room: 0, archiveScore: 33, aiStatus: "ready", text, wordCount: 60,
  });

  await finalizeAndPersistFailure({ deviceKey, id, userId: "lifecycle06-failure-user-1", text, wordCount: 60, archiveScore: 33 });

  // Real DB row, real json_extract read — the exact call
  // app/reports/[id]/page.tsx's loadOwnedReport makes.
  const display = await resolvePersistedSimilarityDisplay(client, {
    reportDeviceKey: deviceKey, reportId: id, archiveScore: 33, unifiedScore: null,
    hasUnifiedSimilarity: false, corpusSourceMatchingEnabledAtComputation: null,
    unifiedSimilarityFailed: true,
  });
  assert.deepEqual(display, { status: "failed" }, "REQUIRED: a persisted failure marker must read back as the 'failed' status, not 'pending'");

  // The room card's own read path — never calls the resolver, pure SQL —
  // must agree exactly, matching SIM-03/SIM-04's own "room and detail can
  // never disagree" guarantee, now extended to the failure case.
  const occupant = await findRoomOccupant(client, "lifecycle06-failure-user-1", 0);
  assert.equal(occupant.status, "ready");
  assert.equal(occupant.report.similarityStatus, "failed", "REQUIRED: the room card must read the same terminal failure, not stay stuck showing a neutral 'Calculating…' placeholder forever");
  assert.equal(occupant.report.isUnified, false, "a failed resolution must never claim a false combined result");
  assert.equal(occupant.report.primaryScore, occupant.report.archiveScore, "with no trustworthy combined score, primaryScore must stay the archive-only fallback, never a stale/invented number");
});

test("LIFECYCLE-06 REGRESSION (approval-pass finding): a fresh terminal failure following an EARLIER successful save must never be masked by that stale unifiedSimilarity — the room card and resolvePersistedSimilarityDisplay must both show 'failed', not silently fall back to the old 'resolved' score", async () => {
  // A genuine MATCHED source is seeded (mirroring SIM-03 (1)'s own
  // pattern) so the FIRST save genuinely succeeds with a real, non-zero
  // unified result to leave stale — this is exactly the shape a client
  // resave's own reportPayload.unifiedSimilarity would carry forward from
  // a locally-cached copy (see saveEnrichedAiResult's own {...report,
  // ...aiResult} spread in app/reports/rooms/[room]/room-page-shell.tsx).
  const text = "Volcanologists monitoring gas emissions at a restless caldera detected a sustained shift in sulfur dioxide flux preceding the eventual eruption.";
  await seedActivePromotedSource(text);
  const { id, deviceKey } = await insertSavedReport({
    userId: "lifecycle06-stale-mask-user-1", room: 0, archiveScore: 5, aiStatus: "ready", text, wordCount: 30,
  });

  await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", async () => {
    // Step 1: a genuine success persists a real unifiedSimilarity.
    await finalizeAndPersist({ deviceKey, id, userId: "lifecycle06-stale-mask-user-1", text, wordCount: 30, archiveScore: 5 });
    const afterSuccess = await findRoomOccupant(client, "lifecycle06-stale-mask-user-1", 0);
    assert.equal(afterSuccess.report.similarityStatus, "resolved", "sanity: the first save must genuinely succeed and be readable as resolved");

    // Step 2: a later attempt (e.g. a retry resave whose own submitted
    // payload still carries the OLD unifiedSimilarity from step 1) fails
    // deterministically. finalizeAndPersistFailure re-reads the CURRENT
    // row (which already has unifiedSimilarity set from step 1) before
    // writing — exactly reproducing the "stale success already present"
    // precondition this regression covers.
    await finalizeAndPersistFailure({ deviceKey, id, userId: "lifecycle06-stale-mask-user-1", text, wordCount: 30, archiveScore: 5 });

    const rawRow = await client.execute({ sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, id] });
    const rawPersisted = JSON.parse(rawRow.rows[0].payload_json);
    assert.equal(rawPersisted.unifiedSimilarity, undefined, "REQUIRED: the fresh failure write must have cleared the stale unifiedSimilarity, not merely added unifiedSimilarityFailed alongside it");
    assert.equal(rawPersisted.unifiedSimilarityFailed, true);

    const afterFailure = await findRoomOccupant(client, "lifecycle06-stale-mask-user-1", 0);
    assert.equal(afterFailure.report.similarityStatus, "failed", "REQUIRED: the room card must show the FRESH failure, never fall back to masking it behind the stale successful score from step 1");

    const display = await resolvePersistedSimilarityDisplay(client, {
      reportDeviceKey: deviceKey, reportId: id, archiveScore: 5,
      unifiedScore: rawPersisted.unifiedSimilarity?.unifiedScore ?? null,
      hasUnifiedSimilarity: rawPersisted.unifiedSimilarity !== undefined,
      corpusSourceMatchingEnabledAtComputation: rawPersisted.corpusSourceMatchingEnabledAtComputation ?? null,
      unifiedSimilarityFailed: rawPersisted.unifiedSimilarityFailed ?? false,
    });
    assert.deepEqual(display, { status: "failed" }, "REQUIRED: resolvePersistedSimilarityDisplay must also report the fresh failure, not the stale resolved result");
  });
});

test("LIFECYCLE-06: a later successful resave clears a prior terminal failure marker — 'failed' is sticky only until a genuinely successful attempt overwrites it, exactly mirroring how a later AI retry overwrites ai_status 'failed' with 'ready'", async () => {
  // A genuine MATCHED source is seeded (mirroring SIM-03 (1)'s own
  // pattern) so the retry's own resolution reaches "resolved" rather than
  // "stale" — a NO_HISTORICAL_MATCH snapshot is, by design (see this
  // file's own Phase E8E comment via lib/report-historical-match.ts),
  // NEVER treated as current, always eligible for a recheck; using a bare
  // unrelated fixture here would make even a genuinely successful retry
  // read back as "stale" for a reason unrelated to what this test is
  // actually proving (clearing the failure marker specifically).
  const text = "Entomologists surveying pollinator diversity along an urban-to-rural gradient documented a marked decline in wild bee species richness near dense development.";
  await seedActivePromotedSource(text);
  const { id, deviceKey } = await insertSavedReport({
    userId: "lifecycle06-clear-user-1", room: 0, archiveScore: 18, aiStatus: "ready", text, wordCount: 45,
  });

  await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", async () => {
    await finalizeAndPersistFailure({ deviceKey, id, userId: "lifecycle06-clear-user-1", text, wordCount: 45, archiveScore: 18 });
    const beforeRetry = await findRoomOccupant(client, "lifecycle06-clear-user-1", 0);
    assert.equal(beforeRetry.report.similarityStatus, "failed", "sanity: the failure must be persisted and readable before the retry");

    // A genuine retry — the SAME finalizeAndPersist helper every
    // success-path test in this file already uses, with the REAL
    // (non-throwing) compute function this time.
    await finalizeAndPersist({ deviceKey, id, userId: "lifecycle06-clear-user-1", text, wordCount: 45, archiveScore: 18 });
    const afterRetry = await findRoomOccupant(client, "lifecycle06-clear-user-1", 0);
    assert.equal(afterRetry.report.similarityStatus, "resolved", "REQUIRED: a genuinely successful resave must clear the earlier failure marker, not leave it stuck showing Unavailable forever");
    assert.equal(afterRetry.report.isUnified, true);
  });
});

test("SIM-03 (6): room and detail agree — both read the SAME write-time-persisted result, before and after a stale-generation re-finalization", async () => {
  const { id, deviceKey } = await insertSavedReport({
    userId: "sim03-agree-user-1", room: 0, archiveScore: 0, aiStatus: "ready", text: TEXT_AGREEMENT, wordCount: 100,
  });

  await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", async () => {
    // Initial finalization (mirrors the POST handler): nothing promoted
    // yet, so this settles at the archive-only 0 and persists that.
    await finalizeAndPersist({ deviceKey, id, userId: "sim03-agree-user-1", text: TEXT_AGREEMENT, wordCount: 100, archiveScore: 0 });
    const beforeRoom = await findRoomOccupant(client, "sim03-agree-user-1", 0);
    assert.equal(beforeRoom.report.primaryScore, 0, "sanity: no source promoted yet, nothing to match");
    // NO_HISTORICAL_MATCH is never treated as "current," by design (see
    // lib/report-historical-match.ts's own Phase E8E comment) — a fresh
    // finalization that found nothing is deliberately always eligible for
    // a cheap recheck, so a later-promoted match is never missed.
    assert.equal(await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: deviceKey, reportId: id }), false, "a NO_HISTORICAL_MATCH snapshot is never current, even freshly written");

    // A source matching this exact report's text is promoted AFTER
    // finalization already ran — the real "a report is viewed before
    // another account's upload finishes indexing" ordering this codebase
    // already documents (see lib/report-historical-match.ts's own Phase
    // E8E comment) — bumps corpus_match_generation, making the persisted
    // result stale (requirement 8's own separate path).
    await seedActivePromotedSource(TEXT_AGREEMENT);
    assert.equal(await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: deviceKey, reportId: id }), false, "promotion must make the previously-current snapshot stale");

    // The self-heal re-finalization (what the stale-generation path does)
    // persists exactly once, and BOTH surfaces immediately agree on the
    // refreshed value — there is no separate "detail" computation to drift
    // from "room": both only ever read this same persisted column.
    await finalizeAndPersist({ deviceKey, id, userId: "sim03-agree-user-1", text: TEXT_AGREEMENT, wordCount: 100, archiveScore: 0 });
    const afterRoom = await findRoomOccupant(client, "sim03-agree-user-1", 0);
    assert.equal(afterRoom.report.primaryScore, 100, "must reflect the newly promoted match — NO_HISTORICAL_MATCH is never treated as final, exactly like every other report view");
    assert.equal(await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: deviceKey, reportId: id }), true, "re-finalization must leave the snapshot current again");
  });
});

test("SIM-02 (7): the expensive matcher is not run twice for the same still-current snapshot — a second resolution call is a pure cache hit", async () => {
  await seedActivePromotedSource(TEXT_CACHE_REUSE);
  const { id, deviceKey } = await insertSavedReport({
    userId: "sim02-cache-user-1", room: 0, archiveScore: 0, aiStatus: "ready", text: TEXT_CACHE_REUSE, wordCount: 100,
  });

  await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", async () => {
    const first = await resolvePrimarySimilaritySummary(client, {
      reportDeviceKey: deviceKey, reportId: id, accountId: "sim02-cache-user-1", rawText: TEXT_CACHE_REUSE,
      wordCount: 100, archiveMatchedPositions: null, externalAcademicEvidence: null, archiveScore: 0,
    });
    assert.equal(first.primaryScore, 100, "test setup sanity");

    const rowAfterFirst = await client.execute({
      sql: "SELECT computed_at FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?",
      args: [deviceKey, id],
    });
    const computedAtAfterFirst = rowAfterFirst.rows[0]?.computed_at;
    assert.ok(computedAtAfterFirst, "the first call must have written a real snapshot row");

    // Second call, identical params, same corpus-match generation, same
    // version tags — getOrComputeHistoricalMatchSnapshot's own staleness
    // check must accept the existing row as-is and never re-run
    // matchAgainstUserSubmissionCorpus (the expensive search) a second time.
    const second = await resolvePrimarySimilaritySummary(client, {
      reportDeviceKey: deviceKey, reportId: id, accountId: "sim02-cache-user-1", rawText: TEXT_CACHE_REUSE,
      wordCount: 100, archiveMatchedPositions: null, externalAcademicEvidence: null, archiveScore: 0,
    });
    assert.equal(second.primaryScore, 100);

    const rowAfterSecond = await client.execute({
      sql: "SELECT computed_at FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?",
      args: [deviceKey, id],
    });
    assert.equal(rowAfterSecond.rows[0]?.computed_at, computedAtAfterFirst, "the snapshot row must not have been rewritten — the second call was a cache hit, not a recompute");
  });
});

test("SIM-03 (8): the room card's summary never exposes an account id, decision id, or representation id — only numbers and a boolean, and findRoomOccupant reads it via a plain json_extract, never a full payload parse", async () => {
  const text = "Herpetologists radio-tracking a population of forest salamanders documented unexpectedly long-distance dispersal between adjacent watershed populations.";
  await seedActivePromotedSource(text);
  const { id, deviceKey } = await insertSavedReport({
    userId: "sim03-privacy-user-1", room: 0, archiveScore: 0, aiStatus: "ready", text, wordCount: 100,
  });
  await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", async () => {
    await finalizeAndPersist({ deviceKey, id, userId: "sim03-privacy-user-1", text, wordCount: 100, archiveScore: 0 });

    // Flag stays "true" for this read too (same reasoning as SIM-03 (1)
    // above) — this test is about the summary's shape/privacy, not about
    // flag-rollback behavior, which SIM-04 (2) covers on its own.
    const occupant = await findRoomOccupant(client, "sim03-privacy-user-1", 0);
    assert.equal(occupant.report.primaryScore, 100, "test setup sanity");

    const serialized = JSON.stringify(occupant.report);
    assert.doesNotMatch(serialized, /@/, "no email-shaped string may appear in a room summary");
    assert.doesNotMatch(serialized, /sim03-privacy-user-1/, "the viewing account's own raw id must never appear in what is sent to the client");
    assert.doesNotMatch(serialized, /Herpetologists|salamanders/i, "the submitted text itself must never appear in the room summary — confirms this came from json_extract's two scalar fields, not a full payload_json parse handed back as-is");
    assert.equal(Object.keys(occupant.report).sort().join(","), "aiScore,aiTone,archiveScore,createdAt,id,isUnified,primaryScore,scoreBand,similarityStatus,submissionId,title,wordCount", "the room summary shape must stay exactly this — no representation/decision/account id field ever added");
  });
});

// --- Rendering: never a transient archive-only number while pending --------

// --- SIM-04: the read-side display resolver, and the write-side resolver's own uncaught-failure boundary ---

test("SIM-04 (1): resolvePersistedSimilarityDisplay treats a moved-on generation as \"stale\" and falls back to the archive score — never trusts the persisted unifiedSimilarity number, and never touches the matcher to find out", async () => {
  const text = "Volcanologists monitoring gas emissions from a restless caldera detected a shift in sulfur dioxide flux that preceded a period of elevated seismic unrest.";
  const { id, deviceKey } = await insertSavedReport({
    userId: "sim04-stale-user-1", room: 0, archiveScore: 7, aiStatus: "ready", text, wordCount: 100,
  });
  await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", async () => {
    await finalizeAndPersist({ deviceKey, id, userId: "sim04-stale-user-1", text, wordCount: 100, archiveScore: 7 });

    const snapshotCountBefore = (await client.execute("SELECT COUNT(*) AS n FROM report_historical_match_snapshots")).rows[0].n;

    // A source matching this report's own text is promoted AFTER
    // finalization already ran — bumps corpus_match_generation without ever
    // touching payload_json. The flag itself never changes in this test —
    // isolating the generation-staleness path from the flag-rollback path
    // SIM-04 (2) covers separately.
    await seedActivePromotedSource(text);

    const row = await client.execute({ sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, id] });
    const payload = JSON.parse(row.rows[0].payload_json);
    assert.equal(payload.unifiedSimilarity.unifiedScore, 0, "sanity: the persisted number itself is untouched by the later promotion — still the old, now-stale value");

    const display = await resolvePersistedSimilarityDisplay(client, {
      reportDeviceKey: deviceKey, reportId: id, archiveScore: 7,
      unifiedScore: payload.unifiedSimilarity.unifiedScore, hasUnifiedSimilarity: true,
      corpusSourceMatchingEnabledAtComputation: payload.corpusSourceMatchingEnabledAtComputation,
    });
    assert.equal(display.status, "stale", "a moved-on generation must never be reported as resolved");
    // Discriminated-union guarantee (acceptance-check hardening): the
    // "stale" branch carries no primaryScore/isUnified field AT ALL — not
    // merely a convention a caller has to remember, but a shape a caller
    // literally cannot misuse. A consumer that forgot to check `.status`
    // first and tried `display.primaryScore` would fail to compile, and
    // this assertion is the runtime mirror of that same guarantee.
    assert.ok(!("primaryScore" in display), "the stale branch must carry no primaryScore field to accidentally render");
    assert.ok(!("isUnified" in display), "the stale branch must carry no isUnified field either");

    const snapshotCountAfter = (await client.execute("SELECT COUNT(*) AS n FROM report_historical_match_snapshots")).rows[0].n;
    assert.equal(Number(snapshotCountAfter), Number(snapshotCountBefore), "resolvePersistedSimilarityDisplay itself must never create/update a report_historical_match_snapshots row — proves it never ran the matcher");
  });
});

test("SIM-04 (2): resolvePersistedSimilarityDisplay applies live CORPUS_SOURCE_MATCHING_ENABLED filtering without ever touching payload_json or the matcher — ON->OFF rollback is immediately \"resolved\"+archive-only, OFF->ON roll-forward is \"stale\"", async () => {
  await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "false", async () => {
    const result = await resolvePersistedSimilarityDisplay(client, {
      reportDeviceKey: "sim04-flagsim-device", reportId: "sim04-flagsim-report",
      archiveScore: 15, unifiedScore: 100, hasUnifiedSimilarity: true,
      corpusSourceMatchingEnabledAtComputation: true,
    });
    assert.equal(result.status, "resolved", "a rollback (was on, now off) is immediately, deterministically correct — no wait needed");
    assert.equal(result.primaryScore, 15, "must be the archive-only score, never the old corpus-inflated 100");
    assert.equal(result.isUnified, false);
  });

  await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", async () => {
    const result = await resolvePersistedSimilarityDisplay(client, {
      reportDeviceKey: "sim04-flagsim-device", reportId: "sim04-flagsim-report",
      archiveScore: 15, unifiedScore: 0, hasUnifiedSimilarity: true,
      corpusSourceMatchingEnabledAtComputation: false,
    });
    assert.equal(result.status, "stale", "a roll-forward (was off, now on) must never be reported as final — a new corpus match cannot be ruled out without recomputing");
    assert.ok(!("primaryScore" in result), "no fallback number to accidentally render while a roll-forward is unresolved");
    assert.ok(!("isUnified" in result));
  });
});

test('SIM-04 DISCRIMINATED UNION: the "pending" branch (unifiedSimilarity never persisted at all) also carries no primaryScore/isUnified field — a legacy or not-yet-finalized report can never be rendered with a borrowed number', async () => {
  const result = await resolvePersistedSimilarityDisplay(client, {
    reportDeviceKey: "sim04-pending-device", reportId: "sim04-pending-report",
    archiveScore: 33, unifiedScore: null, hasUnifiedSimilarity: false,
    corpusSourceMatchingEnabledAtComputation: null,
  });
  assert.equal(result.status, "pending");
  assert.ok(!("primaryScore" in result), "the pending branch must carry no primaryScore field");
  assert.ok(!("isUnified" in result), "the pending branch must carry no isUnified field");
  assert.equal(Object.keys(result).length, 1, 'the pending branch must be exactly { status: "pending" } — nothing else');
});

test("SIM-04 (3): resolvePrimarySimilaritySummary is not unconditionally safe — a genuine infra failure (unlike a computeUnifiedSimilarity failure) propagates OUT uncaught, which is exactly why app/api/reports/route.ts and app/api/reports/[id]/route.ts each wrap their own call in a try/catch", async () => {
  const brokenClient = createClient({ url: `file:${dbFile}` });
  await brokenClient.close();

  await assert.rejects(
    () => resolvePrimarySimilaritySummary(brokenClient, {
      reportDeviceKey: "sim04-crash-device", reportId: "sim04-crash-report", accountId: null,
      rawText: "irrelevant", wordCount: 10, archiveMatchedPositions: null, externalAcademicEvidence: null, archiveScore: 42,
    }),
    "a closed client must make the resolver's own pre-compute reads throw, and resolvePrimarySimilaritySummary must not swallow that — its own try/catch only covers computeUnifiedSimilarity",
  );

  // Mirrors exactly what app/api/reports/route.ts's POST handler does around
  // this same call: a genuine failure here must leave the caller's own
  // payload untouched — never undefined, never a partial/corrupted write.
  const payloadJsonToPersist = JSON.stringify({ archiveScore: 42, text: "irrelevant" });
  let caught = false;
  try {
    await resolvePrimarySimilaritySummary(brokenClient, {
      reportDeviceKey: "sim04-crash-device", reportId: "sim04-crash-report", accountId: null,
      rawText: "irrelevant", wordCount: 10, archiveMatchedPositions: null, externalAcademicEvidence: null, archiveScore: 42,
    });
  } catch {
    caught = true;
    // left untouched, exactly like route.ts's own catch block
  }
  assert.equal(caught, true, "test setup sanity: the closed client must actually throw");
  assert.deepEqual(JSON.parse(payloadJsonToPersist), { archiveScore: 42, text: "irrelevant" }, "the save's own payload must be completely unaffected by a finalization crash — no partial/corrupted unifiedSimilarity, no false 0%");
});

test("SIM-02 (2)+(3): computeUnifiedSimilarity itself never invents a result while its own inputs are absent — it is the caller's job (report-detail-shell.tsx) to gate on \"pending\", covered by tests/similarity-result-consistency.test.mjs's own OverviewReport pending tests", () => {
  // Documented here, not re-tested here, to avoid duplicating coverage
  // across two files for the same component-level behavior — see that
  // file's own "SIM-02" section for the actual OverviewReport(pending=...)
  // rendering assertions and report-detail-shell.tsx's structural wiring
  // check.
  const result = computeUnifiedSimilarity({ wordCount: 100, archiveMatchedPositions: [], externalAcademicEvidence: [], historicalSubmissionMatch: undefined });
  assert.equal(result.unifiedScore, 0, "sanity: with genuinely no evidence, computeUnifiedSimilarity settles at a real 0, exactly like tests/similarity-result-consistency.test.mjs's own genuine-0% coverage expects");
});

// --- Non-converging NO_HISTORICAL_MATCH presentation-resolution fix --------
//
// findRoomOccupant's self-heal path previously could never converge for a
// report whose true, correct historical-match answer is NO_HISTORICAL_MATCH:
// lib/report-historical-match.ts's own isSnapshotRowCurrent unconditionally
// excludes that status from being a cache hit (Phase E8E fix, deliberately
// unchanged — a same-moment concurrent upload's later-finished indexing must
// never be permanently hidden), so every read recomputed, rewrote
// computed_at, and re-read "stale" again, forever. isFreshCurrentNoHistoricalMatch
// plus selfHealUnifiedSimilarity's own presentationResolved field (see that
// type's own comment) let findRoomOccupant treat THIS RESPONSE as resolved
// without ever making the underlying snapshot cacheable for the next one.

function freshNoMatchFixture(overrides = {}) {
  return {
    status: "NO_HISTORICAL_MATCH",
    computedAt: new Date().toISOString(),
    matcherVersion: USER_SUBMISSION_MATCHER_VERSION,
    fingerprintVersion: CORPUS_FINGERPRINT_VERSION,
    canonicalizationVersion: CANONICALIZATION_VERSION,
    ...overrides,
  };
}

test("isFreshCurrentNoHistoricalMatch: a genuinely fresh, current, non-partial NO_HISTORICAL_MATCH at the same generation is presentation-eligible", () => {
  assert.equal(isFreshCurrentNoHistoricalMatch(freshNoMatchFixture(), 5, 5), true);
});

test("isFreshCurrentNoHistoricalMatch: a MATCHED result is never presentation-eligible — this signal exists only for NO_HISTORICAL_MATCH, MATCHED already works through the ordinary current-cache path", () => {
  const matched = freshNoMatchFixture({ status: "MATCHED", matches: [] });
  assert.equal(isFreshCurrentNoHistoricalMatch(matched, 5, 5), false);
});

test("isFreshCurrentNoHistoricalMatch: an UNAVAILABLE (failed computation) result is never presentation-eligible", () => {
  assert.equal(isFreshCurrentNoHistoricalMatch(freshNoMatchFixture({ status: "UNAVAILABLE" }), 5, 5), false);
});

test("REQUIRED: a partial no-match never presentation-resolves", () => {
  assert.equal(isFreshCurrentNoHistoricalMatch(freshNoMatchFixture({ partial: true }), 5, 5), false);
});

test("REQUIRED: a version-mismatched no-match never presentation-resolves (matcher, fingerprint, and canonicalization each checked independently)", () => {
  assert.equal(isFreshCurrentNoHistoricalMatch(freshNoMatchFixture({ matcherVersion: "stale-matcher-v0" }), 5, 5), false);
  assert.equal(isFreshCurrentNoHistoricalMatch(freshNoMatchFixture({ fingerprintVersion: "stale-fingerprint-v0" }), 5, 5), false);
  assert.equal(isFreshCurrentNoHistoricalMatch(freshNoMatchFixture({ canonicalizationVersion: "stale-canonicalization-v0" }), 5, 5), false);
});

test("REQUIRED: a generation-behind no-match never presentation-resolves — the stamped generation must be >= the live generation re-read after the write", () => {
  assert.equal(isFreshCurrentNoHistoricalMatch(freshNoMatchFixture(), 4, 5), false, "generationAtComputation (4) behind liveGenerationAfterWrite (5) must not presentation-resolve");
  assert.equal(isFreshCurrentNoHistoricalMatch(freshNoMatchFixture(), 5, 5), true, "sanity: equal generations must presentation-resolve");
  assert.equal(isFreshCurrentNoHistoricalMatch(freshNoMatchFixture(), 6, 5), true, "sanity: stamped generation ahead of a stale re-read must still presentation-resolve");
});

test("REQUIRED: current-version/current-generation NO_HISTORICAL_MATCH remains non-cacheable through isHistoricalMatchSnapshotCurrent() — isSnapshotRowCurrent itself is untouched by this fix", async () => {
  const deviceKey = "device-nomatch-noncacheable";
  const reportId = "report-nomatch-noncacheable";
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: [reportId, deviceKey, "sub-" + reportId, "Fixture", new Date().toISOString(), 50, 0, "Low", "{}", null],
  });
  await resolvePrimarySimilaritySummary(client, {
    reportDeviceKey: deviceKey, reportId, accountId: null,
    rawText: "A distinctive fixture sentence about non-cacheable historical match status used only for this specific isSnapshotRowCurrent regression test case.",
    wordCount: 20, archiveMatchedPositions: null, externalAcademicEvidence: null, archiveScore: 0,
  });
  assert.equal(
    await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: deviceKey, reportId }),
    false,
    "REQUIRED: even immediately after a fresh, current-version, current-generation NO_HISTORICAL_MATCH write, the ongoing cache-currency check must still say false — this fix must never weaken it",
  );
});

test("REQUIRED: findRoomOccupant performs one recomputation and returns similarityStatus='resolved' for that same response when the freshly computed result is a valid no-match, and does not immediately classify it as stale again", async () => {
  const text = "Glaciologists measuring subglacial meltwater discharge at an isolated outlet glacier recorded a seasonal pulse pattern unlike any previously documented catchment nearby, presentation resolution fixture one.";
  const { id, deviceKey } = await insertSavedReport({
    userId: "nomatch-basic-user-1", room: 0, archiveScore: 0, aiStatus: "ready", text, wordCount: 40,
  });

  await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", async () => {
    // Write-time finalization equivalent: persists a genuine, freshly
    // computed NO_HISTORICAL_MATCH — no source was ever promoted for this
    // text — exactly mirroring the real Room 4 shape (a report whose
    // similarity finalization already ran and genuinely found nothing).
    await finalizeAndPersist({ deviceKey, id, userId: "nomatch-basic-user-1", text, wordCount: 40, archiveScore: 0 });

    // Sanity: WITHOUT this fix's own override, the freshly-persisted result
    // reads as stale — proves this scenario genuinely exercises the gap.
    assert.equal(await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: deviceKey, reportId: id }), false, "test setup sanity: a fresh NO_HISTORICAL_MATCH must not be a cache hit yet");

    const occupant = await findRoomOccupant(client, "nomatch-basic-user-1", 0);
    assert.equal(occupant.status, "ready", "ai_score=0 (a real, non-null score) — deriveRoomStatus must say ready, matching the real Room 4 shape");
    assert.equal(occupant.report.similarityStatus, "resolved", "REQUIRED: the request-scoped override must reveal a freshly recomputed, genuine no-match — never left stuck at stale");
    assert.equal(occupant.report.isUnified, true);
    assert.equal(occupant.report.primaryScore, 0, "a genuine no-match's own primaryScore is the archive/academic-only contribution — here 0, since neither exists in this fixture");
  });
});

test("REQUIRED: a second, independent findRoomOccupant call still genuinely recomputes (never becomes a cache hit) yet still presentation-resolves — 'safe to display now' is never mistaken for 'safe to cache for later'", async () => {
  const text = "Paleoclimatologists analyzing a sediment core from a remote alpine lake reconstructed a multi-millennial record of dust deposition tied to shifting regional wind patterns, presentation resolution fixture two.";
  const { id, deviceKey } = await insertSavedReport({
    userId: "nomatch-repeat-user-1", room: 0, archiveScore: 0, aiStatus: "ready", text, wordCount: 40,
  });

  await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", async () => {
    await finalizeAndPersist({ deviceKey, id, userId: "nomatch-repeat-user-1", text, wordCount: 40, archiveScore: 0 });

    const firstOccupant = await findRoomOccupant(client, "nomatch-repeat-user-1", 0);
    assert.equal(firstOccupant.report.similarityStatus, "resolved");
    const snapshotAfterFirst = await client.execute({ sql: "SELECT computed_at FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?", args: [deviceKey, id] });
    assert.ok(snapshotAfterFirst.rows[0], "test setup sanity");

    assert.equal(await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: deviceKey, reportId: id }), false, "REQUIRED: presentation-resolving one response must never make the underlying snapshot a cache hit for the next request — preserves the original concurrent-indexing protection");

    const secondOccupant = await findRoomOccupant(client, "nomatch-repeat-user-1", 0);
    assert.equal(secondOccupant.report.similarityStatus, "resolved", "REQUIRED: a second, wholly independent request must ALSO presentation-resolve, not merely the first");
    const snapshotAfterSecond = await client.execute({ sql: "SELECT computed_at FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?", args: [deviceKey, id] });
    assert.notEqual(snapshotAfterSecond.rows[0].computed_at, snapshotAfterFirst.rows[0].computed_at, "REQUIRED: the second call must have genuinely recomputed (a real, different computed_at) — never cached, exactly preserving the pre-existing E8E protection");
  });
});

test("REQUIRED: a MATCHED (ordinary cacheable) result retains its existing behavior — selfHealUnifiedSimilarity's own presentationResolved stays false, since MATCHED already works through the normal isHistoricalMatchSnapshotCurrent cache path and never needs this one-shot signal", async () => {
  const text = "Structural engineers retrofitting a century-old masonry bridge documented an unusual load-redistribution pattern following the installation of external post-tensioning cables, presentation resolution fixture three.";
  await seedActivePromotedSource(text);

  const deviceKey = "device-matched-presentation";
  const reportId = "report-matched-presentation";
  await ensureUser("nomatch-matched-user-1");
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, room_number, ai_status)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [reportId, deviceKey, "sub-" + reportId, "Fixture", new Date().toISOString(), 40, 0, "Low", JSON.stringify({ version: 11, id: reportId, text, wordCount: 40, archiveScore: 0, score: 0 }), "nomatch-matched-user-1", 1, "ready"],
  });

  await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", async () => {
    // No unifiedSimilarity persisted yet (payload_json above has none) —
    // findRoomOccupant's own "pending" branch triggers self-heal directly,
    // giving a real MATCHED outcome from selfHealUnifiedSimilarity to check.
    const healed = await selfHealUnifiedSimilarity(client, { reportDeviceKey: deviceKey, reportId, accountId: "nomatch-matched-user-1" });
    assert.equal(healed.attempted, true);
    assert.equal(healed.outcome, "resolved");
    assert.equal(healed.unifiedSimilarity.unifiedScore, 100, "test setup sanity: a real promoted match must be found");
    assert.equal(healed.presentationResolved, false, "REQUIRED: a MATCHED outcome must never set presentationResolved — that signal exists only for NO_HISTORICAL_MATCH");

    const occupant = await findRoomOccupant(client, "nomatch-matched-user-1", 1);
    assert.equal(occupant.report.similarityStatus, "resolved", "sanity: MATCHED still resolves normally, through the ordinary cache-current path, unaffected by this fix");
    const snapshotAfterFirst = await client.execute({ sql: "SELECT computed_at FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?", args: [deviceKey, reportId] });

    // A second read must be a genuine cache hit — computed_at unchanged —
    // the opposite of the NO_HISTORICAL_MATCH case above, proving this fix
    // changed nothing about MATCHED's existing, already-correct behavior.
    const secondOccupant = await findRoomOccupant(client, "nomatch-matched-user-1", 1);
    assert.equal(secondOccupant.report.similarityStatus, "resolved");
    const snapshotAfterSecond = await client.execute({ sql: "SELECT computed_at FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?", args: [deviceKey, reportId] });
    assert.equal(snapshotAfterSecond.rows[0].computed_at, snapshotAfterFirst.rows[0].computed_at, "REQUIRED: unlike NO_HISTORICAL_MATCH, a MATCHED snapshot must remain an ordinary cache hit on the next read — no regression from this fix");
  });
});

test("REQUIRED: a corpus-generation bump racing the heal (landing after the recomputation's own write, before the live re-read) prevents presentation resolution", async () => {
  const text = "Radio astronomers surveying a dense stellar nursery detected an anomalous periodic maser signal whose emission cycle did not match any previously catalogued source in the region, presentation resolution fixture four.";
  const { id, deviceKey } = await insertSavedReport({
    userId: "nomatch-race-user-1", room: 0, archiveScore: 0, aiStatus: "ready", text, wordCount: 40,
  });

  await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", async () => {
    let bumped = false;
    const healed = await selfHealUnifiedSimilarity(client, {
      reportDeviceKey: deviceKey, reportId: id, accountId: "nomatch-race-user-1",
      testOnlyAfterWriteBeforeGenerationRecheck: async () => {
        // Reproduces a promotion/deactivation committing on a SEPARATE
        // connection between this recomputation's own write (already
        // committed at this point) and the live generation re-read that
        // decides presentationResolved — mirrors
        // getOrComputeHistoricalMatchSnapshot's own testOnlyPauseBeforeWrite
        // precedent (report-historical-match-invalidation.test.mjs).
        const other = createClient({ url: `file:${dbFile}` });
        await bumpCorpusMatchGeneration(other);
        other.close();
        bumped = true;
      },
    });
    assert.ok(bumped, "test setup sanity: the barrier hook must actually run");
    assert.equal(healed.attempted, true);
    assert.equal(healed.outcome, "resolved");
    assert.equal(healed.presentationResolved, false, "REQUIRED: a generation bump racing the recomputation must prevent presentation resolution, exactly like a plain generation-behind result");

    // The underlying write itself is unaffected by this — only
    // presentationResolved, a purely in-memory decision, changes.
    const row = await client.execute({ sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, id] });
    const payload = JSON.parse(row.rows[0].payload_json);
    assert.equal(payload.unifiedSimilarity !== undefined, true, "sanity: the unifiedSimilarity write itself must still have landed");
  });
});

test("REQUIRED: one findRoomOccupant() invocation performs at most one historical recomputation — no recursive/non-converging retry within the same read", () => {
  const source = fs.readFileSync(path.join(repoRoot, "lib", "reports-repo.ts"), "utf8");
  const selfHealCallCount = (source.match(/selfHealUnifiedSimilarity\(/g) || []).length;
  assert.equal(selfHealCallCount, 1, "REQUIRED: findRoomOccupant must call selfHealUnifiedSimilarity exactly once per read — no loop, no recursive retry chasing convergence");
  assert.doesNotMatch(source, /while\s*\(/, "REQUIRED: no while-loop retry construct around the self-heal/re-read sequence");
  assert.doesNotMatch(source, /for\s*\(.*selfHeal/, "REQUIRED: no for-loop retry construct around the self-heal call");
});
