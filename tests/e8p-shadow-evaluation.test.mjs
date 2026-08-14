import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { indexDocumentSubmissionIntoCorpus } from "../lib/user-submission-corpus.ts";
import { getOrComputeHistoricalMatchSnapshot } from "../lib/report-historical-match.ts";
import { runHistoricalMatchShadowEvaluation } from "../lib/e8p-shadow-evaluation.ts";
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
  return indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
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

test("structural: the persisted INSERT column list contains no document/passage/account-identity field names", () => {
  const insertMatch = MODULE_SOURCE.match(/INSERT OR IGNORE INTO historical_match_shadow_evaluations[\s\S]*?VALUES/);
  assert.ok(insertMatch, "expected to find the telemetry INSERT statement");
  const columnList = insertMatch[0];
  for (const forbidden of [/\btext\b/i, /\bcontent\b/i, /\bpassage_text\b/i, /\baccount_id\b/i, /\bemail\b/i]) {
    assert.doesNotMatch(columnList, forbidden, `telemetry column list must not contain ${forbidden}`);
  }
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

// --- BEHAVIORAL: partial-copy discovery (the core E8P measurement) ----------

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
// withFiller() adds, specifically to push containment just under
// PRODUCTION's real 0.5 threshold. A second, independent "noise" document
// sharing a small amount of the same filler is also indexed — needed so the
// freqIndex this module builds (bounded to the candidates actually found
// for this query, per this module's own documented "corpus-scarce"
// limitation) has more than a single document to compare against; with only
// the one true historical candidate in the corpus, V2 distinctiveness for
// this exact fixture empirically comes out to 0.60, under the 0.7 gate.
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

test("partial-copy discovery: a genuine partial copy that escapes whole-document acceptance is proposed as HISTORICAL_PARTIAL_MATCH", async () => {
  await indexSubmission("e8p-partial-owner", HIST_DISTINCTIVE_DOCUMENT);
  await indexSubmission("e8p-partial-noise-owner", PARTIAL_COPY_NOISE_DOCUMENT);

  const deviceKey = "device-e8p-partial";
  const reportId = "report-e8p-partial";
  await ensureSavedReport(deviceKey, reportId, "e8p-partial-viewer");

  const productionResult = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: "e8p-partial-viewer", rawText: PARTIAL_COPY_SUBMITTED_TEXT });
  assert.equal(productionResult.status, "NO_HISTORICAL_MATCH", "test precondition: this fixture is constructed to escape today's whole-document acceptance (see this file's own comment above for the empirical verification)");

  await runHistoricalMatchShadowEvaluation(client, { reportDeviceKey: deviceKey, reportId, accountId: "e8p-partial-viewer", rawText: PARTIAL_COPY_SUBMITTED_TEXT, productionResult });

  const row = await shadowRow(deviceKey, reportId);
  assert.ok(row, "expected a telemetry row to be persisted");
  assert.equal(row.status, "OK");
  assert.equal(row.proposed_status, "HISTORICAL_PARTIAL_MATCH", "the proposed E8O policy is expected to surface this as a partial-copy opportunity production currently misses");
  assert.equal(row.agreement, "DISAGREE_NEW_PARTIAL");
  assert.ok(Number(row.passage_level_evaluated_count) >= 1, "E8M/V2 must have actually run for at least one candidate");
  assert.ok(Number(row.candidate_count) >= 1);
  assert.ok(Number(row.freq_index_document_count) >= 1, "the noise document must have been available as freqIndex context");
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
