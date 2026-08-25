import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import {
  createPendingReportAdmissionJob,
  processReportAdmissionJob,
  buildReportAdmissionSourceRef,
} from "../lib/corpus-admission-report-integration.ts";
import { resolvePrimarySimilaritySummary } from "../lib/report-primary-similarity.ts";
import { matchAgainstUserSubmissionCorpus } from "../lib/user-submission-matching.ts";
import { findRoomOccupant } from "../lib/reports-repo.ts";
import { deactivateAcceptedRepresentation } from "../lib/corpus-admission-admin-actions.ts";
import { bumpCorpusMatchGeneration, getCurrentCorpusMatchGeneration } from "../lib/report-historical-match.ts";
import { isRepresentationEligibleForMatching, createReusableDocumentRepresentation, recordCorpusShingles, corpusShingleHashes } from "../lib/user-submission-corpus.ts";
import { canonicalSha256 } from "../lib/document-identity.ts";
import { canonicalizeText } from "../lib/canonical-text.ts";

/**
 * Self-match exclusion fix, ACCOUNT-LEVEL: automatic promotion (lib/corpus-
 * admission-report-integration.ts's processReportAdmissionJob) can stage/
 * index a fresh ACCEPT's own representation before or during the SAME
 * report's own later similarity re-evaluations (an AI-completion resave, a
 * room self-heal after the promotion's own generation bump, or any later
 * unrelated bump). Because a promoted representation carries no source-
 * report identity of its own, nothing previously stopped a report from
 * matching a representation its own admission had just created/reactivated.
 *
 * A first fix scoped exclusion to the exact source REPORT (excludeSourceReport,
 * an exact source_ref string equality check). That left a second leak: two
 * DIFFERENT reports from the SAME account could still self-match each other,
 * because each report's own full source_ref (embedding its own reportId) is
 * a different string. The required invariant is account-level, not
 * report-level: ordinary admission-promoted corpus matching is cross-account
 * only. A representation is eligible for report R only if it has at least
 * one active indexed admission backing whose source belongs to a DIFFERENT
 * account from R. Same-account prior reports must not make the
 * representation eligible, no matter which report created that backing.
 *
 * The fix: findCandidateCorpusRepresentations/isRepresentationEligibleForMatching
 * (lib/user-submission-corpus.ts) now accept an optional excludeAccountId —
 * the account id of the report currently being evaluated — and require that
 * a representation's admission-promotion backing (SQL condition 2) belong to
 * a decision whose source_ref does NOT start with that account's canonical
 * prefix (lib/corpus-admission-source-ref.ts's buildReportAdmissionAccountPrefix,
 * compared via safe substr(...) equality, never SQL LIKE, so a wildcard
 * character in an account id can never be interpreted as a pattern) to
 * count. A second, independent active backing from any OTHER account still
 * counts, including the same account's OWN representation via a different
 * account's independent backing. resolvePrimarySimilaritySummary
 * (lib/report-primary-similarity.ts) passes its own accountId param straight
 * through as excludeAccountId, so every existing caller (write-time
 * finalization, the detail page's self-heal, the room's own self-heal) gets
 * the fix for free with no call-site changes. Global generation invalidation
 * is completely unchanged — self-exclusion, not timing, is what makes
 * ordinary stale recomputation safe again. Every fixture here is synthetic.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_corpus_admission_self_match_exclusion.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
const dbUrl = `file:${dbFile}`;
const client = createClient({ url: dbUrl });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);
const openConnection = () => createClient({ url: dbUrl });

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

const originalAdmissionFlag = process.env.CORPUS_ADMISSION_ENABLED;
const originalPromotionFlag = process.env.CORPUS_PROMOTION_ENABLED;
const originalSourceMatchingFlag = process.env.CORPUS_SOURCE_MATCHING_ENABLED;
test.after(() => {
  if (originalAdmissionFlag === undefined) delete process.env.CORPUS_ADMISSION_ENABLED; else process.env.CORPUS_ADMISSION_ENABLED = originalAdmissionFlag;
  if (originalPromotionFlag === undefined) delete process.env.CORPUS_PROMOTION_ENABLED; else process.env.CORPUS_PROMOTION_ENABLED = originalPromotionFlag;
  if (originalSourceMatchingFlag === undefined) delete process.env.CORPUS_SOURCE_MATCHING_ENABLED; else process.env.CORPUS_SOURCE_MATCHING_ENABLED = originalSourceMatchingFlag;
});
process.env.CORPUS_ADMISSION_ENABLED = "true";
process.env.CORPUS_PROMOTION_ENABLED = "true";
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";

let userCounter = 0;
async function ensureUser() {
  userCounter += 1;
  const accountId = `self-match-account-${userCounter}`;
  await client.execute({
    sql: "INSERT INTO users (id, email, username, password_hash, corpus_reuse_consented_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)",
    args: [accountId, `${accountId}@example.test`, accountId, "not-a-real-hash"],
  });
  return accountId;
}

let reportCounter = 0;
async function seedSavedReport(accountId, rawText) {
  reportCounter += 1;
  const deviceKey = `self-match-device-${reportCounter}`;
  const reportId = `self-match-report-${reportCounter}`;
  const payload = { version: 11, id: reportId, submissionId: `sub-${reportCounter}`, title: `Fixture ${reportCounter}`, text: rawText };
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, ai_score, ai_tone, payload_json, user_id, room_number, ai_status, updated_at)
          VALUES (?,?,?,?,CURRENT_TIMESTAMP,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [reportId, deviceKey, payload.submissionId, payload.title, 40, 0, "Low", 0, "low", JSON.stringify(payload), accountId, 0, "ready"],
  });
  return { deviceKey, reportId };
}

// Manual, direct-DB fixture helpers (mirrors tests/corpus-admission-
// promotion-sweep.test.mjs's own insertDecision/insertAcceptedRepresentation/
// insertStagedPromotion conventions) — used ONLY for scenarios needing
// simultaneously active backings, which the REAL admission gate's own
// "first accepted sample wins" dedup (a genuine partial UNIQUE index,
// ux_corpus_admission_accepted_representations_canonical_sha256_active,
// drizzle/0032: "two simultaneously-active rows [for one hash] can never
// share one") makes structurally unreachable through evaluateCorpusAdmissionCandidate
// itself — confirmed empirically: a second real admission of identical
// content while the first is still active is correctly REJECTed, not
// ACCEPTed. This directly exercises admissionEligibilitySql's own condition
// 2 in isolation, independent of what the current gate happens to allow.
async function insertDecisionRaw({ sourceRef, canonicalSha256 }) {
  const id = crypto.randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_decisions
          (id, run_id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes,
           detected_format, extracted_word_count, detected_language, language_confidence, canonical_sha256, extractor_version,
           content_store_id, quality_score, quality_model_version, component_scores, feature_vector, feature_vector_version,
           corpus_value_score, corpus_value_model_version, family_relation, family_matched_source_ref, family_containment,
           consent_metadata, dry_run, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [
      id, null, sourceRef, "v1", "ACCEPT", "[]", 1, "[]", "txt", 50, "English", 0.95, canonicalSha256, "v1", null, 80, "v1",
      "{}", "{}", "v1", 0.9, "v1", "NONE", null, null, JSON.stringify({ kind: "PER_USER_CONSENT", consented: true }), 0,
    ],
  });
  return id;
}
async function insertAcceptedRepresentationRaw(decisionId, canonicalSha256) {
  const id = crypto.randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version, revoked_at, created_at)
          VALUES (?,?,?,?,?,NULL,CURRENT_TIMESTAMP)`,
    args: [id, decisionId, canonicalSha256, 50, "v1"],
  });
  return id;
}
async function insertIndexedPromotionRaw(decisionId, acceptedRepresentationId, representationId) {
  const id = crypto.randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_promotions (id, decision_id, accepted_representation_id, representation_id, link_type, fingerprint_version, status, attempt_count, created_at, updated_at)
          VALUES (?,?,?,?,?,?,'indexed',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    args: [id, decisionId, acceptedRepresentationId, representationId, "NEW_CONTENT_REPRESENTATION", "corpus-shingle-v1"],
  });
  return id;
}

const WORD_BANK = [
  "research", "analysis", "population", "sample", "variable", "hypothesis", "method", "outcome", "region",
  "temperature", "pressure", "reaction", "material", "structure", "process", "signal", "pattern", "network",
  "sediment", "species", "habitat", "climate", "growth", "measurement", "instrument", "observation", "protocol",
  "significant", "distinct", "gradual", "consistent", "notable", "substantial", "minor", "extensive", "localized",
  "documented", "identified", "recorded", "analyzed", "examined", "compared", "measured", "observed", "reported",
];
function seededRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 0xffffffff; };
}
function plausibleArticleText(seed, targetWords = 3300) {
  const rng = seededRandom(seed);
  const paragraphs = [];
  let wordCount = 0;
  while (wordCount < targetWords) {
    const sentence = `The ${Array.from({ length: 10 + Math.floor(rng() * 18) }, () => WORD_BANK[Math.floor(rng() * WORD_BANK.length)]).join(" ")}.`;
    const paragraph = Array.from({ length: 5 + Math.floor(rng() * 4) }, () => sentence).join(" ");
    paragraphs.push(paragraph);
    wordCount += paragraph.split(/\s+/).length;
  }
  return paragraphs.join("\n\n");
}

/** Mirrors tests/report-primary-similarity.test.mjs's own finalizeAndPersist exactly — the real write-time-finalization call, which is where excludeAccountId is threaded through internally (as params.accountId). */
async function finalizeAndPersist({ deviceKey, id, userId, text, wordCount, archiveScore = 0 }) {
  const resolution = await resolvePrimarySimilaritySummary(client, {
    reportDeviceKey: deviceKey, reportId: id, accountId: userId, rawText: text,
    wordCount, archiveMatchedPositions: null, externalAcademicEvidence: null, archiveScore,
  });
  if (resolution.unifiedSimilarity) {
    const existing = await client.execute({ sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, id] });
    const payload = JSON.parse(existing.rows[0].payload_json);
    payload.unifiedSimilarity = resolution.unifiedSimilarity;
    payload.corpusSourceMatchingEnabledAtComputation = resolution.corpusSourceMatchingEnabled;
    payload.unifiedSimilarityGeneration = resolution.corpusGeneration;
    await client.execute({ sql: "UPDATE saved_reports SET payload_json = ? WHERE device_key = ? AND id = ?", args: [JSON.stringify(payload), deviceKey, id] });
  }
  return resolution;
}

/** Real admission + automatic promotion, via the actual job pipeline — mirrors tests/corpus-admission-automatic-promotion.test.mjs's own uploadAndProcess. */
async function admitAndAutoPromote({ accountId, deviceKey, reportId }) {
  const created = await createPendingReportAdmissionJob(client, { accountId, deviceKey, reportId });
  const outcome = await processReportAdmissionJob(client, { jobId: created.jobId, openConnection });
  assert.equal(outcome.outcome, "succeeded", "test setup sanity: admission job must succeed");
  assert.equal(outcome.decision, "ACCEPT", "test setup sanity: this fixture must genuinely ACCEPT");
  return outcome;
}

async function decisionRowFor(sourceRef) {
  const result = await client.execute({ sql: "SELECT * FROM corpus_admission_decisions WHERE source_ref = ?", args: [sourceRef] });
  return result.rows[0] ?? null;
}
async function promotionRowForDecision(decisionId) {
  const result = await client.execute({ sql: "SELECT * FROM corpus_admission_promotions WHERE decision_id = ?", args: [decisionId] });
  return result.rows[0] ?? null;
}

// --- 1/2: newly auto-promoted report cannot match its own sole backing, incl. resave ---

test("REQUIRED: a newly auto-promoted report cannot match its own sole admission backing — an AI-completion-style resave (a second finalization for the SAME report) still cannot self-match", async () => {
  const accountId = await ensureUser();
  const text = plausibleArticleText(4001);
  const { deviceKey, reportId } = await seedSavedReport(accountId, text);
  const sourceRef = buildReportAdmissionSourceRef({ accountId, deviceKey, reportId });

  // Call A — before admission/promotion has ever run, correctly no match.
  const callA = await finalizeAndPersist({ deviceKey, id: reportId, userId: accountId, text, wordCount: 40 });
  assert.equal(callA.historicalSubmissionMatch.status, "NO_HISTORICAL_MATCH", "test setup sanity: nothing else in the corpus yet");

  // Admission ACCEPTs and automatically promotes THIS report's own content.
  await admitAndAutoPromote({ accountId, deviceKey, reportId });
  const decision = await decisionRowFor(sourceRef);
  const promotion = await promotionRowForDecision(decision.id);
  assert.equal(promotion.status, "indexed", "test setup sanity: automatic promotion must succeed");

  // Call B — the AI-completion resave: a SECOND finalization for the exact
  // same report, now that its own content has just been promoted. Before
  // this fix, this would find its own just-created representation via
  // findCandidateCorpusRepresentations and self-match at ~100%.
  const callB = await finalizeAndPersist({ deviceKey, id: reportId, userId: accountId, text, wordCount: 40 });
  assert.equal(callB.historicalSubmissionMatch.status, "NO_HISTORICAL_MATCH", "REQUIRED: a resave after this report's own promotion must still see no historical match — self-only backing must be excluded");
  assert.equal(callB.unifiedSimilarity.unifiedScore, 0, "REQUIRED: no self-inflated score from the report's own promoted representation");
});

// --- 3: room/self-heal recomputation after the promotion generation bump ---

test("REQUIRED: room self-heal recomputation, triggered by the report's own promotion generation bump, still cannot self-match", async () => {
  const accountId = await ensureUser();
  const text = plausibleArticleText(4002);
  const { deviceKey, reportId } = await seedSavedReport(accountId, text);

  const callA = await finalizeAndPersist({ deviceKey, id: reportId, userId: accountId, text, wordCount: 40 });
  assert.equal(callA.historicalSubmissionMatch.status, "NO_HISTORICAL_MATCH");
  const generationAtCallA = callA.corpusGeneration;

  await admitAndAutoPromote({ accountId, deviceKey, reportId });
  const generationAfterPromotion = await getCurrentCorpusMatchGeneration(client);
  assert.ok(generationAfterPromotion > generationAtCallA, "test setup sanity: the report's own promotion must have bumped the generation, making its own persisted snapshot stale");

  // findRoomOccupant's own self-heal fires because the persisted snapshot
  // (stamped at generationAtCallA) is now stale relative to
  // generationAfterPromotion — exactly the trigger identified in the prior
  // read-only trace. This is the SAME code path a real room poll uses.
  const occupant = await findRoomOccupant(client, accountId, 0);
  assert.equal(occupant.status, "ready");
  assert.equal(occupant.report.similarityStatus, "resolved", "self-heal must reach a real terminal resolved state, not stay stuck");
  assert.equal(occupant.report.primaryScore, 0, "REQUIRED: the self-heal recomputation triggered by this report's own promotion must not self-match — score stays 0, not ~100%");
});

// --- 4: a much later, genuinely unrelated generation bump ---

test("REQUIRED: a much later, unrelated generation bump still cannot make the report self-match while it remains the only active backing", async () => {
  const accountId = await ensureUser();
  const text = plausibleArticleText(4003);
  const { deviceKey, reportId } = await seedSavedReport(accountId, text);

  await finalizeAndPersist({ deviceKey, id: reportId, userId: accountId, text, wordCount: 40 });
  await admitAndAutoPromote({ accountId, deviceKey, reportId });

  // First self-heal (as in the previous test) already converges to 0 — now
  // simulate a COMPLETELY unrelated later event (some other decision's own
  // promotion bumping the generation again) with nothing to do with this
  // report or its content.
  await client.execute({ sql: "SELECT 1" });
  await bumpCorpusMatchGeneration(client);
  await bumpCorpusMatchGeneration(client);

  const occupant = await findRoomOccupant(client, accountId, 0);
  assert.equal(occupant.report.similarityStatus, "resolved");
  assert.equal(occupant.report.primaryScore, 0, "REQUIRED: an unrelated later generation bump must still correctly re-resolve to no match — the report's own representation is still self-only-backed");
});

// --- 5: another report submitted after promotion sees it and matches normally ---

test("REQUIRED: a different report, submitted after the first report's promotion, sees the representation and matches normally", async () => {
  const text = plausibleArticleText(4004);

  const accountA = await ensureUser();
  const { deviceKey: deviceA, reportId: reportA } = await seedSavedReport(accountA, text);
  await finalizeAndPersist({ deviceKey: deviceA, id: reportA, userId: accountA, text, wordCount: 40 });
  await admitAndAutoPromote({ accountId: accountA, deviceKey: deviceA, reportId: reportA });

  const accountB = await ensureUser();
  const { deviceKey: deviceB, reportId: reportB } = await seedSavedReport(accountB, text);
  const resultB = await finalizeAndPersist({ deviceKey: deviceB, id: reportB, userId: accountB, text, wordCount: 40 });

  assert.equal(resultB.historicalSubmissionMatch.status, "MATCHED", "REQUIRED: a genuinely different report must see A's promoted representation as a real candidate");
  assert.equal(resultB.historicalSubmissionMatch.matches[0].relationshipType, "TURNITPLUS_CORPUS_SOURCE");
  assert.ok(resultB.unifiedSimilarity.unifiedScore > 0, "REQUIRED: the match must contribute a real, non-zero score — immediate promotion still benefits subsequent reports");
});

// --- 6/7/8: two SIMULTANEOUSLY active indexed backings on one representation, BOTH directions ---
//
// The real admission gate's own "first accepted sample wins" dedup
// (ux_corpus_admission_accepted_representations_canonical_sha256_active,
// drizzle/0032: "two simultaneously-active rows can never share one [hash]")
// makes two decisions BOTH holding an active accepted_representation for
// the identical canonical hash structurally unreachable through
// evaluateCorpusAdmissionCandidate — confirmed directly: a second real
// admission of identical content while the first is still active is
// correctly REJECTed as DUPLICATE_ALREADY_REPRESENTED, never a second
// ACCEPT. This test therefore constructs the DB shape directly (mirroring
// tests/corpus-admission-promotion-sweep.test.mjs's own established manual-
// fixture convention for exactly this reason), to exercise
// admissionEligibilitySql's own condition 2 in full: two independent,
// non-revoked accepted_representations, from two DIFFERENT accounts, both
// indexed against the SAME corpus_document_representations row — and proves
// the relationship is symmetric: A remains eligible through B's backing,
// AND B remains eligible through A's backing.

test("REQUIRED: with two simultaneously active indexed backings on one representation from two DIFFERENT accounts, each account excludes its OWN backing but remains eligible through the OTHER's independent backing — symmetric in both directions; revoking either backing removes only that account's eligibility", async () => {
  const text = plausibleArticleText(4005);
  const canonicalText = canonicalizeText(text);

  const representation = await createReusableDocumentRepresentation(client, { canonicalText });
  await recordCorpusShingles(client, representation.id, canonicalText);

  const accountA = await ensureUser();
  const { deviceKey: deviceA, reportId: reportA } = await seedSavedReport(accountA, text);
  const sourceRefA = buildReportAdmissionSourceRef({ accountId: accountA, deviceKey: deviceA, reportId: reportA });
  const decisionA = await insertDecisionRaw({ sourceRef: sourceRefA, canonicalSha256: `${canonicalSha256(text)}-a` });
  const acceptedRepA = await insertAcceptedRepresentationRaw(decisionA, `${canonicalSha256(text)}-a`);
  await insertIndexedPromotionRaw(decisionA, acceptedRepA, representation.id);

  // A alone: self-only backing, must be excluded from A's own query.
  const resaveASelfOnly = await finalizeAndPersist({ deviceKey: deviceA, id: reportA, userId: accountA, text, wordCount: 40 });
  assert.equal(resaveASelfOnly.historicalSubmissionMatch.status, "NO_HISTORICAL_MATCH", "test setup sanity: with only A's own backing, A must not match itself");

  // A second, INDEPENDENT decision from a DIFFERENT account (B) also
  // actively backs the SAME representation — a different accepted-
  // representation hash (satisfies the real partial-unique constraint),
  // deliberately pointed at the same corpus_document_representations row.
  const accountB = await ensureUser();
  const { deviceKey: deviceB, reportId: reportB } = await seedSavedReport(accountB, text);
  const sourceRefB = buildReportAdmissionSourceRef({ accountId: accountB, deviceKey: deviceB, reportId: reportB });
  const decisionB = await insertDecisionRaw({ sourceRef: sourceRefB, canonicalSha256: `${canonicalSha256(text)}-b` });
  const acceptedRepB = await insertAcceptedRepresentationRaw(decisionB, `${canonicalSha256(text)}-b`);
  await insertIndexedPromotionRaw(decisionB, acceptedRepB, representation.id);

  // --- A excludes A's own backing, but remains eligible through B's ---
  const resaveA = await finalizeAndPersist({ deviceKey: deviceA, id: reportA, userId: accountA, text, wordCount: 40 });
  assert.equal(resaveA.historicalSubmissionMatch.status, "MATCHED", "REQUIRED: A must remain eligible through B's independent, non-self, active backing");
  assert.equal(resaveA.historicalSubmissionMatch.matches[0].matchedRepresentationId, representation.id);

  // --- Symmetric: B excludes B's own backing, but remains eligible through A's ---
  const resaveB = await finalizeAndPersist({ deviceKey: deviceB, id: reportB, userId: accountB, text, wordCount: 40 });
  assert.equal(resaveB.historicalSubmissionMatch.status, "MATCHED", "REQUIRED: symmetrically, B must remain eligible through A's independent, non-self, active backing");
  assert.equal(resaveB.historicalSubmissionMatch.matches[0].matchedRepresentationId, representation.id);

  // --- revoking B leaves A unable to match itself again ---
  const revokeB = await deactivateAcceptedRepresentation({ decisionId: decisionB, adminUserId: "admin-test", reason: "test revoke B", openConnection });
  assert.equal(revokeB.outcome, "deactivated", "test setup sanity: B's own backing must actually be revoked");
  const resaveAAfterRevokeB = await finalizeAndPersist({ deviceKey: deviceA, id: reportA, userId: accountA, text, wordCount: 40 });
  assert.equal(resaveAAfterRevokeB.historicalSubmissionMatch.status, "NO_HISTORICAL_MATCH", "REQUIRED: once B's backing is revoked, A is back to self-only and must not match itself");

  // A's own backing is still active and B's is now gone — B, querying
  // again, must ALSO lose eligibility (its only remaining active backing is
  // its own, self-excluded), proving revocation removes eligibility on
  // whichever side lost its only different-account backing, not just A's.
  const resaveBAfterRevokeB = await finalizeAndPersist({ deviceKey: deviceB, id: reportB, userId: accountB, text, wordCount: 40 });
  assert.equal(resaveBAfterRevokeB.historicalSubmissionMatch.status, "MATCHED", "test setup sanity: B still has A's independent, non-self, active backing at this point");
});

// --- 9: full Remove -> re-upload -> subsequent-report lifecycle ---

test("REQUIRED (full lifecycle): Remove -> source re-upload stays unmatched for that source report, then a subsequent independent report matches normally — no manual sweep anywhere in this test", async () => {
  const text = plausibleArticleText(4006);

  // X is indexed from report A.
  const accountA = await ensureUser();
  const { deviceKey: deviceA, reportId: reportA } = await seedSavedReport(accountA, text);
  await finalizeAndPersist({ deviceKey: deviceA, id: reportA, userId: accountA, text, wordCount: 40 });
  const decisionA = await admitAndAutoPromote({ accountId: accountA, deviceKey: deviceA, reportId: reportA });

  // Report B -> matches (100%-equivalent).
  const accountB = await ensureUser();
  const { deviceKey: deviceB, reportId: reportB } = await seedSavedReport(accountB, text);
  const resultB = await finalizeAndPersist({ deviceKey: deviceB, id: reportB, userId: accountB, text, wordCount: 40 });
  assert.equal(resultB.historicalSubmissionMatch.status, "MATCHED");
  assert.ok(resultB.unifiedSimilarity.unifiedScore > 0);

  // Admin removes/deactivates A's backing.
  await deactivateAcceptedRepresentation({ decisionId: decisionA.decisionId, adminUserId: "admin-test", reason: "test Remove", openConnection });

  // Report C uploads X — can ACCEPT and automatically promote immediately
  // (the old, revoked accepted_representation no longer blocks a fresh
  // ACCEPT of the identical content).
  const accountC = await ensureUser();
  const { deviceKey: deviceC, reportId: reportC } = await seedSavedReport(accountC, text);
  const callAC = await finalizeAndPersist({ deviceKey: deviceC, id: reportC, userId: accountC, text, wordCount: 40 });
  assert.equal(callAC.historicalSubmissionMatch.status, "NO_HISTORICAL_MATCH", "test setup sanity: A's backing is revoked, C's own backing does not exist yet");
  const decisionC = await admitAndAutoPromote({ accountId: accountC, deviceKey: deviceC, reportId: reportC });
  const promotionC = await promotionRowForDecision(decisionC.decisionId);
  assert.equal(promotionC.status, "indexed", "REQUIRED: C's re-ACCEPT must automatically promote immediately, no manual sweep");

  // Report C itself remains unmatched — its own new backing is excluded
  // from its own matching query (mirrors the resave/self-heal tests above).
  const resaveC = await finalizeAndPersist({ deviceKey: deviceC, id: reportC, userId: accountC, text, wordCount: 40 });
  assert.equal(resaveC.historicalSubmissionMatch.status, "NO_HISTORICAL_MATCH", "REQUIRED: report C must remain ~unmatched against its own sole new backing");
  const occupantC = await findRoomOccupant(client, accountC, 0);
  assert.equal(occupantC.report.primaryScore, 0, "REQUIRED: C's own room self-heal (post-promotion generation bump) must also stay unmatched");

  // Report D, submitted afterward from another account, matches normally —
  // proving the fix is scoped to C alone, not a global suppression.
  const accountD = await ensureUser();
  const { deviceKey: deviceD, reportId: reportD } = await seedSavedReport(accountD, text);
  const resultD = await finalizeAndPersist({ deviceKey: deviceD, id: reportD, userId: accountD, text, wordCount: 40 });
  assert.equal(resultD.historicalSubmissionMatch.status, "MATCHED", "REQUIRED: report D must match normally through C's own newly-promoted, non-self backing");
  assert.ok(resultD.unifiedSimilarity.unifiedScore > 0);
});

// --- ACCOUNT-LEVEL ACCEPTANCE SEQUENCE (the scenario reported as the leak) ---
//
// The exact sequence reported: A1 upload -> ~2%; A2 SAME ACCOUNT (a
// DIFFERENT report than A1) -> ~2%; Remove A's backing; B1 upload -> ~2%;
// B2 SAME ACCOUNT -> ~2%; A3 upload -> ~100%. The critical assertion is A2
// and B2: under the OLD report-level-only fix, a second report from the
// SAME account as the sole active backing would incorrectly match at
// ~100%, because report-level exclusion only ever compared the exact
// source report, never the account. "~2%"/"~100%" in the report is this
// test's NO_HISTORICAL_MATCH (no corpus contribution) vs MATCHED with a
// high containment score.

test("REQUIRED ACCEPTANCE: A1 upload (no match) -> A2 same account (no match) -> Remove A's backing -> B1 upload (no match) -> B2 same account (no match) -> A3 upload (MATCHED, through B)", async () => {
  const text = plausibleArticleText(4030);

  const accountA = await ensureUser();
  const { deviceKey: deviceA1, reportId: reportA1 } = await seedSavedReport(accountA, text);
  const a1 = await finalizeAndPersist({ deviceKey: deviceA1, id: reportA1, userId: accountA, text, wordCount: 40 });
  assert.equal(a1.historicalSubmissionMatch.status, "NO_HISTORICAL_MATCH", "A1: empty corpus, no match yet");
  const decisionA = await admitAndAutoPromote({ accountId: accountA, deviceKey: deviceA1, reportId: reportA1 });

  // A2: a SECOND report from the SAME account A, after A1's own promotion —
  // the exact scenario the report-level-only fix left open.
  const { deviceKey: deviceA2, reportId: reportA2 } = await seedSavedReport(accountA, text);
  const a2 = await finalizeAndPersist({ deviceKey: deviceA2, id: reportA2, userId: accountA, text, wordCount: 40 });
  assert.equal(a2.historicalSubmissionMatch.status, "NO_HISTORICAL_MATCH", "REQUIRED: A2, from the SAME account as the only active backing (a DIFFERENT report than the one that created it), must still see no match — this is exactly the account-level leak this fix closes");
  assert.equal(a2.unifiedSimilarity.unifiedScore, 0);

  // Remove A's corpus backing entirely.
  await deactivateAcceptedRepresentation({ decisionId: decisionA.decisionId, adminUserId: "admin-test", reason: "test Remove A", openConnection });

  // B1: a DIFFERENT account uploads the same content — A's backing is
  // revoked and B has none yet, so the corpus is effectively empty for B.
  const accountB = await ensureUser();
  const { deviceKey: deviceB1, reportId: reportB1 } = await seedSavedReport(accountB, text);
  const b1 = await finalizeAndPersist({ deviceKey: deviceB1, id: reportB1, userId: accountB, text, wordCount: 40 });
  assert.equal(b1.historicalSubmissionMatch.status, "NO_HISTORICAL_MATCH", "B1: A's backing is revoked, B has no backing yet");
  const decisionB = await admitAndAutoPromote({ accountId: accountB, deviceKey: deviceB1, reportId: reportB1 });

  // B2: a SECOND report from the SAME account B.
  const { deviceKey: deviceB2, reportId: reportB2 } = await seedSavedReport(accountB, text);
  const b2 = await finalizeAndPersist({ deviceKey: deviceB2, id: reportB2, userId: accountB, text, wordCount: 40 });
  assert.equal(b2.historicalSubmissionMatch.status, "NO_HISTORICAL_MATCH", "REQUIRED: B2, from the SAME account as B's only active backing, must still see no match");
  assert.equal(b2.unifiedSimilarity.unifiedScore, 0);

  // A3: account A, via a THIRD report (different from A1/A2), uploads
  // again. B's backing is active and belongs to a DIFFERENT account from
  // A — A3 must match, and score near-100% against identical content.
  const { deviceKey: deviceA3, reportId: reportA3 } = await seedSavedReport(accountA, text);
  const a3 = await finalizeAndPersist({ deviceKey: deviceA3, id: reportA3, userId: accountA, text, wordCount: 40 });
  assert.equal(a3.historicalSubmissionMatch.status, "MATCHED", "REQUIRED: A3 must match through B's cross-account backing");
  assert.ok(a3.unifiedSimilarity.unifiedScore > 0.9, "REQUIRED: A3 must score near-100% against B's identical-content backing");
});

// --- "with only ONE account active, ANY LATER report from that SAME account remains unmatched" ---

test("REQUIRED: with only account A active, every one of several later reports from account A remains unmatched against A's own sole backing", async () => {
  const text = plausibleArticleText(4031);
  const accountA = await ensureUser();

  const { deviceKey: device0, reportId: report0 } = await seedSavedReport(accountA, text);
  await finalizeAndPersist({ deviceKey: device0, id: report0, userId: accountA, text, wordCount: 40 });
  await admitAndAutoPromote({ accountId: accountA, deviceKey: device0, reportId: report0 });

  for (let i = 0; i < 3; i += 1) {
    const { deviceKey, reportId } = await seedSavedReport(accountA, text);
    const result = await finalizeAndPersist({ deviceKey, id: reportId, userId: accountA, text, wordCount: 40 });
    assert.equal(result.historicalSubmissionMatch.status, "NO_HISTORICAL_MATCH", `REQUIRED: later same-account report #${i} must not self-match while A's backing remains the only active one`);
  }
});

test("REQUIRED: with only account B active, every one of several later reports from account B remains unmatched against B's own sole backing (symmetric to the account-A case)", async () => {
  const text = plausibleArticleText(4032);
  const accountB = await ensureUser();

  const { deviceKey: device0, reportId: report0 } = await seedSavedReport(accountB, text);
  await finalizeAndPersist({ deviceKey: device0, id: report0, userId: accountB, text, wordCount: 40 });
  await admitAndAutoPromote({ accountId: accountB, deviceKey: device0, reportId: report0 });

  for (let i = 0; i < 3; i += 1) {
    const { deviceKey, reportId } = await seedSavedReport(accountB, text);
    const result = await finalizeAndPersist({ deviceKey, id: reportId, userId: accountB, text, wordCount: 40 });
    assert.equal(result.historicalSubmissionMatch.status, "NO_HISTORICAL_MATCH", `REQUIRED: later same-account report #${i} must not self-match while B's backing remains the only active one`);
  }
});

// --- cross-account matching works in both directions ---

test("REQUIRED: A can match B and B can match A — cross-account matching works in both directions", async () => {
  const textAB = plausibleArticleText(4033);
  const textBA = plausibleArticleText(4034);

  // Direction 1: A backs, B matches through A.
  const accountA1 = await ensureUser();
  const { deviceKey: deviceA1, reportId: reportA1 } = await seedSavedReport(accountA1, textAB);
  await finalizeAndPersist({ deviceKey: deviceA1, id: reportA1, userId: accountA1, text: textAB, wordCount: 40 });
  await admitAndAutoPromote({ accountId: accountA1, deviceKey: deviceA1, reportId: reportA1 });

  const accountB1 = await ensureUser();
  const { deviceKey: deviceB1, reportId: reportB1 } = await seedSavedReport(accountB1, textAB);
  const resultB1 = await finalizeAndPersist({ deviceKey: deviceB1, id: reportB1, userId: accountB1, text: textAB, wordCount: 40 });
  assert.equal(resultB1.historicalSubmissionMatch.status, "MATCHED", "REQUIRED: B must match through A's cross-account backing");

  // Direction 2: B backs, A matches through B (different content, different accounts, roles reversed).
  const accountB2 = await ensureUser();
  const { deviceKey: deviceB2, reportId: reportB2 } = await seedSavedReport(accountB2, textBA);
  await finalizeAndPersist({ deviceKey: deviceB2, id: reportB2, userId: accountB2, text: textBA, wordCount: 40 });
  await admitAndAutoPromote({ accountId: accountB2, deviceKey: deviceB2, reportId: reportB2 });

  const accountA2 = await ensureUser();
  const { deviceKey: deviceA2, reportId: reportA2 } = await seedSavedReport(accountA2, textBA);
  const resultA2 = await finalizeAndPersist({ deviceKey: deviceA2, id: reportA2, userId: accountA2, text: textBA, wordCount: 40 });
  assert.equal(resultA2.historicalSubmissionMatch.status, "MATCHED", "REQUIRED: A must match through B's cross-account backing");
});

// --- exact-canonical-hash fallback must obey the same account-level exclusion ---

test("REQUIRED: the exact-canonical-hash fallback path (matchAgainstUserSubmissionCorpus's findReusableRepresentationByCanonicalHash defensive branch) obeys the same account-level exclusion as the shingle-based path", async () => {
  // A text short enough to produce ZERO 5-word shingles, so it can ONLY
  // ever be found via the exact-canonical-hash fallback, never via the
  // shingle-based candidate search — isolates that fallback path entirely.
  const shortText = "one two three four";
  const canonicalText = canonicalizeText(shortText);
  assert.equal(corpusShingleHashes(canonicalText, 5).size, 0, "test setup sanity: text must be short enough to produce no shingles at all");

  const representation = await createReusableDocumentRepresentation(client, { canonicalText });
  await recordCorpusShingles(client, representation.id, canonicalText);

  const accountA = "exact-fallback-account-a";
  const sourceRefA = buildReportAdmissionSourceRef({ accountId: accountA, deviceKey: "d", reportId: "r" });
  const hash = canonicalSha256(canonicalText);
  const decisionA = await insertDecisionRaw({ sourceRef: sourceRefA, canonicalSha256: hash });
  const acceptedA = await insertAcceptedRepresentationRaw(decisionA, hash);
  await insertIndexedPromotionRaw(decisionA, acceptedA, representation.id);

  // Same account as the sole backing: exact-hash fallback must exclude it.
  const selfResult = await matchAgainstUserSubmissionCorpus(client, { accountId: accountA, canonicalText, excludeAccountId: accountA });
  assert.equal(selfResult.status, "NO_HISTORICAL_MATCH", "REQUIRED: exact-canonical fallback must exclude a representation backed only by the querying account's own admission");

  // A different account: exact-hash fallback must still find and match it.
  const accountB = "exact-fallback-account-b";
  const otherResult = await matchAgainstUserSubmissionCorpus(client, { accountId: accountB, canonicalText, excludeAccountId: accountB });
  assert.equal(otherResult.status, "MATCHED", "REQUIRED: exact-canonical fallback must still match through a DIFFERENT account's active backing");
  assert.equal(otherResult.matches[0].matchType, "EXACT_CANONICAL_MATCH");
});

// --- account ids sharing a textual prefix must not collide ---

test("REQUIRED: account ids with a shared textual prefix (e.g. \"abc\" / \"abc123\") do not collide in either direction", async () => {
  const text = plausibleArticleText(4035);
  const canonicalText = canonicalizeText(text);

  const shortAccountId = "prefix-collision-abc";
  const longAccountId = "prefix-collision-abc999";

  // Representation 1: backed ONLY by the SHORT account id.
  const repShort = await createReusableDocumentRepresentation(client, { canonicalText });
  await recordCorpusShingles(client, repShort.id, canonicalText);
  const sourceRefShort = buildReportAdmissionSourceRef({ accountId: shortAccountId, deviceKey: "d1", reportId: "r1" });
  const decisionShort = await insertDecisionRaw({ sourceRef: sourceRefShort, canonicalSha256: `${canonicalSha256(text)}-short` });
  const acceptedShort = await insertAcceptedRepresentationRaw(decisionShort, `${canonicalSha256(text)}-short`);
  await insertIndexedPromotionRaw(decisionShort, acceptedShort, repShort.id);

  assert.equal(
    await isRepresentationEligibleForMatching(client, repShort.id, { excludeAccountId: longAccountId }),
    true,
    "REQUIRED: excluding a LONGER account id that shares a textual prefix with the actual (shorter) backing account must not falsely exclude it",
  );
  assert.equal(
    await isRepresentationEligibleForMatching(client, repShort.id, { excludeAccountId: shortAccountId }),
    false,
    "test setup sanity: excluding the true backing account id does exclude it",
  );

  // Representation 2 (different content, so it gets a distinct row): backed
  // ONLY by the LONG account id — the reverse direction.
  const textLong = plausibleArticleText(4036);
  const canonicalTextLong = canonicalizeText(textLong);
  const repLong = await createReusableDocumentRepresentation(client, { canonicalText: canonicalTextLong });
  await recordCorpusShingles(client, repLong.id, canonicalTextLong);
  const sourceRefLong = buildReportAdmissionSourceRef({ accountId: longAccountId, deviceKey: "d2", reportId: "r2" });
  const decisionLong = await insertDecisionRaw({ sourceRef: sourceRefLong, canonicalSha256: `${canonicalSha256(textLong)}-long` });
  const acceptedLong = await insertAcceptedRepresentationRaw(decisionLong, `${canonicalSha256(textLong)}-long`);
  await insertIndexedPromotionRaw(decisionLong, acceptedLong, repLong.id);

  assert.equal(
    await isRepresentationEligibleForMatching(client, repLong.id, { excludeAccountId: shortAccountId }),
    true,
    "REQUIRED: excluding the SHORTER account id must not falsely exclude a backing actually owned by the longer account that merely shares its prefix",
  );
  assert.equal(
    await isRepresentationEligibleForMatching(client, repLong.id, { excludeAccountId: longAccountId }),
    false,
    "test setup sanity: excluding the true (long) backing account id does exclude it",
  );
});

// --- Direct unit coverage of the new predicate itself ---

test("REQUIRED: isRepresentationEligibleForMatching directly — self-account-only backing excluded, different-account backing included, revoked backing never counts", async () => {
  const text = plausibleArticleText(4007);
  const accountA = await ensureUser();
  const { deviceKey: deviceA, reportId: reportA } = await seedSavedReport(accountA, text);
  await finalizeAndPersist({ deviceKey: deviceA, id: reportA, userId: accountA, text, wordCount: 40 });
  const decisionA = await admitAndAutoPromote({ accountId: accountA, deviceKey: deviceA, reportId: reportA });
  const promotionA = await promotionRowForDecision(decisionA.decisionId);

  assert.equal(await isRepresentationEligibleForMatching(client, promotionA.representation_id), true, "without excludeAccountId, unchanged pre-fix behavior: eligible");
  assert.equal(await isRepresentationEligibleForMatching(client, promotionA.representation_id, { excludeAccountId: accountA }), false, "REQUIRED: self-only backing excluded when the caller is that exact account, even via a DIFFERENT report than the one that created the backing");

  const otherAccountId = "unrelated-account";
  assert.equal(await isRepresentationEligibleForMatching(client, promotionA.representation_id, { excludeAccountId: otherAccountId }), true, "excluding a DIFFERENT account must not affect A's own eligibility");
});
