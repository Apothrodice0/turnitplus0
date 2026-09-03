import { productionCountsRelationship } from "./device-self-scoring-rule";

/**
 * Phase B1 — the PURE candidate policy for shadow document-local
 * exact-canonical duplicate suppression.
 *
 * SHADOW ONLY. This module decides, for one already-computed historical
 * match, whether that match is a
 * `DOCUMENT_LOCAL_CORPUS_DUPLICATE_CANDIDATE` — a single qualifying
 * TurnitPlus internal exact-canonical whole-document duplicate whose
 * contribution a shadow counterfactual (lib/corpus-duplicate-counterfactual.ts)
 * is entitled to hypothetically remove, purely to MEASURE what the unified
 * similarity percentage would be without it.
 *
 * IT ESTABLISHES NOTHING ELSE. A candidate is NOT:
 *   - SELF, or an effective same-Passport SELF,
 *   - the same owner, the same person, or the same account,
 *   - a claim of authorship, and
 *   - authorized / declared reuse.
 * The vocabulary here is deliberately its own — `originConfidence` /
 * `multiOriginEvidence` describe only what the current corpus/admission
 * schema can actually attest, and never more.
 *
 * PURE: no database, no environment reads, no I/O, no mutation, never throws.
 * It consumes already-computed deterministic evidence — production's own
 * persisted relationshipType / matchType, the report's authenticated state,
 * whether scoring already treats the match as an effective device SELF, and
 * the bounded backing-shape counts from lib/submission-provenance.ts's
 * summarizeSubmissionProvenance — and re-derives none of them.
 *
 * CURRENT-MODEL ONLY (see the Phase-B discovery): the current corpus model
 * gives an exact-canonical `TURNITPLUS_CORPUS_SOURCE` match EXACTLY ONE
 * visible admission backing — admission dedup collapses every later identical
 * upload into a non-backing REJECT decision, and the
 * corpus_admission_accepted_representations canonical-SHA partial-unique index
 * prevents a second visible backing. So this module CANNOT and DOES NOT emit
 * `PROVEN_SINGLE_LINEAGE`, and in Phase B1 it also never emits
 * `MULTI_ORIGIN_PROVEN`: it can only report that there is NO EVIDENCE of
 * multiple independent corpus origins, which is not the same thing as proof
 * of a single one. `PRIOR_SUBMISSION` is deliberately NOT a v1 candidate: the
 * submission-reference path is dormant in production and needs its own review
 * before it can ever qualify.
 */

export const CORPUS_DUPLICATE_SUPPRESSION_POLICY_VERSION = "document-local-corpus-duplicate-policy-v1" as const;

/** The one internal evidence label this policy attaches to a qualifying match. Never surfaced to an end user. */
export const DOCUMENT_LOCAL_CORPUS_DUPLICATE_EVIDENCE_LABEL = "DOCUMENT_LOCAL_CORPUS_DUPLICATE_CANDIDATE" as const;

/**
 * How confident the CURRENT schema lets us be about this representation's
 * corpus origin. Deliberately small — there is no `PROVEN_SINGLE_LINEAGE`
 * value, because the schema cannot prove one (see this module's own header).
 */
export type OriginConfidence =
  /** Exactly one active admission backing, zero submission-reference backings — the schema neither proves nor disproves other independent origins. The only value a Phase-B1 candidate ever carries. */
  | "SINGLE_BACKING_NO_MULTI_ORIGIN_EVIDENCE"
  /** The backing shape is not the one Phase B1 supports (≠1 admission backing, or any submission-reference backing). Not a candidate. */
  | "BACKING_SHAPE_UNSUPPORTED"
  /** The match failed an earlier gate (status / relationship / matchType / anonymity / already-excluded) — backing shape was not even inspected. */
  | "NOT_EVALUATED";

/**
 * What the schema lets us say about multiple independent corpus origins.
 * Phase B1 never emits `MULTI_ORIGIN_PROVEN` (see this module's own header) —
 * if a genuinely representable ≥2-independent-mature-backing shape is ever
 * discovered, that is a STOP-and-report finding, not something this module
 * invents grouping semantics for.
 */
export type MultiOriginEvidence =
  /** One visible backing; the schema shows no evidence of a second independent origin (but does not prove there isn't one). */
  | "MULTI_ORIGIN_NOT_PROVEN"
  /** Not applicable — the match is not a candidate, so the question was never reached. */
  | "N/A";

/** Bounded, non-identifying reason a match is / is not a candidate. Never user-facing; never ownership/SELF/authorship language. */
export type DocumentLocalCorpusDuplicateCategory =
  /** Qualifying: a counted cross-account exact-canonical whole-document duplicate against a single-backed promoted corpus source. */
  | "CROSS_ACCOUNT_EXACT_CANONICAL"
  /** production's persisted relationshipType is already SELF — scoring already excludes it; Phase B claims no additional suppression. */
  | "ALREADY_SELF"
  /** production's persisted relationshipType is UNKNOWN_RELATIONSHIP — scoring already excludes it. */
  | "ALREADY_UNKNOWN"
  /** scoring already treats this match as an effective same-Passport SELF (lib/device-self-scoring-rule.ts) — no double-count. */
  | "ALREADY_EFFECTIVE_DEVICE_SELF"
  /** the report is anonymous — no actor to reason about; conservatively not a candidate. */
  | "ANONYMOUS"
  /** historical match status is not MATCHED. */
  | "NOT_MATCHED"
  /** matchType is not EXACT_CANONICAL_MATCH (a STRONG_TEXT_MATCH / distinctive-passage match never qualifies in Phase B). */
  | "NOT_EXACT_CANONICAL"
  /** relationshipType is not TURNITPLUS_CORPUS_SOURCE (PRIOR_SUBMISSION is explicitly excluded from Phase B1). */
  | "NOT_CORPUS_SOURCE"
  /** the promoted backing shape is not exactly (1 admission backing, 0 submission-reference backings). */
  | "BACKING_SHAPE_UNSUPPORTED"
  /** a catch-all guard — should be unreachable given the gates above. */
  | "NOT_ELIGIBLE";

/**
 * Everything the pure classifier needs, all already computed by the caller
 * (lib/corpus-duplicate-counterfactual.ts's driver, or a future scheduler).
 * No representation id, account id, passport id, source_ref, or text.
 */
export type CorpusDuplicateCandidateEvidence = {
  /** production's historicalSubmissionMatch.status for this report. */
  historicalStatus: string | null | undefined;
  /** production's own persisted relationshipType for this matched representation — read, never re-derived. */
  relationshipType: string | null | undefined;
  /** production's own persisted matchType for this matched representation — read, never re-derived. */
  matchType: string | null | undefined;
  /** the report has a stable account (accountId !== null). */
  reportIsAuthenticated: boolean;
  /** scoring already classified this representation as an effective same-Passport SELF (its matchedRepresentationId is in resolvePrimarySimilaritySummary's effectiveDeviceSelfRepresentationIds). */
  isAlreadyEffectiveDeviceSelf: boolean;
  /** bounded backing-shape counts from lib/submission-provenance.ts's summarizeSubmissionProvenance — counts only, no ids. */
  backing: {
    admittedPromotionBackingCount: number;
    submissionReferenceBackingCount: number;
  };
};

export type CorpusDuplicateCandidateClassification = {
  policyVersion: typeof CORPUS_DUPLICATE_SUPPRESSION_POLICY_VERSION;
  evidenceLabel: typeof DOCUMENT_LOCAL_CORPUS_DUPLICATE_EVIDENCE_LABEL;
  isCandidate: boolean;
  category: DocumentLocalCorpusDuplicateCategory;
  originConfidence: OriginConfidence;
  multiOriginEvidence: MultiOriginEvidence;
  /** short machine-readable reason — bounded, never user-facing, never ownership/SELF/authorship/authorized-reuse wording. */
  reason: string;
};

const EXACT_CANONICAL_WHOLE_DOCUMENT_DUPLICATE = "EXACT_CANONICAL_MATCH";
const SUPPORTED_CORPUS_RELATIONSHIP = "TURNITPLUS_CORPUS_SOURCE";

function result(
  isCandidate: boolean,
  category: DocumentLocalCorpusDuplicateCategory,
  originConfidence: OriginConfidence,
  multiOriginEvidence: MultiOriginEvidence,
  reason: string,
): CorpusDuplicateCandidateClassification {
  return {
    policyVersion: CORPUS_DUPLICATE_SUPPRESSION_POLICY_VERSION,
    evidenceLabel: DOCUMENT_LOCAL_CORPUS_DUPLICATE_EVIDENCE_LABEL,
    isCandidate,
    category,
    originConfidence,
    multiOriginEvidence,
    reason,
  };
}

/**
 * The single decision. First failing gate wins; only a match that clears every
 * gate is a `DOCUMENT_LOCAL_CORPUS_DUPLICATE_CANDIDATE`.
 *
 * Gate order (each is a "scoring already handles this" or "not the shape we
 * measure" check, never an ownership judgement):
 *   1. historical status must be MATCHED
 *   2. report must be authenticated (an anonymous report has no actor to reason about)
 *   3. relationshipType must not already be SELF
 *   4. relationshipType must not already be UNKNOWN_RELATIONSHIP
 *   5. scoring must not already treat it as an effective same-Passport SELF
 *   6. relationshipType must be TURNITPLUS_CORPUS_SOURCE (PRIOR_SUBMISSION is out in v1)
 *   7. matchType must be EXACT_CANONICAL_MATCH (an exact canonical WHOLE-DOCUMENT duplicate)
 *   8. the promoted backing shape must be exactly (1 admission backing, 0 submission-reference backings)
 */
export function classifyDocumentLocalCorpusDuplicate(
  evidence: CorpusDuplicateCandidateEvidence,
): CorpusDuplicateCandidateClassification {
  if (evidence.historicalStatus !== "MATCHED") {
    return result(false, "NOT_MATCHED", "NOT_EVALUATED", "N/A", "historical match status is not MATCHED");
  }
  if (!evidence.reportIsAuthenticated) {
    return result(false, "ANONYMOUS", "NOT_EVALUATED", "N/A", "anonymous report — conservatively not a candidate");
  }
  if (evidence.relationshipType === "SELF") {
    return result(false, "ALREADY_SELF", "NOT_EVALUATED", "N/A", "relationshipType is already SELF — scoring already excludes it");
  }
  if (evidence.relationshipType === "UNKNOWN_RELATIONSHIP") {
    return result(false, "ALREADY_UNKNOWN", "NOT_EVALUATED", "N/A", "relationshipType is UNKNOWN_RELATIONSHIP — scoring already excludes it");
  }
  if (evidence.isAlreadyEffectiveDeviceSelf) {
    return result(false, "ALREADY_EFFECTIVE_DEVICE_SELF", "NOT_EVALUATED", "N/A", "scoring already treats this as an effective same-Passport SELF — no additional suppression");
  }
  if (evidence.relationshipType !== SUPPORTED_CORPUS_RELATIONSHIP) {
    return result(false, "NOT_CORPUS_SOURCE", "NOT_EVALUATED", "N/A", "relationshipType is not TURNITPLUS_CORPUS_SOURCE (PRIOR_SUBMISSION is excluded from Phase B1)");
  }
  // Belt-and-braces: TURNITPLUS_CORPUS_SOURCE is production-counted by
  // definition, but assert it via the shared classifier so this and the
  // scoring path can never disagree on what "counted" means.
  if (!productionCountsRelationship(evidence.relationshipType)) {
    return result(false, "NOT_ELIGIBLE", "NOT_EVALUATED", "N/A", "relationshipType is not production-counted");
  }
  if (evidence.matchType !== EXACT_CANONICAL_WHOLE_DOCUMENT_DUPLICATE) {
    return result(false, "NOT_EXACT_CANONICAL", "NOT_EVALUATED", "N/A", "matchType is not EXACT_CANONICAL_MATCH (exact canonical whole-document duplicate)");
  }

  const isSupportedBackingShape =
    evidence.backing.admittedPromotionBackingCount === 1 &&
    evidence.backing.submissionReferenceBackingCount === 0;
  if (!isSupportedBackingShape) {
    return result(
      false,
      "BACKING_SHAPE_UNSUPPORTED",
      "BACKING_SHAPE_UNSUPPORTED",
      "N/A",
      `backing shape not supported in Phase B1 (admittedPromotionBackingCount=${evidence.backing.admittedPromotionBackingCount}, submissionReferenceBackingCount=${evidence.backing.submissionReferenceBackingCount})`,
    );
  }

  return result(
    true,
    "CROSS_ACCOUNT_EXACT_CANONICAL",
    "SINGLE_BACKING_NO_MULTI_ORIGIN_EVIDENCE",
    "MULTI_ORIGIN_NOT_PROVEN",
    "counted cross-account exact-canonical whole-document duplicate of a single-backed promoted corpus source; no evidence of multiple independent corpus origins",
  );
}
