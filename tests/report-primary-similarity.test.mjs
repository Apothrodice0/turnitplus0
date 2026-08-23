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
import { bumpCorpusMatchGeneration } from "../lib/report-historical-match.ts";
import { resolvePrimarySimilaritySummary } from "../lib/report-primary-similarity.ts";
import { findRoomOccupant } from "../lib/reports-repo.ts";
import { computeUnifiedSimilarity } from "../lib/unified-similarity.ts";

/**
 * Release-hardening audit finding SIM-02: regression coverage for the
 * room-card/report-detail loading inconsistency — a real room permanently
 * showed 0% (lib/reports-repo.ts's findRoomOccupant had no access to the
 * unified/combined result at all, only the persisted archive_score column),
 * while opening the same report showed a 0%-then-100% flash (the detail
 * page's server-rendered initial payload is deliberately fast/unenriched —
 * see app/reports/[id]/page.tsx's own comment — so its first client render
 * always fell back to primarySimilarityScore's archive-only value before the
 * background enrichment fetch resolved). This file covers the new shared
 * server-side resolver (lib/report-primary-similarity.ts) directly, and
 * findRoomOccupant's own use of it — both against a real DB, a real
 * promoted corpus source, and the real report_historical_match_snapshots
 * cache (never a second/duplicate matching implementation).
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

// Deliberately unrelated topics per test — matchAgainstUserSubmissionCorpus
// does a real global shingle search across everything in this file's shared
// DB, so overlapping fixtures would cross-contaminate each other's results.
const TEXT_ROOM_CARD = "Paleobotanists studying fossilized pollen grains from a lakebed core reconstructed a detailed record of vegetation change across four glacial cycles in the region.";
const TEXT_FLAG_OFF = "Seismologists deploying a dense array of ocean-bottom sensors mapped a previously unknown fault segment running parallel to the main subduction zone offshore.";
const TEXT_AGREEMENT = "Mycologists cataloguing fungal diversity in an old-growth temperate rainforest identified several species new to the region using both morphological and genetic sequencing methods.";
const TEXT_CACHE_REUSE = "Climatologists analyzing tree-ring width variations across a network of high-elevation sites derived a multi-century reconstruction of regional drought severity.";

test("SIM-02 (1): room card resolves the combined score — archive_score=0, genuine corpus-source match=100%, matching the real observed bug", async () => {
  await seedActivePromotedSource(TEXT_ROOM_CARD);
  const { id, deviceKey } = await insertSavedReport({
    userId: "sim02-room-user-1", room: 0, archiveScore: 0, aiStatus: "ready", text: TEXT_ROOM_CARD, wordCount: 100,
  });

  const occupant = await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", () => findRoomOccupant(client, "sim02-room-user-1", 0));

  assert.equal(occupant.status, "ready");
  assert.equal(occupant.report.archiveScore, 0, "the persisted archive_score column must stay exactly what was saved");
  assert.equal(occupant.report.primaryScore, 100, "the room card must show the resolved combined score, not the archive-only 0%");
  assert.equal(occupant.report.isUnified, true);
  void id; void deviceKey;
});

test("SIM-02 (4): flag-off mode uses archive-only values, even with a real corpus source that would otherwise match", async () => {
  await seedActivePromotedSource(TEXT_FLAG_OFF);
  // archiveScore/archiveMatchedPositions deliberately agree at "nothing" —
  // this report's only possible source of a non-zero score is the promoted
  // corpus source seeded above, so a flag-off score of exactly 0 proves
  // that contribution never reached the result; with the flag on (see the
  // sibling assertion below), the identical report resolves to 100.
  const { id, deviceKey } = await insertSavedReport({
    userId: "sim02-flagoff-user-1", room: 0, archiveScore: 0, aiStatus: "ready", text: TEXT_FLAG_OFF, wordCount: 100,
  });

  const resolutionFlagOff = await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "false", () =>
    resolvePrimarySimilaritySummary(client, {
      reportDeviceKey: deviceKey, reportId: id, accountId: "sim02-flagoff-user-1", rawText: TEXT_FLAG_OFF,
      wordCount: 100, archiveMatchedPositions: null, externalAcademicEvidence: null, archiveScore: 0,
    }));
  assert.equal(resolutionFlagOff.primaryScore, 0, "with the flag off, the corpus-source contribution must never reach the resolved score");

  const occupant = await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "false", () => findRoomOccupant(client, "sim02-flagoff-user-1", 0));
  assert.equal(occupant.report.primaryScore, 0, "the room card must agree — archive-only value, flag off");

  // Sanity: the SAME report, SAME snapshot cache, with the flag on — proves
  // this test's setup genuinely has a real corpus match available, so the
  // 0 above is a real "flag correctly suppressed it," not an accident of a
  // broken fixture.
  const resolutionFlagOn = await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", () =>
    resolvePrimarySimilaritySummary(client, {
      reportDeviceKey: deviceKey, reportId: id, accountId: "sim02-flagoff-user-1", rawText: TEXT_FLAG_OFF,
      wordCount: 100, archiveMatchedPositions: null, externalAcademicEvidence: null, archiveScore: 0,
    }));
  assert.equal(resolutionFlagOn.primaryScore, 100, "sanity: with the flag on, the same real corpus match resolves to 100 — confirms the flag-off 0 above was not just a fixture accident");
});

test("SIM-02 (5): a genuine computeUnifiedSimilarity failure produces an explicit archive fallback, never an undefined/thrown result", async () => {
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
  // historicalSubmissionMatch is still resolved normally — only the
  // unified-arithmetic step failed, not the (separate, already-defensive)
  // snapshot lookup.
  assert.ok(resolution.historicalSubmissionMatch);
});

test("SIM-02 (6): room and detail agree, before and after a corpus-eligibility change recomputes the resolved score", async () => {
  const { id, deviceKey } = await insertSavedReport({
    userId: "sim02-agree-user-1", room: 0, archiveScore: 0, aiStatus: "ready", text: TEXT_AGREEMENT, wordCount: 100,
  });

  await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", async () => {
    const beforeRoom = await findRoomOccupant(client, "sim02-agree-user-1", 0);
    const beforeDetail = await resolvePrimarySimilaritySummary(client, {
      reportDeviceKey: deviceKey, reportId: id, accountId: "sim02-agree-user-1", rawText: TEXT_AGREEMENT,
      wordCount: 100, archiveMatchedPositions: null, externalAcademicEvidence: null, archiveScore: 0,
    });
    assert.equal(beforeRoom.report.primaryScore, beforeDetail.primaryScore, "room and detail must agree before any corpus change");
    assert.equal(beforeRoom.report.primaryScore, 0, "sanity: no source promoted yet, nothing to match");

    // A source matching this exact report's text is promoted AFTER both
    // reads above — the real "a report is viewed before another account's
    // upload finishes indexing" ordering this codebase already documents
    // (see lib/report-historical-match.ts's own Phase E8E comment).
    await seedActivePromotedSource(TEXT_AGREEMENT);

    const afterRoom = await findRoomOccupant(client, "sim02-agree-user-1", 0);
    const afterDetail = await resolvePrimarySimilaritySummary(client, {
      reportDeviceKey: deviceKey, reportId: id, accountId: "sim02-agree-user-1", rawText: TEXT_AGREEMENT,
      wordCount: 100, archiveMatchedPositions: null, externalAcademicEvidence: null, archiveScore: 0,
    });
    assert.equal(afterRoom.report.primaryScore, afterDetail.primaryScore, "room and detail must still agree after recomputation");
    assert.equal(afterRoom.report.primaryScore, 100, "both must reflect the newly promoted match — NO_HISTORICAL_MATCH is never treated as final, exactly like every other report view");
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

test("SIM-02 (8): the room card's resolved summary never exposes an account id, decision id, or representation id — only numbers and a boolean", async () => {
  await seedActivePromotedSource("Herpetologists radio-tracking a population of forest salamanders documented unexpectedly long-distance dispersal between adjacent watershed populations.");
  const { id: reportId } = await insertSavedReport({
    userId: "sim02-privacy-user-1", room: 0, archiveScore: 0, aiStatus: "ready",
    text: "Herpetologists radio-tracking a population of forest salamanders documented unexpectedly long-distance dispersal between adjacent watershed populations.",
    wordCount: 100,
  });

  const occupant = await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", () => findRoomOccupant(client, "sim02-privacy-user-1", 0));
  assert.equal(occupant.report.primaryScore, 100, "test setup sanity");

  const serialized = JSON.stringify(occupant.report);
  assert.doesNotMatch(serialized, /@/, "no email-shaped string may appear in a room summary");
  assert.doesNotMatch(serialized, /sim02-privacy-user-1/, "the viewing account's own raw id must never appear in what is sent to the client");
  assert.equal(Object.keys(occupant.report).sort().join(","), "aiScore,aiTone,archiveScore,createdAt,id,isUnified,primaryScore,scoreBand,submissionId,title,wordCount", "the room summary shape must stay exactly this — no representation/decision/account id field ever added");
  void reportId;
});

// --- Rendering: never a transient archive-only number while pending --------

test("SIM-02 (2)+(3): computeUnifiedSimilarity itself never invents a result while its own inputs are absent — it is the caller's job (report-detail-shell.tsx) to gate on \"pending\", covered by tests/similarity-result-consistency.test.mjs's own OverviewReport pending tests", () => {
  // Documented here, not re-tested here, to avoid duplicating coverage
  // across two files for the same component-level behavior — see that
  // file's own "SIM-02" section for the actual OverviewReport(pending=...)
  // rendering assertions and report-detail-shell.tsx's structural wiring
  // check.
  const result = computeUnifiedSimilarity({ wordCount: 100, archiveMatchedPositions: [], externalAcademicEvidence: [], historicalSubmissionMatch: undefined });
  assert.equal(result.unifiedScore, 0, "sanity: with genuinely no evidence, computeUnifiedSimilarity settles at a real 0, exactly like tests/similarity-result-consistency.test.mjs's own genuine-0% coverage expects");
});
