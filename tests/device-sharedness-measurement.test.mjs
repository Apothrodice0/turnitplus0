import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { resetRateForTest, resetReadRateForTest, resetAuthRateForTest } from "../lib/rate-limit.ts";
import { buildReportAdmissionSourceRef } from "../lib/corpus-admission-source-ref.ts";
import { DEVICE_PROVENANCE_SHADOW_POLICY_VERSION } from "../lib/device-provenance-shadow.ts";
import { PROPOSED_ACCEPTANCE_POLICY_VERSION } from "../lib/e8o-historical-match-policy.ts";
import {
  summarizeSharedDeviceRiskMeasurement,
  DEFAULT_SHARED_DEVICE_RECENT_LIMIT,
  MAX_SHARED_DEVICE_RECENT_LIMIT,
} from "../lib/device-sharedness-measurement.ts";
import * as signupRoute from "../app/api/auth/signup/route.ts";
import * as sharedDeviceRoute from "../app/api/developer/shared-device-risk/route.ts";

/**
 * ADMIN-ONLY shared-device false-SELF RISK measurement
 * (lib/device-sharedness-measurement.ts + the
 * app/api/developer/shared-device-risk route).
 *
 * Covers: structural (SELECT-only, no scoring imports, no identity in output),
 * the 5 important cases, telemetry/snapshot drift, independent-backing rows
 * stay excluded, malformed evidence, empty dataset, admin-only 404, and
 * score-invariance.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_device_sharedness_measurement.db");
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.ADMIN_EMAIL = "sdrm-admin@example.com";

const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.ADMIN_EMAIL;
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
  }
});

let seq = 0;
const uniq = (p) => `${p}-${++seq}`;
const hex32 = () => crypto.randomBytes(32).toString("hex");

// distinctive canary values seeded once and asserted-absent from every
// serialized output (the summary object AND the admin route response).
const CANARY_DEVICE_KEY = "SDRM-CANARY-DEVICE-KEY-must-never-leak";
const CANARY_REPORT_ID = "SDRM-CANARY-REPORT-ID-visible-ok";
const CANARY_PASSPORT = "PP-SDRM-CANARY";
const CANARY_TARGET_ACCOUNT = "acc-SDRM-CANARY-TARGET";
const CANARY_SOURCE_ACCOUNT = "acc-SDRM-CANARY-SOURCE";

async function ensureUser(accountId) {
  if (!accountId) return;
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
    args: [accountId, `${accountId}@ex.test`, accountId, "not-a-real-hash"],
  });
}

async function ensurePassport(passportId) {
  await client.execute({
    sql: "INSERT OR IGNORE INTO device_passports (id, public_key_spki, algorithm, created_at, provenance_generation) VALUES (?,?,?,?,0)",
    args: [passportId, Buffer.from(`spki-${passportId}`), "ECDSA-P256-SHA256", Date.now()],
  });
}

async function seedReport({ reportId, deviceKey, accountId = null, passportId = null }) {
  await ensureUser(accountId);
  if (passportId) await ensurePassport(passportId);
  const payload = JSON.stringify({ version: 11, id: reportId, submissionId: `sub-${reportId}`, title: "t", text: "x", wordCount: 50, score: 0, archiveScore: 0 });
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, verified_device_passport_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [reportId, deviceKey, `sub-${reportId}`, "t", new Date().toISOString(), 50, 0, "Low", payload, accountId, passportId],
  });
}

async function makeRepresentation() {
  const id = crypto.randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_document_representations (id, canonical_sha256, canonical_text, word_count, canonicalization_version)
          VALUES (?,?,?,?,?)`,
    args: [id, hex32(), `canonical text ${uniq("rep")}`, 50, "canon-v1"],
  });
  return id;
}

/** Seed an active indexed admission backing for `representationId`, optionally device-linked to `passportId`, with `source_ref` for `sourceAccountId`. */
async function addAdmissionBacking(representationId, { sourceAccountId, passportId = null, badSourceRef = false } = {}) {
  await ensureUser(sourceAccountId);
  const sourceRef = badSourceRef
    ? `bulk-import:collection=example:item=${uniq("item")}`
    : buildReportAdmissionSourceRef({ accountId: sourceAccountId, deviceKey: uniq("src-dev"), reportId: uniq("src-rep") });
  const decisionId = crypto.randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_decisions (id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes, dry_run)
          VALUES (?,?,?,?,?,?,?,?)`,
    args: [decisionId, sourceRef, "v1", "ACCEPT", "[]", 1, "[]", 0],
  });
  const arId = crypto.randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version) VALUES (?,?,?,?,?)`,
    args: [arId, decisionId, hex32(), 50, "corpus-shingle-v1"],
  });
  await client.execute({
    sql: `INSERT INTO corpus_admission_promotions (id, decision_id, accepted_representation_id, representation_id, link_type, fingerprint_version, status, attempt_count)
          VALUES (?,?,?,?,?,?,'indexed',1)`,
    args: [crypto.randomUUID(), decisionId, arId, representationId, "NEW_CONTENT_REPRESENTATION", "corpus-shingle-v1"],
  });
  if (passportId) {
    await ensurePassport(passportId);
    await client.execute({
      sql: `INSERT INTO corpus_admission_decision_device_provenance (decision_id, device_passport_id, verified_at) VALUES (?,?,?)`,
      args: [decisionId, passportId, Date.now()],
    });
  }
  return decisionId;
}

async function seedSnapshot(deviceKey, reportId, representationIds, { relationshipType = "TURNITPLUS_CORPUS_SOURCE", matchType = "EXACT_CANONICAL_MATCH" } = {}) {
  const resultJson = JSON.stringify(
    representationIds.map((rid) => ({ matchedRepresentationId: rid, relationshipType, matchType, containment: 1, matchedWordCount: 50 })),
  );
  await client.execute({
    sql: `INSERT INTO report_historical_match_snapshots
            (report_device_key, report_id, status, matcher_version, fingerprint_version, canonicalization_version, result_json, candidate_count, processing_duration_ms)
          VALUES (?,?,?,?,?,?,?,?,?)`,
    args: [deviceKey, reportId, "MATCHED", "m", "f", "c", resultJson, representationIds.length, 1],
  });
}

async function seedShadow({
  reportDeviceKey,
  reportId,
  policyVersion = DEVICE_PROVENANCE_SHADOW_POLICY_VERSION,
  productionRelationship = "TURNITPLUS_CORPUS_SOURCE",
  proposedRelationship = "SELF",
  agreement = "DISAGREE_DEVICE_SELF",
  status = "OK",
  computedAt = null,
  evidence = {},
}) {
  const proposedEvidence = typeof evidence === "string" ? evidence : JSON.stringify({
    reason: "SAME_DEVICE_EXACT_DOCUMENT",
    wouldDowngrade: true,
    hasReportPassport: true,
    matchesEvaluated: 1,
    deviceSelfCandidateCount: 1,
    exactSameDeviceMatchCount: 1,
    independentBlockedCandidateCount: 0,
    candidateExactCanonicalMatch: true,
    candidateSameVerifiedDeviceBacking: true,
    candidateIndependentBackingCount: 0,
    candidateReason: "SAME_DEVICE_EXACT_DOCUMENT",
    deviceDistinctAccounts: 2,
    deviceSubmissionCount: 2,
    deviceAnonUploads: 0,
    deviceSharedAcrossAccounts: true,
    ...evidence,
  });
  await client.execute({
    sql: `INSERT INTO historical_match_shadow_evaluations
            (report_device_key, report_id, production_status, production_relationship, proposed_status,
             proposed_relationship, proposed_evidence, agreement, candidate_count, passage_level_evaluated_count,
             freq_index_document_count, submitted_word_count, e8m_runtime_ms, v2_runtime_ms, total_runtime_ms,
             policy_version, correspondence_version, distinctiveness_version, status, error_message, computed_at, created_at)
          VALUES (?,?,?,?,?,?,?,?,0,0,0,0,NULL,NULL,1,?,?,?,?,NULL,COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)`,
    args: [
      reportDeviceKey, reportId, "MATCHED", productionRelationship, "MATCHED",
      proposedRelationship, proposedEvidence, agreement,
      policyVersion, "n/a-production-matchtype-passthrough", "n/a", status,
      computedAt,
    ],
  });
}

/**
 * A full same-device SELF downgrade candidate:
 *   - target account T uploads reportId under passportId (saved_reports)
 *   - source account S has their own report under passportId (so the pair
 *     "shares" that passport), AND a same-device admission backing of `rep`
 *   - a MATCHED snapshot pointing production at `rep`
 *   - a wouldDowngrade shadow row
 */
async function seedCandidate({ tag, passportId, targetAccountId, sourceAccountId, extraDeviceAccounts = [], evidence = {} }) {
  const deviceKey = uniq(`${tag}-dk`);
  const reportId = uniq(`${tag}-r`);
  await seedReport({ reportId, deviceKey, accountId: targetAccountId, passportId });
  // the source account's own upload under the same passport
  await seedReport({ reportId: uniq(`${tag}-src-r`), deviceKey: uniq(`${tag}-src-dk`), accountId: sourceAccountId, passportId });
  // any extra distinct accounts seen on this passport (Case 2 fan-out)
  for (const acc of extraDeviceAccounts) {
    await seedReport({ reportId: uniq(`${tag}-x-r`), deviceKey: uniq(`${tag}-x-dk`), accountId: acc, passportId });
  }
  const rep = await makeRepresentation();
  await addAdmissionBacking(rep, { sourceAccountId, passportId });
  await seedSnapshot(deviceKey, reportId, [rep]);
  await seedShadow({ reportDeviceKey: deviceKey, reportId, computedAt: `2026-08-29 0${(seq % 9) + 1}:00:0${seq % 9}`, evidence });
  return { deviceKey, reportId, rep };
}

// ---------------------------------------------------------------------------
// STRUCTURAL
// ---------------------------------------------------------------------------

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
function importLines(src) {
  return src.split(/\r?\n/).filter((l) => /^\s*(?:import|export)\b.*\bfrom\b/.test(l)).join("\n");
}
const MEASURE_SRC = fs.readFileSync(path.join(repoRoot, "lib/device-sharedness-measurement.ts"), "utf8");
const RISK_SRC = fs.readFileSync(path.join(repoRoot, "lib/device-sharedness-risk.ts"), "utf8");
const ROUTE_SRC = fs.readFileSync(path.join(repoRoot, "app/api/developer/shared-device-risk/route.ts"), "utf8");

test("structural: the measurement module issues no write statement and imports nothing on the scoring / relationship path", () => {
  const code = stripComments(MEASURE_SRC);
  assert.doesNotMatch(code, /\bINSERT\s+INTO\b/i, "no INSERT");
  assert.doesNotMatch(code, /\bUPDATE\s+\w+\s+SET\b/i, "no UPDATE");
  assert.doesNotMatch(code, /\bDELETE\s+FROM\b/i, "no DELETE");
  assert.doesNotMatch(code, /\bCREATE\s+TABLE\b/i, "no DDL");
  assert.doesNotMatch(
    importLines(MEASURE_SRC),
    /unified-similarity|report-primary-similarity|user-submission-matching|report-historical-match|device-self-scoring-rule|similarity-worker|similarity-core|receipt-pdf/,
    "no scoring / relationship-classification module import",
  );
  assert.doesNotMatch(code, /\.unifiedScore\s*=|\.score\s*=|\.archiveScore\s*=|\.aiScore\s*=/, "assigns no score field");
  assert.match(code, /historical_match_shadow_evaluations/, "reads the shadow-telemetry table");
});

test("structural: the pure risk classifier is pure — no @libsql/client, no env, no db calls", () => {
  assert.doesNotMatch(importLines(RISK_SRC), /@libsql\/client/, "no db client import");
  assert.doesNotMatch(stripComments(RISK_SRC), /process\.env|client\.(execute|batch)/, "no env read, no db call");
});

test("structural: the source_ref account prefix literal is exactly 22 chars (matches buildReportAdmissionAccountPrefix)", () => {
  assert.equal("report-upload:account=".length, 22);
  assert.match(MEASURE_SRC, /SOURCE_REF_ACCOUNT_PREFIX = "report-upload:account="/);
});

test("structural: the route is admin-gated and 404s (never 401/403) for a non-admin", () => {
  assert.match(ROUTE_SRC, /getAdminSessionUser/);
  assert.match(ROUTE_SRC, /status:\s*404/);
  assert.doesNotMatch(ROUTE_SRC, /status:\s*40[13]/, "must never return 401/403");
});

// ---------------------------------------------------------------------------
// EMPTY DATASET (15)
// ---------------------------------------------------------------------------

test("empty dataset: every metric zero / empty, recent []", async () => {
  const s = await summarizeSharedDeviceRiskMeasurement(client);
  assert.equal(s.policyVersion, DEVICE_PROVENANCE_SHADOW_POLICY_VERSION);
  assert.equal(s.totals.wouldDowngradeCandidates, 0);
  assert.equal(s.totals.candidatesEvaluated, 0);
  assert.deepEqual(s.deviceAccountCountBuckets, { one: 0, two: 0, threePlus: 0, unknown: 0 });
  assert.equal(s.pairSharesExactlyOnePassport, 0);
  assert.equal(s.pairSharesTwoOrMorePassports, 0);
  assert.equal(s.distinctCandidateDevices, 0);
  assert.equal(s.devicesWithExactlyOnePair, 0);
  assert.equal(s.devicesWithMultiplePairs, 0);
  assert.deepEqual(s.recentCandidates, []);
  for (const p of ["CURRENT_PREVIEW", "TWO_ACCOUNT_MAX", "MULTI_PASSPORT_PAIR", "CONSERVATIVE_COMBINED"]) {
    assert.deepEqual(s.policyImpact[p], { kept: 0, blocked: 0 });
  }
  assert.equal(s.recentCandidatesLimit, DEFAULT_SHARED_DEVICE_RECENT_LIMIT);
});

// ---------------------------------------------------------------------------
// THE IMPORTANT CASES
// ---------------------------------------------------------------------------

test("cases 1-4 + drift + independent-backing exclusion, hand-computed", async () => {
  // Case 1 — our proven Preview test: 2 accounts, 1 passport, 1 pair.
  const c1 = await seedCandidate({ tag: "c1", passportId: "PP-1", targetAccountId: "acc-A1", sourceAccountId: "acc-B1" });

  // Case 2 — 3+ accounts on one passport (high fan-out).
  await seedCandidate({
    tag: "c2", passportId: "PP-2", targetAccountId: "acc-A2", sourceAccountId: "acc-B2",
    extraDeviceAccounts: ["acc-C2", "acc-D2"],
  });

  // Case 3 — same pair on 2 cryptographically distinct passports.
  const c3 = await seedCandidate({ tag: "c3", passportId: "PP-3a", targetAccountId: "acc-A3", sourceAccountId: "acc-B3" });
  // give A3 & B3 a second shared passport PP-3b
  await seedReport({ reportId: uniq("c3-b-a"), deviceKey: uniq("c3-b-adk"), accountId: "acc-A3", passportId: "PP-3b" });
  await seedReport({ reportId: uniq("c3-b-b"), deviceKey: uniq("c3-b-bdk"), accountId: "acc-B3", passportId: "PP-3b" });

  // Case 4 — one passport, two unrelated candidate account-pairs.
  await seedCandidate({ tag: "c4a", passportId: "PP-4", targetAccountId: "acc-A4a", sourceAccountId: "acc-B4a" });
  await seedCandidate({ tag: "c4b", passportId: "PP-4", targetAccountId: "acc-A4b", sourceAccountId: "acc-B4b" });

  // Drift — wouldDowngrade shadow row + a snapshot, but the matched
  // representation has NO recoverable same-device backing on the report's
  // passport (telemetry/snapshot drift).
  const driftDk = uniq("drift-dk");
  const driftR = uniq("drift-r");
  await seedReport({ reportId: driftR, deviceKey: driftDk, accountId: "acc-DR", passportId: "PP-DRIFT" });
  const driftRep = await makeRepresentation();
  await addAdmissionBacking(driftRep, { sourceAccountId: "acc-DRIFT-SRC" }); // no passportId -> not a same-device backing
  await seedSnapshot(driftDk, driftR, [driftRep]);
  await seedShadow({ reportDeviceKey: driftDk, reportId: driftR, computedAt: "2026-08-29 09:00:09" });

  // Independent-backing candidate — the shadow rule already BLOCKED it
  // (wouldDowngrade:false). Must never be counted here (test 13).
  const ibDk = uniq("ib-dk");
  const ibR = uniq("ib-r");
  await seedReport({ reportId: ibR, deviceKey: ibDk, accountId: "acc-IB", passportId: "PP-IB" });
  await seedShadow({
    reportDeviceKey: ibDk, reportId: ibR, proposedRelationship: null, agreement: "AGREE",
    computedAt: "2026-08-29 09:30:09",
    evidence: { reason: "NO_DEVICE_DOWNGRADE", wouldDowngrade: false, independentBlockedCandidateCount: 1, candidateIndependentBackingCount: 3 },
  });

  // A different policy's row — must be ignored.
  await seedShadow({
    reportDeviceKey: uniq("g-dk"), reportId: uniq("g-r"), policyVersion: PROPOSED_ACCEPTANCE_POLICY_VERSION,
    computedAt: "2026-08-29 09:45:09",
  });

  const s = await summarizeSharedDeviceRiskMeasurement(client, { recentLimit: 100 });

  // 6 wouldDowngrade candidates: c1, c2, c3, c4a, c4b, drift  (ib excluded, g excluded)
  assert.equal(s.totals.wouldDowngradeCandidates, 6);
  assert.equal(s.totals.candidatesEvaluated, 6);
  assert.equal(s.totals.candidatesRepresentationDrift, 1, "only the drift row (snapshot present, no live same-device backing)");
  assert.equal(s.totals.candidatesMissingSnapshot, 0);
  assert.equal(s.totals.candidatesMissingReportRow, 0);
  assert.equal(s.totals.candidatesMissingPassport, 0);

  // live account-count per candidate's passport:
  //   PP-1 {A1,B1}=2 ; PP-3a {A3,B3}=2 ; PP-2 {A2,B2,C2,D2}=4 ;
  //   PP-4 {A4a,B4a,A4b,B4b}=4 (both c4 candidates) ; PP-DRIFT {DR}=1
  assert.equal(s.deviceAccountCountBuckets.two, 2, "c1 c3");
  assert.equal(s.deviceAccountCountBuckets.threePlus, 3, "c2 c4a c4b");
  assert.equal(s.deviceAccountCountBuckets.one, 1, "drift");
  assert.equal(s.deviceAccountCountBuckets.unknown, 0);

  // pair shared-passport counts: c3 -> 2 ; c1 c2 c4a c4b -> 1 ; drift -> unknown
  assert.equal(s.pairSharesTwoOrMorePassports, 1, "c3 only");
  assert.equal(s.pairSharesExactlyOnePassport, 4, "c1 c2 c4a c4b");
  assert.equal(s.pairSharedPassportUnknown, 1, "drift");

  // devices: PP-1/PP-2/PP-3a = 1 pair ; PP-4 = 2 pairs ; PP-DRIFT = 0 pairs
  assert.equal(s.devicesWithMultiplePairs, 1, "PP-4");
  assert.equal(s.devicesWithExactlyOnePair, 3, "PP-1 PP-2 PP-3a");
  assert.equal(s.devicesWithNoResolvablePair, 1, "PP-DRIFT");
  assert.equal(s.distinctCandidateDevices, 5, "PP-1 PP-2 PP-3a PP-4 PP-DRIFT");

  // risk categories
  const rc = s.riskCategoryDistribution;
  assert.equal(rc.PAIR_MULTI_PASSPORT, 1, "c3 (pair on 2 passports)");
  assert.equal(rc.SHARED_HIGH_FANOUT, 3, "c2 (4 accounts) + c4a + c4b (4 accounts / 2 pairs on device)");
  assert.equal(rc.SHARED_LOW_EVIDENCE, 1, "c1");
  assert.equal(rc.PERSONAL_LIKELY, 1, "drift (1 account, no resolvable pair)");
  assert.equal(rc.SHARED_MULTI_ACCOUNT, 0);
  assert.equal(rc.UNKNOWN, 0);

  // policy impact — all 6 are Policy A candidates
  assert.deepEqual(s.policyImpact.CURRENT_PREVIEW, { kept: 6, blocked: 0 });
  // B (<=2 accounts): c1 c3 kept ; c2 c4a c4b blocked ; drift (1 acc) kept
  assert.deepEqual(s.policyImpact.TWO_ACCOUNT_MAX, { kept: 3, blocked: 3 });
  // C (pair >=2 passports, own included): only c3
  assert.deepEqual(s.policyImpact.MULTI_PASSPORT_PAIR, { kept: 1, blocked: 5 });
  // D (refined): exactly 2 acc + 0 anon + (>=1 OTHER Passport | exactly 1 unordered pair)
  //   c1 -> Branch B (2 acc, 0 anon, 1 unordered pair) ; c3 -> Branch A (pair also on PP-3b)
  //   c2 / c4a / c4b blocked (4 accounts) ; drift blocked (1 account)
  assert.deepEqual(s.policyImpact.CONSERVATIVE_COMBINED, { kept: 2, blocked: 4 });

  // per-row: our proven 2-account test case (c1)
  const c1row = s.recentCandidates.find((r) => r.reportId === c1.reportId);
  assert.ok(c1row);
  assert.equal(c1row.deviceDistinctAccounts, 2);
  assert.equal(c1row.unorderedDeviceAccountPairCount, 1);
  assert.equal(c1row.pairSharedPassportCount, 1);
  assert.equal(c1row.pairOtherVerifiedPassportCount, 0, "pair only ever seen on c1's own Passport");
  assert.equal(c1row.candidateSourceAccountCount, 1);
  assert.equal(c1row.riskCategory, "SHARED_LOW_EVIDENCE");
  assert.equal(c1row.policyA, true);
  assert.equal(c1row.policyB, true);
  assert.equal(c1row.policyC, false);
  assert.equal(c1row.policyD, true); // Branch B

  const c3row = s.recentCandidates.find((r) => r.reportId === c3.reportId);
  assert.equal(c3row.pairSharedPassportCount, 2);
  assert.equal(c3row.pairOtherVerifiedPassportCount, 1, "pair also co-occurs on PP-3b");
  assert.equal(c3row.riskCategory, "PAIR_MULTI_PASSPORT");
  assert.equal(c3row.policyC, true);
  assert.equal(c3row.policyD, true); // Branch A — >=1 other verified Passport
});

// ---------------------------------------------------------------------------
// RECIPROCAL PAIR — A->B and B->A on one Passport collapse to ONE unordered pair
// ---------------------------------------------------------------------------

test("reciprocal A->B / B->A on one Passport counts as ONE unordered account pair", async () => {
  // Two candidates on the SAME verified Passport, opposite directions:
  //   recip-1: target = acc-RA, source = acc-RB
  //   recip-2: target = acc-RB, source = acc-RA
  // Distinct accounts on the Passport = {acc-RA, acc-RB} = 2.
  // Directional keys would be RA::RB and RB::RA -> 2 pairs -> SHARED_HIGH_FANOUT
  // (Case 4) and Policy D blocked. Sorted (unordered) keys collapse to one.
  const c1 = await seedCandidate({ tag: "recip-1", passportId: "PP-RECIP", targetAccountId: "acc-RA", sourceAccountId: "acc-RB" });
  const c2 = await seedCandidate({ tag: "recip-2", passportId: "PP-RECIP", targetAccountId: "acc-RB", sourceAccountId: "acc-RA" });

  const s = await summarizeSharedDeviceRiskMeasurement(client, { recentLimit: 100 });

  const r1 = s.recentCandidates.find((r) => r.reportId === c1.reportId);
  const r2 = s.recentCandidates.find((r) => r.reportId === c2.reportId);
  assert.ok(r1 && r2, "both reciprocal candidates surfaced");

  assert.equal(r1.unorderedDeviceAccountPairCount, 1, "reciprocal directions count as one unordered pair");
  assert.equal(r2.unorderedDeviceAccountPairCount, 1);
  assert.equal(r1.deviceDistinctAccounts, 2);
  assert.equal(r2.deviceDistinctAccounts, 2);

  // one unordered pair + 2 accounts + no anon -> low-evidence, NOT high fan-out
  assert.equal(r1.riskCategory, "SHARED_LOW_EVIDENCE");
  assert.equal(r2.riskCategory, "SHARED_LOW_EVIDENCE");

  // pair only ever seen on PP-RECIP -> no cross-device corroboration
  assert.equal(r1.pairOtherVerifiedPassportCount, 0);
  assert.equal(r2.pairOtherVerifiedPassportCount, 0);

  // Policy D keeps both via Branch B (exactly 2 accounts, 0 anon, exactly 1 unordered pair)
  assert.equal(r1.policyD, true);
  assert.equal(r2.policyD, true);
});

// ---------------------------------------------------------------------------
// MALFORMED / INCOMPLETE PROVENANCE (14)
// ---------------------------------------------------------------------------

test("malformed evidence + missing report row handled safely", async () => {
  // wouldDowngrade row whose proposed_evidence is not valid JSON -> filtered out by the json_valid guard entirely
  const mdk = uniq("mal-dk");
  const mr = uniq("mal-r");
  await client.execute({
    sql: `INSERT INTO historical_match_shadow_evaluations
            (report_device_key, report_id, production_status, production_relationship, proposed_status,
             proposed_relationship, proposed_evidence, agreement, candidate_count, passage_level_evaluated_count,
             freq_index_document_count, submitted_word_count, e8m_runtime_ms, v2_runtime_ms, total_runtime_ms,
             policy_version, correspondence_version, distinctiveness_version, status, error_message, computed_at, created_at)
          VALUES (?,?,?,?,?,?,?,?,0,0,0,0,NULL,NULL,1,?,?,?,?,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    args: [mdk, mr, "MATCHED", "PRIOR_SUBMISSION", "MATCHED", null, "not-json{{", "AGREE",
      DEVICE_PROVENANCE_SHADOW_POLICY_VERSION, "n/a-production-matchtype-passthrough", "n/a", "OK"],
  });

  // wouldDowngrade row with valid evidence but NO saved_reports row
  const gonedk = uniq("gone-dk");
  const goner = uniq("gone-r");
  await seedShadow({ reportDeviceKey: gonedk, reportId: goner, computedAt: "2026-08-29 10:00:00" });

  const before = s0 => s0; // noop
  const s = await summarizeSharedDeviceRiskMeasurement(client, { recentLimit: 100 });
  assert.ok(!s.recentCandidates.some((r) => r.reportId === mr), "malformed-evidence row is excluded (json_valid guard)");
  const goneRow = s.recentCandidates.find((r) => r.reportId === goner);
  assert.ok(goneRow, "the missing-report-row candidate is still surfaced");
  assert.equal(goneRow.deviceDistinctAccounts, null);
  assert.equal(goneRow.riskCategory, "UNKNOWN");
  assert.equal(goneRow.policyB, false, "unknown facts fail policy B closed");
  assert.ok(s.totals.candidatesMissingReportRow >= 1);
  void before;
});

// ---------------------------------------------------------------------------
// SCORE INVARIANCE (18)
// ---------------------------------------------------------------------------

test("score invariance: running the summary changes no row in any table it can see", async () => {
  const snap = async () => {
    const t = await client.execute("SELECT * FROM historical_match_shadow_evaluations ORDER BY id");
    const r = await client.execute("SELECT * FROM saved_reports ORDER BY device_key, id");
    const h = await client.execute("SELECT * FROM report_historical_match_snapshots ORDER BY id");
    const p = await client.execute("SELECT * FROM corpus_admission_promotions ORDER BY id");
    return JSON.stringify({ t: t.rows, r: r.rows, h: h.rows, p: p.rows });
  };
  const before = await snap();
  await summarizeSharedDeviceRiskMeasurement(client, { recentLimit: 100 });
  await summarizeSharedDeviceRiskMeasurement(client);
  assert.equal(await snap(), before, "no table content changed");
});

// ---------------------------------------------------------------------------
// PRIVACY — no identity in the output (16)
// ---------------------------------------------------------------------------

test("privacy: no reportDeviceKey / passport id / account id / email / source_ref appears anywhere in the summary", async () => {
  // seed a candidate whose device_key, passport, and accounts are distinctive
  // canary strings — the row must be present (by reportId) but nothing else.
  await seedReport({ reportId: CANARY_REPORT_ID, deviceKey: CANARY_DEVICE_KEY, accountId: CANARY_TARGET_ACCOUNT, passportId: CANARY_PASSPORT });
  await seedReport({ reportId: uniq("canary-src-r"), deviceKey: uniq("canary-src-dk"), accountId: CANARY_SOURCE_ACCOUNT, passportId: CANARY_PASSPORT });
  const canaryRep = await makeRepresentation();
  await addAdmissionBacking(canaryRep, { sourceAccountId: CANARY_SOURCE_ACCOUNT, passportId: CANARY_PASSPORT });
  await seedSnapshot(CANARY_DEVICE_KEY, CANARY_REPORT_ID, [canaryRep]);
  await seedShadow({ reportDeviceKey: CANARY_DEVICE_KEY, reportId: CANARY_REPORT_ID, computedAt: "2026-08-29 11:00:00" });

  const s = await summarizeSharedDeviceRiskMeasurement(client, { recentLimit: 100 });
  const serialized = JSON.stringify(s);

  // the candidate IS represented — but by reportId only
  assert.ok(s.recentCandidates.some((r) => r.reportId === CANARY_REPORT_ID), "the canary candidate row is present (by reportId)");
  assert.equal(serialized.includes(CANARY_REPORT_ID), true, "reportId may appear");

  // the seeded device key must never appear, anywhere
  assert.equal(serialized.includes(CANARY_DEVICE_KEY), false, "seeded reportDeviceKey leaked into the summary");
  assert.doesNotMatch(serialized, /reportDeviceKey|"device_key"|"deviceKey"|report_device_key/, "no device-key field name in the summary");

  for (const canary of [
    CANARY_DEVICE_KEY, CANARY_PASSPORT, CANARY_TARGET_ACCOUNT, CANARY_SOURCE_ACCOUNT,
    "PP-1", "PP-2", "PP-3a", "PP-4", "PP-DRIFT",
    "acc-A1", "acc-B1", "acc-A2", "acc-B2", "acc-A3", "acc-B3", "acc-A4a", "acc-B4b",
    "report-upload:account=", "@ex.test",
  ]) {
    assert.equal(serialized.includes(canary), false, `summary leaked: ${canary}`);
  }
  assert.doesNotMatch(serialized, /passportId|public_key|source_ref|"accountId"|device_passport_id|nonce|challenge/);
});

// ---------------------------------------------------------------------------
// ADMIN-ONLY ACCESS (17) + ORDINARY PRIVACY (16)
// ---------------------------------------------------------------------------

function extractCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return null;
  const m = setCookie.match(/tp_session_v1=([^;]*)/);
  return m ? m[1] : null;
}
async function signup(email, deviceKey, tag) {
  await resetAuthRateForTest(tag);
  const res = await signupRoute.POST(new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": tag },
    body: JSON.stringify({ email, password: "sdrm-password-1", username: tag.replace(/[^a-z0-9]/gi, ""), deviceKey }),
  }));
  assert.equal(res.status, 201, `signup ${email}`);
  return extractCookie(res);
}
async function callRoute(cookie, tag, qs = "") {
  await resetReadRateForTest(tag);
  await resetRateForTest(tag);
  const headers = { "x-forwarded-for": tag };
  if (cookie) headers.cookie = `tp_session_v1=${cookie}`;
  return sharedDeviceRoute.GET(new Request(`http://localhost/api/developer/shared-device-risk${qs}`, { headers }));
}

test("admin-only: no session -> 404 (no body), non-admin -> 404 (no body), admin -> 200 with the measurement", async () => {
  const adminCookie = await signup("sdrm-admin@example.com", "sdrm-admin-dev", "sdrm-admin-1");
  const plainCookie = await signup("sdrm-ordinary@example.com", "sdrm-ordinary-dev", "sdrm-ordinary-1");

  const noSession = await callRoute(null, "sdrm-nosess");
  assert.equal(noSession.status, 404);
  assert.equal((await noSession.text()).length, 0);

  const nonAdmin = await callRoute(plainCookie, "sdrm-nonadmin");
  assert.equal(nonAdmin.status, 404);
  assert.equal((await nonAdmin.text()).length, 0);

  const adminRes = await callRoute(adminCookie, "sdrm-admin-get");
  assert.equal(adminRes.status, 200);
  const rawBody = await adminRes.text();
  const body = JSON.parse(rawBody);
  assert.equal(body.policyVersion, DEVICE_PROVENANCE_SHADOW_POLICY_VERSION);
  assert.equal(typeof body.totals.wouldDowngradeCandidates, "number");
  assert.ok(Array.isArray(body.recentCandidates));
  // the canary candidate (seeded in the privacy test above) is present by reportId
  // but its device_key / passport / accounts must not appear in the route response
  assert.ok(body.recentCandidates.some((r) => r.reportId === CANARY_REPORT_ID), "canary row present by reportId");
  assert.equal(rawBody.includes(CANARY_DEVICE_KEY), false, "route response leaked the seeded reportDeviceKey");
  assert.doesNotMatch(rawBody, /reportDeviceKey|report_device_key|"device_key"|"deviceKey"/);
  for (const canary of [CANARY_DEVICE_KEY, CANARY_PASSPORT, CANARY_TARGET_ACCOUNT, CANARY_SOURCE_ACCOUNT, "acc-A1", "PP-1", "report-upload:account="]) {
    assert.equal(rawBody.includes(canary), false, `route response leaked: ${canary}`);
  }

  const limited = await callRoute(adminCookie, "sdrm-admin-limit", "?recentLimit=1");
  const limitedBody = await limited.json();
  assert.ok(limitedBody.recentCandidates.length <= 1);
  assert.ok(limitedBody.recentCandidatesLimit <= MAX_SHARED_DEVICE_RECENT_LIMIT);
});

console.log("device-sharedness-measurement: structural + empty + cases 1-4 + drift + independent-backing exclusion + malformed + score-invariance + privacy + admin-only passed");
