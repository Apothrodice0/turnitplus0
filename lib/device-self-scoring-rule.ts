/**
 * Device Passport — the ONE pure classifier for the same-device SELF rule,
 * shared VERBATIM by:
 *
 *   - lib/device-provenance-shadow.ts — the observational shadow telemetry
 *     (policy_version "device-provenance-shadow-v1"), and
 *   - lib/report-primary-similarity.ts — the PRODUCTION unified-similarity
 *     scoring path, gated on DEVICE_PASSPORT_SELF_ENABLED
 *     (lib/device-passport-server.ts's isDevicePassportSelfScoringEnabled).
 *
 * Extracted from the shadow's own original inline `wouldDowngrade` expression
 * so the observed telemetry and the scored decision are computed by the SAME
 * code and can never drift.
 *
 * PURE: no database, no environment reads, no I/O, never throws. It consumes
 * already-computed deterministic provenance evidence — production's own
 * persisted relationshipType / matchType plus the bounded backing facts from
 * lib/submission-provenance.ts's summarizeSubmissionProvenance — and never
 * re-derives any of them. It NEVER reads historical_match_shadow_evaluations:
 * the shadow table is observational and written AFTER the response, so
 * production scoring must reason from the underlying evidence directly.
 *
 * It carries NO passport id, account id, email, device identifier, IP, or any
 * secret — only bounded booleans, counts, and short enums.
 */

/** The single reason string the rule produces when it fires. */
export const DEVICE_SELF_SCORING_REASON = "SAME_DEVICE_EXACT_DOCUMENT" as const;

/**
 * Relationships whose matched words production actually COUNTS toward the
 * unified similarity score. lib/unified-similarity.ts's computeUnifiedSimilarity
 * already excludes SELF and UNKNOWN_RELATIONSHIP unconditionally, so only
 * PRIOR_SUBMISSION and TURNITPLUS_CORPUS_SOURCE are ever candidates for this
 * downgrade.
 */
export function productionCountsRelationship(relationship: string | null | undefined): boolean {
  return relationship === "PRIOR_SUBMISSION" || relationship === "TURNITPLUS_CORPUS_SOURCE";
}

export type DeviceSelfMatchEvidence = {
  /** production's own persisted relationshipType for this matched representation — read, never re-derived. */
  relationshipType: string | null | undefined;
  /** production's own persisted matchType for this matched representation. */
  matchType: string | null | undefined;
  /**
   * lib/submission-provenance.ts: ≥1 active/admitted backing of this matched
   * representation is linked to the report's OWN immutable verified upload
   * Device Passport. Requires the report to actually have a verified passport
   * (the caller passes reportVerifiedDevicePassportId into
   * summarizeSubmissionProvenance) — this can never be true without one.
   */
  sameVerifiedDeviceBacking: boolean;
  /**
   * lib/submission-provenance.ts: backings that positively evidence a DISTINCT
   * actor from the report's uploader — a different account's submission
   * reference, a different verified device's admission, or a no-device
   * admission not carrying the report's own account prefix
   * (INDEPENDENT_BACKING_DEFINITION). Any independent backing blocks the rule.
   */
  independentBackingCount: number;
};

export type DeviceSelfMatchClassification = {
  productionCountsRelationship: boolean;
  exactCanonicalMatch: boolean;
  sameVerifiedDeviceBacking: boolean;
  independentBackingCount: number;
  hasNoIndependentBacking: boolean;
  /**
   * TRUE iff ALL of these hold for this ONE historical source:
   *   1. a production-counted relationship (PRIOR_SUBMISSION / TURNITPLUS_CORPUS_SOURCE),
   *   2. an exact canonical document match,
   *   3. a backing from the report's own verified Device Passport, and
   *   4. ZERO independent backing.
   * The report having a verified passport (condition from the task) is
   * enforced upstream: sameVerifiedDeviceBacking cannot be true otherwise.
   * Deliberately conservative — ANY independent backing blocks it.
   */
  isEffectiveDeviceSelf: boolean;
  /** DEVICE_SELF_SCORING_REASON when isEffectiveDeviceSelf, else "NOT_DEVICE_SELF". */
  reason: typeof DEVICE_SELF_SCORING_REASON | "NOT_DEVICE_SELF";
};

/**
 * The single decision. Same four-condition test the device-provenance shadow
 * has always used for its `wouldDowngrade` signal — now the one place it
 * lives.
 */
export function classifyDeviceSelfMatch(evidence: DeviceSelfMatchEvidence): DeviceSelfMatchClassification {
  const countsRelationship = productionCountsRelationship(evidence.relationshipType ?? null);
  const exactCanonicalMatch = evidence.matchType === "EXACT_CANONICAL_MATCH";
  const sameVerifiedDeviceBacking = evidence.sameVerifiedDeviceBacking === true;
  const hasNoIndependentBacking = evidence.independentBackingCount === 0;
  const isEffectiveDeviceSelf =
    countsRelationship && exactCanonicalMatch && sameVerifiedDeviceBacking && hasNoIndependentBacking;
  return {
    productionCountsRelationship: countsRelationship,
    exactCanonicalMatch,
    sameVerifiedDeviceBacking,
    independentBackingCount: evidence.independentBackingCount,
    hasNoIndependentBacking,
    isEffectiveDeviceSelf,
    reason: isEffectiveDeviceSelf ? DEVICE_SELF_SCORING_REASON : "NOT_DEVICE_SELF",
  };
}
