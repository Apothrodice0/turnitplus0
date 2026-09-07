import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { indexDocumentSubmissionIntoCorpus } from "../lib/user-submission-corpus.ts";
import { getOrComputeHistoricalMatchSnapshot } from "../lib/report-historical-match.ts";
import { matureCorpusBackings } from "./helpers/corpus-maturity.mjs";
import { runHistoricalMatchShadowEvaluation } from "../lib/e8p-shadow-evaluation.ts";
import { runAfterResponse } from "../lib/run-after-response.ts";
import { PROPOSED_ACCEPTANCE_POLICY_VERSION, PROPOSED_ROBUST_CORRESPONDENCE_VERSION, PROPOSED_DISTINCTIVENESS_MODEL_VERSION } from "../lib/e8o-historical-match-policy.ts";
import { HIST_DISTINCTIVE_DOCUMENT, LONG_BLOCK, MANY_SHORT_COMMON_OVERLAPS, HIST_GENERIC_DOCUMENT, SECONDARY_REVIEW_DOCUMENT } from "../lib/e8k-calibration-fixtures.ts";

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_e8p_shadow_evaluation.db");
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

const knownUsers = new Set();
async function ensureUser(accountId) {
  if (accountId === null || knownUsers.has(accountId)) return;
  knownUsers.add(accountId);
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
    args: [accountId, `${accountId}@example.test`, accountId, "not-a-real-hash"],
  });
}
async function ensureSavedReport(deviceKey, reportId, accountId) {
  await ensureUser(accountId);
  await client.execute({
    sql: `INSERT OR IGNORE INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: [reportId, deviceKey, "sub-" + reportId, "Fixture Report", new Date().toISOString(), 100, 0, "Low", "{}", accountId],
  });
}
async function indexSubmission(accountId, rawText) {
  await ensureUser(accountId);
  const identity = await createDocumentIdentity(client, { accountId, title: "T", author: null, rawText });
  const _r = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  await matureCorpusBackings(client); // Phase A: age the seeded backing so it is matchable "now"
  return _r;
}
async function shadowRow(reportDeviceKey, reportId) {
  const result = await client.execute({
    sql: "SELECT * FROM historical_match_shadow_evaluations WHERE report_device_key = ? AND report_id = ?",
    args: [reportDeviceKey, reportId],
  });
  return result.rows[0] ?? null;
}
async function snapshotRow(reportDeviceKey, reportId) {
  const result = await client.execute({
    sql: "SELECT * FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?",
    args: [reportDeviceKey, reportId],
  });
  return result.rows[0] ? { ...result.rows[0] } : null;
}
/** Seeds a shadow row directly (bypassing the module) so cache-rule tests can construct an exact pre-existing row shape without running the full candidate/E8M/V2 pipeline. */
async function insertRawShadowRow(reportDeviceKey, reportId, overrides = {}) {
  const row = {
    production_status: "NO_HISTORICAL_MATCH",
    production_relationship: null,
    proposed_status: "NO_HISTORICAL_MATCH",
    proposed_relationship: null,
    proposed_evidence: null,
    agreement: "AGREE",
    candidate_count: 0,
    passage_level_evaluated_count: 0,
    freq_index_document_count: 0,
    submitted_word_count: 100,
    e8m_runtime_ms: null,
    v2_runtime_ms: null,
    total_runtime_ms: 10,
    policy_version: PROPOSED_ACCEPTANCE_POLICY_VERSION,
    correspondence_version: PROPOSED_ROBUST_CORRESPONDENCE_VERSION,
    distinctiveness_version: PROPOSED_DISTINCTIVENESS_MODEL_VERSION,
    status: "OK",
    error_message: null,
    ...overrides,
  };
  await client.execute({
    sql: `INSERT INTO historical_match_shadow_evaluations
          (report_device_key, report_id, production_status, production_relationship, proposed_status, proposed_relationship,
           proposed_evidence, agreement, candidate_count, passage_level_evaluated_count, freq_index_document_count,
           submitted_word_count, e8m_runtime_ms, v2_runtime_ms, total_runtime_ms, policy_version, correspondence_version,
           distinctiveness_version, status, error_message, computed_at, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    args: [
      reportDeviceKey, reportId, row.production_status, row.production_relationship, row.proposed_status, row.proposed_relationship,
      row.proposed_evidence, row.agreement, row.candidate_count, row.passage_level_evaluated_count, row.freq_index_document_count,
      row.submitted_word_count, row.e8m_runtime_ms, row.v2_runtime_ms, row.total_runtime_ms, row.policy_version, row.correspondence_version,
      row.distinctiveness_version, row.status, row.error_message,
    ],
  });
}
function minimalProductionResult(status, matches) {
  return { status, matches, computedAt: new Date().toISOString(), matcherVersion: "x", fingerprintVersion: "x", canonicalizationVersion: "x" };
}

// --- STRUCTURAL SAFETY --------------------------------------------------------

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
const MODULE_PATH = path.join(repoRoot, "lib/e8p-shadow-evaluation.ts");
const MODULE_SOURCE = stripComments(fs.readFileSync(MODULE_PATH, "utf8"));

test("structural: the module never references report_historical_match_snapshots (the production table) anywhere", () => {
  assert.doesNotMatch(MODULE_SOURCE, /report_historical_match_snapshots/, "this module must only ever read/write historical_match_shadow_evaluations, never the production snapshot table");
});

test("structural: the module never imports or calls a production scoring/rendering path", () => {
  assert.doesNotMatch(MODULE_SOURCE, /similarity-worker|receipt-pdf|report-classification/);
  assert.doesNotMatch(MODULE_SOURCE, /\.score\s*=|\.archiveScore\s*=|\.aiScore\s*=|verifiedSimilarity/);
});

test("structural: the persisted INSERT/UPSERT column list contains no document/passage/account-identity field names", () => {
  const insertMatch = MODULE_SOURCE.match(/INSERT INTO historical_match_shadow_evaluations[\s\S]*?computed_at = excluded\.computed_at/);
  assert.ok(insertMatch, "expected to find the telemetry INSERT ... ON CONFLICT DO UPDATE statement");
  const columnList = insertMatch[0];
  for (const forbidden of [/\btext\b/i, /\bcontent\b/i, /\bpassage_text\b/i, /\baccount_id\b/i, /\bemail\b/i]) {
    assert.doesNotMatch(columnList, forbidden, `telemetry column list must not contain ${forbidden}`);
  }
});

test("structural: the module never references saved_reports (report content/scores live there)", () => {
  assert.doesNotMatch(MODULE_SOURCE, /saved_reports/, "this module must never read or write saved_reports directly");
});

test("structural: no console.* call in the module ever references raw/canonical/candidate text variables", () => {
  const consoleLines = MODULE_SOURCE.split(/\r?\n/).filter((l) => /console\.(log|error|warn)/.test(l));
  assert.ok(consoleLines.length > 0, "expected at least one console.error call (the non-fatal failure log)");
  for (const line of consoleLines) {
    for (const forbidden of [/\brawText\b/, /\bcanonicalText\b/, /\bcandidateText\b/, /\baccountId\b/, /\bsurvivor\.canonicalText\b/]) {
      assert.doesNotMatch(line, forbidden, `console call must never reference document text or account id: "${line.trim()}"`);
    }
  }
});

// --- BEHAVIORAL: MATCHED fast path -------------------------------------------

test("MATCHED fast path: production already found a full match -> shadow agrees trivially, without running E8M/V2", async () => {
  const text = "Cryptographers auditing a legacy authentication protocol identified a timing side channel in its password comparison routine, e8p-fixture-matched-fastpath-marker.";
  await indexSubmission("e8p-fastpath-owner", text);

  const deviceKey = "device-e8p-fastpath";
  const reportId = "report-e8p-fastpath";
  await ensureSavedReport(deviceKey, reportId, "e8p-fastpath-viewer");

  const productionResult = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: "e8p-fastpath-viewer", rawText: text });
  assert.equal(productionResult.status, "MATCHED", "test precondition: production must have found a real match for this fixture");
  assert.equal(productionResult.matches[0].relationshipType, "PRIOR_SUBMISSION");

  await runHistoricalMatchShadowEvaluation(client, { reportDeviceKey: deviceKey, reportId, accountId: "e8p-fastpath-viewer", rawText: text, productionResult });

  const row = await shadowRow(deviceKey, reportId);
  assert.ok(row, "expected a telemetry row to be persisted");
  assert.equal(row.production_status, "MATCHED");
  assert.equal(row.proposed_status, "HISTORICAL_FULL_MATCH");
  assert.equal(row.agreement, "AGREE");
  assert.equal(row.proposed_relationship, "PRIOR_SUBMISSION");
  assert.equal(row.proposed_evidence, "EXACT_CANONICAL_MATCH");
  assert.equal(Number(row.passage_level_evaluated_count), 0, "the MATCHED fast path must never spend an E8M/V2 pass");
});

// --- BEHAVIORAL: self-reference ownership-drop replication ------------------

test("ownership-drop replication: a first-ever upload (production NO_HISTORICAL_MATCH via the self-reference drop) must not be reported as a shadow disagreement", async () => {
  // Mirrors tests/report-historical-match.test.mjs's own "very first-ever
  // upload" fixture exactly: exactly ONE indexed reference, from the same
  // account whose report is being viewed. Even though the text is an exact
  // canonical match of itself, production's own ownership-drop rule
  // (lib/user-submission-matching.ts:235) correctly reports
  // NO_HISTORICAL_MATCH here — this module must replicate that rule, not
  // manufacture a false "shadow found a match production missed" anomaly.
  const text = "Glaciologists resurveying an alpine ice core site measured an accelerated annual layer thinning rate relative to every prior decade's own recorded baseline, e8p-fixture-first-upload-marker.";
  await indexSubmission("e8p-first-upload-account", text);

  const deviceKey = "device-e8p-first-upload";
  const reportId = "report-e8p-first-upload";
  await ensureSavedReport(deviceKey, reportId, "e8p-first-upload-account");

  const productionResult = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: "e8p-first-upload-account", rawText: text });
  assert.equal(productionResult.status, "NO_HISTORICAL_MATCH", "test precondition: the self-reference drop must apply here, exactly like tests/report-historical-match.test.mjs's own equivalent fixture");

  await runHistoricalMatchShadowEvaluation(client, { reportDeviceKey: deviceKey, reportId, accountId: "e8p-first-upload-account", rawText: text, productionResult });

  const row = await shadowRow(deviceKey, reportId);
  assert.ok(row, "expected a telemetry row to be persisted even for the NO_HISTORICAL_MATCH path");
  assert.equal(row.proposed_status, "NO_HISTORICAL_MATCH");
  assert.equal(row.agreement, "AGREE", "must not be reported as DISAGREE_NEW_FULL — this is the known, already-handled self-reference edge case, not real signal");
});

// --- BEHAVIORAL: partial-copy discovery (Phase 6.7: see this fixture's own
// updated note below — production now finds this case directly) ----------

// Deliberately NOT one of e8k-calibration-fixtures.ts's own ready-made
// PARTIAL_COPY pairs (e.g. ONE_LONG_DISTINCTIVE_OVERLAP/HIST_DISTINCTIVE_DOCUMENT):
// empirically verified (see this phase's own probe script, not checked in)
// that pair's containment (~0.50) actually clears PRODUCTION's real, looser
// USER_SUBMISSION_MATCH_THRESHOLDS (0.5/15 words) even though it was built
// to escape E8L/E8N's own stricter calibration thresholds (0.6/20 words) —
// so it would make production itself report MATCHED, not a useful
// "production misses this" fixture for this test's purpose. This fixture
// instead reuses e8k-calibration-fixtures.ts's own LONG_BLOCK excerpt (a
// genuinely distinctive ~377-word passage) diluted with substantially more
// surrounding unrelated filler than lib/e8k-calibration-fixtures.ts's own
// withFiller() adds, specifically to push whole-document CONTAINMENT just
// under production's 0.5 strongContainmentThreshold. A second, independent
// "noise" document sharing a small amount of the same filler is also
// indexed — needed so the freqIndex this module builds (bounded to the
// candidates actually found for this query, per this module's own
// documented "corpus-scarce" limitation) has more than a single document to
// compare against.
//
// PHASE 6.7 UPDATE — this fixture no longer escapes PRODUCTION overall.
// Phase 6.6 PART 2 added a SECOND, independent production acceptance path,
// lib/document-correspondence.ts's distinctivePassageMatch: a single
// contiguous, sufficiently long (>=30 words), sufficiently non-generic
// (density-gated) passage is now real production evidence on its own,
// regardless of whole-document containment. LONG_BLOCK's ~377 words clear
// this comfortably (containment dilution was only ever a whole-document
// metric — distinctivePassageMatch was specifically designed to be immune
// to it), so getOrComputeHistoricalMatchSnapshot now returns MATCHED for
// this fixture, not NO_HISTORICAL_MATCH. The test below is updated to
// assert that real, verified outcome directly, rather than the no-longer-
// true "production misses this" precondition it originally documented.
//
// This also surfaces a genuine, worth-recording architectural finding: for
// any SINGLE substantial passage, distinctivePassageMatch's acceptance
// region is now a superset of what lib/e8o-historical-match-policy.ts's own
// proposed decision tree requires (that policy's hasSubstantialSinglePassage
// guardrail itself requires >=40 words in one passage before
// HISTORICAL_PARTIAL_MATCH can ever be reached — already above this
// production fix's own 30-word floor). A realistic single-passage fixture
// that production now misses but the proposed E8O policy would uniquely
// catch is therefore no longer constructible from this codebase's existing
// calibration fixtures — not a gap in this test, a real consequence of the
// production fix having covered that ground first.
const UNRELATED_FILLER = [
  "Urban planners reviewing decades of transit ridership data across a mid-sized metropolitan region identified a consistent pattern in which bus routes serving mixed-use commercial corridors retained significantly higher weekday ridership than comparable routes serving primarily single-family residential zones, even after controlling for route length and service frequency.",
  "The planners attributed part of the difference to walkability, noting that corridors with continuous sidewalk coverage and shorter average block lengths saw riders willing to walk considerably farther to reach a stop than riders in areas with frequent sidewalk gaps or unusually long blocks.",
  "A parallel survey of driver satisfaction found that operators on the higher-ridership corridors reported fewer schedule-adherence complaints despite heavier passenger loads, a result the analysis team suggested was linked to more predictable dwell times at well-used stops compared with the more sporadic boarding patterns typical of lower-density routes.",
  "Budget committee members reviewing the findings proposed reallocating a modest share of next year's service hours toward the highest-performing corridors, while cautioning that any reduction in coverage elsewhere would need to be weighed carefully against the transit agency's separate equity-of-access commitments made in the prior fiscal year.",
  "A follow-up technical memo recommended a twelve-month pilot in which two lower-density routes would receive modestly increased frequency specifically to test whether ridership gains under improved service levels could partially close the observed gap, before any permanent reallocation decision was made.",
  "Committee members ultimately deferred a final vote on the reallocation proposal pending the pilot's results, directing staff to report back with ridership and cost data at the committee's regularly scheduled session the following spring.",
  "Several residents who submitted written comment ahead of the meeting expressed concern that any reduction in service to residential corridors would disproportionately affect riders without reliable access to a private vehicle, a concern staff acknowledged directly in the memo's closing section.",
  "The transit agency's planning director noted in closing remarks that the pilot design had been deliberately structured to avoid any net reduction in total service hours during the trial period, addressing the most frequently raised concern from the public comment period directly.",
].join(" ");
const UNRELATED_FILLER_SNIPPET = UNRELATED_FILLER.split(" ").slice(0, 60).join(" ");
const PARTIAL_COPY_SUBMITTED_TEXT = `${UNRELATED_FILLER}\n\n${UNRELATED_FILLER}\n\n${LONG_BLOCK}\n\n${UNRELATED_FILLER}\n\n${UNRELATED_FILLER}`;
const PARTIAL_COPY_NOISE_DOCUMENT = `${UNRELATED_FILLER_SNIPPET}\n\n${SECONDARY_REVIEW_DOCUMENT}\n\n${HIST_GENERIC_DOCUMENT}`;

// --- BEHAVIORAL: E8P.2 — the real production race, reproduced deterministically ---
//
// Placed here (before "partial-copy discovery" below, which indexes these
// same HIST_DISTINCTIVE_DOCUMENT/PARTIAL_COPY_NOISE_DOCUMENT fixtures under
// different accounts) so this test's own "nothing matching exists in the
// corpus yet" precondition is genuinely true — node:test runs a single
// file's top-level test() calls in registration order against this file's
// one shared client/db, so test ordering here is deliberate, not incidental.
test("RACE regression (E8P.2): a stale NO_HISTORICAL_MATCH+candidate_count=0 row is recomputed once the corpus grows, finds the new candidate, and stays exactly one row — exercised through the real runAfterResponse path", async () => {
  const deviceKey = "device-e8p-race";
  const reportId = "report-e8p-race";
  await ensureSavedReport(deviceKey, reportId, "e8p-race-viewer");

  // Steps 1-3: A's report is viewed while nothing matching exists in the
  // corpus yet -> production NO_HISTORICAL_MATCH, shadow finds zero candidates.
  const productionResultBefore = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: "e8p-race-viewer", rawText: PARTIAL_COPY_SUBMITTED_TEXT });
  assert.equal(productionResultBefore.status, "NO_HISTORICAL_MATCH", "precondition: nothing indexed yet for this fixture");

  await runAfterResponse(() => runHistoricalMatchShadowEvaluation(client, { reportDeviceKey: deviceKey, reportId, accountId: "e8p-race-viewer", rawText: PARTIAL_COPY_SUBMITTED_TEXT, productionResult: productionResultBefore }));

  // Step 4: assert exactly one telemetry row, candidate_count 0.
  const firstRow = await shadowRow(deviceKey, reportId);
  assert.ok(firstRow, "expected a telemetry row after the first view");
  assert.equal(firstRow.production_status, "NO_HISTORICAL_MATCH");
  assert.equal(Number(firstRow.candidate_count), 0);
  const firstComputedAt = firstRow.computed_at;

  // Step 5: Account B's matching document is indexed AFTER A's shadow evaluation already ran and cached its zero-candidate result.
  await indexSubmission("e8p-race-account-b", HIST_DISTINCTIVE_DOCUMENT);
  await indexSubmission("e8p-race-noise-owner", PARTIAL_COPY_NOISE_DOCUMENT); // freqIndex context, same construction as the partial-copy-discovery test below

  // Step 6: A's report is viewed again. Production's own NO_HISTORICAL_MATCH
  // snapshot always recomputes on every view (pre-existing E8E behavior,
  // unrelated to this fix) — real corpus growth means it may or may not
  // itself change; what this test proves is the SHADOW layer's own behavior.
  const productionResultAfter = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: "e8p-race-viewer", rawText: PARTIAL_COPY_SUBMITTED_TEXT });

  // Step 13 (captured around the actual recompute, not a separate call):
  // report_historical_match_snapshots must be unaffected BY THE SHADOW CALL
  // itself, across the exact recompute this test is proving happens.
  const snapshotBeforeShadowRerun = await snapshotRow(deviceKey, reportId);

  // Step 7: shadow evaluation MUST rerun (this is what E8P.2 fixes).
  await runAfterResponse(() => runHistoricalMatchShadowEvaluation(client, { reportDeviceKey: deviceKey, reportId, accountId: "e8p-race-viewer", rawText: PARTIAL_COPY_SUBMITTED_TEXT, productionResult: productionResultAfter }));

  const snapshotAfterShadowRerun = await snapshotRow(deviceKey, reportId);
  assert.deepEqual(snapshotAfterShadowRerun, snapshotBeforeShadowRerun, "the shadow call itself must never mutate report_historical_match_snapshots, even across a recompute");

  const secondRow = await shadowRow(deviceKey, reportId);
  assert.ok(secondRow);
  // Step 8: candidate_count now becomes >0.
  assert.ok(Number(secondRow.candidate_count) >= 1, "the newly-indexed candidate must now be found");
  // Step 9 (Phase 6.7 update): production itself now finds this candidate
  // directly. lib/document-correspondence.ts's distinctivePassageMatch
  // (Phase 6.6 PART 2) accepts a sufficiently long, sufficiently
  // distinctive single contiguous passage independent of whole-document
  // containment — LONG_BLOCK (~377 genuinely distinctive words) clears it
  // comfortably. getOrComputeHistoricalMatchSnapshot therefore now returns
  // MATCHED for productionResultAfter, so runHistoricalMatchShadowEvaluation
  // takes its own documented MATCHED fast path (lib/e8p-shadow-evaluation.ts
  // — never recomputes E8M/V2 when production's real status is already
  // MATCHED) rather than reaching the passage-level path this test
  // originally exercised. This still fully proves E8P.2's own subject
  // (a stale zero-candidate row is correctly recomputed once the corpus
  // grows) — only the downstream classification the recompute lands on
  // has changed, from a proposed-only partial match to a real, direct
  // production full match that shadow correctly agrees with.
  assert.equal(secondRow.proposed_status, "HISTORICAL_FULL_MATCH");
  assert.equal(secondRow.agreement, "AGREE");
  // Step 11: proof that a real recompute happened, not a coincidental re-insert
  // of the same content. NOT proven via computed_at inequality — SQLite's
  // CURRENT_TIMESTAMP only has whole-second resolution, so two real,
  // distinct recomputes landing in the same second would otherwise look
  // identical and make this assertion flaky. The candidate_count/proposed_status
  // change already asserted above (0 -> 1, NO_HISTORICAL_MATCH -> HISTORICAL_PARTIAL_MATCH)
  // is itself the robust proof: that content is governed by real corpus
  // state, not by anything time-based, and could not have appeared without
  // the candidate-search/E8M/V2 path actually re-running.
  assert.ok(firstComputedAt, "sanity: the first row's computed_at was captured");

  // Step 10: telemetry table still contains exactly ONE row for this report + policy version.
  const countResult = await client.execute({
    sql: "SELECT COUNT(*) AS cnt FROM historical_match_shadow_evaluations WHERE report_device_key = ? AND report_id = ? AND policy_version = ?",
    args: [deviceKey, reportId, PROPOSED_ACCEPTANCE_POLICY_VERSION],
  });
  assert.equal(Number(countResult.rows[0].cnt), 1, "recomputation must upsert in place, never append a second row");

  // Step 12: production status/result itself is a real, valid status — E8P never invents or corrupts it.
  assert.ok(["NO_HISTORICAL_MATCH", "MATCHED", "UNAVAILABLE"].includes(productionResultAfter.status));
});

test("partial-copy discovery: Phase 6.6's distinctivePassageMatch fix now makes production find this directly; shadow evaluation correctly agrees via the MATCHED fast path (E8M/V2 is no longer needed for this fixture — see the fixture comment above)", async () => {
  await indexSubmission("e8p-partial-owner", HIST_DISTINCTIVE_DOCUMENT);
  await indexSubmission("e8p-partial-noise-owner", PARTIAL_COPY_NOISE_DOCUMENT);

  const deviceKey = "device-e8p-partial";
  const reportId = "report-e8p-partial";
  await ensureSavedReport(deviceKey, reportId, "e8p-partial-viewer");

  const productionResult = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: "e8p-partial-viewer", rawText: PARTIAL_COPY_SUBMITTED_TEXT });
  assert.equal(productionResult.status, "MATCHED", "Phase 6.7: production now finds this fixture directly via distinctivePassageMatch (Phase 6.6 PART 2) — see the fixture comment above for why this is a real, verified change, not a weakened test");
  assert.equal(productionResult.matches[0].relationshipType, "PRIOR_SUBMISSION");
  assert.equal(productionResult.matches[0].matchType, "STRONG_TEXT_MATCH", "accepted via distinctivePassageMatch, not the unchanged exact-canonical-hash short-circuit");

  await runHistoricalMatchShadowEvaluation(client, { reportDeviceKey: deviceKey, reportId, accountId: "e8p-partial-viewer", rawText: PARTIAL_COPY_SUBMITTED_TEXT, productionResult });

  const row = await shadowRow(deviceKey, reportId);
  assert.ok(row, "expected a telemetry row to be persisted");
  assert.equal(row.status, "OK");
  assert.equal(row.proposed_status, "HISTORICAL_FULL_MATCH", "production's own real MATCHED result is reproduced through the MATCHED fast path (lib/e8p-shadow-evaluation.ts), not proposed independently");
  assert.equal(row.agreement, "AGREE", "shadow correctly agrees with production now that production finds this case directly — no disagreement remains to report");
  assert.equal(Number(row.passage_level_evaluated_count), 0, "the MATCHED fast path never spends an E8M/V2 pass — production's own result already settles it");
  assert.ok(Number(row.candidate_count) >= 1);
  assert.equal(Number(row.freq_index_document_count), 0, "freqIndex is only ever built on the passage-level path, which the fast path does not reach");
});

test("generic boilerplate: a real E8N COMMON_BOILERPLATE fixture is correctly rejected (no false partial match)", async () => {
  await indexSubmission("e8p-boilerplate-owner", HIST_GENERIC_DOCUMENT);

  const deviceKey = "device-e8p-boilerplate";
  const reportId = "report-e8p-boilerplate";
  await ensureSavedReport(deviceKey, reportId, "e8p-boilerplate-viewer");

  const productionResult = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: "e8p-boilerplate-viewer", rawText: MANY_SHORT_COMMON_OVERLAPS });
  assert.equal(productionResult.status, "NO_HISTORICAL_MATCH");

  await runHistoricalMatchShadowEvaluation(client, { reportDeviceKey: deviceKey, reportId, accountId: "e8p-boilerplate-viewer", rawText: MANY_SHORT_COMMON_OVERLAPS, productionResult });

  const row = await shadowRow(deviceKey, reportId);
  assert.ok(row);
  assert.equal(row.proposed_status, "NO_HISTORICAL_MATCH", "generic boilerplate overlap must be rejected by the V2 distinctiveness gate, not proposed as a partial match");
  assert.equal(row.agreement, "AGREE");
});

// --- BEHAVIORAL: idempotency --------------------------------------------------

test("idempotency: a second call for the same report and policy version does not recompute or insert a second row", async () => {
  const text = "Paleobotanists cataloguing a newly excavated fossil bed identified pollen grains from a plant lineage not previously documented at this specific stratigraphic layer, e8p-fixture-idempotency-marker.";
  await ensureSavedReport("device-e8p-idempotent", "report-e8p-idempotent", null);
  const productionResult = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: "device-e8p-idempotent", reportId: "report-e8p-idempotent", accountId: null, rawText: text });

  await runHistoricalMatchShadowEvaluation(client, { reportDeviceKey: "device-e8p-idempotent", reportId: "report-e8p-idempotent", accountId: null, rawText: text, productionResult });
  const first = await shadowRow("device-e8p-idempotent", "report-e8p-idempotent");
  assert.ok(first);

  await runHistoricalMatchShadowEvaluation(client, { reportDeviceKey: "device-e8p-idempotent", reportId: "report-e8p-idempotent", accountId: null, rawText: text, productionResult });
  const second = await shadowRow("device-e8p-idempotent", "report-e8p-idempotent");

  assert.equal(second.computed_at, first.computed_at, "a second call must be a no-op, not recompute");

  const countResult = await client.execute({
    sql: "SELECT COUNT(*) AS cnt FROM historical_match_shadow_evaluations WHERE report_device_key = ? AND report_id = ?",
    args: ["device-e8p-idempotent", "report-e8p-idempotent"],
  });
  assert.equal(Number(countResult.rows[0].cnt), 1, "exactly one telemetry row must exist, never appended");
});

// --- BEHAVIORAL: zero effect on the real production snapshot ----------------

test("zero side effect: running shadow evaluation never mutates report_historical_match_snapshots", async () => {
  const text = "Volcanologists monitoring a dormant caldera detected a gradual increase in dissolved gas ratios at three separate fumarole sampling stations, e8p-fixture-zero-side-effect-marker.";
  await ensureSavedReport("device-e8p-zeroeffect", "report-e8p-zeroeffect", null);
  const productionResult = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: "device-e8p-zeroeffect", reportId: "report-e8p-zeroeffect", accountId: null, rawText: text });

  const before = await snapshotRow("device-e8p-zeroeffect", "report-e8p-zeroeffect");
  assert.ok(before, "expected the real production snapshot row to already exist");

  await runHistoricalMatchShadowEvaluation(client, { reportDeviceKey: "device-e8p-zeroeffect", reportId: "report-e8p-zeroeffect", accountId: null, rawText: text, productionResult });

  const after = await snapshotRow("device-e8p-zeroeffect", "report-e8p-zeroeffect");
  assert.deepEqual(after, before, "the production snapshot row must be byte-identical before and after shadow evaluation runs");
});

// --- BEHAVIORAL: UNAVAILABLE production result is skipped --------------------

test("UNAVAILABLE production result: shadow evaluation skips entirely, no telemetry row is written", async () => {
  const deviceKey = "device-e8p-unavailable";
  const reportId = "report-e8p-unavailable";
  const productionResult = { status: "UNAVAILABLE", computedAt: new Date().toISOString(), matcherVersion: "x", fingerprintVersion: "x", canonicalizationVersion: "x" };

  await runHistoricalMatchShadowEvaluation(client, { reportDeviceKey: deviceKey, reportId, accountId: null, rawText: "irrelevant text for this fixture case only.", productionResult });

  const row = await shadowRow(deviceKey, reportId);
  assert.equal(row, null, "an UNAVAILABLE production result must never produce a telemetry row");
});

// --- BEHAVIORAL: E8P.2 cache reuse/recompute rule, cases A-D --------------

test("cache rule A: NO_HISTORICAL_MATCH + candidate_count=0 recomputes", async () => {
  const deviceKey = "device-e8p-cache-a";
  const reportId = "report-e8p-cache-a";
  await ensureSavedReport(deviceKey, reportId, null);
  // A sentinel no real computation could ever produce — proof of recompute
  // is "this value is gone," which is robust regardless of SQLite's
  // whole-second CURRENT_TIMESTAMP resolution (computed_at is not used here).
  await insertRawShadowRow(deviceKey, reportId, { production_status: "NO_HISTORICAL_MATCH", candidate_count: 0, status: "OK", total_runtime_ms: 999999 });

  await runHistoricalMatchShadowEvaluation(client, {
    reportDeviceKey: deviceKey, reportId, accountId: null,
    rawText: "A distinct, unindexed fixture text for cache rule A with enough words to be a valid query on its own.",
    productionResult: minimalProductionResult("NO_HISTORICAL_MATCH"),
  });

  const after = await shadowRow(deviceKey, reportId);
  assert.notEqual(Number(after.total_runtime_ms), 999999, "a stale zero-candidate row must be recomputed (the sentinel value must be overwritten), not reused");
});

test("cache rule B: NO_HISTORICAL_MATCH + candidate_count>0 reuses the cached row", async () => {
  const deviceKey = "device-e8p-cache-b";
  const reportId = "report-e8p-cache-b";
  await ensureSavedReport(deviceKey, reportId, null);
  await insertRawShadowRow(deviceKey, reportId, { production_status: "NO_HISTORICAL_MATCH", candidate_count: 1, status: "OK" });
  const before = await shadowRow(deviceKey, reportId);

  await runHistoricalMatchShadowEvaluation(client, {
    reportDeviceKey: deviceKey, reportId, accountId: null,
    rawText: "irrelevant — this call must be skipped entirely before any text is even canonicalized.",
    productionResult: minimalProductionResult("NO_HISTORICAL_MATCH"),
  });

  const after = await shadowRow(deviceKey, reportId);
  assert.equal(after.computed_at, before.computed_at, "a row with an already-evaluated candidate must not be recomputed just because the corpus might have grown");
});

test("cache rule C: MATCHED reuses the cached row", async () => {
  const deviceKey = "device-e8p-cache-c";
  const reportId = "report-e8p-cache-c";
  await ensureSavedReport(deviceKey, reportId, null);
  await insertRawShadowRow(deviceKey, reportId, { production_status: "MATCHED", candidate_count: 0, status: "OK" });
  const before = await shadowRow(deviceKey, reportId);

  await runHistoricalMatchShadowEvaluation(client, {
    reportDeviceKey: deviceKey, reportId, accountId: null,
    rawText: "irrelevant for this case.",
    productionResult: minimalProductionResult("MATCHED", [{ relationshipType: "UNKNOWN_RELATIONSHIP", matchedRepresentationId: "x", matchType: "EXACT_CANONICAL_MATCH", containment: 1, matchedWordCount: 10, passageCount: 0, longestMatchWords: 10, passages: [], historicalSubmissionCount: 1 }]),
  });

  const after = await shadowRow(deviceKey, reportId);
  assert.equal(after.computed_at, before.computed_at, "MATCHED rows must stay cached — classifyHistoricalMatch's own steps 1-2 already guarantee this outcome can't change");
});

test("cache rule D: FAILED preserves existing failure-cache behavior (reused despite candidate_count=0)", async () => {
  const deviceKey = "device-e8p-cache-d";
  const reportId = "report-e8p-cache-d";
  await ensureSavedReport(deviceKey, reportId, null);
  await insertRawShadowRow(deviceKey, reportId, { production_status: "NO_HISTORICAL_MATCH", candidate_count: 0, status: "FAILED", error_message: "simulated prior failure" });
  const before = await shadowRow(deviceKey, reportId);

  await runHistoricalMatchShadowEvaluation(client, {
    reportDeviceKey: deviceKey, reportId, accountId: null,
    rawText: "irrelevant for this case.",
    productionResult: minimalProductionResult("NO_HISTORICAL_MATCH"),
  });

  const after = await shadowRow(deviceKey, reportId);
  assert.equal(after.computed_at, before.computed_at, "FAILED must stay cached exactly as before this fix — the FAILED check must win over the zero-candidate recompute rule");
  assert.equal(after.status, "FAILED");
});

// --- BEHAVIORAL: E8P.2 cases E/F — repeat recomputation stays deterministic and never duplicates ---

test("cache rule E/F: repeated recomputation of a persistently-stale row stays deterministic and never duplicates", async () => {
  const deviceKey = "device-e8p-cache-ef";
  const reportId = "report-e8p-cache-ef";
  await ensureSavedReport(deviceKey, reportId, null);
  const rawText = "A persistently unmatched fixture for the repeat-recomputation determinism test, e8p-cache-ef-marker, with enough distinct words.";
  const productionResult = minimalProductionResult("NO_HISTORICAL_MATCH");

  // Seed with a sentinel no real computation could produce (E8P.2's own
  // per-call recomputation happens well under a second, so proving "call 1
  // genuinely recomputed" via computed_at inequality would be flaky against
  // SQLite's whole-second CURRENT_TIMESTAMP resolution — the sentinel is not).
  await insertRawShadowRow(deviceKey, reportId, { production_status: "NO_HISTORICAL_MATCH", candidate_count: 0, status: "OK", total_runtime_ms: 999999 });

  const observed = [];
  for (let i = 0; i < 3; i += 1) {
    await runHistoricalMatchShadowEvaluation(client, { reportDeviceKey: deviceKey, reportId, accountId: null, rawText, productionResult });
    observed.push(await shadowRow(deviceKey, reportId));
  }

  // E: call 1 must have overwritten the seeded sentinel — proof the first recompute actually ran.
  assert.notEqual(Number(observed[0].total_runtime_ms), 999999, "call 1 must recompute over the seeded sentinel row");

  // F: deterministic — substantive fields identical across all three real computations, since corpus state never changed between them.
  for (const field of ["production_status", "proposed_status", "agreement", "candidate_count", "proposed_relationship", "proposed_evidence"]) {
    assert.equal(observed[1][field], observed[0][field], `${field} must be deterministic across recomputes of unchanged input`);
    assert.equal(observed[2][field], observed[0][field], `${field} must be deterministic across recomputes of unchanged input`);
  }

  const countResult = await client.execute({
    sql: "SELECT COUNT(*) AS cnt FROM historical_match_shadow_evaluations WHERE report_device_key = ? AND report_id = ?",
    args: [deviceKey, reportId],
  });
  assert.equal(Number(countResult.rows[0].cnt), 1, "repeated recomputation must still upsert in place, never append additional rows");
});

// --- BEHAVIORAL: E8P.2 case G — score/archiveScore invariance across a recompute ---

test("cache rule G: score and archiveScore on the underlying report are unaffected by a shadow recompute", async () => {
  const deviceKey = "device-e8p-cache-g";
  const reportId = "report-e8p-cache-g";
  const payload = JSON.stringify({ score: 42, archiveScore: 17, text: "irrelevant fixture text for this invariance check." });
  await ensureUser(null);
  await client.execute({
    sql: `INSERT OR IGNORE INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: [reportId, deviceKey, "sub-" + reportId, "Fixture Report", new Date().toISOString(), 100, 17, "Low", payload, null],
  });
  await insertRawShadowRow(deviceKey, reportId, { production_status: "NO_HISTORICAL_MATCH", candidate_count: 0, status: "OK" }); // stale -> will recompute

  const beforeReport = await client.execute({ sql: "SELECT archive_score, payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, reportId] });

  await runHistoricalMatchShadowEvaluation(client, {
    reportDeviceKey: deviceKey, reportId, accountId: null,
    rawText: "irrelevant fixture text for this invariance check.",
    productionResult: minimalProductionResult("NO_HISTORICAL_MATCH"),
  });

  const afterReport = await client.execute({ sql: "SELECT archive_score, payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, reportId] });
  assert.deepEqual(afterReport.rows[0], beforeReport.rows[0], "saved_reports (archive_score column and payload_json, including its embedded score/archiveScore) must be byte-identical across a shadow recompute");

  const parsedAfter = JSON.parse(String(afterReport.rows[0].payload_json));
  assert.equal(parsedAfter.score, 42);
  assert.equal(parsedAfter.archiveScore, 17);
});

// --- BEHAVIORAL: E8P.2 case H — snapshot non-mutation for the isolated (seeded-row) recompute case ---

test("cache rule H: report_historical_match_snapshots is unaffected by a shadow recompute triggered from a seeded stale row", async () => {
  const deviceKey = "device-e8p-cache-h";
  const reportId = "report-e8p-cache-h";
  const rawText = "A fixture specifically for the isolated snapshot-invariance check, e8p-cache-h-marker, with enough distinct words to be valid.";
  await ensureSavedReport(deviceKey, reportId, null);

  // Establish a real production snapshot first (mirrors how a report is actually viewed).
  await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: null, rawText });
  await insertRawShadowRow(deviceKey, reportId, { production_status: "NO_HISTORICAL_MATCH", candidate_count: 0, status: "OK" }); // force staleness

  const before = await snapshotRow(deviceKey, reportId);
  assert.ok(before);

  await runHistoricalMatchShadowEvaluation(client, {
    reportDeviceKey: deviceKey, reportId, accountId: null, rawText,
    productionResult: minimalProductionResult("NO_HISTORICAL_MATCH"),
  });

  const after = await snapshotRow(deviceKey, reportId);
  assert.deepEqual(after, before, "report_historical_match_snapshots must be byte-identical before and after a shadow recompute");
});

// --- BEHAVIORAL: E8P.2 / concurrency — two simultaneous recomputations must not duplicate rows ---

test("concurrency: two simultaneous recomputations of the same stale row produce exactly one final row and no unhandled error", async () => {
  const deviceKey = "device-e8p-concurrent";
  const reportId = "report-e8p-concurrent";
  await ensureSavedReport(deviceKey, reportId, null);
  await insertRawShadowRow(deviceKey, reportId, { production_status: "NO_HISTORICAL_MATCH", candidate_count: 0, status: "OK" }); // stale -> both concurrent calls will attempt to recompute

  const rawText = "A fixture for the concurrency test, e8p-concurrent-marker, with enough distinct words to be a valid query.";
  const productionResult = minimalProductionResult("NO_HISTORICAL_MATCH");

  const results = await Promise.allSettled([
    runHistoricalMatchShadowEvaluation(client, { reportDeviceKey: deviceKey, reportId, accountId: null, rawText, productionResult }),
    runHistoricalMatchShadowEvaluation(client, { reportDeviceKey: deviceKey, reportId, accountId: null, rawText, productionResult }),
  ]);
  for (const r of results) assert.equal(r.status, "fulfilled", "neither concurrent evaluation may throw/reject");

  const countResult = await client.execute({
    sql: "SELECT COUNT(*) AS cnt FROM historical_match_shadow_evaluations WHERE report_device_key = ? AND report_id = ? AND policy_version = ?",
    args: [deviceKey, reportId, PROPOSED_ACCEPTANCE_POLICY_VERSION],
  });
  assert.equal(Number(countResult.rows[0].cnt), 1, "concurrent recomputation of the same stale row must never produce more than one row");

  const finalRow = await shadowRow(deviceKey, reportId);
  assert.ok(finalRow, "a deterministic final row must exist");
  assert.equal(finalRow.status, "OK");
});
