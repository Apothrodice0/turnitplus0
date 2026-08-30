import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import crypto, { createHash } from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { canonicalizeText } from "../lib/canonical-text.ts";
import { tokens } from "../lib/similarity-core.ts";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import {
  createReusableDocumentRepresentation,
  recordCorpusShingles,
  indexDocumentSubmissionIntoCorpus,
} from "../lib/user-submission-corpus.ts";
import { buildReportAdmissionSourceRef } from "../lib/corpus-admission-source-ref.ts";
import { resolvePrimarySimilaritySummary } from "../lib/report-primary-similarity.ts";
import { evaluateDeviceSelfSharedGuard } from "../lib/device-shared-guard.ts";
import { getReportSimilarityDecisionTrace } from "../lib/developer-repo.ts";
import { DEVICE_PASSPORT_ALGORITHM } from "../lib/device-passport-server.ts";
import {
  evaluateConservativeSharedGuard,
  BRANCH_A_OTHER_PASSPORT_MIN,
} from "../lib/device-shared-guard-policy.ts";
import { simulateSharedDevicePolicies } from "../lib/device-sharedness-risk.ts";
import {
  resolveActorObservation,
  DEVICE_ACTOR_KEY_VERSION,
  ANONYMOUS_ACTOR_KEY,
  DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV,
} from "../lib/device-passport-actor-ledger.ts";

/**
 * Refined CONSERVATIVE_COMBINED (Policy D) shared-device fan-out TELEMETRY,
 * layered on the Preview-gated Device Passport SELF rule.
 *
 * Flags:
 *   DEVICE_PASSPORT_SELF_ENABLED                     — master SELF scoring switch
 *   DEVICE_PASSPORT_CONSERVATIVE_SHARED_GUARD_ENABLED — the optional telemetry verdict
 *
 * Behaviour matrix under test:
 *   SELF OFF                -> baseline scoring, guard flag irrelevant
 *   SELF ON  + guard OFF    -> byte-identical base Device Passport SELF behaviour
 *   SELF ON  + guard ON     -> the refined Policy D verdict over the durable shared-device
 *                              fan-out facts is computed and surfaced to the ADMIN decision
 *                              trace, but it NEVER vetoes scoring — a representation the base
 *                              rule accepted stays an effective SELF regardless of the verdict.
 *
 * The pure-policy tests below still exercise evaluateConservativeSharedGuard's
 * own pass/block decision (unchanged — still consumed VERBATIM by the admin
 * A/B/C/D simulation); the DB integration tests assert the score is no longer
 * changed by that verdict.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_device_passport_shared_guard_scoring.db");
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
}

process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";
const ACTOR_HMAC_KEY = "shared-guard-scoring-test-actor-hmac-key-not-a-real-secret";
const originalSelfFlag = process.env.DEVICE_PASSPORT_SELF_ENABLED;
const originalGuardFlag = process.env.DEVICE_PASSPORT_CONSERVATIVE_SHARED_GUARD_ENABLED;
const originalActorKey = process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV];
delete process.env.DEVICE_PASSPORT_SELF_ENABLED;
delete process.env.DEVICE_PASSPORT_CONSERVATIVE_SHARED_GUARD_ENABLED;
process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV] = ACTOR_HMAC_KEY; // per-test override via withActorKey()

const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  for (const [k, v] of [
    ["DEVICE_PASSPORT_SELF_ENABLED", originalSelfFlag],
    ["DEVICE_PASSPORT_CONSERVATIVE_SHARED_GUARD_ENABLED", originalGuardFlag],
    [DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV, originalActorKey],
  ]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
  }
});

function withActorKey(value, fn) {
  const original = process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV];
  if (value === undefined) delete process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV];
  else process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV] = value;
  return Promise.resolve(fn()).finally(() => {
    if (original === undefined) delete process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV];
    else process.env[DEVICE_PASSPORT_ACTOR_HMAC_KEY_ENV] = original;
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let seq = 0;
const uniq = (p) => `${p}-${++seq}`;
const hex32 = () => crypto.randomBytes(32).toString("hex");

function withFlags({ self, guard }, fn) {
  const origSelf = process.env.DEVICE_PASSPORT_SELF_ENABLED;
  const origGuard = process.env.DEVICE_PASSPORT_CONSERVATIVE_SHARED_GUARD_ENABLED;
  if (self === undefined) delete process.env.DEVICE_PASSPORT_SELF_ENABLED;
  else process.env.DEVICE_PASSPORT_SELF_ENABLED = self;
  if (guard === undefined) delete process.env.DEVICE_PASSPORT_CONSERVATIVE_SHARED_GUARD_ENABLED;
  else process.env.DEVICE_PASSPORT_CONSERVATIVE_SHARED_GUARD_ENABLED = guard;
  return Promise.resolve(fn()).finally(() => {
    if (origSelf === undefined) delete process.env.DEVICE_PASSPORT_SELF_ENABLED;
    else process.env.DEVICE_PASSPORT_SELF_ENABLED = origSelf;
    if (origGuard === undefined) delete process.env.DEVICE_PASSPORT_CONSERVATIVE_SHARED_GUARD_ENABLED;
    else process.env.DEVICE_PASSPORT_CONSERVATIVE_SHARED_GUARD_ENABLED = origGuard;
  });
}

// A fresh document per call whose every 5-gram shingle is unique to that call,
// so no two DB-backed scenarios can cross-match in the global shingle search.
// Long enough (~140 informative tokens) to be a solid exact whole-document
// corpus match; the matcher does not require real prose.
let textCounter = 0;
const takeText = () => {
  textCounter += 1;
  return Array.from({ length: 140 }, (_, k) => `qz${textCounter}word${k}x`).join(" ");
};

async function ensureUser(accountId) {
  if (!accountId) return;
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash, corpus_reuse_consented_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)",
    args: [accountId, `${accountId}@ex.test`, accountId, "not-a-real-hash"],
  });
}

async function ensurePassport(passportId, { trackingVersion = 1 } = {}) {
  await client.execute({
    sql: "INSERT OR IGNORE INTO device_passports (id, public_key_spki, algorithm, created_at, provenance_generation, actor_usage_tracking_version) VALUES (?,?,?,?,0,?)",
    args: [passportId, Buffer.from(`spki-${passportId}`), DEVICE_PASSPORT_ALGORITHM, Date.now(), trackingVersion],
  });
}

/** Force a Passport's durable actor-usage completeness marker (0 = legacy/history-incomplete, 1 = tracked since birth). */
async function setPassportTrackingVersion(passportId, version) {
  await ensurePassport(passportId, { trackingVersion: version });
  await client.execute({
    sql: "UPDATE device_passports SET actor_usage_tracking_version = ? WHERE id = ?",
    args: [version, passportId],
  });
}

/**
 * A durable device_passport_actor_usage row — this is what the repointed guard
 * reads for deviceDistinctAccounts / deviceAnonUploads / target+source
 * membership / pairOther co-occurrence. `accountId` null => the anonymous
 * sentinel row. Idempotent (UPSERT bumps observation_count).
 */
async function seedActorUsage(passportId, accountId, { anonymous = false } = {}) {
  await ensurePassport(passportId);
  const obs = anonymous || accountId == null
    ? { actorKeyVersion: DEVICE_ACTOR_KEY_VERSION, actorKey: ANONYMOUS_ACTOR_KEY, isAnonymous: true }
    : resolveActorObservation(accountId);
  await client.execute({
    sql: `INSERT INTO device_passport_actor_usage
            (device_passport_id, actor_key_version, actor_key, is_anonymous, first_observed_at, last_observed_at, observation_count)
          VALUES (?,?,?,?,?,?,1)
          ON CONFLICT (device_passport_id, actor_key_version, actor_key) DO UPDATE SET
            last_observed_at = excluded.last_observed_at,
            observation_count = device_passport_actor_usage.observation_count + 1`,
    args: [passportId, obs.actorKeyVersion, obs.actorKey, obs.isAnonymous ? 1 : 0, Date.now(), Date.now()],
  });
}

/** The pseudonymous actor_key the guard derives for an account (for assertions / privacy checks). */
const actorKeyOf = (accountId) => resolveActorObservation(accountId).actorKey;

async function seedReport({ deviceKey, reportId, accountId = null, passportId = null, rawText }) {
  await ensureUser(accountId);
  if (passportId) await ensurePassport(passportId);
  const wordCount = tokens(canonicalizeText(rawText)).length;
  const payload = JSON.stringify({
    version: 11, id: reportId, submissionId: `sub-${reportId}`, title: "t.pdf", text: rawText,
    wordCount, score: 0, archiveScore: 0, sources: [], repeats: [],
  });
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, verified_device_passport_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [reportId, deviceKey, `sub-${reportId}`, "t.pdf", new Date().toISOString(), wordCount, 0, "Low", payload, accountId, passportId],
  });
  return { wordCount };
}

/** Just a saved_reports row under a passport — used to control deviceDistinctAccounts / deviceAnonUploads / pair-on-other-passport. Not matched against. */
async function seedBareReportUnderPassport({ accountId, passportId }) {
  await ensurePassport(passportId);
  if (accountId) await ensureUser(accountId);
  const reportId = uniq("bare-r");
  const deviceKey = uniq("bare-dk");
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, verified_device_passport_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [reportId, deviceKey, `sub-${reportId}`, "t.pdf", new Date().toISOString(), 10, 0, "Low", JSON.stringify({ version: 11, id: reportId, text: "unrelated bare row", wordCount: 10 }), accountId, passportId],
  });
}

/** An active indexed same-device admission backing for `representationId`. */
async function addSameDeviceAdmissionBacking(representationId, { sourceAccountId, passportId, nonCanonicalSourceRef = false } = {}) {
  if (sourceAccountId) await ensureUser(sourceAccountId);
  await ensurePassport(passportId);
  const sourceRef = nonCanonicalSourceRef
    ? `bulk-import:collection=legacy:item=${uniq("item")}`
    : buildReportAdmissionSourceRef({ accountId: sourceAccountId, deviceKey: uniq("src-dev"), reportId: uniq("src-rep") });
  const decisionId = crypto.randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_decisions (id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes, dry_run) VALUES (?,?,?,?,?,?,?,?)`,
    args: [decisionId, sourceRef, "v1", "ACCEPT", "[]", 1, "[]", 0],
  });
  const arId = crypto.randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version) VALUES (?,?,?,?,?)`,
    args: [arId, decisionId, hex32(), 50, "corpus-shingle-v1"],
  });
  await client.execute({
    sql: `INSERT INTO corpus_admission_promotions (id, decision_id, accepted_representation_id, representation_id, link_type, fingerprint_version, status, attempt_count) VALUES (?,?,?,?,?,?,'indexed',1)`,
    args: [crypto.randomUUID(), decisionId, arId, representationId, "NEW_CONTENT_REPRESENTATION", "corpus-shingle-v1"],
  });
  await client.execute({
    sql: `INSERT INTO corpus_admission_decision_device_provenance (decision_id, device_passport_id, verified_at) VALUES (?,?,?)`,
    args: [decisionId, passportId, Date.now()],
  });
  return decisionId;
}

/** A different verified device backing — an independent backing. */
async function addDifferentDeviceAdmissionBacking(representationId) {
  return addSameDeviceAdmissionBacking(representationId, {
    sourceAccountId: uniq("indep-acc"),
    passportId: uniq("indep-pp"),
  });
}

/**
 * A promoted corpus representation whose canonical text EXACTLY matches
 * `rawText`, backed by a same-device admission promotion on `backingPassportId`
 * from `sourceAccountId`.
 */
async function seedExactCorpusSource(rawText, { backingPassportId, sourceAccountId, extraIndependentBacking = false, nonCanonicalSourceRef = false } = {}) {
  const canonicalText = canonicalizeText(rawText);
  const rep = await createReusableDocumentRepresentation(client, { canonicalText });
  await recordCorpusShingles(client, rep.id, canonicalText);
  await addSameDeviceAdmissionBacking(rep.id, { sourceAccountId, passportId: backingPassportId, nonCanonicalSourceRef });
  if (extraIndependentBacking) await addDifferentDeviceAdmissionBacking(rep.id);
  return rep.id;
}

async function resolve({ deviceKey, reportId, accountId = null, rawText, archiveMatchedPositions = null, externalAcademicEvidence = null }) {
  return resolvePrimarySimilaritySummary(client, {
    reportDeviceKey: deviceKey, reportId, accountId, rawText,
    wordCount: tokens(canonicalizeText(rawText)).length,
    archiveMatchedPositions, externalAcademicEvidence, archiveScore: 0,
  });
}

const range = (a, b) => { const o = []; for (let i = a; i < b; i += 1) o.push(i); return o; };

/**
 * Standard "live fixture shape" builder: report by T on passport P, a corpus
 * source exactly matching, same-device backed by account S on P. The repointed
 * guard reads the DURABLE actor ledger, so T and S each get a pseudonymous
 * device_passport_actor_usage row on P and P is marked
 * actor_usage_tracking_version = 1 (=> deviceDistinctAccounts 2,
 * deviceAnonUploads 0, one candidate pair, both actors present). Returns ids so
 * a test can extend it.
 */
async function seedTwoAccountSharedDeviceFixture() {
  const text = takeText();
  const deviceKey = uniq("dk"), reportId = uniq("r");
  const passportP = uniq("passportP");
  const accountT = uniq("accT"), accountS = uniq("accS");
  const repId = await seedExactCorpusSource(text, { backingPassportId: passportP, sourceAccountId: accountS });
  await seedReport({ deviceKey, reportId, accountId: accountT, passportId: passportP, rawText: text });
  await setPassportTrackingVersion(passportP, 1);
  await seedActorUsage(passportP, accountT); // T durably used device P
  await seedActorUsage(passportP, accountS); // S durably used device P
  // `accountId` is spread straight into resolve() by callers.
  return { text, deviceKey, reportId, accountId: accountT, passportP, accountT, accountS, repId };
}

/**
 * Same shape as seedTwoAccountSharedDeviceFixture, except the corpus source is a
 * NEAR (not byte-identical) variant of the report -> the matcher produces a
 * STRONG_TEXT_MATCH rather than an EXACT_CANONICAL_MATCH.
 */
async function seedTwoAccountSharedDeviceStrongFixture() {
  const text = takeText();
  const nearText = `${text} qzExtraTrailingClauseForStrongVariant one two three four five six seven eight nine ten`;
  const deviceKey = uniq("dk"), reportId = uniq("r");
  const passportP = uniq("passportP");
  const accountT = uniq("accT"), accountS = uniq("accS");
  const repId = await seedExactCorpusSource(nearText, { backingPassportId: passportP, sourceAccountId: accountS });
  await seedReport({ deviceKey, reportId, accountId: accountT, passportId: passportP, rawText: text });
  await setPassportTrackingVersion(passportP, 1);
  await seedActorUsage(passportP, accountT);
  await seedActorUsage(passportP, accountS);
  return { text, deviceKey, reportId, accountId: accountT, passportP, accountT, accountS, repId };
}

// ===========================================================================
// PURE POLICY — the ONE canonical refined Policy D (lib/device-shared-guard-policy.ts)
// ===========================================================================

test("pure/canonical: BRANCH_A_OTHER_PASSPORT_MIN is 1 and re-exported by device-sharedness-risk", () => {
  assert.equal(BRANCH_A_OTHER_PASSPORT_MIN, 1);
});

test("pure 3/4: Branch A (>=1 other Passport) and Branch B (exactly 1 pair) each qualify", () => {
  // Branch A only (Branch B cannot fire — pair count != 1)
  assert.deepEqual(
    evaluateConservativeSharedGuard({ deviceDistinctAccounts: 2, deviceAnonUploads: 0, unorderedDeviceAccountPairCount: 4, pairOtherVerifiedPassportCount: 1 }),
    { passed: true, branchA: true, branchB: false, reason: "PAIR_OTHER_PASSPORT" },
  );
  // Branch B only (no cross-Passport corroboration)
  assert.deepEqual(
    evaluateConservativeSharedGuard({ deviceDistinctAccounts: 2, deviceAnonUploads: 0, unorderedDeviceAccountPairCount: 1, pairOtherVerifiedPassportCount: 0 }),
    { passed: true, branchA: false, branchB: true, reason: "LOW_RISK_SINGLE_PAIR" },
  );
});

test("pure 5: 3+ accounts -> BLOCKED_ACCOUNT_FANOUT", () => {
  const r = evaluateConservativeSharedGuard({ deviceDistinctAccounts: 3, deviceAnonUploads: 0, unorderedDeviceAccountPairCount: 1, pairOtherVerifiedPassportCount: 9 });
  assert.equal(r.passed, false);
  assert.equal(r.reason, "BLOCKED_ACCOUNT_FANOUT");
});

test("pure 6: anonymous uploads -> BLOCKED_ANONYMOUS_USE", () => {
  const r = evaluateConservativeSharedGuard({ deviceDistinctAccounts: 2, deviceAnonUploads: 2, unorderedDeviceAccountPairCount: 1, pairOtherVerifiedPassportCount: 9 });
  assert.equal(r.passed, false);
  assert.equal(r.reason, "BLOCKED_ANONYMOUS_USE");
});

test("pure 7: multiple unordered pairs -> BLOCKED_MULTIPLE_PAIRS, unless Branch A independently qualifies", () => {
  assert.equal(evaluateConservativeSharedGuard({ deviceDistinctAccounts: 2, deviceAnonUploads: 0, unorderedDeviceAccountPairCount: 3, pairOtherVerifiedPassportCount: 0 }).reason, "BLOCKED_MULTIPLE_PAIRS");
  const withCorroboration = evaluateConservativeSharedGuard({ deviceDistinctAccounts: 2, deviceAnonUploads: 0, unorderedDeviceAccountPairCount: 3, pairOtherVerifiedPassportCount: 1 });
  assert.equal(withCorroboration.passed, true);
  assert.equal(withCorroboration.reason, "PAIR_OTHER_PASSPORT");
});

test("pure 8: pair has >=1 OTHER verified Passport -> Branch A qualifies", () => {
  const r = evaluateConservativeSharedGuard({ deviceDistinctAccounts: 2, deviceAnonUploads: 0, unorderedDeviceAccountPairCount: 1, pairOtherVerifiedPassportCount: 1 });
  assert.equal(r.branchA, true);
  assert.equal(r.passed, true);
});

test("pure 9: current Passport only, no other Passport -> Branch A false", () => {
  const r = evaluateConservativeSharedGuard({ deviceDistinctAccounts: 2, deviceAnonUploads: 0, unorderedDeviceAccountPairCount: 5, pairOtherVerifiedPassportCount: 0 });
  assert.equal(r.branchA, false);
});

test("pure 11: null deviceDistinctAccounts -> fail closed (BLOCKED_INSUFFICIENT_EVIDENCE)", () => {
  const r = evaluateConservativeSharedGuard({ deviceDistinctAccounts: null, deviceAnonUploads: 0, unorderedDeviceAccountPairCount: 1, pairOtherVerifiedPassportCount: 1 });
  assert.equal(r.passed, false);
  assert.equal(r.reason, "BLOCKED_INSUFFICIENT_EVIDENCE");
});

test("pure 12: null anon count -> fail closed", () => {
  const r = evaluateConservativeSharedGuard({ deviceDistinctAccounts: 2, deviceAnonUploads: null, unorderedDeviceAccountPairCount: 1, pairOtherVerifiedPassportCount: 1 });
  assert.equal(r.passed, false);
});

test("pure 13: null unordered pair count -> Branch B false", () => {
  const r = evaluateConservativeSharedGuard({ deviceDistinctAccounts: 2, deviceAnonUploads: 0, unorderedDeviceAccountPairCount: null, pairOtherVerifiedPassportCount: 1 });
  assert.equal(r.branchB, false);
  assert.equal(r.branchA, true, "Branch A can still fire off the other-Passport count");
});

test("pure 14: null pair-other count -> Branch A false", () => {
  const r = evaluateConservativeSharedGuard({ deviceDistinctAccounts: 2, deviceAnonUploads: 0, unorderedDeviceAccountPairCount: 1, pairOtherVerifiedPassportCount: null });
  assert.equal(r.branchA, false);
  assert.equal(r.branchB, true, "Branch B can still fire off the exact single pair");
});

test("pure 15: all required facts unavailable -> blocked", () => {
  const r = evaluateConservativeSharedGuard({ deviceDistinctAccounts: null, deviceAnonUploads: null, unorderedDeviceAccountPairCount: null, pairOtherVerifiedPassportCount: null });
  assert.equal(r.passed, false);
  assert.equal(r.reason, "BLOCKED_INSUFFICIENT_EVIDENCE");
});

test("pure 10: reciprocal pair collapses to one — {A,B} == {B,A} (count is set-based upstream, decision uses the single value)", () => {
  // The decision layer receives an already-deduped count; here we prove
  // exactly-1 passes Branch B and 2 does not.
  assert.equal(evaluateConservativeSharedGuard({ deviceDistinctAccounts: 2, deviceAnonUploads: 0, unorderedDeviceAccountPairCount: 1, pairOtherVerifiedPassportCount: 0 }).branchB, true);
  assert.equal(evaluateConservativeSharedGuard({ deviceDistinctAccounts: 2, deviceAnonUploads: 0, unorderedDeviceAccountPairCount: 2, pairOtherVerifiedPassportCount: 0 }).branchB, false);
});

test("canonical: simulateSharedDevicePolicies' CONSERVATIVE_COMBINED == evaluateConservativeSharedGuard (no drift)", () => {
  const cases = [
    { deviceDistinctAccounts: 2, deviceAnonUploads: 0, unorderedDeviceAccountPairCount: 1, pairOtherVerifiedPassportCount: 0 },
    { deviceDistinctAccounts: 2, deviceAnonUploads: 0, unorderedDeviceAccountPairCount: 3, pairOtherVerifiedPassportCount: 1 },
    { deviceDistinctAccounts: 3, deviceAnonUploads: 0, unorderedDeviceAccountPairCount: 1, pairOtherVerifiedPassportCount: 9 },
    { deviceDistinctAccounts: 2, deviceAnonUploads: 4, unorderedDeviceAccountPairCount: 1, pairOtherVerifiedPassportCount: 9 },
    { deviceDistinctAccounts: null, deviceAnonUploads: null, unorderedDeviceAccountPairCount: null, pairOtherVerifiedPassportCount: null },
  ];
  for (const c of cases) {
    const sim = simulateSharedDevicePolicies({ currentRuleWouldDowngrade: true, pairSharedPassportCount: 1, ...c }).CONSERVATIVE_COMBINED;
    assert.equal(sim, evaluateConservativeSharedGuard(c).passed, `drift for ${JSON.stringify(c)}`);
  }
});

// ===========================================================================
// DB SCORING INTEGRATION
// ===========================================================================

test("1: SELF flag OFF -> baseline byte-identical regardless of the guard flag", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture();
  const guardOff = await withFlags({ self: undefined, guard: undefined }, () => resolve({ ...fx, rawText: fx.text }));
  const guardOn = await withFlags({ self: undefined, guard: "true" }, () => resolve({ ...fx, rawText: fx.text }));
  assert.equal(guardOff.unifiedSimilarity.unifiedScore, 100, "SELF off: an exact whole-document corpus match is 100%");
  assert.deepEqual(guardOn.unifiedSimilarity, guardOff.unifiedSimilarity, "the guard flag does nothing while SELF is off");
  assert.deepEqual(guardOn.effectiveDeviceSelfRepresentationIds, []);
  assert.equal(guardOn.deviceSelfSharedGuard, null, "no guard object when SELF scoring is off");
});

test("2: SELF ON + guard OFF -> byte-identical current Device Passport SELF behaviour", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture();
  const selfOnlyA = await withFlags({ self: "true", guard: undefined }, () => resolve({ ...fx, rawText: fx.text }));
  const selfOnlyB = await withFlags({ self: "true", guard: "false" }, () => resolve({ ...fx, rawText: fx.text }));
  assert.equal(selfOnlyA.unifiedSimilarity.unifiedScore, 0, "SELF on, guard off: the same-device corpus source is an effective SELF -> 0");
  assert.deepEqual(selfOnlyA.effectiveDeviceSelfRepresentationIds, [fx.repId]);
  assert.deepEqual(selfOnlyB.unifiedSimilarity, selfOnlyA.unifiedSimilarity, "guard='false' is identical to guard unset");
  assert.equal(selfOnlyA.deviceSelfSharedGuard.enabled, false);
  assert.equal(selfOnlyA.deviceSelfSharedGuard.passed, true);
  assert.equal(selfOnlyA.deviceSelfSharedGuard.reason, "NOT_APPLIED");
});

test("3 + 22: SELF ON + guard ON + Branch A qualifies (pair on other Passports) -> SELF (score 0)", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture();
  // the (T,S) pair also co-occurs on two OTHER Passports in the durable ledger
  const passportP2 = uniq("passportP2"), passportP3 = uniq("passportP3");
  await seedActorUsage(passportP2, fx.accountT);
  await seedActorUsage(passportP2, fx.accountS);
  await seedActorUsage(passportP3, fx.accountT);
  await seedActorUsage(passportP3, fx.accountS);

  const on = await withFlags({ self: "true", guard: "true" }, () => resolve({ ...fx, rawText: fx.text }));
  assert.equal(on.unifiedSimilarity.unifiedScore, 0, "Branch A satisfied -> the SELF downgrade is kept");
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [fx.repId]);
  const g = on.deviceSelfSharedGuard;
  assert.equal(g.enabled, true);
  assert.equal(g.passed, true);
  assert.equal(g.reason, "PAIR_OTHER_PASSPORT");
  assert.equal(g.deviceDistinctAccounts, 2);
  assert.equal(g.deviceAnonUploads, 0);
  assert.equal(g.unorderedDeviceAccountPairCount, 1);
  assert.equal(g.pairOtherVerifiedPassportCount, 2, "live fixture shape: 2 other Passports carry the pair");
});

test("4: SELF ON + guard ON + Branch B qualifies (lone shared browser, no other Passport) -> SELF (score 0)", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture();
  const on = await withFlags({ self: "true", guard: "true" }, () => resolve({ ...fx, rawText: fx.text }));
  assert.equal(on.unifiedSimilarity.unifiedScore, 0);
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [fx.repId]);
  const g = on.deviceSelfSharedGuard;
  assert.equal(g.passed, true);
  assert.equal(g.reason, "LOW_RISK_SINGLE_PAIR");
  assert.equal(g.unorderedDeviceAccountPairCount, 1);
  assert.equal(g.pairOtherVerifiedPassportCount, 0);
});

test("5: SELF ON + guard ON + 3 accounts on the Passport -> verdict BLOCKED_ACCOUNT_FANOUT (telemetry) but scoring still SELF (score 0)", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture();
  await seedActorUsage(fx.passportP, uniq("accU")); // a third account durably used device P

  const on = await withFlags({ self: "true", guard: "true" }, () => resolve({ ...fx, rawText: fx.text }));
  assert.equal(on.unifiedSimilarity.unifiedScore, 0, "shared-device fan-out no longer vetoes the Device Passport SELF downgrade");
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [fx.repId], "the base rule still made it an effective SELF");
  const g = on.deviceSelfSharedGuard;
  assert.equal(g.passed, false, "the Policy D verdict is still recorded for admin telemetry");
  assert.equal(g.reason, "BLOCKED_ACCOUNT_FANOUT");
  assert.equal(g.deviceDistinctAccounts, 3);
});

test("6: SELF ON + guard ON + anonymous upload on the Passport -> verdict BLOCKED_ANONYMOUS_USE (telemetry) but scoring still SELF (score 0)", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture();
  await seedActorUsage(fx.passportP, null, { anonymous: true }); // durable anonymous use of device P

  const on = await withFlags({ self: "true", guard: "true" }, () => resolve({ ...fx, rawText: fx.text }));
  assert.equal(on.unifiedSimilarity.unifiedScore, 0, "durable anonymous use no longer vetoes the Device Passport SELF downgrade");
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [fx.repId]);
  const g = on.deviceSelfSharedGuard;
  assert.equal(g.passed, false, "recorded for admin telemetry only");
  assert.equal(g.reason, "BLOCKED_ANONYMOUS_USE");
  assert.equal(g.deviceDistinctAccounts, 2);
  assert.ok(g.deviceAnonUploads >= 1);
});

test("7: SELF ON + guard ON + a second cross-account source (forces 3 device accounts) -> verdict blocked (telemetry) but scoring still SELF", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture();
  // a SECOND same-device backing on the SAME representation, from a different account U, also on passport P.
  const accountU = uniq("accU2");
  await addSameDeviceAdmissionBacking(fx.repId, { sourceAccountId: accountU, passportId: fx.passportP });
  await seedActorUsage(fx.passportP, accountU);

  const on = await withFlags({ self: "true", guard: "true" }, () => resolve({ ...fx, rawText: fx.text }));
  assert.equal(on.unifiedSimilarity.unifiedScore, 0, "same-device + exact + zero independent backing -> the base rule still makes it an effective SELF");
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [fx.repId]);
  assert.equal(on.deviceSelfSharedGuard.passed, false, "the >2-account fan-out is still recorded for admin telemetry");
});

test("8: SELF ON + guard ON + pair corroborated on another Passport -> Branch A keeps SELF", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture();
  const passportP2 = uniq("passportP2");
  await seedActorUsage(passportP2, fx.accountT);
  await seedActorUsage(passportP2, fx.accountS);

  const on = await withFlags({ self: "true", guard: "true" }, () => resolve({ ...fx, rawText: fx.text }));
  assert.equal(on.unifiedSimilarity.unifiedScore, 0);
  assert.equal(on.deviceSelfSharedGuard.reason, "PAIR_OTHER_PASSPORT");
  assert.equal(on.deviceSelfSharedGuard.pairOtherVerifiedPassportCount, 1);
});

test("9: SELF ON + guard ON + current Passport only (no other Passport) -> Branch A false, Branch B carries it", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture();
  const on = await withFlags({ self: "true", guard: "true" }, () => resolve({ ...fx, rawText: fx.text }));
  assert.equal(on.deviceSelfSharedGuard.pairOtherVerifiedPassportCount, 0, "Branch A cannot fire");
  assert.equal(on.deviceSelfSharedGuard.reason, "LOW_RISK_SINGLE_PAIR");
  assert.equal(on.unifiedSimilarity.unifiedScore, 0);
});

test("10: reciprocal same-device backings from ONE source account count as one pair", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture();
  // add a SECOND same-device backing to the SAME rep, again from account S (reciprocal / repeat).
  await addSameDeviceAdmissionBacking(fx.repId, { sourceAccountId: fx.accountS, passportId: fx.passportP });

  const on = await withFlags({ self: "true", guard: "true" }, () => resolve({ ...fx, rawText: fx.text }));
  assert.equal(on.deviceSelfSharedGuard.unorderedDeviceAccountPairCount, 1, "two backings, one source account -> one pair");
  assert.equal(on.unifiedSimilarity.unifiedScore, 0);
});

test("11-12 (DB): a guard-resolution failure is telemetry only — the Device Passport SELF downgrade still holds", async () => {
  // A non-canonical source_ref makes the guard's account-pair unresolvable, so
  // its verdict is a conservative BLOCKED_INSUFFICIENT_EVIDENCE — but that no
  // longer changes the score.
  const fx = await seedTwoAccountSharedDeviceFixture();
  // replace the backing with a non-canonical one (source account unresolvable by the guard)
  await client.execute({ sql: "DELETE FROM corpus_admission_promotions WHERE representation_id = ?", args: [fx.repId] });
  await addSameDeviceAdmissionBacking(fx.repId, { sourceAccountId: fx.accountS, passportId: fx.passportP, nonCanonicalSourceRef: true });

  const on = await withFlags({ self: "true", guard: "true" }, () => resolve({ ...fx, rawText: fx.text }));
  assert.equal(on.unifiedSimilarity.unifiedScore, 0, "an unresolvable guard fact no longer changes the score");
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [fx.repId], "the base rule still saw a same-device exact match with zero independent backing");
  assert.equal(on.deviceSelfSharedGuard.passed, false, "the conservative verdict is still recorded for admin telemetry");
  assert.equal(on.deviceSelfSharedGuard.reason, "BLOCKED_INSUFFICIENT_EVIDENCE");
});

test("15 (DB): representation drift / no resolvable backing -> match remains counted", async () => {
  // corpus source with a same-device backing, but strip the promotion so no
  // backing survives at guard time — classifier still saw it via provenance? No:
  // strip AFTER seeding but the classifier reads live too, so instead use a rep
  // whose only backing is non-canonical (covered above). Here: no cross-account,
  // no same-account, no unresolved -> BLOCKED_INSUFFICIENT_EVIDENCE is unreachable
  // because such a rep is never an effective SELF. Assert the realistic path:
  // guard ON, fixture qualifies, then remove S's device-provenance row so the
  // same-device backing disappears -> rep is no longer effective SELF -> counted.
  const fx = await seedTwoAccountSharedDeviceFixture();
  await client.execute({ sql: "DELETE FROM corpus_admission_decision_device_provenance", args: [] });
  const on = await withFlags({ self: "true", guard: "true" }, () => resolve({ ...fx, rawText: fx.text }));
  assert.equal(on.unifiedSimilarity.unifiedScore, 100);
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, []);
});

test("16: an independent backing still blocks the SELF downgrade BEFORE the guard is consulted", async () => {
  const text = takeText();
  const deviceKey = uniq("dk"), reportId = uniq("r"), passportP = uniq("passportP"), accountT = uniq("accT"), accountS = uniq("accS");
  const repId = await seedExactCorpusSource(text, { backingPassportId: passportP, sourceAccountId: accountS, extraIndependentBacking: true });
  await seedReport({ deviceKey, reportId, accountId: accountT, passportId: passportP, rawText: text });
  await seedBareReportUnderPassport({ accountId: accountS, passportId: passportP });

  const on = await withFlags({ self: "true", guard: "true" }, () => resolve({ deviceKey, reportId, accountId: accountT, rawText: text }));
  assert.equal(on.unifiedSimilarity.unifiedScore, 100, "independent backing -> not an effective SELF -> guard never runs");
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, []);
  assert.equal(on.deviceSelfSharedGuard.reason, "NOT_APPLIED");
  void repId;
});

test("17: a DIFFERENT verified Passport still counts (guard never runs)", async () => {
  const text = takeText();
  const deviceKey = uniq("dk"), reportId = uniq("r"), reportPassport = uniq("passportR"), otherPassport = uniq("passportO");
  await seedExactCorpusSource(text, { backingPassportId: otherPassport, sourceAccountId: uniq("accS") });
  await seedReport({ deviceKey, reportId, accountId: uniq("accT"), passportId: reportPassport, rawText: text });

  const on = await withFlags({ self: "true", guard: "true" }, () => resolve({ deviceKey, reportId, rawText: text }));
  assert.equal(on.unifiedSimilarity.unifiedScore, 100);
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, []);
  assert.equal(on.deviceSelfSharedGuard.reason, "NOT_APPLIED");
});

test("18: a same-device STRONG_TEXT_MATCH now qualifies as an effective SELF (guard does not veto)", async () => {
  const text = takeText();
  const deviceKey = uniq("dk"), reportId = uniq("r"), passportP = uniq("passportP");
  const nearText = `${text} A trailing clause that makes this a near but not byte-identical variant of the submitted document for this particular test case.`;
  const repId = await seedExactCorpusSource(nearText, { backingPassportId: passportP, sourceAccountId: uniq("accS") });
  await seedReport({ deviceKey, reportId, accountId: uniq("accT"), passportId: passportP, rawText: text });

  const on = await withFlags({ self: "true", guard: "true" }, () => resolve({ deviceKey, reportId, rawText: text }));
  assert.equal(on.historicalSubmissionMatch.matches[0].matchType, "STRONG_TEXT_MATCH");
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [repId], "STRONG_TEXT_MATCH same-device source qualifies");
  assert.equal(on.unifiedSimilarity.unifiedScore, 0, "and the strong same-device source contributes 0");
  const contrib = on.unifiedSimilarity.contributions.find((c) => c.sourceId === repId);
  assert.equal(contrib.effectiveScoringReason, "SAME_DEVICE_STRONG_TEXT_DOCUMENT");
});

test("18b: a DIFFERENT verified Passport + STRONG_TEXT_MATCH still counts (guard never runs)", async () => {
  const text = takeText();
  const deviceKey = uniq("dk"), reportId = uniq("r"), reportPassport = uniq("passportR"), otherPassport = uniq("passportO");
  const nearText = `${text} A trailing clause that makes this a near but not byte-identical variant for the different-passport strong case.`;
  await seedExactCorpusSource(nearText, { backingPassportId: otherPassport, sourceAccountId: uniq("accS") });
  await seedReport({ deviceKey, reportId, accountId: uniq("accT"), passportId: reportPassport, rawText: text });

  const on = await withFlags({ self: "true", guard: "true" }, () => resolve({ deviceKey, reportId, rawText: text }));
  assert.equal(on.historicalSubmissionMatch.matches[0].matchType, "STRONG_TEXT_MATCH");
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, []);
  assert.ok(on.unifiedSimilarity.unifiedScore > 0);
});

test("19: same-account SELF is UNCHANGED by the guard (genuine SELF match)", async () => {
  const text = takeText();
  const deviceKey = uniq("dk"), reportId = uniq("r"), account = uniq("acc-self");
  await ensureUser(account);
  await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: (await createDocumentIdentity(client, { accountId: account, title: "p1", author: null, rawText: text })).id, rawText: text });
  await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: (await createDocumentIdentity(client, { accountId: account, title: "p2", author: null, rawText: text })).id, rawText: text });
  await seedReport({ deviceKey, reportId, accountId: account, rawText: text });

  const guardOff = await withFlags({ self: "true", guard: undefined }, () => resolve({ deviceKey, reportId, accountId: account, rawText: text }));
  const guardOn = await withFlags({ self: "true", guard: "true" }, () => resolve({ deviceKey, reportId, accountId: account, rawText: text }));
  assert.equal(guardOff.historicalSubmissionMatch.matches[0].relationshipType, "SELF");
  assert.deepEqual(guardOn.unifiedSimilarity, guardOff.unifiedSimilarity, "a genuine same-account SELF is identical with the guard on");
  assert.deepEqual(guardOn.effectiveDeviceSelfRepresentationIds, []);
  assert.equal(guardOn.unifiedSimilarity.selfExcludedWords > 0, true);
});

test("19b: guard resolver — a same-account-only same-device backing is NOT_APPLIED (SAME-ACCOUNT rule), SELF kept", async () => {
  // Direct resolver test: the production matcher never even offers a report a
  // representation backed ONLY by its own account (the account-level self-match
  // fix), so this defensive branch is exercised here against the resolver.
  const text = takeText();
  const passportP = uniq("ppOwn"), account = uniq("accOwn");
  const repId = await seedExactCorpusSource(text, { backingPassportId: passportP, sourceAccountId: account });
  await seedReport({ deviceKey: uniq("dk"), reportId: uniq("r"), accountId: account, passportId: passportP, rawText: text });

  const g = await evaluateDeviceSelfSharedGuard(client, {
    enabled: true,
    verifiedDevicePassportId: passportP,
    reportAccountId: account,
    effectiveSelfRepresentationIds: [repId],
  });
  assert.equal(g.passed, true, "same-account-only -> guard does not act, SELF downgrade kept");
  assert.equal(g.reason, "NOT_APPLIED");
  assert.equal(g.unorderedDeviceAccountPairCount, 0);
  assert.equal(g.durableActorHistoryComplete, null, "same-account short-circuit never evaluates durable history");
});

test("20 + 21: independent archive AND scholarly positions survive the guard-passed SELF exclusion", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture(); // Branch B qualifies
  const wc = tokens(canonicalizeText(fx.text)).length;
  const archivePositions = range(0, Math.min(20, wc));
  const externalAcademicEvidence = [{
    provider: "openaire", providerId: "o-1", title: "Ext", authors: null, publication: null, year: null,
    doi: "10.1/x", url: "https://ex.test/x", similarity: 90,
    matchedPassages: [{ submittedText: "", submittedWordStart: Math.min(40, wc - 1), submittedWordEnd: Math.min(60, wc - 1), matchedWordCount: 20 }],
  }];
  const on = await withFlags({ self: "true", guard: "true" }, () => resolve({ ...fx, rawText: fx.text, archiveMatchedPositions: archivePositions, externalAcademicEvidence }));
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [fx.repId], "the device source is still an effective SELF");
  assert.ok(on.unifiedSimilarity.deviceSelfExcludedWords > 0);
  assert.ok(on.unifiedSimilarity.archiveOnlyWords > 0, "independent archive positions survive");
  assert.ok(on.unifiedSimilarity.liveAcademicOnlyWords > 0, "independent scholarly positions survive");
  assert.ok(on.unifiedSimilarity.unifiedScore > 0 && on.unifiedSimilarity.unifiedScore < 100);
});

test("23 + 24: ordinary API leaks nothing; admin trace carries only bounded guard counts + enum", async () => {
  process.env.DEVICE_PASSPORT_ENABLED = "true";
  try {
    const fx = await seedTwoAccountSharedDeviceFixture();
    await withFlags({ self: "true", guard: "true" }, async () => {
      const resolution = await resolve({ ...fx, rawText: fx.text });
      assert.equal(resolution.unifiedSimilarity.unifiedScore, 0, "sanity: Branch B kept the SELF downgrade");

      const trace = await getReportSimilarityDecisionTrace(client, fx.deviceKey, fx.reportId);
      assert.ok(trace.resolvable);
      const g = trace.deviceSelfSharedGuard;
      assert.ok(g, "the admin trace carries the guard decision");
      assert.equal(g.sharedGuardEnabled, true);
      assert.equal(g.sharedGuardPassed, true);
      assert.equal(g.sharedGuardReason, "LOW_RISK_SINGLE_PAIR");
      assert.equal(g.durableActorHistoryComplete, true, "a boolean — never the tracking-version number");
      assert.equal(g.deviceDistinctAccounts, 2);
      assert.equal(g.deviceAnonUploads, 0);
      assert.equal(g.unorderedDeviceAccountPairCount, 1);
      assert.equal(g.pairOtherVerifiedPassportCount, 0);
      // the guard object itself is bounded primitives only — no identity of any kind
      for (const v of Object.values(g)) assert.ok(typeof v === "boolean" || typeof v === "number" || typeof v === "string" || v === null);
      assert.equal(typeof g.durableActorHistoryComplete, "boolean", "durableActorHistoryComplete is a bare boolean here");
      const guardSerialized = JSON.stringify(g);
      for (const forbidden of [
        fx.passportP, fx.accountT, fx.accountS, `${fx.accountT}@ex.test`, `${fx.accountS}@ex.test`,
        `spki-${fx.passportP}`, "source_ref", "report-upload:account=",
        actorKeyOf(fx.accountT), actorKeyOf(fx.accountS), ANONYMOUS_ACTOR_KEY, "actor_key",
        "actor_usage_tracking_version", "tracking_version", "trackingVersion",
      ]) {
        assert.equal(guardSerialized.includes(forbidden), false, `guard object leaked: ${forbidden}`);
      }
      // the shared guard adds no Passport secret / device-key / report-owner id
      // to the wider trace either. (Cross-account BACKING identity on the
      // downgraded corpus source is a separate, pre-existing admin-only feature
      // — see tests/device-passport-self-scoring.test.mjs test 14.)
      const serialized = JSON.stringify(trace);
      for (const forbidden of [fx.passportP, fx.accountT, `${fx.accountT}@ex.test`, `spki-${fx.passportP}`, "public_key_spki", "verified_device_passport_id", "device_passport_id", "session_token_hash", "nonce_hash"]) {
        assert.equal(serialized.includes(forbidden), false, `admin trace leaked: ${forbidden}`);
      }
    });
  } finally {
    delete process.env.DEVICE_PASSPORT_ENABLED;
  }
});

test("25: the scoring path imports no shadow / measurement / developer module", () => {
  const importLines = (src) => src.split(/\r?\n/).filter((l) => /^\s*(?:import|export)\b.*\bfrom\b/.test(l)).join("\n");
  const forbidden = /device-provenance-shadow|device-provenance-shadow-measurement|device-sharedness-measurement|developer-repo/;
  for (const rel of ["lib/report-primary-similarity.ts", "lib/device-shared-guard.ts", "lib/device-shared-guard-policy.ts"]) {
    const imports = importLines(fs.readFileSync(path.join(repoRoot, rel), "utf8"));
    assert.doesNotMatch(imports, forbidden, `${rel} must not import a shadow/measurement/developer module`);
  }
});

test("26: the guard DB resolver is SELECT-only (no INSERT / UPDATE / DELETE / DDL)", () => {
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const code = stripComments(fs.readFileSync(path.join(repoRoot, "lib/device-shared-guard.ts"), "utf8"));
  assert.doesNotMatch(code, /\bINSERT\s+INTO\b/i, "no INSERT");
  assert.doesNotMatch(code, /\bUPDATE\s+\w+\s+SET\b/i, "no UPDATE");
  assert.doesNotMatch(code, /\bDELETE\s+FROM\b/i, "no DELETE");
  assert.doesNotMatch(code, /\bCREATE\s+TABLE\b/i, "no DDL");
});

test("26b: the pure Policy-D module is pure — no @libsql/client, no env, no db calls", () => {
  const src = fs.readFileSync(path.join(repoRoot, "lib/device-shared-guard-policy.ts"), "utf8");
  const importLines = src.split(/\r?\n/).filter((l) => /^\s*import\b/.test(l)).join("\n");
  assert.equal(importLines.trim(), "", "the canonical Policy-D module imports nothing");
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ""), /process\.env|client\.(execute|batch)/, "no env read, no db call");
});

test("27 (DB): a throwing client during guard resolution is telemetry only — the SELF downgrade still holds", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture();
  // a client whose execute throws on the guard's fan-out SELECT (the base-rule
  // classifier queries still succeed). Resolve normally first to warm the
  // snapshot, then run again with a client that throws on the fan-out SELECT.
  await withFlags({ self: "true", guard: "true" }, () => resolve({ ...fx, rawText: fx.text }));

  let calls = 0;
  const throwingClient = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "execute") {
        return async (arg) => {
          calls += 1;
          const sql = typeof arg === "string" ? arg : arg?.sql ?? "";
          // the repointed guard's durable fan-out SELECT against device_passport_actor_usage
          if (/SUM\(CASE WHEN is_anonymous = 0 THEN 1 ELSE 0 END\)/i.test(sql)) {
            throw new Error("simulated guard query failure");
          }
          return target.execute(arg);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const resolution = await withFlags({ self: "true", guard: "true" }, () =>
    resolvePrimarySimilaritySummary(throwingClient, {
      reportDeviceKey: fx.deviceKey, reportId: fx.reportId, accountId: fx.accountT, rawText: fx.text,
      wordCount: tokens(canonicalizeText(fx.text)).length,
      archiveMatchedPositions: null, externalAcademicEvidence: null, archiveScore: 0,
    }),
  );
  assert.ok(calls > 0, "the throwing client was exercised");
  assert.equal(resolution.unifiedSimilarity.unifiedScore, 0, "a guard query throwing no longer changes the score");
  assert.deepEqual(resolution.effectiveDeviceSelfRepresentationIds, [fx.repId]);
  assert.equal(resolution.deviceSelfSharedGuard.passed, false, "the failure is recorded as a conservative admin-telemetry verdict");
});

// ===========================================================================
// REPOINTED TO device_passport_actor_usage — the 10 critical scenarios
// ===========================================================================

/** Direct guard call with the repointed fact sources. */
function runGuard(fx, over = {}) {
  return evaluateDeviceSelfSharedGuard(client, {
    enabled: true,
    verifiedDevicePassportId: fx.passportP,
    reportAccountId: fx.accountT,
    effectiveSelfRepresentationIds: [fx.repId],
    ...over,
  });
}

test("REPOINT 1: current Passport actor_usage_tracking_version 0 -> verdict BLOCKED_INCOMPLETE_ACTOR_HISTORY (telemetry), scoring still SELF", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture();
  await setPassportTrackingVersion(fx.passportP, 0); // legacy / history-incomplete

  const g = await runGuard(fx);
  assert.equal(g.passed, false, "a version-0 Passport produces a conservative telemetry verdict");
  assert.equal(g.reason, "BLOCKED_INCOMPLETE_ACTOR_HISTORY", "the normal legacy case has its own bounded reason, not BLOCKED_INSUFFICIENT_EVIDENCE");
  assert.equal(g.durableActorHistoryComplete, false);

  const on = await withFlags({ self: "true", guard: "true" }, () => resolve({ ...fx, rawText: fx.text }));
  assert.equal(on.unifiedSimilarity.unifiedScore, 0, "the incomplete-actor-history verdict is telemetry only — the SELF downgrade holds");
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [fx.repId]);
});

test("REPOINT 2: version 0 + a full set of backfilled/observed ledger rows STILL blocks (INCOMPLETE_ACTOR_HISTORY)", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture();
  // exactly the clean two-account shape a legitimate pass would need...
  await seedActorUsage(fx.passportP, fx.accountT);
  await seedActorUsage(fx.passportP, fx.accountS);
  // ...but the Passport itself is not durably tracked.
  await setPassportTrackingVersion(fx.passportP, 0);

  const g = await runGuard(fx);
  assert.equal(g.passed, false, "ledger rows never substitute for durable-since-birth tracking");
  assert.equal(g.reason, "BLOCKED_INCOMPLETE_ACTOR_HISTORY");
  assert.equal(g.durableActorHistoryComplete, false);
});

test("REPOINT 3: version 1 + clean two-account ledger case PASSES (Branch B, score 0)", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture(); // version 1, T+S pseudonymous rows on P
  const g = await runGuard(fx);
  assert.equal(g.passed, true);
  assert.equal(g.reason, "LOW_RISK_SINGLE_PAIR");
  assert.equal(g.durableActorHistoryComplete, true);
  assert.equal(g.deviceDistinctAccounts, 2);
  assert.equal(g.deviceAnonUploads, 0);
  assert.equal(g.unorderedDeviceAccountPairCount, 1);
  assert.equal(g.pairOtherVerifiedPassportCount, 0);

  const on = await withFlags({ self: "true", guard: "true" }, () => resolve({ ...fx, rawText: fx.text }));
  assert.equal(on.unifiedSimilarity.unifiedScore, 0);
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [fx.repId]);
});

test("REPOINT 4: a THIRD durable account on the ledger -> blocked verdict even after every saved_reports row is deleted", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture();
  await seedActorUsage(fx.passportP, uniq("accU")); // third durable actor on P
  await client.execute({ sql: "DELETE FROM saved_reports", args: [] }); // fan-out is NOT a saved_reports fact

  const g = await runGuard(fx);
  assert.equal(g.passed, false);
  assert.equal(g.reason, "BLOCKED_ACCOUNT_FANOUT");
  assert.equal(g.deviceDistinctAccounts, 3, "the count came from device_passport_actor_usage, not saved_reports");
});

test("REPOINT 5: durable anonymous actor evidence -> blocked verdict even after the anonymous report is claimed / deleted", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture();
  await seedActorUsage(fx.passportP, null, { anonymous: true }); // durable anonymous-use sentinel
  await client.execute({ sql: "DELETE FROM saved_reports WHERE user_id IS NULL", args: [] }); // "claim / delete" every anon report
  await client.execute({ sql: "DELETE FROM saved_reports", args: [] });

  const g = await runGuard(fx);
  assert.equal(g.passed, false);
  assert.equal(g.reason, "BLOCKED_ANONYMOUS_USE");
  assert.equal(g.deviceAnonUploads, 1, "the veto came from the durable anonymous actor row");
});

test("REPOINT 6: other-Passport pair corroboration survives saved_reports deletion (Branch A, from the ledger)", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture();
  const passportP2 = uniq("passportP2");
  await seedActorUsage(passportP2, fx.accountT);
  await seedActorUsage(passportP2, fx.accountS);
  await client.execute({ sql: "DELETE FROM saved_reports", args: [] });

  const g = await runGuard(fx);
  assert.equal(g.passed, true);
  assert.equal(g.reason, "PAIR_OTHER_PASSPORT");
  assert.equal(g.pairOtherVerifiedPassportCount, 1, "co-occurrence came from device_passport_actor_usage on the other Passport");
});

test("REPOINT 7: a missing target OR source ledger-membership row blocks", async () => {
  // source (S) missing from the current Passport ledger
  const a = await seedTwoAccountSharedDeviceFixture();
  await client.execute({
    sql: "DELETE FROM device_passport_actor_usage WHERE device_passport_id = ? AND actor_key = ?",
    args: [a.passportP, actorKeyOf(a.accountS)],
  });
  const gS = await runGuard(a);
  assert.equal(gS.passed, false, "source actor not positively present -> blocked");
  assert.equal(gS.reason, "BLOCKED_INSUFFICIENT_EVIDENCE", "missing durable membership is insufficient-evidence, not incomplete-history");
  assert.equal(gS.durableActorHistoryComplete, true, "the Passport IS durably tracked; only a membership row is missing");

  // target (T) missing from the current Passport ledger
  const b = await seedTwoAccountSharedDeviceFixture();
  await client.execute({
    sql: "DELETE FROM device_passport_actor_usage WHERE device_passport_id = ? AND actor_key = ?",
    args: [b.passportP, actorKeyOf(b.accountT)],
  });
  const gT = await runGuard(b);
  assert.equal(gT.passed, false, "target actor not positively present -> blocked");
  assert.equal(gT.reason, "BLOCKED_INSUFFICIENT_EVIDENCE");
  assert.equal(gT.durableActorHistoryComplete, true);
});

test("REPOINT 8: a missing actor HMAC key -> verdict BLOCKED_INSUFFICIENT_EVIDENCE (telemetry), scoring still SELF", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture();
  const g = await withActorKey(undefined, () => runGuard(fx));
  assert.equal(g.passed, false);
  assert.equal(g.reason, "BLOCKED_INSUFFICIENT_EVIDENCE", "key derivation failure is NOT the legacy-version-0 case");
  assert.equal(g.durableActorHistoryComplete, true, "the version was read (>= 1) before the HMAC check");

  const on = await withActorKey(undefined, () =>
    withFlags({ self: "true", guard: "true" }, () => resolve({ ...fx, rawText: fx.text })),
  );
  assert.equal(on.unifiedSimilarity.unifiedScore, 0, "a guard-evidence failure is telemetry only — the SELF downgrade holds");
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [fx.repId]);
});

test("REPOINT 9: guard OFF is byte-identical — the ledger has ZERO influence when the flag is off", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture();
  // an account fan-out AND anonymous use in the ledger — enough to block if the guard ran
  await seedActorUsage(fx.passportP, uniq("accX"));
  await seedActorUsage(fx.passportP, uniq("accY"));
  await seedActorUsage(fx.passportP, null, { anonymous: true });

  const unset = await withFlags({ self: "true", guard: undefined }, () => resolve({ ...fx, rawText: fx.text }));
  const explicitFalse = await withFlags({ self: "true", guard: "false" }, () => resolve({ ...fx, rawText: fx.text }));
  assert.equal(unset.unifiedSimilarity.unifiedScore, 0, "guard off: the Device Passport SELF downgrade is kept regardless of the ledger");
  assert.deepEqual(unset.effectiveDeviceSelfRepresentationIds, [fx.repId]);
  assert.deepEqual(explicitFalse.unifiedSimilarity, unset.unifiedSimilarity, "guard='false' == guard unset, byte for byte");
  assert.equal(unset.deviceSelfSharedGuard.enabled, false);
  assert.equal(unset.deviceSelfSharedGuard.passed, true);
  assert.equal(unset.deviceSelfSharedGuard.reason, "NOT_APPLIED");
  assert.equal(unset.deviceSelfSharedGuard.deviceDistinctAccounts, null, "guard off never even resolves a fact");
  assert.equal(unset.deviceSelfSharedGuard.durableActorHistoryComplete, null, "guard off: durable actor history is never evaluated");
});

test("REPOINT 10: a DB failure on a ledger query fails CLOSED — the verdict is a block, never a pass", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture();
  let hit = 0;
  const throwing = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "execute") {
        return async (arg) => {
          const sql = typeof arg === "string" ? arg : arg?.sql ?? "";
          if (/FROM device_passport_actor_usage/i.test(sql) && /actor_key = \?/i.test(sql)) {
            hit += 1;
            throw new Error("simulated actor-ledger membership query failure");
          }
          return target.execute(arg);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const g = await evaluateDeviceSelfSharedGuard(throwing, {
    enabled: true,
    verifiedDevicePassportId: fx.passportP,
    reportAccountId: fx.accountT,
    effectiveSelfRepresentationIds: [fx.repId],
  });
  assert.ok(hit > 0, "the failing ledger query was exercised");
  assert.equal(g.passed, false, "DB failure -> block, never SELF");
  assert.equal(g.reason, "BLOCKED_INSUFFICIENT_EVIDENCE", "a DB failure is insufficient-evidence, not incomplete-history");
  assert.equal(g.durableActorHistoryComplete, true, "the version read succeeded before the membership query threw");
});

test("REPOINT: the guard reads the durable ledger, not saved_reports, for its fan-out / pair facts", () => {
  const raw = fs.readFileSync(path.join(repoRoot, "lib/device-shared-guard.ts"), "utf8");
  // code only — strip block + line comments so the header prose can't match
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // the fan-out / anon / membership / pair-other facts must come from device_passport_actor_usage
  assert.match(code, /FROM device_passport_actor_usage/);
  assert.match(code, /actor_key_version/);
  assert.match(raw, /isDurableActorTrackingAvailable/);
  assert.match(code, /actor_usage_tracking_version/);
  // no saved_reports COUNT(DISTINCT user_id) fan-out, no saved_reports pair-safety join
  assert.doesNotMatch(code, /COUNT\(DISTINCT user_id\)/i, "no saved_reports fan-out count");
  assert.doesNotMatch(code, /FROM\s+saved_reports/i, "the guard must not read saved_reports at all");
});

// ===========================================================================
// FINAL TRACE CORRECTION — durableActorHistoryComplete + BLOCKED_INCOMPLETE_ACTOR_HISTORY
// ===========================================================================

test("TRACE 1: version 0 -> durableActorHistoryComplete=false + BLOCKED_INCOMPLETE_ACTOR_HISTORY", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture();
  await setPassportTrackingVersion(fx.passportP, 0);
  const g = await runGuard(fx);
  assert.equal(g.durableActorHistoryComplete, false);
  assert.equal(g.reason, "BLOCKED_INCOMPLETE_ACTOR_HISTORY");
  assert.equal(g.passed, false);
});

test("TRACE 2: version 1 passing case -> durableActorHistoryComplete=true", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture();
  const g = await runGuard(fx);
  assert.equal(g.passed, true);
  assert.equal(g.durableActorHistoryComplete, true);
});

test("TRACE 3: HMAC failure -> durableActorHistoryComplete=true + BLOCKED_INSUFFICIENT_EVIDENCE", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture();
  const g = await withActorKey(undefined, () => runGuard(fx));
  assert.equal(g.durableActorHistoryComplete, true);
  assert.equal(g.reason, "BLOCKED_INSUFFICIENT_EVIDENCE");
  assert.equal(g.passed, false);
});

test("TRACE 4: guard OFF -> durableActorHistoryComplete not evaluated (null), reason NOT_APPLIED", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture();
  const off = await withFlags({ self: "true", guard: undefined }, () => resolve({ ...fx, rawText: fx.text }));
  assert.equal(off.deviceSelfSharedGuard.enabled, false);
  assert.equal(off.deviceSelfSharedGuard.reason, "NOT_APPLIED");
  assert.equal(off.deviceSelfSharedGuard.durableActorHistoryComplete, null);
  // and the direct same-account short-circuit is likewise null (never evaluated)
  const text = takeText();
  const ppOwn = uniq("ppOwn"), accOwn = uniq("accOwn");
  const repId = await seedExactCorpusSource(text, { backingPassportId: ppOwn, sourceAccountId: accOwn });
  await seedReport({ deviceKey: uniq("dk"), reportId: uniq("r"), accountId: accOwn, passportId: ppOwn, rawText: text });
  const sameAcct = await evaluateDeviceSelfSharedGuard(client, {
    enabled: true, verifiedDevicePassportId: ppOwn, reportAccountId: accOwn, effectiveSelfRepresentationIds: [repId],
  });
  assert.equal(sameAcct.reason, "NOT_APPLIED");
  assert.equal(sameAcct.durableActorHistoryComplete, null, "same-account SELF never evaluates durable history — unchanged");
});

test("TRACE 5: ordinary API surfaces receive none of this — deviceSelfSharedGuard / durableActorHistoryComplete stay admin-only", () => {
  // structural: the guard decision lives on PrimarySimilarityResolution.deviceSelfSharedGuard
  // and is consumed ONLY by lib/developer-repo.ts (the admin decision trace).
  const readImports = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

  for (const rel of ["app/api/reports/[id]/route.ts", "app/api/reports/route.ts"]) {
    const src = readImports(rel);
    for (const forbidden of ["deviceSelfSharedGuard", "durableActorHistoryComplete", "sharedGuardReason", "DecisionTraceDeviceSelfSharedGuard"]) {
      assert.doesNotMatch(src, new RegExp(forbidden), `${rel} (ordinary user API) must not reference ${forbidden}`);
    }
  }

  // NO app/ route file references the guard decision at all — it never reaches
  // the ordinary user surface; it flows resolution -> lib/developer-repo.ts ->
  // lib/admin-similarity-decision-trace.ts (both admin-only).
  const walk = (dir, acc = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, acc);
      else if (/\.(ts|tsx)$/.test(e.name)) acc.push(full);
    }
    return acc;
  };
  const appReferers = walk(path.join(repoRoot, "app"))
    .filter((f) => /deviceSelfSharedGuard|durableActorHistoryComplete|sharedGuardReason|BLOCKED_INCOMPLETE_ACTOR_HISTORY/.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(repoRoot, f).split(path.sep).join("/"));
  assert.deepEqual(appReferers, [], `no app/ file may reference the shared-guard decision — it never reaches the ordinary user surface; found: ${appReferers.join(", ")}`);
});

test("TRACE 6: the admin serialization stays bounded — boolean|number|string|null only, incl. the new reason and boolean", async () => {
  process.env.DEVICE_PASSPORT_ENABLED = "true";
  try {
    const fx = await seedTwoAccountSharedDeviceFixture();
    await setPassportTrackingVersion(fx.passportP, 0); // exercise BLOCKED_INCOMPLETE_ACTOR_HISTORY through the trace
    await withFlags({ self: "true", guard: "true" }, async () => {
      await resolve({ ...fx, rawText: fx.text });
      const trace = await getReportSimilarityDecisionTrace(client, fx.deviceKey, fx.reportId);
      const g = trace.deviceSelfSharedGuard;
      assert.ok(g);
      assert.equal(g.sharedGuardReason, "BLOCKED_INCOMPLETE_ACTOR_HISTORY");
      assert.equal(g.sharedGuardPassed, false);
      assert.equal(g.durableActorHistoryComplete, false);
      for (const [k, v] of Object.entries(g)) {
        assert.ok(
          typeof v === "boolean" || typeof v === "number" || typeof v === "string" || v === null,
          `admin guard field ${k} is not a bounded primitive: ${typeof v}`,
        );
      }
      const s = JSON.stringify(g);
      for (const forbidden of [fx.passportP, fx.accountT, fx.accountS, actorKeyOf(fx.accountT), "actor_usage_tracking_version", "tracking_version", "trackingVersion"]) {
        assert.equal(s.includes(forbidden), false, `admin serialization leaked: ${forbidden}`);
      }
      // durableActorHistoryComplete is strictly a boolean|null — never a number
      assert.ok(g.durableActorHistoryComplete === true || g.durableActorHistoryComplete === false || g.durableActorHistoryComplete === null);
    });
  } finally {
    delete process.env.DEVICE_PASSPORT_ENABLED;
  }
});

// ===========================================================================
// NO-VETO REGRESSION — the shared-device fan-out verdict is ADMIN TELEMETRY,
// never a scoring veto. Once the base Device Passport SELF rule accepts a
// representation (production-counted relationship +
// EXACT_CANONICAL_MATCH/STRONG_TEXT_MATCH + sameVerifiedDeviceBacking + zero
// independent backing) it STAYS an effective SELF no matter what the
// shared-device guard / durable actor ledger reports.
// Runtime-oriented: every case drives resolvePrimarySimilaritySummary end to end.
// ===========================================================================

/** Add N extra distinct pseudonymous account actors to a Passport's durable ledger. */
async function addExtraDeviceAccounts(passportId, n) {
  for (let i = 0; i < n; i += 1) await seedActorUsage(passportId, uniq("fanout-acc"));
}

test("NO-VETO 1: 2 actors on one Passport, exact same-device doc -> effective SELF (score 0)", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture(); // T + S on P
  const on = await withFlags({ self: "true", guard: "true" }, () => resolve({ ...fx, rawText: fx.text }));
  assert.equal(on.unifiedSimilarity.unifiedScore, 0);
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [fx.repId]);
  assert.equal(on.deviceSelfSharedGuard.passed, true, "2 accounts, 0 anon -> Policy D Branch B");
});

test("NO-VETO 2: 3 actors on one Passport -> verdict BLOCKED_ACCOUNT_FANOUT, scoring still effective SELF (score 0)", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture();
  await addExtraDeviceAccounts(fx.passportP, 1); // -> 3 distinct actors
  const on = await withFlags({ self: "true", guard: "true" }, () => resolve({ ...fx, rawText: fx.text }));
  assert.equal(on.unifiedSimilarity.unifiedScore, 0);
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [fx.repId]);
  assert.equal(on.deviceSelfSharedGuard.passed, false);
  assert.equal(on.deviceSelfSharedGuard.reason, "BLOCKED_ACCOUNT_FANOUT");
  assert.equal(on.deviceSelfSharedGuard.deviceDistinctAccounts, 3);
});

test("NO-VETO 3: 10 actors on one Passport -> verdict BLOCKED_ACCOUNT_FANOUT, scoring still effective SELF (score 0)", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture();
  await addExtraDeviceAccounts(fx.passportP, 8); // -> 10 distinct actors
  const on = await withFlags({ self: "true", guard: "true" }, () => resolve({ ...fx, rawText: fx.text }));
  assert.equal(on.unifiedSimilarity.unifiedScore, 0);
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [fx.repId]);
  assert.equal(on.deviceSelfSharedGuard.passed, false);
  assert.equal(on.deviceSelfSharedGuard.reason, "BLOCKED_ACCOUNT_FANOUT");
  assert.equal(on.deviceSelfSharedGuard.deviceDistinctAccounts, 10);
});

test("NO-VETO 4: anonymous use in the Passport's durable history + exact same-device doc -> effective SELF (score 0)", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture();
  await seedActorUsage(fx.passportP, null, { anonymous: true });
  const on = await withFlags({ self: "true", guard: "true" }, () => resolve({ ...fx, rawText: fx.text }));
  assert.equal(on.unifiedSimilarity.unifiedScore, 0);
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [fx.repId]);
  assert.equal(on.deviceSelfSharedGuard.passed, false);
  assert.equal(on.deviceSelfSharedGuard.reason, "BLOCKED_ANONYMOUS_USE");
});

test("NO-VETO 5: verdict BLOCKED_ACCOUNT_FANOUT is carried on the admin trace but the score is 0", async () => {
  process.env.DEVICE_PASSPORT_ENABLED = "true";
  try {
    const fx = await seedTwoAccountSharedDeviceFixture();
    await addExtraDeviceAccounts(fx.passportP, 3); // -> 5 distinct actors
    await withFlags({ self: "true", guard: "true" }, async () => {
      const resolution = await resolve({ ...fx, rawText: fx.text });
      assert.equal(resolution.unifiedSimilarity.unifiedScore, 0);
      assert.deepEqual(resolution.effectiveDeviceSelfRepresentationIds, [fx.repId]);
      const trace = await getReportSimilarityDecisionTrace(client, fx.deviceKey, fx.reportId);
      assert.equal(trace.finalScore, 0);
      assert.equal(trace.deviceSelfSharedGuard.sharedGuardReason, "BLOCKED_ACCOUNT_FANOUT");
      assert.equal(trace.deviceSelfSharedGuard.sharedGuardPassed, false);
      const src = trace.sources.find((s) => s.sourceId === fx.repId);
      assert.equal(src.effectiveScoringRelationship, "SELF");
      assert.equal(src.countedTowardScore, false);
    });
  } finally {
    delete process.env.DEVICE_PASSPORT_ENABLED;
  }
});

test("NO-VETO 6: verdict BLOCKED_ANONYMOUS_USE is carried on the admin trace but the score is 0", async () => {
  process.env.DEVICE_PASSPORT_ENABLED = "true";
  try {
    const fx = await seedTwoAccountSharedDeviceFixture();
    await seedActorUsage(fx.passportP, null, { anonymous: true });
    await withFlags({ self: "true", guard: "true" }, async () => {
      const resolution = await resolve({ ...fx, rawText: fx.text });
      assert.equal(resolution.unifiedSimilarity.unifiedScore, 0);
      const trace = await getReportSimilarityDecisionTrace(client, fx.deviceKey, fx.reportId);
      assert.equal(trace.deviceSelfSharedGuard.sharedGuardReason, "BLOCKED_ANONYMOUS_USE");
      assert.equal(trace.deviceSelfSharedGuard.sharedGuardPassed, false);
      assert.equal(trace.finalScore, 0);
    });
  } finally {
    delete process.env.DEVICE_PASSPORT_ENABLED;
  }
});

test("NO-VETO 7: independentBackingCount > 0 STILL prevents the Device Passport SELF downgrade (base rule, not the guard)", async () => {
  const text = takeText();
  const deviceKey = uniq("dk"), reportId = uniq("r"), passportP = uniq("passportP"), accountT = uniq("accT"), accountS = uniq("accS");
  await seedExactCorpusSource(text, { backingPassportId: passportP, sourceAccountId: accountS, extraIndependentBacking: true });
  await seedReport({ deviceKey, reportId, accountId: accountT, passportId: passportP, rawText: text });

  const on = await withFlags({ self: "true", guard: "true" }, () => resolve({ deviceKey, reportId, accountId: accountT, rawText: text }));
  assert.equal(on.unifiedSimilarity.unifiedScore, 100, "an independent (different-device) backing keeps the match counted");
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, []);
  assert.equal(on.deviceSelfSharedGuard.reason, "NOT_APPLIED", "the guard is never consulted — nothing qualified");
});

test("NO-VETO 8: a DIFFERENT verified Passport still does not qualify", async () => {
  const text = takeText();
  const deviceKey = uniq("dk"), reportId = uniq("r"), reportPassport = uniq("passportR"), otherPassport = uniq("passportO");
  await seedExactCorpusSource(text, { backingPassportId: otherPassport, sourceAccountId: uniq("accS") });
  await seedReport({ deviceKey, reportId, accountId: uniq("accT"), passportId: reportPassport, rawText: text });

  const on = await withFlags({ self: "true", guard: "true" }, () => resolve({ deviceKey, reportId, rawText: text }));
  assert.equal(on.unifiedSimilarity.unifiedScore, 100);
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, []);
  assert.equal(on.deviceSelfSharedGuard.reason, "NOT_APPLIED");
});

test("NO-VETO 9: a same-device STRONG_TEXT_MATCH with an independent backing STILL does not qualify (base rule)", async () => {
  const text = takeText();
  const deviceKey = uniq("dk"), reportId = uniq("r"), passportP = uniq("passportP");
  const nearText = `${text} A trailing clause making this a near but not byte-identical variant for this particular no-veto test case.`;
  await seedExactCorpusSource(nearText, { backingPassportId: passportP, sourceAccountId: uniq("accS"), extraIndependentBacking: true });
  await seedReport({ deviceKey, reportId, accountId: uniq("accT"), passportId: passportP, rawText: text });

  const on = await withFlags({ self: "true", guard: "true" }, () => resolve({ deviceKey, reportId, rawText: text }));
  assert.equal(on.historicalSubmissionMatch.matches[0].matchType, "STRONG_TEXT_MATCH");
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [], "independentBackingCount > 0 blocks the STRONG downgrade");
  assert.ok(on.unifiedSimilarity.unifiedScore > 0);
});

test("NO-VETO 11: same-device STRONG_TEXT_MATCH + 3 actors on the Passport -> BLOCKED_ACCOUNT_FANOUT (telemetry) but scoring still effective SELF (score 0)", async () => {
  const fx = await seedTwoAccountSharedDeviceStrongFixture();
  await addExtraDeviceAccounts(fx.passportP, 1); // -> 3 distinct actors
  const on = await withFlags({ self: "true", guard: "true" }, () => resolve({ ...fx, rawText: fx.text }));
  assert.equal(on.historicalSubmissionMatch.matches[0].matchType, "STRONG_TEXT_MATCH");
  assert.equal(on.unifiedSimilarity.unifiedScore, 0);
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [fx.repId]);
  assert.equal(on.deviceSelfSharedGuard.passed, false);
  assert.equal(on.deviceSelfSharedGuard.reason, "BLOCKED_ACCOUNT_FANOUT");
  assert.equal(on.deviceSelfSharedGuard.deviceDistinctAccounts, 3);
});

test("NO-VETO 12: same-device STRONG_TEXT_MATCH + 10 actors on the Passport -> BLOCKED_ACCOUNT_FANOUT (telemetry) but scoring still effective SELF (score 0)", async () => {
  const fx = await seedTwoAccountSharedDeviceStrongFixture();
  await addExtraDeviceAccounts(fx.passportP, 8); // -> 10 distinct actors
  const on = await withFlags({ self: "true", guard: "true" }, () => resolve({ ...fx, rawText: fx.text }));
  assert.equal(on.historicalSubmissionMatch.matches[0].matchType, "STRONG_TEXT_MATCH");
  assert.equal(on.unifiedSimilarity.unifiedScore, 0);
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [fx.repId]);
  assert.equal(on.deviceSelfSharedGuard.passed, false);
  assert.equal(on.deviceSelfSharedGuard.reason, "BLOCKED_ACCOUNT_FANOUT");
  assert.equal(on.deviceSelfSharedGuard.deviceDistinctAccounts, 10);
});

test("NO-VETO 13: same-device STRONG_TEXT_MATCH + anonymous use in the Passport's durable history -> BLOCKED_ANONYMOUS_USE (telemetry) but scoring still effective SELF (score 0)", async () => {
  const fx = await seedTwoAccountSharedDeviceStrongFixture();
  await seedActorUsage(fx.passportP, null, { anonymous: true });
  const on = await withFlags({ self: "true", guard: "true" }, () => resolve({ ...fx, rawText: fx.text }));
  assert.equal(on.historicalSubmissionMatch.matches[0].matchType, "STRONG_TEXT_MATCH");
  assert.equal(on.unifiedSimilarity.unifiedScore, 0);
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [fx.repId]);
  assert.equal(on.deviceSelfSharedGuard.passed, false);
  assert.equal(on.deviceSelfSharedGuard.reason, "BLOCKED_ANONYMOUS_USE");
});

test("NO-VETO 10: unrelated archive + scholarly positions survive the guard-blocked SELF exclusion", async () => {
  const fx = await seedTwoAccountSharedDeviceFixture();
  await addExtraDeviceAccounts(fx.passportP, 2); // -> 4 actors -> verdict BLOCKED_ACCOUNT_FANOUT
  const wc = tokens(canonicalizeText(fx.text)).length;
  const archiveMatchedPositions = range(0, Math.min(15, wc));
  const externalAcademicEvidence = [{
    provider: "openaire", providerId: "o-nv", title: "Ext", authors: null, publication: null, year: null,
    doi: "10.1/nv", url: "https://ex.test/nv", similarity: 88,
    matchedPassages: [{ submittedText: "", submittedWordStart: Math.min(30, wc - 1), submittedWordEnd: Math.min(50, wc - 1), matchedWordCount: 20 }],
  }];
  const on = await withFlags({ self: "true", guard: "true" }, () => resolve({ ...fx, rawText: fx.text, archiveMatchedPositions, externalAcademicEvidence }));
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [fx.repId], "the device source is still an effective SELF");
  assert.ok(on.unifiedSimilarity.deviceSelfExcludedWords > 0);
  assert.ok(on.unifiedSimilarity.archiveOnlyWords > 0, "independent archive positions still counted");
  assert.ok(on.unifiedSimilarity.liveAcademicOnlyWords > 0, "independent scholarly positions still counted");
  assert.ok(on.unifiedSimilarity.unifiedScore > 0 && on.unifiedSimilarity.unifiedScore < 100);
  assert.equal(on.deviceSelfSharedGuard.reason, "BLOCKED_ACCOUNT_FANOUT", "the fan-out is still recorded for telemetry");
});

console.log("device-passport-shared-guard-scoring: pure Policy D + flag matrix + Branch A/B + telemetry-only verdict (no scoring veto) + fail-closed + same-account + independent-survival + admin trace + privacy passed");
