import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { getOrComputeHistoricalMatchSnapshot } from "../lib/report-historical-match.ts";
// SNAPSHOT_MATCHER_VERSION (base matcher label + candidate-discovery config
// digest) is the exact value CURRENT_VERSIONS.matcherVersion holds, so a row
// inserted with it takes the cache-hit path rather than a fresh recompute —
// which is what every test here relies on (see this file's own header
// comment). Imported directly to avoid hardcoding a version string that
// could silently drift.
import { SNAPSHOT_MATCHER_VERSION } from "../lib/report-historical-match.ts";
const USER_SUBMISSION_MATCHER_VERSION = SNAPSHOT_MATCHER_VERSION;
import { CORPUS_FINGERPRINT_VERSION, CANONICALIZATION_VERSION } from "../lib/user-submission-corpus.ts";

/**
 * "Clearing the flag must immediately hide cached corpus matches" — proves
 * this is a READ-TIME filter (getOrComputeHistoricalMatchSnapshot's own
 * applyCorpusSourceMatchingFlag), never a database mutation: a snapshot row
 * computed/cached while CORPUS_SOURCE_MATCHING_ENABLED was "true" is
 * inspected with the flag off, on, and off again, and the STORED row is
 * asserted byte-identical throughout — only what the function RETURNS
 * changes. Mirrors lib/e8p-visibility.ts's own "no code change, no matcher
 * change, no database change" rollback story. Every fixture is synthetic.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_report_historical_match_flag_rollback.db");
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

function withEnv(name, value, fn) {
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return Promise.resolve(fn()).finally(() => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  });
}

async function rawSnapshotRow(reportDeviceKey, reportId) {
  const result = await client.execute({
    sql: "SELECT status, result_json FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?",
    args: [reportDeviceKey, reportId],
  });
  return result.rows[0];
}

// Version constants above matched to lib/report-historical-match.ts's own
// CURRENT_VERSIONS so the cache-hit path (not a fresh recompute) is what's
// under test — imported directly to avoid hardcoding version strings that
// could silently drift.
async function insertOnlyCorpusSourceSnapshot(reportDeviceKey, reportId) {
  const resultJson = JSON.stringify([
    {
      relationshipType: "TURNITPLUS_CORPUS_SOURCE",
      matchedRepresentationId: "rep-corpus-source-only",
      matchType: "EXACT_CANONICAL_MATCH",
      containment: 1,
      matchedWordCount: 50,
      passageCount: 1,
      longestMatchWords: 50,
      passages: [{ submittedText: "excerpt", submittedWordStart: 0, submittedWordEnd: 50, matchedWordCount: 50 }],
      historicalSubmissionCount: 0,
    },
  ]);
  await client.execute({
    sql: `INSERT INTO report_historical_match_snapshots
          (report_device_key, report_id, status, matcher_version, fingerprint_version, canonicalization_version, result_json, candidate_count, processing_duration_ms, error_message, computed_at, is_partial, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [reportDeviceKey, reportId, "MATCHED", USER_SUBMISSION_MATCHER_VERSION, CORPUS_FINGERPRINT_VERSION, CANONICALIZATION_VERSION, resultJson, 1, 10, null, new Date().toISOString(), 0],
  });
}

async function insertMixedSnapshot(reportDeviceKey, reportId) {
  const resultJson = JSON.stringify([
    {
      relationshipType: "PRIOR_SUBMISSION",
      matchedRepresentationId: "rep-real-submission",
      matchType: "STRONG_TEXT_MATCH",
      containment: 0.7,
      matchedWordCount: 40,
      passageCount: 1,
      longestMatchWords: 40,
      passages: [{ submittedText: "real excerpt", submittedWordStart: 0, submittedWordEnd: 40, matchedWordCount: 40 }],
      historicalSubmissionCount: 1,
    },
    {
      relationshipType: "TURNITPLUS_CORPUS_SOURCE",
      matchedRepresentationId: "rep-corpus-source-mixed",
      matchType: "EXACT_CANONICAL_MATCH",
      containment: 1,
      matchedWordCount: 50,
      passageCount: 1,
      longestMatchWords: 50,
      passages: [{ submittedText: "corpus excerpt", submittedWordStart: 0, submittedWordEnd: 50, matchedWordCount: 50 }],
      historicalSubmissionCount: 0,
    },
  ]);
  await client.execute({
    sql: `INSERT INTO report_historical_match_snapshots
          (report_device_key, report_id, status, matcher_version, fingerprint_version, canonicalization_version, result_json, candidate_count, processing_duration_ms, error_message, computed_at, is_partial, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [reportDeviceKey, reportId, "MATCHED", USER_SUBMISSION_MATCHER_VERSION, CORPUS_FINGERPRINT_VERSION, CANONICALIZATION_VERSION, resultJson, 2, 10, null, new Date().toISOString(), 0],
  });
}

test("FLAG-OFF ROLLBACK: a cached snapshot whose ONLY entry is TURNITPLUS_CORPUS_SOURCE reads as NO_HISTORICAL_MATCH with the flag off, MATCHED with it on — same stored row throughout", async () => {
  const reportDeviceKey = "flag-rollback-device-1";
  const reportId = "flag-rollback-report-1";
  await insertOnlyCorpusSourceSnapshot(reportDeviceKey, reportId);

  const off1 = await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", undefined, () =>
    getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey, reportId, accountId: null, rawText: "irrelevant on a cache hit" }));
  assert.equal(off1.status, "NO_HISTORICAL_MATCH", "the only entry was corpus-source; stripping it must drop status to NO_HISTORICAL_MATCH, not an empty MATCHED array");

  const on = await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", () =>
    getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey, reportId, accountId: null, rawText: "irrelevant on a cache hit" }));
  assert.equal(on.status, "MATCHED");
  assert.equal(on.matches.length, 1);
  assert.equal(on.matches[0].relationshipType, "TURNITPLUS_CORPUS_SOURCE");

  const off2 = await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", undefined, () =>
    getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey, reportId, accountId: null, rawText: "irrelevant on a cache hit" }));
  assert.equal(off2.status, "NO_HISTORICAL_MATCH");

  // The stored row itself must never have been touched by any of the three
  // reads above — toggling the flag is purely a read-time filter.
  const stored = await rawSnapshotRow(reportDeviceKey, reportId);
  assert.equal(stored.status, "MATCHED");
  assert.equal(JSON.parse(stored.result_json).length, 1);
  assert.equal(JSON.parse(stored.result_json)[0].relationshipType, "TURNITPLUS_CORPUS_SOURCE");
});

test("FLAG-OFF ROLLBACK: a mixed snapshot keeps its real PRIOR_SUBMISSION entry and only strips the corpus-source one", async () => {
  const reportDeviceKey = "flag-rollback-device-2";
  const reportId = "flag-rollback-report-2";
  await insertMixedSnapshot(reportDeviceKey, reportId);

  const off = await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", undefined, () =>
    getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey, reportId, accountId: null, rawText: "irrelevant on a cache hit" }));
  assert.equal(off.status, "MATCHED", "the real PRIOR_SUBMISSION entry must still be shown even with the flag off");
  assert.equal(off.matches.length, 1);
  assert.equal(off.matches[0].relationshipType, "PRIOR_SUBMISSION");

  const on = await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", () =>
    getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey, reportId, accountId: null, rawText: "irrelevant on a cache hit" }));
  assert.equal(on.matches.length, 2);

  const stored = await rawSnapshotRow(reportDeviceKey, reportId);
  assert.equal(JSON.parse(stored.result_json).length, 2, "the stored row must always keep both entries regardless of what any read returned");
});

// A richer 4-entry mixed snapshot (SELF, PRIOR_SUBMISSION, and TWO distinct
// TURNITPLUS_CORPUS_SOURCE entries) with every field given a distinct,
// checkable value — proves the filter doesn't just get matches.length right
// by accident, but that every surviving entry's own fields (containment,
// matchedWordCount, passageCount, longestMatchWords, historicalSubmissionCount,
// passages) survive completely untouched, in original order, with nothing
// shifted, merged, or recalculated.
const RICH_SELF_ENTRY = {
  relationshipType: "SELF",
  matchedRepresentationId: "rep-self",
  matchType: "EXACT_CANONICAL_MATCH",
  containment: 1,
  matchedWordCount: 120,
  passageCount: 2,
  longestMatchWords: 80,
  passages: [
    { submittedText: "self excerpt one", submittedWordStart: 0, submittedWordEnd: 80, matchedWordCount: 80 },
    { submittedText: "self excerpt two", submittedWordStart: 90, submittedWordEnd: 130, matchedWordCount: 40 },
  ],
  historicalSubmissionCount: 0,
};
const RICH_PRIOR_ENTRY = {
  relationshipType: "PRIOR_SUBMISSION",
  matchedRepresentationId: "rep-prior",
  matchType: "STRONG_TEXT_MATCH",
  containment: 0.62,
  matchedWordCount: 45,
  passageCount: 1,
  longestMatchWords: 45,
  passages: [{ submittedText: "prior excerpt", submittedWordStart: 200, submittedWordEnd: 245, matchedWordCount: 45 }],
  historicalSubmissionCount: 3,
};
const RICH_CORPUS_ENTRY_1 = {
  relationshipType: "TURNITPLUS_CORPUS_SOURCE",
  matchedRepresentationId: "rep-corpus-1",
  matchType: "EXACT_CANONICAL_MATCH",
  containment: 1,
  matchedWordCount: 55,
  passageCount: 1,
  longestMatchWords: 55,
  passages: [{ submittedText: "corpus excerpt one", submittedWordStart: 300, submittedWordEnd: 355, matchedWordCount: 55 }],
  historicalSubmissionCount: 0,
};
const RICH_CORPUS_ENTRY_2 = {
  relationshipType: "TURNITPLUS_CORPUS_SOURCE",
  matchedRepresentationId: "rep-corpus-2",
  matchType: "STRONG_TEXT_MATCH",
  containment: 0.51,
  matchedWordCount: 20,
  passageCount: 1,
  longestMatchWords: 20,
  passages: [{ submittedText: "corpus excerpt two", submittedWordStart: 400, submittedWordEnd: 420, matchedWordCount: 20 }],
  historicalSubmissionCount: 0,
};

async function insertRichMixedSnapshot(reportDeviceKey, reportId) {
  const resultJson = JSON.stringify([RICH_SELF_ENTRY, RICH_CORPUS_ENTRY_1, RICH_PRIOR_ENTRY, RICH_CORPUS_ENTRY_2]);
  await client.execute({
    sql: `INSERT INTO report_historical_match_snapshots
          (report_device_key, report_id, status, matcher_version, fingerprint_version, canonicalization_version, result_json, candidate_count, processing_duration_ms, error_message, computed_at, is_partial, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [reportDeviceKey, reportId, "MATCHED", USER_SUBMISSION_MATCHER_VERSION, CORPUS_FINGERPRINT_VERSION, CANONICALIZATION_VERSION, resultJson, 4, 10, null, "2026-01-01T00:00:00.000Z", 0],
  });
}

test("RECOMPUTED COUNTS: a rich 4-entry mixed snapshot strips exactly the two corpus-source entries, and the two survivors are byte-identical to what was stored — nothing shifted, merged, or recalculated", async () => {
  const reportDeviceKey = "flag-rollback-device-3";
  const reportId = "flag-rollback-report-3";
  await insertRichMixedSnapshot(reportDeviceKey, reportId);

  const off = await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", undefined, () =>
    getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey, reportId, accountId: null, rawText: "irrelevant on a cache hit" }));

  assert.equal(off.status, "MATCHED");
  assert.equal(off.matches.length, 2, "exactly the two real entries must remain — both corpus-source entries stripped, not just one");
  // Original relative order preserved (SELF then PRIOR_SUBMISSION, matching
  // their order in the stored array once the two corpus entries between/
  // after them are removed) — proves this is a filter, not a rebuild.
  assert.deepEqual(off.matches[0], RICH_SELF_ENTRY);
  assert.deepEqual(off.matches[1], RICH_PRIOR_ENTRY);

  // Top-level fields describe the COMPUTATION, not the entry count — must
  // be completely unaffected by which entries got filtered.
  assert.equal(off.computedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(off.matcherVersion, USER_SUBMISSION_MATCHER_VERSION);
  assert.equal(off.fingerprintVersion, CORPUS_FINGERPRINT_VERSION);
  assert.equal(off.canonicalizationVersion, CANONICALIZATION_VERSION);

  const on = await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", "true", () =>
    getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey, reportId, accountId: null, rawText: "irrelevant on a cache hit" }));
  assert.equal(on.matches.length, 4, "with the flag on, all four original entries must reappear, in original order");
  assert.deepEqual(on.matches, [RICH_SELF_ENTRY, RICH_CORPUS_ENTRY_1, RICH_PRIOR_ENTRY, RICH_CORPUS_ENTRY_2]);
});

test("RECOMPUTED STATUS: a corpus-only match becomes a clean NO_HISTORICAL_MATCH with no stray matches key, and stays that way on repeated reads", async () => {
  const reportDeviceKey = "flag-rollback-device-4";
  const reportId = "flag-rollback-report-4";
  const resultJson = JSON.stringify([RICH_CORPUS_ENTRY_1]);
  await client.execute({
    sql: `INSERT INTO report_historical_match_snapshots
          (report_device_key, report_id, status, matcher_version, fingerprint_version, canonicalization_version, result_json, candidate_count, processing_duration_ms, error_message, computed_at, is_partial, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [reportDeviceKey, reportId, "MATCHED", USER_SUBMISSION_MATCHER_VERSION, CORPUS_FINGERPRINT_VERSION, CANONICALIZATION_VERSION, resultJson, 1, 10, null, "2026-01-01T00:00:00.000Z", 0],
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const off = await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", undefined, () =>
      getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey, reportId, accountId: null, rawText: "irrelevant on a cache hit" }));
    assert.equal(off.status, "NO_HISTORICAL_MATCH");
    assert.ok(!("matches" in off), "a NO_HISTORICAL_MATCH result must never carry a matches key, empty or otherwise");
    assert.equal(off.computedAt, "2026-01-01T00:00:00.000Z", "the recomputed status must still come from the ORIGINAL cached row (a cache hit), not trigger a fresh live computation");
  }
});
