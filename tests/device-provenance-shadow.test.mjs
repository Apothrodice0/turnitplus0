import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity, canonicalSha256 } from "../lib/document-identity.ts";
import { canonicalizeText } from "../lib/canonical-text.ts";
import {
  createReusableDocumentRepresentation,
  recordCorpusShingles,
  recordSubmissionReference,
  indexDocumentSubmissionIntoCorpus,
} from "../lib/user-submission-corpus.ts";
import { buildReportAdmissionSourceRef } from "../lib/corpus-admission-source-ref.ts";
import { computeUnifiedSimilarity } from "../lib/unified-similarity.ts";
import { resolvePrimarySimilaritySummary } from "../lib/report-primary-similarity.ts";
import {
  runDeviceProvenanceShadowEvaluation,
  summarizeDevicePassportSharedness,
  DEVICE_PROVENANCE_SHADOW_POLICY_VERSION,
} from "../lib/device-provenance-shadow.ts";
import { summarizeSubmissionProvenance } from "../lib/submission-provenance.ts";

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_device_provenance_shadow.db");
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
}
const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

const originalPassportFlag = process.env.DEVICE_PASSPORT_ENABLED;
const originalSourceMatchingFlag = process.env.CORPUS_SOURCE_MATCHING_ENABLED;
process.env.DEVICE_PASSPORT_ENABLED = "true";
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";
test.after(() => {
  client.close();
  if (originalPassportFlag === undefined) delete process.env.DEVICE_PASSPORT_ENABLED; else process.env.DEVICE_PASSPORT_ENABLED = originalPassportFlag;
  if (originalSourceMatchingFlag === undefined) delete process.env.CORPUS_SOURCE_MATCHING_ENABLED; else process.env.CORPUS_SOURCE_MATCHING_ENABLED = originalSourceMatchingFlag;
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let seq = 0;
const uniq = (p) => `${p}-${++seq}`;
const hex32 = () => crypto.randomBytes(32).toString("hex");

const DISTINCT_TEXT =
  "Marine biologists tracking a tagged population of leatherback turtles across the equatorial current recorded an unexpected mid-ocean foraging detour that coincided precisely with a transient bloom of gelatinous zooplankton detected by three independent satellite chlorophyll passes over the same fortnight, which the survey team flagged as the strongest evidence yet for opportunistic long-range prey tracking in this particular species.";

async function ensureUser(accountId) {
  if (!accountId) return;
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
    args: [accountId, `${accountId}@ex.test`, accountId, "not-a-real-hash"],
  });
}

async function ensurePassport(passportId, { provenanceGeneration = 0 } = {}) {
  await client.execute({
    sql: "INSERT OR IGNORE INTO device_passports (id, public_key_spki, algorithm, created_at, provenance_generation) VALUES (?,?,?,?,?)",
    args: [passportId, Buffer.from(`spki-${passportId}`), "ECDSA-P256-SHA256", Date.now(), provenanceGeneration],
  });
}

/** A fresh, unique corpus representation per call (corpus_document_representations.canonical_sha256 is UNIQUE). */
async function makeRepresentation() {
  const canonicalText = canonicalizeText(`${DISTINCT_TEXT} unique-corpus-marker ${uniq("rep")}`);
  const rep = await createReusableDocumentRepresentation(client, { canonicalText });
  await recordCorpusShingles(client, rep.id, canonicalText);
  return rep;
}

async function makeIdentity(accountId, rawText) {
  await ensureUser(accountId);
  const created = await createDocumentIdentity(client, { accountId: accountId ?? null, title: "t", author: null, rawText });
  return created.id;
}

async function addSubmissionRefBacking(representationId, accountId) {
  const identityId = await makeIdentity(accountId, `${DISTINCT_TEXT} sub-marker ${uniq("sub")}`);
  await recordSubmissionReference(client, { representationId, documentIdentityId: identityId, linkType: "NEW_CONTENT_REPRESENTATION" });
  return identityId;
}

/** Directly seeds an active indexed admission backing (mirrors tests/corpus-admission-self-match-exclusion.test.mjs's raw-insert helpers). */
async function addAdmissionBacking(representationId, { sourceAccountId, passportId = null } = {}) {
  await ensureUser(sourceAccountId);
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
    args: [arId, decisionId, hex32(), 50, "corpus-shingle-v1"],
  });
  const promId = crypto.randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_promotions (id, decision_id, accepted_representation_id, representation_id, link_type, fingerprint_version, status, attempt_count)
          VALUES (?,?,?,?,?,?,'indexed',1)`,
    args: [promId, decisionId, arId, representationId, "NEW_CONTENT_REPRESENTATION", "corpus-shingle-v1"],
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

async function seedReport({ deviceKey, reportId, accountId = null, passportId = null, rawText = DISTINCT_TEXT, documentIdentityId = null }) {
  await ensureUser(accountId);
  if (passportId) await ensurePassport(passportId);
  const payload = JSON.stringify({ version: 11, id: reportId, submissionId: `sub-${reportId}`, title: "t", text: rawText, wordCount: 50, score: 0, archiveScore: 0 });
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, verified_device_passport_id, document_identity_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [reportId, deviceKey, `sub-${reportId}`, "t", new Date().toISOString(), 50, 0, "Low", payload, accountId, passportId, documentIdentityId],
  });
}

function matchEntry(representationId, { relationshipType = "PRIOR_SUBMISSION", matchType = "EXACT_CANONICAL_MATCH", matchedWordCount = 40 } = {}) {
  return {
    relationshipType, matchedRepresentationId: representationId, matchType,
    containment: 1, matchedWordCount, passageCount: 1, longestMatchWords: matchedWordCount,
    passages: [{ submittedText: "x y z", submittedWordStart: 0, submittedWordEnd: 3, matchedWordCount: 3 }],
    historicalSubmissionCount: 1,
  };
}
function productionMatched(representationId, opts) {
  return productionMulti([{ representationId, ...(opts ?? {}) }]);
}
function productionMulti(specs) {
  return {
    status: "MATCHED",
    matches: specs.map((s) => matchEntry(s.representationId, s)),
    computedAt: new Date().toISOString(), matcherVersion: "x", fingerprintVersion: "x", canonicalizationVersion: "x",
  };
}
function productionNoMatch() {
  return { status: "NO_HISTORICAL_MATCH", computedAt: new Date().toISOString(), matcherVersion: "x", fingerprintVersion: "x", canonicalizationVersion: "x" };
}

async function shadowRow(deviceKey, reportId) {
  const r = await client.execute({
    sql: "SELECT * FROM historical_match_shadow_evaluations WHERE report_device_key = ? AND report_id = ? AND policy_version = ?",
    args: [deviceKey, reportId, DEVICE_PROVENANCE_SHADOW_POLICY_VERSION],
  });
  return r.rows[0] ? { ...r.rows[0] } : null;
}
const evidenceOf = (row) => JSON.parse(String(row.proposed_evidence));

async function run(deviceKey, reportId, accountId, productionResult, rawText = DISTINCT_TEXT) {
  await runDeviceProvenanceShadowEvaluation(client, { reportDeviceKey: deviceKey, reportId, accountId, rawText, productionResult });
  return shadowRow(deviceKey, reportId);
}

/** A same-device EXACT SELF candidate: matched rep backed ONLY by a same-device admission backing, no independent backing. */
async function makeSameDeviceExactCandidate(passportId) {
  const rep = await makeRepresentation();
  await addAdmissionBacking(rep.id, { sourceAccountId: uniq("srcacc"), passportId });
  return { representationId: rep.id, relationshipType: "TURNITPLUS_CORPUS_SOURCE", matchType: "EXACT_CANONICAL_MATCH" };
}
/** A normal cross-account PRIOR match — a real submission-ref backing from another account, no device backing. */
async function makeNormalPriorMatch() {
  const rep = await makeRepresentation();
  await addSubmissionRefBacking(rep.id, uniq("otheracc"));
  return { representationId: rep.id, relationshipType: "PRIOR_SUBMISSION", matchType: "EXACT_CANONICAL_MATCH" };
}
/** A normal promoted corpus source — an admission backing from a different account with NO device provenance. */
async function makeNormalCorpusSource() {
  const rep = await makeRepresentation();
  await addAdmissionBacking(rep.id, { sourceAccountId: uniq("srcacc") });
  return { representationId: rep.id, relationshipType: "TURNITPLUS_CORPUS_SOURCE", matchType: "EXACT_CANONICAL_MATCH" };
}

// ---------------------------------------------------------------------------
// STRUCTURAL
// ---------------------------------------------------------------------------

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const SHADOW_SRC = stripComments(fs.readFileSync(path.join(repoRoot, "lib/device-provenance-shadow.ts"), "utf8"));
const PROVENANCE_SRC = stripComments(fs.readFileSync(path.join(repoRoot, "lib/submission-provenance.ts"), "utf8"));

test("structural: the shadow module never imports a production scoring / rendering path and never assigns a score field", () => {
  assert.doesNotMatch(SHADOW_SRC, /from\s+["'][^"']*(unified-similarity|report-primary-similarity|similarity-worker|receipt-pdf|report-classification)["']/);
  assert.doesNotMatch(SHADOW_SRC, /\.score\s*=|\.archiveScore\s*=|\.aiScore\s*=|\.unifiedScore\s*=|verifiedSimilarity/);
});

test("structural: the shadow module never writes report_historical_match_snapshots, saved_reports, or any device_passport* table", () => {
  assert.doesNotMatch(SHADOW_SRC, /INSERT INTO report_historical_match_snapshots|UPDATE report_historical_match_snapshots/);
  assert.doesNotMatch(SHADOW_SRC, /INSERT INTO saved_reports|UPDATE saved_reports/);
  assert.doesNotMatch(SHADOW_SRC, /INSERT INTO device_passport|UPDATE device_passport/);
  assert.match(SHADOW_SRC, /INSERT INTO historical_match_shadow_evaluations/);
});

test("structural: the persisted telemetry column list contains no document/passage/identity field names", () => {
  const m = SHADOW_SRC.match(/INSERT INTO historical_match_shadow_evaluations[\s\S]*?computed_at = excluded\.computed_at/);
  assert.ok(m, "expected the telemetry INSERT ... ON CONFLICT DO UPDATE");
  for (const forbidden of [/\btext\b/i, /\bcontent\b/i, /\bpassage_text\b/i, /\baccount_id\b/i, /\bemail\b/i, /passport/i, /source_ref/i]) {
    assert.doesNotMatch(m[0], forbidden, `telemetry column list must not contain ${forbidden}`);
  }
});

test("structural: no console.* line references raw text / passport id / account id variables", () => {
  const lines = SHADOW_SRC.split(/\r?\n/).filter((l) => /console\.(log|error|warn)/.test(l));
  assert.ok(lines.length > 0);
  for (const line of lines) {
    for (const forbidden of [/\brawText\b/, /\bcanonicalText\b/, /passportId/, /\baccountId\b/, /source_ref/]) {
      assert.doesNotMatch(line, forbidden, `console line leaks: ${line.trim()}`);
    }
  }
});

test("structural: the shadow module never stores a representation id (no matchedRepresentationId anywhere in an insert/evidence path)", () => {
  // matchedRepresentationId is read to CALL summarizeSubmissionProvenance and to dedup — never placed on the evidence object.
  const evidenceBlock = SHADOW_SRC.match(/const evidence: ProposedEvidence = \{[\s\S]*?\};/g) ?? [];
  assert.ok(evidenceBlock.length >= 1);
  for (const b of evidenceBlock) {
    assert.doesNotMatch(b, /matchedRepresentationId|representationId|\.id\b|passportId|accountId/, `evidence object must carry no id: ${b.slice(0, 60)}`);
  }
});

test("structural: summarizeSubmissionProvenance compares source_ref / device_passport_id inside SQL (CASE WHEN ... 1/0), never projects the raw identifier, and returns only bounded number/boolean fields", () => {
  assert.match(PROVENANCE_SRC, /substr\(d\.source_ref, 1, length\(\?\)\) = \?/);
  assert.match(PROVENANCE_SRC, /CASE WHEN \? IS NOT NULL AND cadp\.device_passport_id = \? THEN 1 ELSE 0 END/);
  assert.doesNotMatch(PROVENANCE_SRC, /\bAS (source_ref|device_passport_id)\b/);
  const typeBlock = PROVENANCE_SRC.match(/export type MatchedRepresentationProvenance[\s\S]*?\n\};/);
  assert.ok(typeBlock);
  assert.doesNotMatch(typeBlock[0], /:\s*string\b/);
});

// ---------------------------------------------------------------------------
// SCENARIO 1 — no verified report passport
// ---------------------------------------------------------------------------

test("1. report with no verified upload passport -> shadow writes nothing at all", async () => {
  const deviceKey = uniq("dk"), reportId = uniq("r"), accountId = uniq("acc");
  const rep = await makeRepresentation();
  await seedReport({ deviceKey, reportId, accountId, passportId: null });
  await addSubmissionRefBacking(rep.id, uniq("other"));
  const row = await run(deviceKey, reportId, accountId, productionMatched(rep.id));
  assert.equal(row, null, "no verified upload passport -> device evidence is absent, nothing observed");
});

// ---------------------------------------------------------------------------
// SCENARIO 2 — same passport + exact canonical + no independent backing -> SELF proposal
// ---------------------------------------------------------------------------

test("2. same verified device backing + EXACT + zero independent backing -> proposes SELF / SAME_DEVICE_EXACT_DOCUMENT", async () => {
  const deviceKey = uniq("dk"), reportId = uniq("r"), accountId = uniq("acc"), passportId = uniq("passport");
  const cand = await makeSameDeviceExactCandidate(passportId);
  await seedReport({ deviceKey, reportId, accountId, passportId });

  const row = await run(deviceKey, reportId, accountId, productionMulti([cand]));
  const ev = evidenceOf(row);
  assert.equal(row.production_status, "MATCHED");
  assert.equal(row.production_relationship, "TURNITPLUS_CORPUS_SOURCE");
  assert.equal(row.proposed_relationship, "SELF", "coarse telemetry signal — >=1 counted match would be SELF");
  assert.equal(row.agreement, "DISAGREE_DEVICE_SELF");
  assert.equal(ev.reason, "SAME_DEVICE_EXACT_DOCUMENT");
  assert.equal(ev.wouldDowngrade, true);
  assert.equal(ev.deviceSelfCandidateCount, 1);
  assert.equal(ev.exactSameDeviceMatchCount, 1);
  assert.equal(ev.independentBlockedCandidateCount, 0);
  assert.equal(ev.matchesEvaluated, 1);
  assert.equal(ev.candidateReason, "SAME_DEVICE_EXACT_DOCUMENT");
  assert.equal(ev.candidateSameVerifiedDeviceBacking, true);
  assert.equal(ev.candidateSameDeviceBackingCount, 1);
  assert.equal(ev.candidateIndependentBackingCount, 0);
  assert.equal(ev.candidateExactCanonicalMatch, true);
});

// ---------------------------------------------------------------------------
// SCENARIO 3 — same passport + near-identical only (STRONG_TEXT_MATCH)
// ---------------------------------------------------------------------------

test("3. same verified device backing but only a STRONG_TEXT_MATCH -> observed, no exact-document downgrade", async () => {
  const deviceKey = uniq("dk"), reportId = uniq("r"), accountId = uniq("acc"), passportId = uniq("passport");
  const rep = await makeRepresentation();
  await seedReport({ deviceKey, reportId, accountId, passportId });
  await addAdmissionBacking(rep.id, { sourceAccountId: uniq("srcacc"), passportId });

  const row = await run(deviceKey, reportId, accountId, productionMulti([{ representationId: rep.id, relationshipType: "PRIOR_SUBMISSION", matchType: "STRONG_TEXT_MATCH" }]));
  const ev = evidenceOf(row);
  assert.equal(ev.candidateExactCanonicalMatch, false);
  assert.equal(ev.wouldDowngrade, false);
  assert.equal(ev.deviceSelfCandidateCount, 0);
  assert.equal(row.proposed_relationship, null, "no proposed change");
  assert.equal(row.agreement, "AGREE");
  assert.equal(ev.candidateSameVerifiedDeviceBacking, true, "the same-device observation is still recorded");
  assert.equal(ev.candidateReason, "SAME_DEVICE_NOT_EXACT");
});

// ---------------------------------------------------------------------------
// SCENARIO 4 — same passport + exact + different-account submission backing
// ---------------------------------------------------------------------------

test("4. same device + exact + a DIFFERENT account's submission backing -> independent backing, NO SELF proposal", async () => {
  const deviceKey = uniq("dk"), reportId = uniq("r"), accountId = uniq("acc"), passportId = uniq("passport");
  const rep = await makeRepresentation();
  await seedReport({ deviceKey, reportId, accountId, passportId });
  await addAdmissionBacking(rep.id, { sourceAccountId: uniq("srcacc"), passportId });
  await addSubmissionRefBacking(rep.id, uniq("otheracc"));

  const row = await run(deviceKey, reportId, accountId, productionMulti([{ representationId: rep.id, relationshipType: "PRIOR_SUBMISSION" }]));
  const ev = evidenceOf(row);
  assert.ok(ev.candidateIndependentBackingCount >= 1);
  assert.equal(ev.wouldDowngrade, false);
  assert.equal(ev.deviceSelfCandidateCount, 0);
  assert.equal(ev.independentBlockedCandidateCount, 1);
  assert.equal(ev.candidateReason, "INDEPENDENT_BACKING_BLOCKED");
});

// ---------------------------------------------------------------------------
// SCENARIO 5 — same passport + exact + different verified-device backing
// ---------------------------------------------------------------------------

test("5. same device + exact + a DIFFERENT verified-device backing -> independent backing, NO SELF proposal", async () => {
  const deviceKey = uniq("dk"), reportId = uniq("r"), accountId = uniq("acc"), passportId = uniq("passport"), otherPassport = uniq("passport");
  const rep = await makeRepresentation();
  await seedReport({ deviceKey, reportId, accountId, passportId });
  await addAdmissionBacking(rep.id, { sourceAccountId: uniq("srcacc"), passportId });
  await addAdmissionBacking(rep.id, { sourceAccountId: uniq("srcacc2"), passportId: otherPassport });

  const row = await run(deviceKey, reportId, accountId, productionMulti([{ representationId: rep.id, relationshipType: "PRIOR_SUBMISSION" }]));
  const ev = evidenceOf(row);
  assert.equal(ev.candidateAdmittedBackingsDifferentDevice, 1);
  assert.ok(ev.candidateIndependentBackingCount >= 1);
  assert.equal(ev.wouldDowngrade, false);
  assert.equal(ev.independentBlockedCandidateCount, 1);
});

// ---------------------------------------------------------------------------
// SCENARIO 6 — backing without device provenance -> bounded fact recorded correctly
// ---------------------------------------------------------------------------

test("6. same device + a same-account backing with no device provenance -> bounded fact recorded, SELF still proposed", async () => {
  const deviceKey = uniq("dk"), reportId = uniq("r"), accountId = uniq("acc"), passportId = uniq("passport");
  const rep = await makeRepresentation();
  await seedReport({ deviceKey, reportId, accountId, passportId });
  await addAdmissionBacking(rep.id, { sourceAccountId: uniq("srcacc"), passportId });
  await addAdmissionBacking(rep.id, { sourceAccountId: accountId }); // own account, no device provenance

  const row = await run(deviceKey, reportId, accountId, productionMulti([{ representationId: rep.id, relationshipType: "TURNITPLUS_CORPUS_SOURCE" }]));
  const ev = evidenceOf(row);
  assert.equal(ev.candidateAdmittedBackingsNoDeviceProvenance, 1);
  assert.equal(ev.candidateBackingsWithoutDeviceProvenance, 1);
  assert.equal(ev.candidateIndependentBackingCount, 0, "an own-account no-device backing is not independent");
  assert.equal(ev.wouldDowngrade, true);
  assert.equal(ev.reason, "SAME_DEVICE_EXACT_DOCUMENT");
});

// ---------------------------------------------------------------------------
// SCENARIO 7 — passport used by multiple accounts
// ---------------------------------------------------------------------------

test("7. passport used by multiple accounts -> deviceDistinctAccounts / deviceSharedAcrossAccounts recorded; production not downgraded on sharedness alone", async () => {
  const passportId = uniq("passport"), deviceKey = uniq("dk"), reportId = uniq("r"), accountId = uniq("acc");
  const cand = await makeSameDeviceExactCandidate(passportId);
  await seedReport({ deviceKey, reportId, accountId, passportId });
  await seedReport({ deviceKey: uniq("dk"), reportId: uniq("r"), accountId: uniq("acc2"), passportId });

  const row = await run(deviceKey, reportId, accountId, productionMulti([cand]));
  const ev = evidenceOf(row);
  assert.equal(ev.deviceDistinctAccounts, 2);
  assert.equal(ev.deviceSharedAcrossAccounts, true);
  assert.equal(row.production_relationship, "TURNITPLUS_CORPUS_SOURCE", "production relationship untouched — no shared-device threshold applied");
  assert.equal(ev.wouldDowngrade, true, "the coarse device rule still fires — sharedness is recorded, not acted on");
});

// ---------------------------------------------------------------------------
// SCENARIO 8 — anonymous passport history
// ---------------------------------------------------------------------------

test("8. anonymous upload history on the passport -> deviceAnonUploads counted", async () => {
  const passportId = uniq("passport"), deviceKey = uniq("dk"), reportId = uniq("r"), accountId = uniq("acc");
  const cand = await makeSameDeviceExactCandidate(passportId);
  await seedReport({ deviceKey, reportId, accountId, passportId });
  await seedReport({ deviceKey: uniq("dk"), reportId: uniq("r"), accountId: null, passportId });

  const row = await run(deviceKey, reportId, accountId, productionMulti([cand]));
  const ev = evidenceOf(row);
  assert.equal(ev.deviceAnonUploads, 1);
  assert.equal(ev.deviceSubmissionCount, 2);
  assert.equal(ev.deviceDistinctAccounts, 1);
});

// ---------------------------------------------------------------------------
// SCENARIO 9 — different passport
// ---------------------------------------------------------------------------

test("9. matched representation backed only by a DIFFERENT verified device -> sameVerifiedDeviceBacking false, no SELF proposal", async () => {
  const deviceKey = uniq("dk"), reportId = uniq("r"), accountId = uniq("acc"), reportPassport = uniq("passport"), otherPassport = uniq("passport");
  const rep = await makeRepresentation();
  await seedReport({ deviceKey, reportId, accountId, passportId: reportPassport });
  await addAdmissionBacking(rep.id, { sourceAccountId: uniq("srcacc"), passportId: otherPassport });

  const row = await run(deviceKey, reportId, accountId, productionMulti([{ representationId: rep.id, relationshipType: "PRIOR_SUBMISSION" }]));
  const ev = evidenceOf(row);
  assert.equal(ev.candidateSameVerifiedDeviceBacking, false);
  assert.equal(ev.wouldDowngrade, false);
  assert.equal(row.agreement, "AGREE");
});

// ---------------------------------------------------------------------------
// SCENARIO 10 — System-2 same-account identity evidence visible, never drives the decision
// ---------------------------------------------------------------------------

test("10. System-2 same-account identity evidence appears in the summary but does NOT alter the production/proposed relationship", async () => {
  const deviceKey = uniq("dk"), reportId = uniq("r"), accountId = uniq("acc"), passportId = uniq("passport");
  const rep = await makeRepresentation();
  const reportIdentityId = await makeIdentity(accountId, DISTINCT_TEXT);
  await makeIdentity(accountId, DISTINCT_TEXT); // a genuine prior identity, same account + same canonical text
  await seedReport({ deviceKey, reportId, accountId, passportId, documentIdentityId: reportIdentityId });
  await addAdmissionBacking(rep.id, { sourceAccountId: uniq("srcacc"), passportId: uniq("passport") }); // different device -> device rule cannot fire

  const row = await run(deviceKey, reportId, accountId, productionMulti([{ representationId: rep.id, relationshipType: "PRIOR_SUBMISSION" }]));
  const ev = evidenceOf(row);
  assert.equal(ev.candidateIdentitySameAccount, true);
  assert.ok(ev.candidatePriorSameAccountIdentityCount >= 1);
  assert.equal(ev.wouldDowngrade, false, "identitySameAccount must NOT trigger a downgrade in this phase");
  assert.equal(row.proposed_relationship, null);
  assert.equal(row.production_relationship, "PRIOR_SUBMISSION", "production classification is unchanged");
});

// ---------------------------------------------------------------------------
// SCENARIO 11 — persisted row leaks nothing
// ---------------------------------------------------------------------------

test("11. the persisted shadow row leaks no passport id / account id / email / source_ref / document text (multi-match)", async () => {
  const deviceKey = uniq("dk"), reportId = uniq("r"), accountId = "leak-canary-account-11", passportId = "leak-canary-passport-11";
  const otherAccount = "leak-canary-other-11";
  await seedReport({ deviceKey, reportId, accountId, passportId });
  const rep1 = await makeRepresentation();
  await addAdmissionBacking(rep1.id, { sourceAccountId: accountId, passportId });
  const rep2 = await makeRepresentation();
  await addSubmissionRefBacking(rep2.id, otherAccount);

  const row = await run(deviceKey, reportId, accountId, productionMulti([
    { representationId: rep1.id, relationshipType: "TURNITPLUS_CORPUS_SOURCE" },
    { representationId: rep2.id, relationshipType: "PRIOR_SUBMISSION" },
  ]));
  const serialized = JSON.stringify(row);
  for (const forbidden of [passportId, accountId, otherAccount, `${accountId}@ex.test`, "report-upload:account=", rep1.id, rep2.id, DISTINCT_TEXT.slice(0, 40), "leatherback turtles"]) {
    assert.equal(serialized.includes(forbidden), false, `shadow row leaked: ${String(forbidden).slice(0, 30)}`);
  }
  assert.equal(String(row.report_device_key), deviceKey);
});

// ---------------------------------------------------------------------------
// SCENARIO 12 — repeated evaluation upserts
// ---------------------------------------------------------------------------

test("12. repeated evaluation upserts in place — exactly one telemetry row per (report, policy_version)", async () => {
  const deviceKey = uniq("dk"), reportId = uniq("r"), accountId = uniq("acc"), passportId = uniq("passport");
  const cand = await makeSameDeviceExactCandidate(passportId);
  await seedReport({ deviceKey, reportId, accountId, passportId });
  const pr = productionMulti([cand]);
  for (let i = 0; i < 4; i += 1) await run(deviceKey, reportId, accountId, pr);
  const count = await client.execute({
    sql: "SELECT COUNT(*) AS c FROM historical_match_shadow_evaluations WHERE report_device_key = ? AND report_id = ?",
    args: [deviceKey, reportId],
  });
  assert.equal(Number(count.rows[0].c), 1);
});

// ---------------------------------------------------------------------------
// SCENARIO 13 — telemetry DB failure never throws
// ---------------------------------------------------------------------------

test("13. a telemetry-store failure makes runDeviceProvenanceShadowEvaluation resolve quietly, never throw", async () => {
  const brokenClient = { execute: async () => { throw new Error("simulated historical_match_shadow_evaluations outage"); } };
  await assert.doesNotReject(() =>
    runDeviceProvenanceShadowEvaluation(brokenClient, {
      reportDeviceKey: "dk", reportId: "r", accountId: "acc", rawText: DISTINCT_TEXT,
      productionResult: productionMatched("rep-x"),
    }),
  );
});

// ---------------------------------------------------------------------------
// SCENARIO 14 — production relationship + unified score + snapshot unchanged
// ---------------------------------------------------------------------------

test("14. production relationship, unified score, and the real historical-match snapshot are all unchanged by a shadow run", async () => {
  const deviceKey = uniq("dk"), reportId = uniq("r"), accountId = uniq("acc"), passportId = uniq("passport");
  await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: await makeIdentity(uniq("owner"), DISTINCT_TEXT), rawText: DISTINCT_TEXT });
  await seedReport({ deviceKey, reportId, accountId, passportId, documentIdentityId: await makeIdentity(accountId, DISTINCT_TEXT) });

  const before = await resolvePrimarySimilaritySummary(client, {
    reportDeviceKey: deviceKey, reportId, accountId, rawText: DISTINCT_TEXT,
    wordCount: 50, archiveMatchedPositions: null, externalAcademicEvidence: null, archiveScore: 0,
  });
  assert.equal(before.historicalSubmissionMatch.status, "MATCHED");
  const snapBefore = { ...(await client.execute({ sql: "SELECT * FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?", args: [deviceKey, reportId] })).rows[0] };
  const uBefore = computeUnifiedSimilarity({ wordCount: 50, archiveMatchedPositions: null, externalAcademicEvidence: null, historicalSubmissionMatch: before.historicalSubmissionMatch });

  await runDeviceProvenanceShadowEvaluation(client, { reportDeviceKey: deviceKey, reportId, accountId, rawText: DISTINCT_TEXT, productionResult: before.historicalSubmissionMatch });

  const snapAfter = { ...(await client.execute({ sql: "SELECT * FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?", args: [deviceKey, reportId] })).rows[0] };
  const after = await resolvePrimarySimilaritySummary(client, {
    reportDeviceKey: deviceKey, reportId, accountId, rawText: DISTINCT_TEXT,
    wordCount: 50, archiveMatchedPositions: null, externalAcademicEvidence: null, archiveScore: 0,
  });
  const uAfter = computeUnifiedSimilarity({ wordCount: 50, archiveMatchedPositions: null, externalAcademicEvidence: null, historicalSubmissionMatch: after.historicalSubmissionMatch });

  assert.deepEqual(snapAfter, snapBefore);
  assert.deepEqual(after.historicalSubmissionMatch, before.historicalSubmissionMatch);
  assert.deepEqual(uAfter, uBefore);
});

// ===========================================================================
// MULTI-MATCH CORRECTION — Phase 4 §4 scenarios A–H
// ===========================================================================

test("A. 3 matches (normal PRIOR, same-device EXACT no independent, normal corpus source) -> deviceSelfCandidateCount = 1, wouldDowngrade = true", async () => {
  const deviceKey = uniq("dk"), reportId = uniq("r"), accountId = uniq("acc"), passportId = uniq("passport");
  await seedReport({ deviceKey, reportId, accountId, passportId });
  const m1 = await makeNormalPriorMatch();
  const m2 = await makeSameDeviceExactCandidate(passportId);
  const m3 = await makeNormalCorpusSource();

  const row = await run(deviceKey, reportId, accountId, productionMulti([m1, m2, m3]));
  const ev = evidenceOf(row);
  assert.equal(ev.matchesEvaluated, 3);
  assert.equal(ev.deviceSelfCandidateCount, 1);
  assert.equal(ev.wouldDowngrade, true);
  assert.equal(ev.exactSameDeviceMatchCount, 1);
  assert.equal(ev.independentBlockedCandidateCount, 0);
  assert.equal(row.proposed_relationship, "SELF");
  assert.equal(row.production_relationship, "PRIOR_SUBMISSION", "the headline relationship is production's matches[0], unchanged");
  assert.equal(Number(row.candidate_count), 3);
  assert.equal(ev.candidateReason, "SAME_DEVICE_EXACT_DOCUMENT");
});

test("B. the same-device candidate is the LAST match -> still detected", async () => {
  const deviceKey = uniq("dk"), reportId = uniq("r"), accountId = uniq("acc"), passportId = uniq("passport");
  await seedReport({ deviceKey, reportId, accountId, passportId });
  const m1 = await makeNormalPriorMatch();
  const m2 = await makeNormalCorpusSource();
  const m3 = await makeSameDeviceExactCandidate(passportId);

  const row = await run(deviceKey, reportId, accountId, productionMulti([m1, m2, m3]));
  const ev = evidenceOf(row);
  assert.equal(ev.deviceSelfCandidateCount, 1);
  assert.equal(ev.wouldDowngrade, true);
  assert.equal(ev.matchesEvaluated, 3);
});

test("C. two same-device EXACT candidates -> deviceSelfCandidateCount = 2", async () => {
  const deviceKey = uniq("dk"), reportId = uniq("r"), accountId = uniq("acc"), passportId = uniq("passport");
  await seedReport({ deviceKey, reportId, accountId, passportId });
  const m1 = await makeSameDeviceExactCandidate(passportId);
  const m2 = await makeSameDeviceExactCandidate(passportId);
  const m3 = await makeNormalPriorMatch();

  const row = await run(deviceKey, reportId, accountId, productionMulti([m1, m2, m3]));
  const ev = evidenceOf(row);
  assert.equal(ev.deviceSelfCandidateCount, 2);
  assert.equal(ev.exactSameDeviceMatchCount, 2);
  assert.equal(ev.wouldDowngrade, true);
  assert.equal(ev.matchesEvaluated, 3);
});

test("D. one same-device EXACT candidate blocked by an independent backing + one valid candidate -> deviceSelfCandidateCount = 1, independentBlockedCandidateCount = 1", async () => {
  const deviceKey = uniq("dk"), reportId = uniq("r"), accountId = uniq("acc"), passportId = uniq("passport");
  await seedReport({ deviceKey, reportId, accountId, passportId });

  // blocked: same-device EXACT but ALSO an independent (other-account) submission backing
  const blockedRep = await makeRepresentation();
  await addAdmissionBacking(blockedRep.id, { sourceAccountId: uniq("srcacc"), passportId });
  await addSubmissionRefBacking(blockedRep.id, uniq("stranger"));
  const blocked = { representationId: blockedRep.id, relationshipType: "PRIOR_SUBMISSION", matchType: "EXACT_CANONICAL_MATCH" };

  const valid = await makeSameDeviceExactCandidate(passportId);

  const row = await run(deviceKey, reportId, accountId, productionMulti([blocked, valid]));
  const ev = evidenceOf(row);
  assert.equal(ev.deviceSelfCandidateCount, 1);
  assert.equal(ev.independentBlockedCandidateCount, 1);
  assert.equal(ev.exactSameDeviceMatchCount, 2);
  assert.equal(ev.wouldDowngrade, true);
  // strongest candidate = the valid SELF candidate, not the blocked one
  assert.equal(ev.candidateReason, "SAME_DEVICE_EXACT_DOCUMENT");
});

test("E. all same-device EXACT candidates are blocked by independent backings -> wouldDowngrade = false", async () => {
  const deviceKey = uniq("dk"), reportId = uniq("r"), accountId = uniq("acc"), passportId = uniq("passport");
  await seedReport({ deviceKey, reportId, accountId, passportId });

  const specs = [];
  for (let i = 0; i < 2; i += 1) {
    const rep = await makeRepresentation();
    await addAdmissionBacking(rep.id, { sourceAccountId: uniq("srcacc"), passportId });
    await addSubmissionRefBacking(rep.id, uniq("stranger"));
    specs.push({ representationId: rep.id, relationshipType: "PRIOR_SUBMISSION", matchType: "EXACT_CANONICAL_MATCH" });
  }

  const row = await run(deviceKey, reportId, accountId, productionMulti(specs));
  const ev = evidenceOf(row);
  assert.equal(ev.deviceSelfCandidateCount, 0);
  assert.equal(ev.independentBlockedCandidateCount, 2);
  assert.equal(ev.exactSameDeviceMatchCount, 2);
  assert.equal(ev.wouldDowngrade, false);
  assert.equal(row.proposed_relationship, null);
  assert.equal(row.agreement, "AGREE");
  assert.equal(ev.candidateReason, "INDEPENDENT_BACKING_BLOCKED");
});

test("F. the production match array is deepEqual before and after the shadow run (never mutated)", async () => {
  const deviceKey = uniq("dk"), reportId = uniq("r"), accountId = uniq("acc"), passportId = uniq("passport");
  await seedReport({ deviceKey, reportId, accountId, passportId });
  const m1 = await makeNormalPriorMatch();
  const m2 = await makeSameDeviceExactCandidate(passportId);
  const productionResult = productionMulti([m1, m2]);
  const snapshot = JSON.parse(JSON.stringify(productionResult));

  await runDeviceProvenanceShadowEvaluation(client, { reportDeviceKey: deviceKey, reportId, accountId, rawText: DISTINCT_TEXT, productionResult });

  assert.deepEqual(productionResult, snapshot, "the shadow must never mutate the match collection or any match object");
});

test("G. the unified similarity result is deepEqual before and after the shadow run, on a multi-match result", async () => {
  const rep1 = await makeRepresentation();
  const rep2 = await makeRepresentation();
  const historicalSubmissionMatch = productionMulti([
    { representationId: rep1.id, relationshipType: "PRIOR_SUBMISSION" },
    { representationId: rep2.id, relationshipType: "TURNITPLUS_CORPUS_SOURCE" },
  ]);
  const uBefore = computeUnifiedSimilarity({ wordCount: 50, archiveMatchedPositions: null, externalAcademicEvidence: null, historicalSubmissionMatch });

  const deviceKey = uniq("dk"), reportId = uniq("r"), accountId = uniq("acc"), passportId = uniq("passport");
  await seedReport({ deviceKey, reportId, accountId, passportId });
  await addAdmissionBacking(rep1.id, { sourceAccountId: uniq("srcacc"), passportId });
  await runDeviceProvenanceShadowEvaluation(client, { reportDeviceKey: deviceKey, reportId, accountId, rawText: DISTINCT_TEXT, productionResult: historicalSubmissionMatch });

  const uAfter = computeUnifiedSimilarity({ wordCount: 50, archiveMatchedPositions: null, externalAcademicEvidence: null, historicalSubmissionMatch });
  assert.deepEqual(uAfter, uBefore);
  assert.equal(uAfter.unifiedScore, uBefore.unifiedScore);
});

test("H. multi-match telemetry stays bounded — no representation id, passport id, account id, email, source_ref, or text", async () => {
  const deviceKey = uniq("dk"), reportId = uniq("r"), accountId = "canary-acc-H", passportId = "canary-passport-H";
  await seedReport({ deviceKey, reportId, accountId, passportId });
  const specs = [];
  for (let i = 0; i < 5; i += 1) {
    const rep = await makeRepresentation();
    await addAdmissionBacking(rep.id, { sourceAccountId: `canary-src-H-${i}`, passportId: i % 2 === 0 ? passportId : `canary-other-H-${i}` });
    await addSubmissionRefBacking(rep.id, `canary-stranger-H-${i}`);
    specs.push({ representationId: rep.id, relationshipType: "PRIOR_SUBMISSION", matchType: i === 0 ? "EXACT_CANONICAL_MATCH" : "STRONG_TEXT_MATCH" });
  }
  const row = await run(deviceKey, reportId, accountId, productionMulti(specs));
  const ev = evidenceOf(row);
  // bounded: the whole evidence blob is small and every value is a number / boolean / short enum
  assert.ok(JSON.stringify(ev).length < 2000, "evidence must stay bounded");
  for (const [k, v] of Object.entries(ev)) {
    if (typeof v === "string") assert.ok(v.length <= 40 && !/canary|report-upload|leatherback/.test(v), `evidence.${k} string leaked: ${v}`);
    else assert.ok(typeof v === "number" || typeof v === "boolean" || v === null, `evidence.${k} is not a bounded primitive`);
  }
  const serialized = JSON.stringify(row);
  for (const forbidden of [passportId, accountId, "canary-src-H", "canary-stranger-H", "canary-other-H", `${accountId}@ex.test`, "report-upload:account=", ...specs.map((s) => s.representationId), DISTINCT_TEXT.slice(0, 40)]) {
    assert.equal(serialized.includes(forbidden), false, `multi-match shadow row leaked: ${String(forbidden).slice(0, 30)}`);
  }
});

// ---------------------------------------------------------------------------
// edge cases
// ---------------------------------------------------------------------------

test("flag OFF: DEVICE_PASSPORT_ENABLED unset -> complete no-op (no row, no error) even with a report passport", async () => {
  const prev = process.env.DEVICE_PASSPORT_ENABLED;
  delete process.env.DEVICE_PASSPORT_ENABLED;
  try {
    const deviceKey = uniq("dk"), reportId = uniq("r"), accountId = uniq("acc"), passportId = uniq("passport");
    const cand = await makeSameDeviceExactCandidate(passportId);
    await seedReport({ deviceKey, reportId, accountId, passportId });
    const row = await run(deviceKey, reportId, accountId, productionMulti([cand]));
    assert.equal(row, null);
  } finally {
    process.env.DEVICE_PASSPORT_ENABLED = prev;
  }
});

test("NO_HISTORICAL_MATCH + report passport -> row records device sharedness only; candidate_count 0; no downgrade", async () => {
  const deviceKey = uniq("dk"), reportId = uniq("r"), accountId = uniq("acc"), passportId = uniq("passport");
  await seedReport({ deviceKey, reportId, accountId, passportId });
  const row = await run(deviceKey, reportId, accountId, productionNoMatch());
  const ev = evidenceOf(row);
  assert.equal(row.production_status, "NO_HISTORICAL_MATCH");
  assert.equal(Number(row.candidate_count), 0);
  assert.equal(ev.reason, "NO_MATCH_TO_EVALUATE");
  assert.equal(ev.wouldDowngrade, false);
  assert.equal(ev.matchesEvaluated, 0);
  assert.equal(ev.deviceSubmissionCount, 1);
});

test("UNAVAILABLE production result -> shadow writes nothing", async () => {
  const deviceKey = uniq("dk"), reportId = uniq("r"), accountId = uniq("acc"), passportId = uniq("passport");
  await seedReport({ deviceKey, reportId, accountId, passportId });
  const row = await run(deviceKey, reportId, accountId, { status: "UNAVAILABLE", computedAt: new Date().toISOString(), matcherVersion: "x", fingerprintVersion: "x", canonicalizationVersion: "x" });
  assert.equal(row, null);
});

test("a prior FAILED telemetry row is left untouched on the next view", async () => {
  const deviceKey = uniq("dk"), reportId = uniq("r"), accountId = uniq("acc"), passportId = uniq("passport");
  const cand = await makeSameDeviceExactCandidate(passportId);
  await seedReport({ deviceKey, reportId, accountId, passportId });
  await client.execute({
    sql: `INSERT INTO historical_match_shadow_evaluations
          (report_device_key, report_id, production_status, proposed_status, proposed_evidence, agreement, total_runtime_ms, policy_version, correspondence_version, distinctiveness_version, status, computed_at, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    args: [deviceKey, reportId, "MATCHED", "MATCHED", JSON.stringify({ error: true }), "AGREE", 1, DEVICE_PROVENANCE_SHADOW_POLICY_VERSION, "n/a", "n/a", "FAILED"],
  });
  const before = await shadowRow(deviceKey, reportId);
  await run(deviceKey, reportId, accountId, productionMulti([cand]));
  const after = await shadowRow(deviceKey, reportId);
  assert.deepEqual(after, before);
});

// ---------------------------------------------------------------------------
// summarizeSubmissionProvenance direct unit coverage
// ---------------------------------------------------------------------------

test("summarizeSubmissionProvenance: never changes summarizeSubmissionOwnership's two fields; classifies backings per the independent-backing definition", async () => {
  const accountId = uniq("acc"), passportId = uniq("passport");
  await ensurePassport(passportId);
  const rep = await makeRepresentation();
  await addAdmissionBacking(rep.id, { sourceAccountId: uniq("srcacc"), passportId });                    // same device (A)
  await addAdmissionBacking(rep.id, { sourceAccountId: uniq("srcacc"), passportId: uniq("passport") });  // different device (B)
  await addAdmissionBacking(rep.id, { sourceAccountId: accountId });                                     // own account, no device (C, not independent)
  await addSubmissionRefBacking(rep.id, uniq("stranger"));                                               // another account submission (independent)

  const p = await summarizeSubmissionProvenance(client, rep.id, {
    accountId,
    excludeDocumentIdentityId: null,
    reportVerifiedDevicePassportId: passportId,
    reportCanonicalSha256: canonicalSha256(DISTINCT_TEXT),
    reportDocumentIdentityId: null,
  });
  assert.equal(p.hasSameAccountSubmission, false);
  assert.equal(p.otherAccountSubmissionCount, 1);
  assert.equal(p.admittedPromotionBackingCount, 3);
  assert.equal(p.sameDeviceBackingCount, 1);
  assert.equal(p.admittedBackingsDifferentDevice, 1);
  assert.equal(p.admittedBackingsNoDeviceProvenance, 1);
  assert.equal(p.submissionReferenceBackingCount, 1);
  assert.equal(p.independentBackingCount, 2);
  assert.equal(p.backingsWithoutDeviceProvenance, 2);
});

test("summarizeDevicePassportSharedness: lifetime-only distinct-account / anon / total counts from indexed saved_reports provenance", async () => {
  const passportId = uniq("passport");
  await ensurePassport(passportId);
  await seedReport({ deviceKey: uniq("dk"), reportId: uniq("r"), accountId: uniq("acc"), passportId });
  await seedReport({ deviceKey: uniq("dk"), reportId: uniq("r"), accountId: uniq("acc"), passportId });
  await seedReport({ deviceKey: uniq("dk"), reportId: uniq("r"), accountId: null, passportId });
  const s = await summarizeDevicePassportSharedness(client, passportId);
  assert.equal(s.deviceSubmissionCount, 3);
  assert.equal(s.deviceDistinctAccounts, 2);
  assert.equal(s.deviceAnonUploads, 1);
});

console.log("device-provenance-shadow: structural + 14 scenarios + multi-match A–H + edge cases passed");
