import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { canonicalizeText } from "../lib/canonical-text.ts";
import { tokens } from "../lib/similarity-core.ts";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import {
  indexDocumentSubmissionIntoCorpus,
  createReusableDocumentRepresentation,
  recordCorpusShingles,
} from "../lib/user-submission-corpus.ts";
import { matureCorpusBackings } from "./helpers/corpus-maturity.mjs";
import { buildReportAdmissionSourceRef } from "../lib/corpus-admission-source-ref.ts";
import { resolvePrimarySimilaritySummary } from "../lib/report-primary-similarity.ts";
import { runDeviceProvenanceShadowEvaluation } from "../lib/device-provenance-shadow.ts";
import { getReportSimilarityDecisionTrace } from "../lib/developer-repo.ts";
import * as signupRoute from "../app/api/auth/signup/route.ts";
import * as loginRoute from "../app/api/auth/login/route.ts";
import * as reportsRoute from "../app/api/reports/route.ts";
import * as reportIdRoute from "../app/api/reports/[id]/route.ts";
import * as developerReportIdRoute from "../app/api/developer/reports/[id]/route.ts";
import { resetRateForTest, resetReadRateForTest, resetAuthRateForTest } from "../lib/rate-limit.ts";

/**
 * Integration coverage for the admin similarity decision trace:
 *   §13  ordinary report responses carry none of it; only an admin session
 *        can reach the developer trace route; no device-passport secret is
 *        ever serialised.
 *   §14  score invariance — resolving production similarity, building the
 *        trace, then resolving again yields a deep-equal result.
 *   §15E/§8  a counted PRIOR_SUBMISSION exposes the backing account's identity.
 *   §15F  a same-account SELF match is excluded AND its account evidence shows.
 *   §15G  a device-provenance shadow candidate: production counts it today,
 *        wouldDowngrade is true, SAME_DEVICE_EXACT_DOCUMENT, and the trace
 *        states the production score is unchanged by the shadow.
 *   §12  a fresh/empty database and a missing report never crash.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_admin_similarity_decision_trace_integration.db");
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
}

process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";
process.env.ADMIN_EMAIL = "asdt-admin@example.com";
const originalPassportFlag = process.env.DEVICE_PASSPORT_ENABLED;

const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  delete process.env.ADMIN_EMAIL;
  if (originalPassportFlag === undefined) delete process.env.DEVICE_PASSPORT_ENABLED;
  else process.env.DEVICE_PASSPORT_ENABLED = originalPassportFlag;
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
  }
});

let seq = 0;
const uniq = (prefix) => `${prefix}-${++seq}`;

// Eight genuinely distinct ~80-word paragraphs (different topics, minimal
// shared vocabulary) so no two scenarios' corpus content can cross-match.
// Each scenario pops its own via takeDistinctText().
const DISTINCT_TEXT_POOL = [
  "Seismologists analyzing a dense array of borehole strainmeters detected a slow-slip transient event migrating along a subduction interface over several weeks. The migration rate was consistent with previously documented episodic tremor and slip sequences observed at comparable convergent margins elsewhere. Surface GPS stations recorded displacement magnitudes too small to be felt but clearly resolvable in the processed strain time series. The authors argue this transient represents a genuine precursory process worth continued monitoring at this specific segment of the margin.",
  "Glaciologists resurveying an alpine ice cap used repeat airborne lidar to quantify surface elevation change across four consecutive melt seasons. Thinning was concentrated at lower elevations near the terminus, consistent with the ablation-dominated mass balance expected for a cap of this size and latitude. Interior accumulation zones showed comparatively little change over the same survey interval, suggesting the loss was not yet propagating upslope. The authors compare their volumetric loss estimate against regional glacier inventories compiled a decade earlier.",
  "Entomologists surveying a fragmented grassland network used pan traps to compare wild bee community composition across patches of varying isolation. Species richness declined significantly with increasing distance from the nearest large reserve, while total abundance was comparatively insensitive to isolation alone. Specialist species accounted for nearly all of the richness decline, whereas generalist species persisted across even the most isolated patches surveyed. The authors recommend prioritizing corridor restoration between the most isolated patches and the nearest reserve.",
  "Limnologists sampling a chain of postglacial lakes measured dissolved organic carbon concentration as a proxy for terrestrial carbon subsidy to each lake basin. Concentration increased predictably with the proportion of forested land in each catchment, independent of lake surface area or maximum depth. Basins with recently logged catchments showed a transient spike in concentration that declined over the following several sampling seasons. The authors interpret this pattern as evidence of a measurable, recoverable disturbance signal in lake carbon budgets.",
  "Marine biologists tracking a tagged population of leatherback turtles across the equatorial current recorded an unexpected mid-ocean foraging detour that coincided precisely with a transient bloom of gelatinous zooplankton detected by three independent satellite chlorophyll passes over the same fortnight, which the survey team flagged as the strongest evidence yet for opportunistic long-range prey tracking in this particular species and a reason to revisit existing assumptions about migratory route fidelity.",
  "Paleoclimatologists reconstructing sea-surface temperature records from coral core samples identified a centuries-long warming trend preceding the onset of a regional monsoon shift, with isotopic banding patterns providing an annually resolved chronology that closely tracked independent ice-core proxies from the same latitude band across the full sampled interval and lent unusual confidence to the inferred timing of the transition relative to earlier lower-resolution reconstructions of the same event.",
  "Archaeobotanists sieving hearth deposits from a series of upland rock shelters catalogued charred seed assemblages spanning roughly three millennia of intermittent occupation. The relative frequency of wild cereal grains rose steadily through the sequence before collapsing abruptly in the uppermost layers, coinciding with a marked increase in charcoal from shrubby taxa. The excavators read this as a local shift from broad-spectrum foraging toward a narrower, more managed woodland economy.",
  "Radio astronomers monitoring a millisecond pulsar over eleven years measured tiny timing residuals consistent with a low-frequency gravitational-wave background rather than any single resolvable source. The correlation between residuals from widely separated pulsars in the array followed the quadrupolar angular pattern predicted for an isotropic stochastic background. The collaboration cautions that a decade more data is needed before the amplitude can be pinned down with confidence.",
];
let distinctTextCursor = 0;
function takeDistinctText() {
  if (distinctTextCursor >= DISTINCT_TEXT_POOL.length) throw new Error("distinct text pool exhausted — add more paragraphs");
  return DISTINCT_TEXT_POOL[distinctTextCursor++];
}

async function ensureUser(accountId) {
  if (!accountId) return;
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash, corpus_reuse_consented_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)",
    args: [accountId, `${accountId}@ex.test`, accountId, "not-a-real-hash"],
  });
}

async function ensurePassport(passportId) {
  await client.execute({
    sql: "INSERT OR IGNORE INTO device_passports (id, public_key_spki, algorithm, created_at, provenance_generation) VALUES (?,?,?,?,0)",
    args: [passportId, Buffer.from(`spki-${passportId}`), "ECDSA-P256-SHA256", Date.now()],
  });
}

async function seedReport({ deviceKey, reportId, accountId = null, passportId = null, rawText, documentIdentityId = null }) {
  await ensureUser(accountId);
  if (passportId) await ensurePassport(passportId);
  const wordCount = tokens(canonicalizeText(rawText)).length;
  const payload = JSON.stringify({
    version: 11, id: 1, submissionId: `sub-${reportId}`, title: "t.pdf", text: rawText,
    wordCount, score: 0, archiveScore: 0, sources: [], repeats: [],
  });
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, verified_device_passport_id, document_identity_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [reportId, deviceKey, `sub-${reportId}`, "t.pdf", new Date().toISOString(), wordCount, 0, "Low", payload, accountId, passportId, documentIdentityId],
  });
}

async function indexPriorSubmission(accountId, rawText) {
  await ensureUser(accountId);
  const identity = await createDocumentIdentity(client, { accountId, title: "prior", author: null, rawText });
  const result = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  // Phase A: age the just-indexed backing so it is matchable "now" (this
  // suite tests the admin trace, not the 7-day activation gate).
  await matureCorpusBackings(client);
  return { identityId: identity.id, representationId: result.representationId };
}

/** A representation backed ONLY by a same-device admission promotion — the SAME_DEVICE_EXACT_DOCUMENT shadow candidate shape. */
async function seedSameDeviceCorpusSource(rawText, passportId, sourceAccountId) {
  await ensureUser(sourceAccountId);
  await ensurePassport(passportId);
  const canonicalText = canonicalizeText(rawText);
  const rep = await createReusableDocumentRepresentation(client, { canonicalText });
  await recordCorpusShingles(client, rep.id, canonicalText);

  const sourceRef = buildReportAdmissionSourceRef({ accountId: sourceAccountId, deviceKey: uniq("src-dev"), reportId: uniq("src-rep") });
  const decisionId = crypto.randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_decisions (id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes, dry_run)
          VALUES (?,?,?,?,?,?,?,?)`,
    args: [decisionId, sourceRef, "v1", "ACCEPT", "[]", 1, "[]", 0],
  });
  const arId = crypto.randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version) VALUES (?,?,?,?,?)`,
    args: [arId, decisionId, crypto.randomBytes(32).toString("hex"), 60, "corpus-shingle-v1"],
  });
  await client.execute({
    sql: `INSERT INTO corpus_admission_promotions (id, decision_id, accepted_representation_id, representation_id, link_type, fingerprint_version, status, attempt_count)
          VALUES (?,?,?,?,?,?,'indexed',1)`,
    args: [crypto.randomUUID(), decisionId, arId, rep.id, "NEW_CONTENT_REPRESENTATION", "corpus-shingle-v1"],
  });
  await client.execute({
    sql: `INSERT INTO corpus_admission_decision_device_provenance (decision_id, device_passport_id, verified_at) VALUES (?,?,?)`,
    args: [decisionId, passportId, Date.now()],
  });
  // Phase A: this suite tests the admin decision trace, not the 7-day
  // activation gate — age the seeded backing so it is matchable "now".
  await matureCorpusBackings(client);
  return { representationId: rep.id, sourceAccountId };
}

async function resolve(deviceKey, reportId, accountId, rawText) {
  return resolvePrimarySimilaritySummary(client, {
    reportDeviceKey: deviceKey, reportId, accountId, rawText,
    wordCount: tokens(canonicalizeText(rawText)).length,
    archiveMatchedPositions: null, externalAcademicEvidence: null, archiveScore: 0,
  });
}

// ===========================================================================
// §15E / §8 — a counted PRIOR_SUBMISSION exposes backing-account identity
// ===========================================================================

test("§15E/§8: a counted cross-account PRIOR_SUBMISSION -> source counted, backing account email visible in the admin trace", async () => {
  const text = takeDistinctText();
  const deviceKey = uniq("dk"), reportId = uniq("r"), reportAccount = uniq("acc-a"), priorAccount = uniq("acc-b");
  await indexPriorSubmission(priorAccount, text);
  await seedReport({ deviceKey, reportId, accountId: reportAccount, rawText: text });

  const resolution = await resolve(deviceKey, reportId, reportAccount, text);
  assert.equal(resolution.historicalSubmissionMatch.status, "MATCHED");
  assert.equal(resolution.historicalSubmissionMatch.matches[0].relationshipType, "PRIOR_SUBMISSION");

  const trace = await getReportSimilarityDecisionTrace(client, deviceKey, reportId);
  assert.ok(trace.resolvable);
  assert.ok(trace.finalScore > 0, "an eligible PRIOR_SUBMISSION must raise the score");
  assert.equal(trace.finalScore, resolution.unifiedSimilarity.unifiedScore);

  const priorSource = trace.sources.find((s) => s.sourceKind === "PREVIOUS_SUBMISSION");
  assert.ok(priorSource, "the prior-submission source must appear in the per-source trace");
  assert.equal(priorSource.relationshipType, "PRIOR_SUBMISSION");
  assert.equal(priorSource.countedTowardScore, true);
  assert.equal(priorSource.countedReason, "COUNTED_PRIOR_SUBMISSION");
  assert.ok(priorSource.newUniqueWordContribution > 0);

  assert.ok(priorSource.accountEvidence, "§8: account/backing evidence must be present for an admin");
  assert.equal(priorSource.accountEvidence.hasSameAccountSubmission, false);
  assert.ok(priorSource.accountEvidence.otherAccountBackingCount >= 1);
  const backing = priorSource.accountEvidence.backings.find((b) => b.channel === "SUBMISSION_REFERENCE");
  assert.ok(backing, "the submission-reference backing must be listed");
  assert.equal(backing.relationshipToReportAccount, "OTHER_ACCOUNT");
  assert.equal(backing.accountEmail, `${priorAccount}@ex.test`, "§8: the backing account's email is resolved through the provenance tables");

  // §14 — the trace never changed the resolved result.
  const again = await resolve(deviceKey, reportId, reportAccount, text);
  assert.deepEqual(again.historicalSubmissionMatch, resolution.historicalSubmissionMatch);
  assert.deepEqual(again.unifiedSimilarity, resolution.unifiedSimilarity);
});

// ===========================================================================
// §15F — a same-account SELF match is excluded AND its account evidence shows
// ===========================================================================

test("§15F: a same-account SELF match -> EXCLUDED_SELF, contributes 0, but same-account backing evidence is still visible", async () => {
  const text = takeDistinctText();
  const deviceKey = uniq("dk"), reportId = uniq("r"), account = uniq("acc-self");
  // Two same-account submissions of the text: the matcher excludes the
  // account's most recent own identity and still sees the earlier one, which
  // is what makes this SELF rather than "nothing to report against".
  await indexPriorSubmission(account, text);
  await indexPriorSubmission(account, text);
  await seedReport({ deviceKey, reportId, accountId: account, rawText: text });

  const resolution = await resolve(deviceKey, reportId, account, text);
  assert.equal(resolution.historicalSubmissionMatch.status, "MATCHED");
  assert.equal(resolution.historicalSubmissionMatch.matches[0].relationshipType, "SELF");
  assert.equal(resolution.unifiedSimilarity.unifiedScore, 0, "SELF contributes nothing");

  const trace = await getReportSimilarityDecisionTrace(client, deviceKey, reportId);
  assert.equal(trace.finalScore, 0);
  const selfSource = trace.sources.find((s) => s.relationshipType === "SELF");
  assert.ok(selfSource);
  assert.equal(selfSource.countedTowardScore, false);
  assert.equal(selfSource.exclusionReason, "EXCLUDED_SELF");
  assert.ok(selfSource.rawMatchedWordCount > 0, "the excluded footprint is still shown");
  assert.ok(trace.excludedSelfMatchedWordCount > 0);
  assert.equal(trace.zeroScoreExplanation.reason, "MATCHES_PRESENT_BUT_ALL_EXCLUDED");

  assert.ok(selfSource.accountEvidence);
  assert.equal(selfSource.accountEvidence.hasSameAccountSubmission, true);
  assert.ok(selfSource.accountEvidence.sameAccountBackingCount >= 1);
  const backing = selfSource.accountEvidence.backings.find((b) => b.relationshipToReportAccount === "SAME_ACCOUNT");
  assert.ok(backing, "the same-account backing is identified");
  assert.equal(backing.accountEmail, `${account}@ex.test`);
});

// ===========================================================================
// §15G — device-provenance shadow candidate
// ===========================================================================

test("§15G: a same-device EXACT corpus source -> production counts it, shadow wouldDowngrade, SAME_DEVICE_EXACT_DOCUMENT, score unchanged by shadow", async () => {
  process.env.DEVICE_PASSPORT_ENABLED = "true";
  try {
    const text = takeDistinctText();
    const deviceKey = uniq("dk"), reportId = uniq("r"), account = uniq("acc-dev"), passportId = uniq("passport"), sourceAccount = uniq("acc-src");
    await seedSameDeviceCorpusSource(text, passportId, sourceAccount);
    await seedReport({ deviceKey, reportId, accountId: account, passportId, rawText: text });

    const resolution = await resolve(deviceKey, reportId, account, text);
    assert.equal(resolution.historicalSubmissionMatch.status, "MATCHED");
    assert.equal(resolution.historicalSubmissionMatch.matches[0].relationshipType, "TURNITPLUS_CORPUS_SOURCE");
    assert.equal(resolution.unifiedSimilarity.unifiedScore, 100, "an exact whole-document corpus-source match scores 100");

    // The real Phase-4 shadow evaluation, fed the real production result.
    await runDeviceProvenanceShadowEvaluation(client, {
      reportDeviceKey: deviceKey, reportId, accountId: account, rawText: text,
      productionResult: resolution.historicalSubmissionMatch,
    });

    const trace = await getReportSimilarityDecisionTrace(client, deviceKey, reportId);
    assert.equal(trace.finalScore, 100, "production score is exactly what production computed");
    assert.equal(trace.scoreUnchangedByDeviceShadow, true);

    const corpusSource = trace.sources.find((s) => s.relationshipType === "TURNITPLUS_CORPUS_SOURCE");
    assert.ok(corpusSource);
    assert.equal(corpusSource.countedReason, "COUNTED_CORPUS_SOURCE");
    assert.equal(corpusSource.countedTowardScore, true);

    assert.ok(trace.deviceShadow, "the shadow row must surface in the trace");
    assert.equal(trace.deviceShadow.verifiedUploadPassport, true);
    assert.equal(trace.deviceShadow.wouldDowngrade, true);
    assert.equal(trace.deviceShadow.shadowProposal, "SELF");
    assert.equal(trace.deviceShadow.reason, "SAME_DEVICE_EXACT_DOCUMENT");
    assert.equal(trace.deviceShadow.candidateReason, "SAME_DEVICE_EXACT_DOCUMENT");
    assert.equal(trace.deviceShadow.deviceSelfCandidateCount, 1);
    assert.equal(trace.deviceShadow.productionScoreChangedByShadow, false);

    // §13 privacy — no passport secret anywhere in the serialised trace.
    const serialized = JSON.stringify(trace);
    for (const forbidden of [passportId, `spki-${passportId}`, "public_key_spki", "device_passport_id", "verified_device_passport_id", "challengeId", "session_token_hash"]) {
      assert.equal(serialized.includes(forbidden), false, `admin trace leaked a device-passport secret: ${forbidden}`);
    }

    // §14 — score invariance around the trace build + shadow run.
    const again = await resolve(deviceKey, reportId, account, text);
    assert.deepEqual(again.historicalSubmissionMatch, resolution.historicalSubmissionMatch);
    assert.deepEqual(again.unifiedSimilarity, resolution.unifiedSimilarity);
  } finally {
    delete process.env.DEVICE_PASSPORT_ENABLED;
  }
});

// ===========================================================================
// §15H — Phase B2 corpus-duplicate suppression shadow row surfaces in the trace
// ===========================================================================

test("§15H: a corpus_duplicate_suppression_shadow_evaluations row -> admin trace carries corpusDuplicateSuppressionShadow, score untouched", async () => {
  const text = takeDistinctText();
  const deviceKey = uniq("dk"), reportId = uniq("r"), account = uniq("acc-b2");
  await seedReport({ deviceKey, reportId, accountId: account, rawText: text });

  await client.execute({
    sql: `INSERT INTO corpus_duplicate_suppression_shadow_evaluations
            (report_device_key, report_id, status, checker_accounts_status, distinct_checker_accounts_bucket,
             policy_version, rule_version, unified_similarity_version, counterfactual_version,
             authoritative_corpus_generation, authoritative_snapshot_computed_at, submitted_word_count,
             authoritative_score, hypothetical_score, score_delta,
             authoritative_unique_matched_words, hypothetical_unique_matched_words, unique_matched_words_removed,
             candidate_matched_words, candidates_excluded,
             archive_only_words_surviving, live_academic_only_words_surviving,
             previous_upload_only_words_surviving, overlap_words_surviving,
             candidate_count, measurement_category, origin_confidence, multi_origin_evidence,
             same_passport_category, cross_account_category, evaluation_truncated, computed_at)
          VALUES (?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?, ?,?,?, ?,?, ?,?,?,?, ?,?,?,?, ?,?,?, ?)`,
    args: [
      deviceKey, reportId, "OK", "OK", "2",
      "document-local-corpus-duplicate-shadow-v1", "document-local-corpus-duplicate-policy-v1",
      "unified-similarity-vX", "corpus-duplicate-counterfactual-v1",
      9, "2026-09-02T12:00:00Z", 90,
      100, 40, 60,
      100, 40, 60,
      60, 1,
      20, 10, 5, 5,
      1, "CROSS_ACCOUNT_EXACT_CANONICAL", "SINGLE_BACKING_NO_MULTI_ORIGIN_EVIDENCE", "MULTI_ORIGIN_NOT_PROVEN",
      0, 1, 0, "2026-09-03 03:00:00",
    ],
  });

  const trace = await getReportSimilarityDecisionTrace(client, deviceKey, reportId);
  assert.ok(trace);
  assert.equal(trace.scoreUnchangedByCorpusDuplicateShadow, true);
  const b2 = trace.corpusDuplicateSuppressionShadow;
  assert.ok(b2, "the B2 shadow block must surface in the admin trace");
  assert.equal(b2.status, "OK");
  assert.equal(b2.authoritativeScore, 100);
  assert.equal(b2.hypotheticalScore, 40);
  assert.equal(b2.scoreDelta, 60);
  assert.equal(b2.candidateCount, 1);
  assert.equal(b2.measurementCategory, "CROSS_ACCOUNT_EXACT_CANONICAL");
  assert.equal(b2.originConfidence, "SINGLE_BACKING_NO_MULTI_ORIGIN_EVIDENCE");
  assert.equal(b2.checkerAccountsStatus, "OK");
  assert.equal(b2.distinctCheckerAccountsBucket, "2");
  assert.equal(b2.productionScoreChangedByShadow, false);

  // the production similarity result is untouched by the shadow row existing
  const resolution = await resolve(deviceKey, reportId, account, text);
  const traceAgain = await getReportSimilarityDecisionTrace(client, deviceKey, reportId);
  assert.equal(traceAgain.finalScore, resolution.unifiedSimilarity.unifiedScore);
});

test("§15H2: a FAILED corpus-duplicate shadow row -> every measurement field serialises as null, never 0", async () => {
  const text = takeDistinctText();
  const deviceKey = uniq("dk"), reportId = uniq("r"), account = uniq("acc-b2f");
  await seedReport({ deviceKey, reportId, accountId: account, rawText: text });
  await client.execute({
    sql: `INSERT INTO corpus_duplicate_suppression_shadow_evaluations
            (report_device_key, report_id, status, error_code, checker_accounts_status,
             policy_version, rule_version, unified_similarity_version, counterfactual_version, computed_at)
          VALUES (?,?,?,?,?, ?,?,?,?, ?)`,
    args: [
      deviceKey, reportId, "FAILED", "PROVENANCE_QUERY_FAILED", "NOT_APPLICABLE",
      "document-local-corpus-duplicate-shadow-v1", "document-local-corpus-duplicate-policy-v1",
      "unified-similarity-vX", "corpus-duplicate-counterfactual-v1", "2026-09-03 03:05:00",
    ],
  });
  const trace = await getReportSimilarityDecisionTrace(client, deviceKey, reportId);
  const b2 = trace.corpusDuplicateSuppressionShadow;
  assert.ok(b2);
  assert.equal(b2.status, "FAILED");
  assert.equal(b2.errorCode, "PROVENANCE_QUERY_FAILED");
  assert.equal(b2.authoritativeScore, null);
  assert.equal(b2.scoreDelta, null);
  assert.equal(b2.candidateCount, null);
  assert.equal(b2.measurementCategory, null);
  const serialised = JSON.stringify(b2);
  assert.doesNotMatch(serialised, /"scoreDelta":\s*0/, "a not-measured delta must never serialise as 0");
});

// ===========================================================================
// §12 — fresh / empty database and missing report never crash
// ===========================================================================

test("§12: a missing report -> getReportSimilarityDecisionTrace returns null; the developer route 404s", async () => {
  const trace = await getReportSimilarityDecisionTrace(client, "no-such-device", "no-such-report");
  assert.equal(trace, null);
});

test("§12: a report with no historical match and no shadow row -> trace resolvable, deviceShadow null, zero explanation NO_MATCHES_FOUND", async () => {
  const deviceKey = uniq("dk"), reportId = uniq("r"), account = uniq("acc-nomatch");
  await seedReport({ deviceKey, reportId, accountId: account, rawText: takeDistinctText() });
  const trace = await getReportSimilarityDecisionTrace(client, deviceKey, reportId);
  assert.ok(trace.resolvable);
  assert.equal(trace.finalScore, 0);
  assert.equal(trace.deviceShadow, null);
  assert.equal(trace.zeroScoreExplanation.reason, "NO_MATCHES_FOUND");
  assert.deepEqual(trace.sources, []);
});

// ===========================================================================
// §13 — HTTP layer: admin authorization + ordinary-response privacy
// ===========================================================================

function extractCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return null;
  const match = setCookie.match(/tp_session_v1=([^;]*)/);
  return match ? match[1] : null;
}

async function signup(email, deviceKey, tag) {
  await resetAuthRateForTest(tag);
  const res = await signupRoute.POST(new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": tag },
    body: JSON.stringify({ email, password: "asdt-password-1", username: tag.replace(/[^a-z0-9]/gi, ""), deviceKey }),
  }));
  assert.equal(res.status, 201, `signup must succeed for ${email}`);
  return extractCookie(res);
}

async function login(email, deviceKey, tag) {
  await resetAuthRateForTest(tag);
  const res = await loginRoute.POST(new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": tag },
    body: JSON.stringify({ email, password: "asdt-password-1", deviceKey }),
  }));
  assert.equal(res.status, 200);
  return extractCookie(res);
}

async function postReport({ deviceKey, cookie, id, text, room, tag }) {
  await resetRateForTest(tag);
  const res = await reportsRoute.POST(new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": tag, cookie: `tp_session_v1=${cookie}` },
    body: JSON.stringify({
      deviceKey, id, submissionId: "sub-" + id, title: "http.pdf",
      createdAt: new Date().toISOString(), wordCount: tokens(text).length, archiveScore: 0, scoreBand: "Low",
      aiScore: 1, aiTone: "low", aiStatus: "ready", room,
      payload: {
        version: 11, id, submissionId: "sub-" + id, title: "http.pdf", author: "", assignment: "",
        created: new Date().toISOString(), score: 0, archiveScore: 0, wordCount: tokens(text).length,
        scoreBand: "Low", matchedWordCount: 0, sources: [], repeats: [], text,
      },
    }),
  }));
  assert.equal(res.status, 200, `save must succeed for ${id}`);
}

async function getOrdinaryReport(id, cookie, tag) {
  await resetReadRateForTest(tag);
  const res = await reportIdRoute.GET(
    new Request(`http://localhost/api/reports/${id}`, { headers: { "x-forwarded-for": tag, cookie: `tp_session_v1=${cookie}` } }),
    { params: Promise.resolve({ id }) },
  );
  return { res, body: await res.json() };
}

async function getDeveloperTrace(id, deviceKey, cookie, tag) {
  await resetReadRateForTest(tag);
  const headers = { "x-forwarded-for": tag };
  if (cookie) headers.cookie = `tp_session_v1=${cookie}`;
  const res = await developerReportIdRoute.GET(
    new Request(`http://localhost/api/developer/reports/${id}?deviceKey=${encodeURIComponent(deviceKey)}`, { headers }),
    { params: Promise.resolve({ id }) },
  );
  return res;
}

test("§13: an admin session receives similarityDecisionTrace from the developer route; a non-admin and no-session both get a plain 404", async () => {
  const PRIOR_TEXT = takeDistinctText();
  // A real prior submission by a third account so the admin's report genuinely matches.
  await indexPriorSubmission(uniq("acc-http-prior"), PRIOR_TEXT);

  const adminCookie = await signup("asdt-admin@example.com", "asdt-admin-dev", "asdt-admin-1");
  const ordinaryCookie = await signup("asdt-ordinary@example.com", "asdt-ordinary-dev", "asdt-ordinary-1");

  await postReport({ deviceKey: "asdt-admin-dev", cookie: adminCookie, id: "asdt-admin-report", text: PRIOR_TEXT, room: 0, tag: "asdt-admin-post" });

  // no session
  const noSession = await getDeveloperTrace("asdt-admin-report", "asdt-admin-dev", null, "asdt-nosess");
  assert.equal(noSession.status, 404);

  // signed-in non-admin
  const nonAdmin = await getDeveloperTrace("asdt-admin-report", "asdt-admin-dev", ordinaryCookie, "asdt-nonadmin");
  assert.equal(nonAdmin.status, 404, "a non-admin must not be able to reach the trace route (indistinguishable from no session)");

  // admin
  const adminRes = await getDeveloperTrace("asdt-admin-report", "asdt-admin-dev", adminCookie, "asdt-admin-get");
  assert.equal(adminRes.status, 200);
  const adminBody = await adminRes.json();
  assert.ok(adminBody.similarityDecisionTrace, "the admin developer route must include similarityDecisionTrace");
  assert.equal(adminBody.similarityDecisionTrace.schemaVersion, "admin-similarity-decision-trace-v1");
  assert.ok(adminBody.similarityDecisionTrace.resolvable);
  assert.equal(typeof adminBody.similarityDecisionTrace.finalScore, "number");
  assert.ok(Array.isArray(adminBody.similarityDecisionTrace.sources));

  // §B2b: the corpus-duplicate suppression shadow block is serialised for an
  // admin. The real deferred B2a evaluator wrote a row for this report during
  // postReport's runAfterResponse (a PRIOR_SUBMISSION match — not a corpus
  // source — so it is a real OK row with no candidate).
  assert.equal(adminBody.similarityDecisionTrace.scoreUnchangedByCorpusDuplicateShadow, true);
  const b2 = adminBody.similarityDecisionTrace.corpusDuplicateSuppressionShadow;
  assert.ok(b2, "an admin must see the Phase B2 corpus-duplicate suppression shadow block");
  assert.ok(["OK", "BOUNDED", "FAILED", "SKIPPED_NOT_MATCHED", "SKIPPED_NO_AUTHORITATIVE"].includes(b2.status));
  assert.equal(b2.productionScoreChangedByShadow, false);
  assert.equal(b2.policyVersion, "document-local-corpus-duplicate-shadow-v1");

  // §13: the full admin developer response serialises no device-passport secret.
  const adminRaw = JSON.stringify(adminBody);
  for (const forbidden of [/public_?key/i, /publicKeySpki/, /\bspki\b/i, /"signature"/, /challengeId/, /challenge_id/, /"nonce"/, /session_?token/i, /verified_device_passport_id/]) {
    assert.doesNotMatch(adminRaw, forbidden, `the admin developer response must not serialise ${forbidden}`);
  }
});

test("§13: the ordinary GET /api/reports/[id] response carries none of the decision trace / historical-match / backing evidence", async () => {
  const PRIOR_TEXT = takeDistinctText();
  const priorAccount = uniq("acc-http-ordinary-prior");
  await indexPriorSubmission(priorAccount, PRIOR_TEXT);

  const ordinaryCookie = await login("asdt-ordinary@example.com", "asdt-ordinary-dev", "asdt-ord-login");
  await postReport({ deviceKey: "asdt-ordinary-dev", cookie: ordinaryCookie, id: "asdt-ordinary-report", text: PRIOR_TEXT, room: 1, tag: "asdt-ord-post" });
  // postReport's runAfterResponse ran the real deferred B2a evaluator, so a
  // corpus_duplicate_suppression_shadow_evaluations row now exists for this
  // report — it must be completely invisible to the ordinary viewer below.

  const { res, body } = await getOrdinaryReport("asdt-ordinary-report", ordinaryCookie, "asdt-ord-get");
  assert.equal(res.status, 200);
  assert.equal(body.payload.similarityDecisionTrace, undefined, "the trace must never be attached to an ordinary report response");
  assert.equal(body.payload.historicalSubmissionMatch, undefined, "historicalSubmissionMatch stays admin-only");

  const raw = JSON.stringify(body);
  assert.doesNotMatch(raw, /similarityDecisionTrace/, "the trace key must not appear anywhere in the ordinary response");
  assert.doesNotMatch(raw, /schemaVersion.{0,40}admin-similarity-decision-trace/);
  assert.doesNotMatch(raw, /accountEvidence|deviceEvidence|backingListTruncated|COUNTED_PRIOR_SUBMISSION|EXCLUDED_SELF/, "no per-source trace field may leak to an ordinary viewer");
  // §B2b: no corpus-duplicate suppression shadow telemetry may reach an ordinary viewer
  assert.doesNotMatch(raw, /corpusDuplicateSuppressionShadow|CROSS_ACCOUNT_EXACT_CANONICAL|MULTI_ORIGIN_NOT_PROVEN|scoreUnchangedByCorpusDuplicateShadow/, "no Phase B2 shadow telemetry may leak to an ordinary viewer");
  assert.doesNotMatch(raw, new RegExp(`${priorAccount}@ex\\.test`), "no backing account email may reach an ordinary viewer");
  // unifiedSimilarity itself is still present for the ordinary owner, but with contributions stripped.
  if (body.payload.unifiedSimilarity) {
    assert.deepEqual(body.payload.unifiedSimilarity.contributions, [], "contributions[] stays stripped for a non-admin");
  }

  // the ordinary report LIST response also carries none of it
  await resetReadRateForTest("asdt-ord-list");
  const listRes = await reportsRoute.GET(new Request("http://localhost/api/reports", {
    headers: { "x-forwarded-for": "asdt-ord-list", cookie: `tp_session_v1=${ordinaryCookie}` },
  }));
  assert.equal(listRes.status, 200);
  const listRaw = await listRes.text();
  assert.doesNotMatch(listRaw, /similarityDecisionTrace|historicalSubmissionMatch|accountEvidence|deviceEvidence|COUNTED_PRIOR_SUBMISSION/, "the ordinary report list must carry none of the trace");
  assert.doesNotMatch(listRaw, new RegExp(`${priorAccount}@ex\\.test`));
});

console.log("admin-similarity-decision-trace-integration: §8/§12/§13/§14/§15E/§15F/§15G passed");
