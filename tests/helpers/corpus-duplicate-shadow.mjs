import { randomUUID } from "node:crypto";
import { canonicalSha256 } from "../../lib/document-identity.ts";
import { canonicalizeText } from "../../lib/canonical-text.ts";
import { tokens } from "../../lib/similarity-core.ts";
import { computeUnifiedSimilarity } from "../../lib/unified-similarity.ts";
import {
  CORPUS_DUPLICATE_SUPPRESSION_SHADOW_POLICY_VERSION,
  runCorpusDuplicateSuppressionShadowEvaluation,
} from "../../lib/corpus-duplicate-suppression-shadow.ts";

/**
 * Shared fixtures for the Phase B2a corpus-duplicate suppression shadow tests.
 * Kept out of the individual test files so the four cover the same real DB
 * shapes (promoted corpus source, saved_reports row, synthetic production
 * result) without four copies drifting apart.
 */

export const SHADOW_POLICY = CORPUS_DUPLICATE_SUPPRESSION_SHADOW_POLICY_VERSION;

let userSeq = 0;
export async function ensureUser(client, accountId) {
  if (!accountId) return;
  userSeq += 1;
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
    args: [accountId, `${accountId}-${userSeq}@ex.test`, `${accountId}${userSeq}`, "not-a-real-hash"],
  });
}

/** A document_identities row for (accountId, text) — inflates the checker-account bucket. */
export async function seedCheckerIdentity(client, accountId, text) {
  await ensureUser(client, accountId);
  await client.execute({
    sql: `INSERT INTO document_identities (id, account_id, title, author, raw_sha256, canonical_sha256, created_at)
          VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [randomUUID(), accountId, null, null, randomUUID(), canonicalSha256(text)],
  });
}

/**
 * Seed a promoted TurnitPlus corpus source for `canonicalText`, backed by ONE
 * indexed admission promotion whose decision's source_ref belongs to
 * `sourceAccountId` (NOT the report account). Returns the representation id.
 *
 * backingShape:
 *   "single-admission"   -> 1 admitted promotion / 0 submission refs  (the B1-supported shape)
 *   "revoked"            -> the accepted_representation is revoked      (BACKING_SHAPE_UNSUPPORTED: 0 admitted)
 */
export async function seedPromotedRepresentation(client, { canonicalText, sourceAccountId, backingShape = "single-admission" } = {}) {
  const repId = randomUUID();
  const decisionId = randomUUID();
  const acceptedId = randomUUID();
  const promotionId = randomUUID();
  // B2 never re-verifies the representation's own text against the report (it
  // consumes production's already-classified matchType), so a per-call unique
  // canonical text is fine — and required, because
  // corpus_admission_accepted_representations.canonical_sha256 is UNIQUE.
  const text = canonicalText ?? `seed representation ${randomUUID()} for corpus-duplicate shadow tests`;
  const hash = canonicalSha256(text);
  const wordCount = tokens(canonicalizeText(text)).length;
  const revokedAt = backingShape === "revoked" ? "2020-01-01 00:00:00" : null;

  await client.execute({
    sql: `INSERT INTO corpus_document_representations
          (id, canonical_sha256, canonical_text, word_count, language, canonicalization_version, extractor_version, first_seen_at, created_at)
          VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    args: [repId, hash, text, wordCount, null, "canonical-text-v1", null],
  });
  await client.execute({
    sql: `INSERT INTO corpus_admission_decisions
          (id, run_id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes,
           detected_format, extracted_word_count, detected_language, language_confidence, canonical_sha256, extractor_version,
           content_store_id, quality_score, quality_model_version, component_scores, feature_vector, feature_vector_version,
           corpus_value_score, corpus_value_model_version, family_relation, family_matched_source_ref, family_containment,
           consent_metadata, dry_run, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [
      decisionId, null, `report-upload:account=${sourceAccountId}:device=seed-${randomUUID()}:report=seed`, "v1", "ACCEPT", "[]", 1, "[]",
      "txt", wordCount, "English", 0.95, hash, "v1", null, 80, "v1",
      "{}", "{}", "v1", 0.9, "v1", "NONE", null, null,
      JSON.stringify({ kind: "PER_USER_CONSENT", consented: true }), 0,
    ],
  });
  await client.execute({
    sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version, revoked_at, created_at)
          VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [acceptedId, decisionId, hash, wordCount, "corpus-shingle-v1", revokedAt],
  });
  await client.execute({
    sql: `INSERT INTO corpus_admission_promotions
          (id, decision_id, accepted_representation_id, representation_id, link_type, fingerprint_version, status, claimed_at, attempt_count, last_error, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,NULL,0,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    args: [promotionId, decisionId, acceptedId, repId, "NEW_CONTENT_REPRESENTATION", "corpus-shingle-v1", "indexed"],
  });
  return repId;
}

/** Minimal saved_reports row so the evaluator's saved_reports SELECT + EXISTS guard succeed. */
export async function seedSavedReport(client, { deviceKey, reportId, accountId = null, text = "seed text.", unifiedSimilarity = null, archiveMatchedPositions = null, externalAcademicEvidence = null, verifiedDevicePassportId = null }) {
  await ensureUser(client, accountId);
  const wordCount = tokens(canonicalizeText(text)).length;
  const payload = {
    version: 11, id: 1, submissionId: "sub", title: "t", author: "", assignment: "", created: new Date().toISOString(),
    score: 0, archiveScore: 0, wordCount, scoreBand: "Low", matchedWordCount: 0, sources: [], repeats: [], text,
    ...(archiveMatchedPositions ? { archiveMatchedPositions } : {}),
    ...(externalAcademicEvidence ? { externalAcademicEvidence } : {}),
    ...(unifiedSimilarity ? { unifiedSimilarity } : {}),
  };
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, verified_device_passport_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [reportId, deviceKey, "sub", "t", new Date().toISOString(), wordCount, 0, "Low", JSON.stringify(payload), accountId, verifiedDevicePassportId],
  });
}

export function matchedResult(matches, overrides = {}) {
  return {
    status: "MATCHED",
    matches,
    computedAt: new Date().toISOString(),
    matcherVersion: "x",
    fingerprintVersion: "x",
    canonicalizationVersion: "x",
    ...overrides,
  };
}

export function noHistoricalMatch(overrides = {}) {
  return {
    status: "NO_HISTORICAL_MATCH",
    computedAt: new Date().toISOString(),
    matcherVersion: "x",
    fingerprintVersion: "x",
    canonicalizationVersion: "x",
    ...overrides,
  };
}

export function corpusMatch({ repId, matchType = "EXACT_CANONICAL_MATCH", relationshipType = "TURNITPLUS_CORPUS_SOURCE", matchedWordCount = 100, passages = [] } = {}) {
  return {
    relationshipType,
    matchedRepresentationId: repId,
    matchType,
    containment: 1,
    matchedWordCount,
    passageCount: passages.length,
    longestMatchWords: matchedWordCount,
    passages,
    historicalSubmissionCount: 0,
  };
}

/** The authoritative UnifiedSimilarityResult production would have computed for these inputs. */
export function authoritativeFor({ wordCount, archiveMatchedPositions = null, externalAcademicEvidence = null, historicalSubmissionMatch = null, effectiveDeviceSelfRepresentationIds = [] }) {
  return computeUnifiedSimilarity({ wordCount, archiveMatchedPositions, externalAcademicEvidence, historicalSubmissionMatch, effectiveDeviceSelfRepresentationIds });
}

/**
 * Direct evaluator call for the tests. The Phase B2 scoring-input parity fields
 * (archiveMatchedPositions / externalAcademicEvidence) are REQUIRED on the
 * evaluator itself; most fixtures score by wordCount alone, so this wrapper
 * defaults them to null. Pass either one explicitly (via `params`) to exercise
 * the request-local parity path — the wrapper never re-reads payload_json.
 */
export async function runShadowEval(client, params) {
  return runCorpusDuplicateSuppressionShadowEvaluation(client, {
    archiveMatchedPositions: null,
    externalAcademicEvidence: null,
    ...params,
  });
}

export async function readShadowRow(client, deviceKey, reportId) {
  const r = await client.execute({
    sql: `SELECT * FROM corpus_duplicate_suppression_shadow_evaluations
          WHERE report_device_key = ? AND report_id = ? AND policy_version = ?`,
    args: [deviceKey, reportId, SHADOW_POLICY],
  });
  const row = r.rows[0];
  return row ? { ...row } : null;
}
