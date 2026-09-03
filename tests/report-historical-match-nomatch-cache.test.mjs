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
import { matureCorpusBackings } from "./helpers/corpus-maturity.mjs";
import {
  getOrComputeHistoricalMatchSnapshot,
  getCurrentCorpusMatchGeneration,
  bumpCorpusMatchGeneration,
  isHistoricalMatchSnapshotCurrent,
  SNAPSHOT_MATCHER_VERSION,
} from "../lib/report-historical-match.ts";

/**
 * CACHE LEGITIMATE NO_HISTORICAL_MATCH RESULTS — dedicated coverage for
 * making a COMPLETE, DEFINITIVE, CURRENT no-match reusable exactly like a
 * MATCHED one, and proving every indeterminate variant (partial, timeout,
 * DB failure, feature-disabled, stale generation, stale version) is NOT.
 *
 * All fixtures synthetic. CORPUS_SOURCE_MATCHING_ENABLED is set on for this
 * file, since no-match caching is deliberately inert while it is off (a
 * flag-off no-match is an incomplete evaluation — see
 * lib/report-historical-match.ts's own header comment). One test flips it
 * off explicitly to prove the feature-disabled path.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_report_historical_match_nomatch_cache.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

const originalFlag = process.env.CORPUS_SOURCE_MATCHING_ENABLED;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";

const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);
const openConnection = () => createClient({ url: `file:${dbFile}` });

test.after(() => {
  client.close();
  if (originalFlag === undefined) delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  else process.env.CORPUS_SOURCE_MATCHING_ENABLED = originalFlag;
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
async function indexSubmission(accountId, rawText) {
  await ensureUser(accountId);
  const identity = await createDocumentIdentity(client, { accountId, title: "T", author: null, rawText });
  const _r = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  await matureCorpusBackings(client); // Phase A: age the seeded backing so it is matchable "now"
  return _r;
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
      id, null, `nomatch-cache-test-${randomUUID()}`, "v1", "ACCEPT", "[]", 1, "[]",
      "txt", 50, "English", 0.95, hash, "v1", null, 80, "v1",
      "{}", "{}", "v1", 0.9, "v1", "NONE", null, null,
      JSON.stringify({ kind: "PER_USER_CONSENT", consented: true }), 0,
    ],
  });
  return id;
}
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
  await matureCorpusBackings(client); // Phase A: age the promoted backing so it is matchable "now" (this suite tests no-match caching, not the 7-day gate)
  const sweep = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  const outcome = sweep.results.find((r) => r.decisionId === decisionId);
  assert.equal(outcome?.outcome, "indexed", "test setup sanity: promotion must succeed");
  return outcome.representationId;
}

let reportSeq = 0;
async function ensureSavedReport(accountId) {
  reportSeq += 1;
  const deviceKey = `nomatch-cache-device-${reportSeq}`;
  const reportId = `nomatch-cache-report-${reportSeq}`;
  await ensureUser(accountId);
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: [reportId, deviceKey, "sub-" + reportId, "Fixture", new Date().toISOString(), 60, 0, "Low", "{}", accountId],
  });
  return { deviceKey, reportId };
}

async function snapshotRow(deviceKey, reportId) {
  const r = await client.execute({
    sql: "SELECT status, matcher_version, is_partial, corpus_generation, computed_at, processing_duration_ms FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?",
    args: [deviceKey, reportId],
  });
  return r.rows[0];
}

/**
 * A client proxy that counts every candidate-DISCOVERY query
 * (findCandidateCorpusRepresentations joins corpus_document_shingles). A
 * cache hit performs zero of these; a genuine recompute performs at least
 * one. This is the "expensive matching work was skipped" proof the task
 * requires — a real spy on the query, not a JSON comparison.
 */
function discoverySpyClient(realClient) {
  let discoveryQueries = 0;
  const looksLikeDiscovery = (sql) => typeof sql === "string" && /corpus_document_shingles/i.test(sql);
  return {
    client: {
      execute: (arg) => {
        const sql = typeof arg === "string" ? arg : arg?.sql;
        if (looksLikeDiscovery(sql)) discoveryQueries += 1;
        return realClient.execute(arg);
      },
      batch: (stmts, mode) => {
        for (const s of stmts) if (looksLikeDiscovery(typeof s === "string" ? s : s?.sql)) discoveryQueries += 1;
        return realClient.batch(stmts, mode);
      },
      transaction: (...a) => realClient.transaction(...a),
    },
    get discoveryQueries() { return discoveryQueries; },
  };
}

const LONE_TEXT_A =
  "Geochemists analysing basalt cores from an intraplate seamount chain identified a distinctive isotopic gradient that constrains the mantle plume's temperature history over roughly twelve million years of activity.";
const LONE_TEXT_B =
  "Acousticians studying the courtship calls of a nocturnal tree frog population documented a previously unreported frequency-hopping pattern that appears to reduce acoustic interference between neighbouring calling males.";

// ---------------------------------------------------------------------------
// 1 + 2 + 3 + 12: first no-match computes, second call reuses, discovery not
// re-run, and a MATCHED snapshot keeps its identical reuse behaviour.
// ---------------------------------------------------------------------------

test("1/2/3: a first definitive no-match computes and persists; an identical second call is a pure cache hit that never re-runs candidate discovery", async () => {
  const { deviceKey, reportId } = await ensureSavedReport("nomatch-cache-viewer-1");
  // A promoted source that shares NOTHING with the query — real discovery
  // work runs on the first call, finds no candidate, and settles NO_HISTORICAL_MATCH.
  await seedActivePromotedSource(
    "Entirely unrelated promoted fixture about municipal water treatment membrane fouling rates, present only so candidate discovery has a non-empty shingle table to scan.",
  );

  const spy = discoverySpyClient(client);
  const first = await getOrComputeHistoricalMatchSnapshot(spy.client, { reportDeviceKey: deviceKey, reportId, accountId: "nomatch-cache-viewer-1", rawText: LONE_TEXT_A });
  assert.equal(first.status, "NO_HISTORICAL_MATCH");
  const rowAfterFirst = await snapshotRow(deviceKey, reportId);
  assert.equal(rowAfterFirst.status, "NO_HISTORICAL_MATCH", "the reusable, feature-enabled no-match marker");
  assert.equal(Number(rowAfterFirst.is_partial), 0);
  assert.ok(spy.discoveryQueries >= 1, "the first call genuinely ran candidate discovery");
  const discoveryAfterFirst = spy.discoveryQueries;

  const second = await getOrComputeHistoricalMatchSnapshot(spy.client, { reportDeviceKey: deviceKey, reportId, accountId: "nomatch-cache-viewer-1", rawText: LONE_TEXT_A });
  assert.equal(second.status, "NO_HISTORICAL_MATCH");
  assert.equal(second.computedAt, first.computedAt, "the second call returned the SAME snapshot, not a recompute");

  const rowAfterSecond = await snapshotRow(deviceKey, reportId);
  assert.equal(rowAfterSecond.computed_at, rowAfterFirst.computed_at, "the snapshot row was not rewritten");
  assert.equal(rowAfterSecond.processing_duration_ms, rowAfterFirst.processing_duration_ms, "no fresh processing timing was recorded");
  assert.equal(spy.discoveryQueries, discoveryAfterFirst, "REQUIRED: candidate discovery was NOT executed a second time — the expensive matching work was skipped");

  assert.equal(await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: deviceKey, reportId }), true, "the definitive no-match reads as a current cache hit");
});

test("12: a MATCHED snapshot's reuse behaviour is unchanged — still a cache hit that never re-runs discovery", async () => {
  const text =
    "Structural geologists mapping a reactivated basement fault beneath a sedimentary basin traced offset marker horizons that record at least three discrete slip events since the early Miocene.";
  await seedActivePromotedSource(text);
  const { deviceKey, reportId } = await ensureSavedReport("nomatch-cache-matched-viewer");

  const spy = discoverySpyClient(client);
  const first = await getOrComputeHistoricalMatchSnapshot(spy.client, { reportDeviceKey: deviceKey, reportId, accountId: "nomatch-cache-matched-viewer", rawText: text });
  assert.equal(first.status, "MATCHED");
  const discoveryAfterFirst = spy.discoveryQueries;
  assert.ok(discoveryAfterFirst >= 1);

  const second = await getOrComputeHistoricalMatchSnapshot(spy.client, { reportDeviceKey: deviceKey, reportId, accountId: "nomatch-cache-matched-viewer", rawText: text });
  assert.equal(second.status, "MATCHED");
  assert.equal(second.computedAt, first.computedAt);
  assert.equal(spy.discoveryQueries, discoveryAfterFirst, "a MATCHED cache hit also skips discovery — no regression");
});

// ---------------------------------------------------------------------------
// 4 + 5: corpus-generation invalidation, and the essential test — a cached
// no-match becomes MATCHED once a real source is added and the generation
// increments.
// ---------------------------------------------------------------------------

test("4/5 (ESSENTIAL): a cached no-match is recomputed after the corpus generation increments, and becomes MATCHED when the newly-promoted source actually matches it", async () => {
  const { deviceKey, reportId } = await ensureSavedReport("nomatch-cache-viewer-5");
  const text =
    "Palaeobotanists examining a Carboniferous coal-ball assemblage described an unusually well-preserved arborescent lycophyte cone with in-situ megaspores that clarifies the group's reproductive biology.";

  const before = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: "nomatch-cache-viewer-5", rawText: text });
  assert.equal(before.status, "NO_HISTORICAL_MATCH");
  const genBefore = Number((await snapshotRow(deviceKey, reportId)).corpus_generation);

  // A source matching this exact text is promoted AFTER the no-match was
  // cached — the real "viewed before another account's upload finished
  // indexing" ordering. The promotion sweep bumps corpus_match_generation.
  const promotedRepresentationId = await seedActivePromotedSource(text);
  const genAfter = await getCurrentCorpusMatchGeneration(client);
  assert.ok(genAfter > genBefore, "the promotion must have bumped the generation past what the cached row was stamped with");
  assert.equal(await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: deviceKey, reportId }), false, "the stale-generation no-match is no longer a cache hit");

  const after = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: "nomatch-cache-viewer-5", rawText: text });
  assert.equal(after.status, "MATCHED", "REQUIRED: the previously-cached no-match recomputed and became MATCHED");
  assert.equal(after.matches[0].matchedRepresentationId, promotedRepresentationId);
  assert.equal(after.matches[0].relationshipType, "TURNITPLUS_CORPUS_SOURCE");
});

test("5b: a cached no-match becomes MATCHED after ANOTHER account's submission is indexed — indexDocumentSubmissionIntoCorpus bumps the generation too", async () => {
  const { deviceKey, reportId } = await ensureSavedReport("nomatch-cache-viewer-5b");
  const text =
    "Limnologists tracking dissolved organic carbon export from a boreal headwater catchment recorded a threefold storm-flow pulse whose spectral signature points to a shallow riparian flow path.";

  const before = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: "nomatch-cache-viewer-5b", rawText: text });
  assert.equal(before.status, "NO_HISTORICAL_MATCH");
  const genBefore = await getCurrentCorpusMatchGeneration(client);

  await indexSubmission("nomatch-cache-other-account-5b", text);
  const genAfter = await getCurrentCorpusMatchGeneration(client);
  assert.equal(genAfter, genBefore + 1, "indexing a submission must bump the corpus-match generation");

  const after = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: "nomatch-cache-viewer-5b", rawText: text });
  assert.equal(after.status, "MATCHED", "REQUIRED: the cached no-match picked up the newly-indexed cross-account submission");
  assert.equal(after.matches[0].relationshipType, "PRIOR_SUBMISSION");
});

test("4b: an unrelated generation bump alone forces one recompute, which stays NO_HISTORICAL_MATCH and then caches again", async () => {
  const { deviceKey, reportId } = await ensureSavedReport("nomatch-cache-viewer-4b");
  const first = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: "nomatch-cache-viewer-4b", rawText: LONE_TEXT_B });
  assert.equal(first.status, "NO_HISTORICAL_MATCH");

  await bumpCorpusMatchGeneration(client);
  assert.equal(await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: deviceKey, reportId }), false);

  const second = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: "nomatch-cache-viewer-4b", rawText: LONE_TEXT_B });
  assert.equal(second.status, "NO_HISTORICAL_MATCH");
  assert.notEqual(second.computedAt, first.computedAt, "the generation bump forced exactly one recompute");
  assert.equal(await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: deviceKey, reportId }), true, "and it is a cache hit again afterwards");
});

// ---------------------------------------------------------------------------
// 6 + 7 + 8: partial / timeout / DB-failure results are never a durable
// no-match.
// ---------------------------------------------------------------------------

test("6/7: a soft-time-budget partial no-match (is_partial=1) is never reused, even at current version and generation", async () => {
  const { deviceKey, reportId } = await ensureSavedReport("nomatch-cache-partial-viewer");
  const first = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: "nomatch-cache-partial-viewer", rawText: LONE_TEXT_A });
  assert.equal(first.status, "NO_HISTORICAL_MATCH");

  // Simulate the matcher's own partial exit (matchTimeBudgetMs exceeded /
  // candidate loop truncated) by marking the freshly-written row partial.
  await client.execute({
    sql: "UPDATE report_historical_match_snapshots SET is_partial = 1 WHERE report_device_key = ? AND report_id = ?",
    args: [deviceKey, reportId],
  });
  assert.equal(await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: deviceKey, reportId }), false, "a partial no-match is never current");

  const second = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: "nomatch-cache-partial-viewer", rawText: LONE_TEXT_A });
  assert.notEqual(second.computedAt, first.computedAt, "the partial row was recomputed, not served");
});

test("8: the matcher's DB-failure isolation path (candidate query rejects -> NO_HISTORICAL_MATCH partial:true) is stored partial and never reused as a final no-match", async () => {
  const { deviceKey, reportId } = await ensureSavedReport("nomatch-cache-dbtimeout-viewer");

  // matchAgainstUserSubmissionCorpus' own catch on the findCandidateCorpusRepresentations
  // Promise.race sets partial:true; getOrComputeHistoricalMatchSnapshot then
  // persists is_partial=1 with status NO_HISTORICAL_MATCH. Reproduce that
  // stored shape directly (the matcher's timeout race itself is covered by
  // tests/user-submission-matching-timeout.test.mjs).
  await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: "nomatch-cache-dbtimeout-viewer", rawText: LONE_TEXT_B });
  await client.execute({
    sql: "UPDATE report_historical_match_snapshots SET is_partial = 1, status = 'NO_HISTORICAL_MATCH' WHERE report_device_key = ? AND report_id = ?",
    args: [deviceKey, reportId],
  });
  assert.equal(await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: deviceKey, reportId }), false, "REQUIRED: a temporary Turso slowdown must never permanently teach the report 'there is no historical match'");

  const retry = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: "nomatch-cache-dbtimeout-viewer", rawText: LONE_TEXT_B });
  const row = await snapshotRow(deviceKey, reportId);
  assert.equal(Number(row.is_partial), 0, "the retry recomputed a complete result");
  assert.equal(retry.status, "NO_HISTORICAL_MATCH");
  assert.equal(await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: deviceKey, reportId }), true, "only the complete recompute is cacheable");
});

test("8b: a FAILED computation is surfaced as UNAVAILABLE (never as a no-match) and that pre-existing behaviour is unchanged", async () => {
  const { deviceKey, reportId } = await ensureSavedReport("nomatch-cache-failed-viewer");
  const brokenClient = createClient({ url: "file::memory:" });
  brokenClient.close();
  const result = await getOrComputeHistoricalMatchSnapshot(brokenClient, { reportDeviceKey: deviceKey, reportId, accountId: null, rawText: LONE_TEXT_A }).catch((e) => e);
  if (!(result instanceof Error)) {
    assert.equal(result.status, "UNAVAILABLE", "a genuine computation failure is UNAVAILABLE, never a NO_HISTORICAL_MATCH");
  }
});

// ---------------------------------------------------------------------------
// 9: version invalidation — matcher/config digest and canonicalization.
// ---------------------------------------------------------------------------

test("9: a snapshot whose matcher_version predates the current candidate-discovery config digest is recomputed, not reused", async () => {
  const { deviceKey, reportId } = await ensureSavedReport("nomatch-cache-version-viewer");
  const first = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: "nomatch-cache-version-viewer", rawText: LONE_TEXT_A });
  assert.equal(first.status, "NO_HISTORICAL_MATCH");
  const rowFirst = await snapshotRow(deviceKey, reportId);
  assert.equal(rowFirst.matcher_version, SNAPSHOT_MATCHER_VERSION, "the stored tag folds in the config digest");

  // An older config: same base matcher label, different digest (e.g. a
  // pre-maxDF-hardening run, which shipped without a version bump).
  await client.execute({
    sql: "UPDATE report_historical_match_snapshots SET matcher_version = 'user-submission-match-v1+cfg.000000000000' WHERE report_device_key = ? AND report_id = ?",
    args: [deviceKey, reportId],
  });
  assert.equal(await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: deviceKey, reportId }), false, "an out-of-date candidate-discovery config must invalidate the no-match");

  const second = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: "nomatch-cache-version-viewer", rawText: LONE_TEXT_A });
  assert.notEqual(second.computedAt, first.computedAt, "the stale-config no-match was recomputed");
  assert.equal((await snapshotRow(deviceKey, reportId)).matcher_version, SNAPSHOT_MATCHER_VERSION);
});

test("9b: a stale canonicalization_version invalidates the no-match", async () => {
  const { deviceKey, reportId } = await ensureSavedReport("nomatch-cache-canon-viewer");
  const first = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: "nomatch-cache-canon-viewer", rawText: LONE_TEXT_B });
  assert.equal(first.status, "NO_HISTORICAL_MATCH");
  await client.execute({
    sql: "UPDATE report_historical_match_snapshots SET canonicalization_version = 'canon-v0-stale' WHERE report_device_key = ? AND report_id = ?",
    args: [deviceKey, reportId],
  });
  assert.equal(await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: deviceKey, reportId }), false);
  const second = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: "nomatch-cache-canon-viewer", rawText: LONE_TEXT_B });
  assert.notEqual(second.computedAt, first.computedAt);
});

// ---------------------------------------------------------------------------
// 10: feature-flag safety — a no-match computed with the flag off can never
// suppress a real corpus-source match once the flag turns on.
// ---------------------------------------------------------------------------

test("10: a no-match computed while CORPUS_SOURCE_MATCHING_ENABLED is off is stored under the feature-disabled marker, is never a cache hit, and cannot poison a later flag-on match", async () => {
  const { deviceKey, reportId } = await ensureSavedReport("nomatch-cache-flag-viewer");
  const text =
    "Seismologists deploying a dense nodal array across a slow-slip zone imaged tremor migration fronts whose along-strike velocity varies systematically with the updip locking pattern.";

  // Flag OFF at computation: the matcher never classifies a corpus-source
  // candidate, so this no-match is incomplete.
  const off = await withEnv("CORPUS_SOURCE_MATCHING_ENABLED", undefined, () =>
    getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: "nomatch-cache-flag-viewer", rawText: text }));
  assert.equal(off.status, "NO_HISTORICAL_MATCH");
  const row = await snapshotRow(deviceKey, reportId);
  assert.equal(row.status, "NO_HISTORICAL_MATCH_FEATURE_DISABLED", "flag-off no-match carries the feature-disabled marker");
  assert.equal(await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: deviceKey, reportId }), false, "the feature-disabled no-match is never a cache hit (flag currently on for this file)");

  // A corpus source matching this text exists. With the flag now on, the
  // very next view must recompute and find it — the stale flag-off no-match
  // must NOT be served.
  await seedActivePromotedSource(text);
  const on = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: "nomatch-cache-flag-viewer", rawText: text });
  assert.equal(on.status, "MATCHED", "REQUIRED: the flag-off no-match did not suppress the real corpus-source match once the flag was on");
  assert.equal(on.matches[0].relationshipType, "TURNITPLUS_CORPUS_SOURCE");
});

// ---------------------------------------------------------------------------
// 11: account / self-match cache scope.
// ---------------------------------------------------------------------------

test("11: a no-match cached for one report keeps that report's own account-exclusion semantics — a self-only promoted backing still does not become a match on reuse", async () => {
  const account = "nomatch-cache-selfscope-account";
  const { deviceKey, reportId } = await ensureSavedReport(account);
  const text =
    "Volcanic petrologists re-examining a zoned clinopyroxene population from a monogenetic scoria cone reconstructed a rapid pre-eruptive magma mixing event only days before the eruption.";

  // First: genuine no-match, cached.
  const first = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: account, rawText: text, excludeAccountId: account });
  assert.equal(first.status, "NO_HISTORICAL_MATCH");

  // The account promotes its OWN representation of this content (generation
  // bumps -> the cached row is now stale and must recompute).
  const identity = await createDocumentIdentity(client, { accountId: account, title: "T", author: null, rawText: text });
  await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText: text });

  const second = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: account, rawText: text, excludeAccountId: account });
  assert.equal(second.status, "NO_HISTORICAL_MATCH", "REQUIRED: the account's own indexed submission is excluded — no self-match appears via the recompute");
});

// ---------------------------------------------------------------------------
// BARRIER: the corpus-source-matching flag is captured ONCE per computation.
// A flip landing between the matcher run and the snapshot write must not
// change which status is persisted — cacheability describes the conditions
// the result was computed under, not the environment at the write instant.
// ---------------------------------------------------------------------------

function setFlag(value) {
  if (value === undefined) delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  else process.env.CORPUS_SOURCE_MATCHING_ENABLED = value;
}

test("BARRIER OFF->ON: computation runs with the flag OFF; the flag flips ON before the snapshot write; the row MUST be persisted as NO_HISTORICAL_MATCH_FEATURE_DISABLED and the next flag-ON call MUST recompute to MATCHED", async () => {
  const { deviceKey, reportId } = await ensureSavedReport("nomatch-cache-barrier-offon");
  const text =
    "Hydrogeologists modelling a fractured-rock aquifer under pumping stress resolved a preferential flow conduit whose transmissivity is two orders of magnitude above the surrounding matrix.";

  // A real promoted cross-account source that DOES match this text already exists.
  const promotedRepresentationId = await seedActivePromotedSource(text);

  setFlag(undefined); // flag OFF at the start of the computation
  let flipped = false;
  try {
    const result = await getOrComputeHistoricalMatchSnapshot(client, {
      reportDeviceKey: deviceKey,
      reportId,
      accountId: "nomatch-cache-barrier-offon",
      rawText: text,
      // The pause fires AFTER the matcher has already run under the captured
      // OFF value and AFTER currentGeneration was read — exactly the gap the
      // old race lived in.
      testOnlyPauseBeforeWrite: async () => { setFlag("true"); flipped = true; },
    });

    assert.equal(flipped, true, "test setup sanity: the barrier must have flipped the flag mid-computation");
    // The computation ran under OFF, so the corpus source was suppressed.
    assert.equal(result.status, "NO_HISTORICAL_MATCH", "the returned result may externally remain NO_HISTORICAL_MATCH");

    const row = await snapshotRow(deviceKey, reportId);
    assert.equal(
      row.status,
      "NO_HISTORICAL_MATCH_FEATURE_DISABLED",
      "REQUIRED: persisted status must reflect the OFF the matcher actually ran under, not the ON that landed before the write",
    );
    assert.equal(
      await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: deviceKey, reportId }),
      false,
      "REQUIRED: isHistoricalMatchSnapshotCurrent must return false for the feature-disabled row",
    );

    // Next call — flag genuinely ON now — must recompute and discover the source.
    const rowBefore = row.computed_at;
    const next = await getOrComputeHistoricalMatchSnapshot(client, {
      reportDeviceKey: deviceKey, reportId, accountId: "nomatch-cache-barrier-offon", rawText: text,
    });
    assert.equal(next.status, "MATCHED", "REQUIRED: the next flag-ON call recomputes and returns MATCHED");
    assert.equal(next.matches[0].matchedRepresentationId, promotedRepresentationId);
    assert.notEqual((await snapshotRow(deviceKey, reportId)).computed_at, rowBefore, "the recompute genuinely rewrote the row");
  } finally {
    setFlag("true"); // restore this file's default
  }
});

test("BARRIER ON->OFF: computation runs with the flag ON and genuinely finds nothing; the flag flips OFF before the write; the row MUST be persisted as the reusable NO_HISTORICAL_MATCH (ON semantics), not the feature-disabled marker", async () => {
  const { deviceKey, reportId } = await ensureSavedReport("nomatch-cache-barrier-onoff-a");
  const text =
    "Astrobiologists culturing a halophilic archaeon under simulated Martian brine chemistry reported sustained metabolic activity at water activities previously assumed to preclude any terrestrial life.";

  setFlag("true"); // ON at the start
  try {
    const result = await getOrComputeHistoricalMatchSnapshot(client, {
      reportDeviceKey: deviceKey,
      reportId,
      accountId: "nomatch-cache-barrier-onoff-a",
      rawText: text,
      testOnlyPauseBeforeWrite: async () => { setFlag(undefined); },
    });
    assert.equal(result.status, "NO_HISTORICAL_MATCH");

    const row = await snapshotRow(deviceKey, reportId);
    assert.equal(
      row.status,
      "NO_HISTORICAL_MATCH",
      "REQUIRED: a complete ON-semantics no-match stays the reusable status even though the environment read OFF at the write instant",
    );
    assert.equal(
      await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: deviceKey, reportId }),
      true,
      "REQUIRED: it is a genuine cache hit — the later OFF does not retroactively make it non-current",
    );
  } finally {
    setFlag("true");
  }
});

test("BARRIER ON->OFF (matched): computation runs with the flag ON and matches a corpus source; the flag flips OFF before the write; the stored row stays MATCHED and read-time filtering (live OFF) hides it — the existing rollback story, unaffected", async () => {
  const { deviceKey, reportId } = await ensureSavedReport("nomatch-cache-barrier-onoff-b");
  const text =
    "Palaeoceanographers reconstructing bottom-water oxygenation from benthic foraminiferal assemblages identified a millennial-scale ventilation collapse coincident with a known meltwater pulse.";
  await seedActivePromotedSource(text);

  setFlag("true");
  try {
    const result = await getOrComputeHistoricalMatchSnapshot(client, {
      reportDeviceKey: deviceKey,
      reportId,
      accountId: "nomatch-cache-barrier-onoff-b",
      rawText: text,
      testOnlyPauseBeforeWrite: async () => { setFlag(undefined); },
    });
    // Read-time applyCorpusSourceMatchingFlag sees the LIVE flag (now OFF) and strips it.
    assert.equal(result.status, "NO_HISTORICAL_MATCH", "read-time filtering hides the corpus-source entry while the flag is currently off");

    const row = await snapshotRow(deviceKey, reportId);
    assert.equal(row.status, "MATCHED", "REQUIRED: the stored row reflects the ON computation — MATCHED, filtered at read time, never rewritten to a no-match");
    assert.equal(await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: deviceKey, reportId }), true, "a MATCHED row stays a cache hit regardless of the live flag");

    // Flag back ON -> the same cached MATCHED row surfaces, no recompute.
    setFlag("true");
    const back = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: "nomatch-cache-barrier-onoff-b", rawText: text });
    assert.equal(back.status, "MATCHED");
    assert.equal(back.computedAt, result.computedAt, "no recompute — the ON computation's row was reused");
  } finally {
    setFlag("true");
  }
});
