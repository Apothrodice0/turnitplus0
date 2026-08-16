import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { indexDocumentSubmissionIntoCorpus } from "../lib/user-submission-corpus.ts";
import { getOrComputeHistoricalMatchSnapshot } from "../lib/report-historical-match.ts";
import { runHistoricalMatchShadowEvaluation } from "../lib/e8p-shadow-evaluation.ts";
import { getExperimentalHistoricalMatchForDisplay, isE8pVisibilityAllowlisted } from "../lib/e8p-visibility.ts";
import { OverviewReport } from "../components/report/similarity-report-papers.tsx";
import { HIST_DISTINCTIVE_DOCUMENT, LONG_BLOCK, SECONDARY_REVIEW_DOCUMENT, HIST_GENERIC_DOCUMENT } from "../lib/e8k-calibration-fixtures.ts";

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_e8p_visibility.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

const originalAllowlistEnv = process.env.E8P_VISIBILITY_ALLOWLIST;
test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
  if (originalAllowlistEnv === undefined) delete process.env.E8P_VISIBILITY_ALLOWLIST;
  else process.env.E8P_VISIBILITY_ALLOWLIST = originalAllowlistEnv;
});

const TEST_ACCOUNT = "e8p-visibility-test-account";
const NON_TEST_ACCOUNT = "e8p-visibility-non-test-account";

function setAllowlist(...ids) {
  process.env.E8P_VISIBILITY_ALLOWLIST = ids.join(",");
}
function clearAllowlist() {
  delete process.env.E8P_VISIBILITY_ALLOWLIST;
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
async function ensureSavedReport(deviceKey, reportId, accountId) {
  await ensureUser(accountId);
  await client.execute({
    sql: `INSERT OR IGNORE INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: [reportId, deviceKey, "sub-" + reportId, "Fixture Report", new Date().toISOString(), 100, 5, "Low", JSON.stringify({ score: 12, archiveScore: 5 }), accountId],
  });
}
async function indexSubmission(accountId, rawText) {
  await ensureUser(accountId);
  const identity = await createDocumentIdentity(client, { accountId, title: "T", author: null, rawText });
  return indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
}
async function snapshotRow(reportDeviceKey, reportId) {
  const result = await client.execute({
    sql: "SELECT * FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?",
    args: [reportDeviceKey, reportId],
  });
  return result.rows[0] ? { ...result.rows[0] } : null;
}
async function shadowCount(reportDeviceKey, reportId) {
  const result = await client.execute({
    sql: "SELECT COUNT(*) AS cnt FROM historical_match_shadow_evaluations WHERE report_device_key = ? AND report_id = ?",
    args: [reportDeviceKey, reportId],
  });
  return Number(result.rows[0].cnt);
}

// Deliberately the EXACT SAME filler text as tests/e8p-shadow-evaluation.test.mjs's
// own "partial-copy discovery" fixture (not just similarly-shaped new prose)
// — that exact text was empirically verified (see that file's own comment)
// to keep V0 containment just under production's real 0.5 threshold when
// paired with LONG_BLOCK. Swapping in different filler prose of similar
// length does NOT reliably reproduce the same threshold-straddling
// containment number — shingle-hash overlap is sensitive to exact word
// choice, not just word count, as this test file's own first draft
// confirmed the hard way. Own DB file, so reuse here is safe.
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

// --- STRUCTURAL SAFETY --------------------------------------------------------

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
const MODULE_SOURCE = stripComments(fs.readFileSync(path.join(repoRoot, "lib/e8p-visibility.ts"), "utf8"));

test("structural: default-safe — the allowlist is empty unless E8P_VISIBILITY_ALLOWLIST is explicitly set", () => {
  clearAllowlist();
  assert.equal(isE8pVisibilityAllowlisted(TEST_ACCOUNT), false, "with no env var set, every account must be excluded — default OFF");
  assert.equal(isE8pVisibilityAllowlisted(null), false, "anonymous accounts must never be allowlisted");
});

test("structural: the module never references report_historical_match_snapshots or historical_match_shadow_evaluations (never writes to either)", () => {
  assert.doesNotMatch(MODULE_SOURCE, /report_historical_match_snapshots/);
  assert.doesNotMatch(MODULE_SOURCE, /historical_match_shadow_evaluations/);
  assert.doesNotMatch(MODULE_SOURCE, /INSERT|UPDATE|DELETE/);
});

test("structural: the module never references a scoring field", () => {
  assert.doesNotMatch(MODULE_SOURCE, /\.score\s*=|\.archiveScore\s*=|\.aiScore\s*=|verifiedSimilarity/);
});

// --- D: OFF switch --------------------------------------------------------

test("D: OFF switch — clearing E8P_VISIBILITY_ALLOWLIST hides the experimental result even for what would otherwise be the test account", async () => {
  await indexSubmission(TEST_ACCOUNT + "-self-prior", HIST_DISTINCTIVE_DOCUMENT);
  await indexSubmission(TEST_ACCOUNT + "-noise", PARTIAL_COPY_NOISE_DOCUMENT);

  clearAllowlist();
  const result = await getExperimentalHistoricalMatchForDisplay(client, {
    accountId: TEST_ACCOUNT,
    rawText: PARTIAL_COPY_SUBMITTED_TEXT,
    productionResult: { status: "NO_HISTORICAL_MATCH", computedAt: new Date().toISOString(), matcherVersion: "v", fingerprintVersion: "v", canonicalizationVersion: "v" },
  });
  assert.equal(result, null, "with the allowlist cleared, no experimental result may be returned for anyone");
});

// --- B/F: test-account partial visibility (PRIOR_SUBMISSION) ---------------

// PHASE 6.7 UPDATE: this fixture (PARTIAL_COPY_SUBMITTED_TEXT, built around
// e8k-calibration-fixtures.ts's LONG_BLOCK) no longer escapes production.
// Phase 6.6 PART 2 added lib/document-correspondence.ts's distinctivePassageMatch
// — a single sufficiently long, sufficiently non-generic contiguous passage
// is now real production evidence on its own, independent of whole-document
// containment dilution. LONG_BLOCK's ~377 words clear it comfortably, so
// getOrComputeHistoricalMatchSnapshot now returns MATCHED here, and
// getExperimentalHistoricalMatchForDisplay's own first gate
// (lib/e8p-visibility.ts: "never runs, and never returns non-null, when
// production already found a real match") correctly, unchangedly returns
// null — exactly the same contract test A already established for an exact
// copy, now also verified for this distinctive-passage case. See
// tests/e8p-shadow-evaluation.test.mjs's own updated "partial-copy
// discovery" comment for the fuller architectural note on why a realistic
// single-passage fixture that production misses but the experimental
// policy would uniquely catch is no longer constructible from this
// codebase's existing calibration fixtures.
test("B/F: test account + ~40% partial copy from a DIFFERENT account -> production now finds it directly (Phase 6.6 PART 2); the experimental path correctly stays silent, exactly as it already does for an exact match (test A)", async () => {
  await indexSubmission("e8p-vis-other-account", HIST_DISTINCTIVE_DOCUMENT);
  await indexSubmission("e8p-vis-noise-account", PARTIAL_COPY_NOISE_DOCUMENT);

  setAllowlist(TEST_ACCOUNT);
  const deviceKey = "device-e8p-vis-partial";
  const reportId = "report-e8p-vis-partial";
  await ensureSavedReport(deviceKey, reportId, TEST_ACCOUNT);

  const productionResult = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: TEST_ACCOUNT, rawText: PARTIAL_COPY_SUBMITTED_TEXT });
  assert.equal(productionResult.status, "MATCHED", "Phase 6.7: production now finds this fixture directly via distinctivePassageMatch — see this test's own updated header comment");
  assert.equal(productionResult.matches[0].relationshipType, "PRIOR_SUBMISSION");

  const result = await getExperimentalHistoricalMatchForDisplay(client, { accountId: TEST_ACCOUNT, rawText: PARTIAL_COPY_SUBMITTED_TEXT, productionResult });
  assert.equal(result, null, "the experimental path must never activate when production already found a real match — same contract as test A, now also true for this fixture");

  // L: telemetry is unaffected by this call — this module never writes to it.
  assert.equal(await shadowCount(deviceKey, reportId), 0, "getExperimentalHistoricalMatchForDisplay must never write shadow telemetry itself");
  // K: production snapshot reflects the real, now-MATCHED result, and is unaffected by the (no-op) experimental call.
  const snapshot = await snapshotRow(deviceKey, reportId);
  assert.ok(snapshot);
  assert.equal(snapshot.status, "MATCHED");
});

// --- E: SELF ----------------------------------------------------------------

// PHASE 6.7 UPDATE: same root cause as B/F above — see that test's own
// header comment. Production now correctly classifies this as a real SELF
// match directly (via distinctivePassageMatch), so the experimental path
// correctly stays silent.
test("E: test account viewing their OWN previously-submitted content (diluted) -> production now classifies it SELF directly (Phase 6.6 PART 2); the experimental path correctly stays silent", async () => {
  await indexSubmission(TEST_ACCOUNT, HIST_DISTINCTIVE_DOCUMENT); // the account's own earlier upload
  await indexSubmission("e8p-vis-self-noise-account", PARTIAL_COPY_NOISE_DOCUMENT);

  setAllowlist(TEST_ACCOUNT);
  const deviceKey = "device-e8p-vis-self";
  const reportId = "report-e8p-vis-self";
  await ensureSavedReport(deviceKey, reportId, TEST_ACCOUNT);

  const productionResult = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: TEST_ACCOUNT, rawText: PARTIAL_COPY_SUBMITTED_TEXT });
  assert.equal(productionResult.status, "MATCHED", "Phase 6.7: production now finds this directly — see this test's own updated header comment");
  assert.equal(productionResult.matches[0].relationshipType, "SELF", "correctly classified SELF, not PRIOR_SUBMISSION, since this account is its own earlier submitter");

  const result = await getExperimentalHistoricalMatchForDisplay(client, { accountId: TEST_ACCOUNT, rawText: PARTIAL_COPY_SUBMITTED_TEXT, productionResult });
  assert.equal(result, null, "the experimental path must never activate when production already found a real match");
});

// --- C: non-test account unchanged ------------------------------------------

// PHASE 6.7 UPDATE: same root cause as B/F and E above. With the REAL
// production flow, PARTIAL_COPY_SUBMITTED_TEXT now resolves MATCHED for any
// account (allowlisted or not — distinctivePassageMatch does not care who
// is asking), so this fixture can no longer isolate "the allowlist itself
// is what's gating display" from "production already matched it" using the
// real flow alone — both would independently return null now. This test's
// own specific purpose (prove the allowlist, not production's own state, is
// the thing gating a non-allowlisted account) is preserved instead by
// reusing the exact synthetic-productionResult technique test D already
// established in this same file (a hand-constructed NO_HISTORICAL_MATCH
// object, bypassing getOrComputeHistoricalMatchSnapshot's real, now-MATCHED
// result) — this exercises getExperimentalHistoricalMatchForDisplay's own
// allowlist check in isolation, exactly as before.
test("C: non-allowlisted account sees no experimental result even when production's own gate would otherwise be open (isolates the allowlist check, same technique as test D)", async () => {
  await indexSubmission("e8p-vis-other-account-2", HIST_DISTINCTIVE_DOCUMENT);
  await indexSubmission("e8p-vis-noise-account-2", PARTIAL_COPY_NOISE_DOCUMENT);

  setAllowlist(TEST_ACCOUNT); // NON_TEST_ACCOUNT deliberately not included
  const deviceKey = "device-e8p-vis-nontest";
  const reportId = "report-e8p-vis-nontest";
  await ensureSavedReport(deviceKey, reportId, NON_TEST_ACCOUNT);

  const syntheticNoMatch = { status: "NO_HISTORICAL_MATCH", computedAt: new Date().toISOString(), matcherVersion: "v", fingerprintVersion: "v", canonicalizationVersion: "v" };
  const result = await getExperimentalHistoricalMatchForDisplay(client, { accountId: NON_TEST_ACCOUNT, rawText: PARTIAL_COPY_SUBMITTED_TEXT, productionResult: syntheticNoMatch });
  assert.equal(result, null, "a non-allowlisted account must never receive an experimental result, even when production's own real-match gate is bypassed and the underlying corpus content would otherwise qualify for the test account");
});

// --- G: NO_HISTORICAL_MATCH (nothing at all) --------------------------------

test("G: test account + genuinely unrelated document -> no experimental result", async () => {
  setAllowlist(TEST_ACCOUNT);
  const deviceKey = "device-e8p-vis-unrelated";
  const reportId = "report-e8p-vis-unrelated";
  await ensureSavedReport(deviceKey, reportId, TEST_ACCOUNT);
  const unrelatedText = "Marine biologists tagging juvenile sea turtles recorded dispersal patterns diverging sharply from previously modeled current-driven trajectories in the region, e8p-vis-unrelated-marker, with enough distinct words to be a valid query.";

  const productionResult = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: TEST_ACCOUNT, rawText: unrelatedText });
  assert.equal(productionResult.status, "NO_HISTORICAL_MATCH");

  const result = await getExperimentalHistoricalMatchForDisplay(client, { accountId: TEST_ACCOUNT, rawText: unrelatedText, productionResult });
  assert.equal(result, null);
});

// --- A: test account + exact copy — production's own MATCHED path is untouched ---

test("A: test account + exact copy -> production's own MATCHED result is untouched, and no experimental result is generated (nothing to add)", async () => {
  const exactText = "Cryptographers auditing a legacy authentication protocol identified a timing side channel in its password comparison routine, e8p-vis-exact-marker, with enough distinct words for a real fixture.";
  await indexSubmission("e8p-vis-exact-owner", exactText);

  setAllowlist(TEST_ACCOUNT);
  const deviceKey = "device-e8p-vis-exact";
  const reportId = "report-e8p-vis-exact";
  await ensureSavedReport(deviceKey, reportId, TEST_ACCOUNT);

  const productionResult = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: deviceKey, reportId, accountId: TEST_ACCOUNT, rawText: exactText });
  assert.equal(productionResult.status, "MATCHED", "precondition: an exact copy must already be a real production match");

  const result = await getExperimentalHistoricalMatchForDisplay(client, { accountId: TEST_ACCOUNT, rawText: exactText, productionResult });
  assert.equal(result, null, "the experimental path must never activate when production already found a real match");
});

// --- H/I/J: invariance and privacy, verified via the real deferred+display paths together ---

// PHASE 6.7 UPDATE: this test's own purpose is different from B/F/E/C above
// — those prove WHEN the experimental path does/doesn't activate; this one
// verifies WHAT the experimental result itself looks like once it exists
// (score invariance, no identity leakage, current-document-only passages).
// With the REAL production flow, PARTIAL_COPY_SUBMITTED_TEXT now resolves
// MATCHED (Phase 6.6 PART 2 — see B/F's own header comment), which would
// make getExperimentalHistoricalMatchForDisplay correctly return null
// before ever reaching the content this test needs to inspect. Reuses the
// same synthetic-productionResult technique as test C/D (a hand-constructed
// NO_HISTORICAL_MATCH object) to genuinely drive the experimental path's
// own internal computation for this check — lib/e8p-visibility.ts computes
// its own per-candidate whole-document signal fresh from
// computeDocumentCorrespondence regardless of the caller-supplied
// productionResult, so this still exercises its real passage/privacy logic
// end to end, only bypassing the outer gate this test is not about.
test("H/I/J: score/archiveScore invariant, no identity leakage, passages are current-document-only", async () => {
  await indexSubmission("e8p-vis-hij-other-account", HIST_DISTINCTIVE_DOCUMENT);
  await indexSubmission("e8p-vis-hij-noise-account", PARTIAL_COPY_NOISE_DOCUMENT);

  setAllowlist(TEST_ACCOUNT);
  const deviceKey = "device-e8p-vis-hij";
  const reportId = "report-e8p-vis-hij";
  const payload = { score: 12, archiveScore: 5 };
  await ensureUser(TEST_ACCOUNT);
  await client.execute({
    sql: `INSERT OR IGNORE INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: [reportId, deviceKey, "sub-" + reportId, "Fixture Report", new Date().toISOString(), 100, 5, "Low", JSON.stringify(payload), TEST_ACCOUNT],
  });

  const syntheticNoMatch = { status: "NO_HISTORICAL_MATCH", computedAt: new Date().toISOString(), matcherVersion: "v", fingerprintVersion: "v", canonicalizationVersion: "v" };
  const result = await getExperimentalHistoricalMatchForDisplay(client, { accountId: TEST_ACCOUNT, rawText: PARTIAL_COPY_SUBMITTED_TEXT, productionResult: syntheticNoMatch });
  assert.ok(result, "the experimental path's own internal candidate search must still genuinely find and classify this content when its outer gate is bypassed");

  // H: score/archiveScore on the underlying report row are untouched.
  const reportRow = await client.execute({ sql: "SELECT archive_score, payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, reportId] });
  assert.equal(Number(reportRow.rows[0].archive_score), 5);
  const parsedPayload = JSON.parse(String(reportRow.rows[0].payload_json));
  assert.equal(parsedPayload.score, 12);
  assert.equal(parsedPayload.archiveScore, 5);

  // I: no identity leakage — the OTHER account's id/email must never appear anywhere in the result.
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("e8p-vis-hij-other-account"));
  assert.ok(!serialized.includes("e8p-vis-hij-noise-account"));
  assert.ok(!serialized.includes("@"), "no email-shaped string should ever appear in the experimental result");

  // J: every passage is current-document-only — none of HIST_DISTINCTIVE_DOCUMENT's own unique sentences (e.g. from EXCERPT_ZONE_TEXT, never part of PARTIAL_COPY_SUBMITTED_TEXT) may appear.
  for (const p of result.passages) {
    assert.ok(!p.submittedText.includes("Kestrel Deep"), "a passage must never contain text unique to the historical document");
  }
});

// --- M: deterministic rendering ---------------------------------------------

test("M: deterministic — repeated calls with unchanged corpus state return identical experimental results", async () => {
  await indexSubmission("e8p-vis-det-other-account", HIST_DISTINCTIVE_DOCUMENT);
  await indexSubmission("e8p-vis-det-noise-account", PARTIAL_COPY_NOISE_DOCUMENT);

  setAllowlist(TEST_ACCOUNT);
  const productionResult = { status: "NO_HISTORICAL_MATCH", computedAt: new Date().toISOString(), matcherVersion: "v", fingerprintVersion: "v", canonicalizationVersion: "v" };

  const first = await getExperimentalHistoricalMatchForDisplay(client, { accountId: TEST_ACCOUNT, rawText: PARTIAL_COPY_SUBMITTED_TEXT, productionResult });
  const second = await getExperimentalHistoricalMatchForDisplay(client, { accountId: TEST_ACCOUNT, rawText: PARTIAL_COPY_SUBMITTED_TEXT, productionResult });
  assert.deepEqual(first, second);
});

// --- UI rendering: reuses the existing "Previously submitted content" section ---

function baseReport(overrides = {}) {
  return {
    version: 11, id: 1, submissionId: "sub-e8p-vis-1", title: "e8p-vis-fixture.pdf", author: "", assignment: "",
    created: new Date().toISOString(), score: 12, archiveScore: 9, wordCount: 1500, characterCount: 8000, pageCount: 4,
    fileSize: "10 KB", databaseSize: 230, corpusVersion: "archive-v1-230-test", scoreBand: "Low", riskStatus: "Lower",
    riskTarget: 0.5, riskCutoff: 0.5, riskCalibration: { auc: 0.9, precision: 0.9, recall: 0.9, sampleSize: 100 },
    features: { maxSourceContainment: 0, longestMatchedSpan: 0, quotationDensity: 0, referenceListRatio: 0, highFrequencyShingleCount: 0, repeatedThreeGramCount: 0, detectedLanguage: "English" },
    excludedDocuments: 0, matchedWordCount: 0, sources: [], repeats: [], text: "fixture text not used by OverviewReport directly",
    ...overrides,
  };
}
function render(report) {
  return renderToStaticMarkup(React.createElement(OverviewReport, { report }));
}
const EXPERIMENTAL_PARTIAL = {
  status: "HISTORICAL_PARTIAL_MATCH",
  relationship: "PRIOR_SUBMISSION",
  evidence: "MULTIPLE_DISTINCTIVE_PASSAGES",
  matchedWordCount: 377,
  containment: 0.4993,
  passageCount: 1,
  passages: [{ submittedText: "a bounded excerpt of the current document only", submittedWordStart: 0, submittedWordEnd: 8, matchedWordCount: 8 }],
  disclaimer: "This is historical submission evidence only, not a plagiarism verdict.",
};

test("UI: experimental section renders inside the existing 'Previously submitted content' heading, not a second section", () => {
  const html = render(baseReport({ experimentalHistoricalMatch: EXPERIMENTAL_PARTIAL }));
  const headingCount = (html.match(/Previously submitted content/g) || []).length;
  assert.equal(headingCount, 1, "must reuse the existing heading, not create a second one");
  assert.match(html, /Historical submission evidence \(experimental\)/);
  assert.match(html, /This content was previously submitted to TurnitPlus\./);
  assert.match(html, /a bounded excerpt of the current document only/);
  assert.match(html, /not a plagiarism verdict/i);
});

test("UI: experimental section never renders alongside a real production match (historicalSubmissionMatch takes priority)", () => {
  const html = render(baseReport({
    historicalSubmissionMatch: {
      status: "MATCHED", computedAt: new Date().toISOString(), matcherVersion: "v", fingerprintVersion: "v", canonicalizationVersion: "v",
      matches: [{ relationshipType: "SELF", matchedRepresentationId: "r1", matchType: "EXACT_CANONICAL_MATCH", containment: 1, matchedWordCount: 100, passageCount: 1, longestMatchWords: 100, passages: [], historicalSubmissionCount: 0 }],
    },
    experimentalHistoricalMatch: EXPERIMENTAL_PARTIAL, // should never happen together in practice, but the UI must be defensive regardless
  }));
  assert.doesNotMatch(html, /experimental/i, "the experimental block must never render when a real production match already exists");
});

test("UI: no experimental section when experimentalHistoricalMatch is absent (ordinary/non-test-account report)", () => {
  const html = render(baseReport({}));
  assert.doesNotMatch(html, /experimental/i);
  assert.doesNotMatch(html, /Previously submitted content/);
});

test("UI: never accuses the submitter of plagiarism/stealing/cheating — 'plagiarism' may only appear inside the required disclaimer negation", () => {
  const html = render(baseReport({ experimentalHistoricalMatch: EXPERIMENTAL_PARTIAL }));
  const sectionMatch = html.match(/<section class="historical-match-block historical-match-block-experimental">[\s\S]*?<\/section>/);
  assert.ok(sectionMatch);
  assert.doesNotMatch(sectionMatch[0], /\bstolen\b|\bcheat(ing|ed)?\b/i, "must never use accusatory wording");
  // "plagiarism" is expected exactly twice, and only ever negated ("not ...plagiarism"): once from
  // E8O's own UI_CONTRACT disclaimer, once from the section 8-required "This is not proof of plagiarism." sentence.
  const plagiarismMentions = sectionMatch[0].match(/[^.]*\bplagiarism\b[^.]*\./gi) ?? [];
  assert.equal(plagiarismMentions.length, 2, `expected exactly 2 sentences mentioning "plagiarism", found: ${JSON.stringify(plagiarismMentions)}`);
  for (const sentence of plagiarismMentions) {
    assert.match(sentence, /\bnot\b/i, `every sentence mentioning "plagiarism" must be a negation/disclaimer, got: "${sentence}"`);
  }
});
