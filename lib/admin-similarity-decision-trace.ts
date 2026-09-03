import type { ExternalAcademicEvidence } from "./academic-search/types";
import type {
  HistoricalSubmissionMatchEntry,
  ReportHistoricalSubmissionMatch,
} from "./report-types";
import type { UnifiedEvidenceContribution, UnifiedSimilarityResult } from "./unified-similarity";
import type { ConservativeSharedGuardReason } from "./device-shared-guard-policy";

/**
 * ADMIN-ONLY internal explanation of WHY a report's final TurnitPlus
 * Similarity score is the number it is.
 *
 * This module is PURE, synchronous, deterministic, and never throws. It
 * implements NO matcher and recomputes NO similarity — it CONSUMES the
 * already-finalized production results (lib/unified-similarity.ts's
 * computeUnifiedSimilarity output, persisted as payload.unifiedSimilarity,
 * plus the historical-match snapshot and the device-provenance shadow row)
 * and re-derives, position by position, how those inputs produce the
 * headline percentage. Its only job is explanation.
 *
 * Ground truth for every word figure is unifiedSimilarity.matchedPositions —
 * the ONE canonical, deduplicated union of every submitted word position that
 * contributed to unifiedScore (see that field's own comment in
 * lib/unified-similarity.ts). This builder never sums per-source percentages
 * and never invents a position; a source's per-source figure can exceed its
 * counted contribution precisely because the same submitted word found by
 * multiple sources is only counted once.
 *
 * The whole trace is intended for the authenticated developer/admin surface
 * only (app/developer/reports/[id]). It carries internal ids
 * (representation ids, academic identity keys) and, where the admin-gated
 * caller resolves them, backing-account emails — but never any device-passport
 * secret: no identifier, no key material, no attestation, no challenge or
 * session value (the device-provenance shadow row this consumes has no such
 * columns to begin with, and this module never reads a passport table).
 */

export const ADMIN_SIMILARITY_DECISION_TRACE_SCHEMA_VERSION =
  "admin-similarity-decision-trace-v1";

// ---------------------------------------------------------------------------
// enums
// ---------------------------------------------------------------------------

export type DecisionTraceSourceKind = "ARCHIVE" | "SCHOLARLY" | "PREVIOUS_SUBMISSION";

export type DecisionTraceRelationship =
  | "N/A"
  | "SELF"
  | "PRIOR_SUBMISSION"
  | "UNKNOWN_RELATIONSHIP"
  | "TURNITPLUS_CORPUS_SOURCE";

export type DecisionTraceMatchType = "N/A" | "EXACT_CANONICAL_MATCH" | "STRONG_TEXT_MATCH";

/** Why a source's matched words WERE counted toward the final union. */
export type DecisionTraceCountedReason =
  | "COUNTED_ARCHIVE_SOURCE"
  | "COUNTED_SCHOLARLY_SOURCE"
  | "COUNTED_PRIOR_SUBMISSION"
  | "COUNTED_CORPUS_SOURCE";

/** Why a source's matched words were NOT counted toward the final union. */
export type DecisionTraceExclusionReason =
  | "EXCLUDED_SELF"
  /**
   * The Preview-gated same-device SELF rule (flag DEVICE_PASSPORT_SELF_ENABLED)
   * treated this production-counted source as an EFFECTIVE SELF for scoring —
   * its BASELINE relationship (see relationshipType) is unchanged; see
   * effectiveScoringRelationship / effectiveScoringReason on the source.
   */
  | "EXCLUDED_EFFECTIVE_DEVICE_SELF"
  | "EXCLUDED_UNKNOWN_RELATIONSHIP"
  | "EXCLUDED_DUPLICATE_WORD_POSITIONS"
  | "NO_VERIFIED_CORRESPONDENCE";

export type DecisionTraceZeroReason =
  | "SUBMISSION_EMPTY"
  | "NO_MATCHES_FOUND"
  | "MATCHES_PRESENT_BUT_ALL_EXCLUDED"
  | "VERIFIED_MATCHES_CONTRIBUTE_ZERO_NEW_POSITIONS";

// ---------------------------------------------------------------------------
// per-source admin evidence (resolved by the admin-gated caller, passed
// through this builder verbatim — never resolved here)
// ---------------------------------------------------------------------------

export type DecisionTraceBackingAccount = {
  channel: "SUBMISSION_REFERENCE" | "ADMISSION_PROMOTION";
  relationshipToReportAccount: "SAME_ACCOUNT" | "OTHER_ACCOUNT" | "ANONYMOUS" | "UNKNOWN";
  /** ADMIN-ONLY. Resolved only in the authenticated developer/admin data layer. */
  accountEmail: string | null;
  accountUsername: string | null;
  documentIdentityId: string | null;
  admissionDecisionId: string | null;
  /** Parsed from an admission decision's own source_ref (report=…) when present — useful for admin debugging. */
  sourceReportId: string | null;
};

export type DecisionTraceAccountEvidence = {
  /** From lib/user-submission-corpus.ts's summarizeSubmissionOwnership — bounded booleans/counts only. */
  hasSameAccountSubmission: boolean;
  otherAccountSubmissionCount: number;
  sameAccountBackingCount: number;
  otherAccountBackingCount: number;
  anonymousBackingCount: number;
  /** Bounded, capped list — ADMIN-ONLY backing identity, resolved through the backing/provenance tables, never stored on corpus_document_representations. */
  backings: DecisionTraceBackingAccount[];
  backingListTruncated: boolean;
};

export type DecisionTraceDeviceEvidence = {
  /** From lib/submission-provenance.ts's summarizeSubmissionProvenance — every field a bounded boolean or count, no passport id. */
  sameVerifiedDeviceBacking: boolean;
  sameDeviceBackingCount: number;
  independentBackingCount: number;
  backingsWithoutDeviceProvenance: number;
  admittedBackingsDifferentDevice: number;
  admittedBackingsNoDeviceProvenance: number;
  admittedPromotionBackingCount: number;
  submissionReferenceBackingCount: number;
  identitySameAccount: boolean;
  priorSameAccountIdentityCount: number;
};

/** Supplementary per-representation facts from the cached historical-match snapshot (matchType/containment etc.), keyed by matchedRepresentationId. */
export type DecisionTraceHistoricalMatchFacts = {
  matchType: HistoricalSubmissionMatchEntry["matchType"];
  containment: number;
  passageCount: number;
  longestMatchWords: number;
  historicalSubmissionCount: number;
  /** production's own reported matched-word count for this representation (matcher output, not position-derived). */
  matchedWordCount: number;
};

// ---------------------------------------------------------------------------
// device-provenance shadow (Phase 4 telemetry — observation only)
// ---------------------------------------------------------------------------

export type DecisionTraceDeviceShadowInput = {
  policyVersion: string;
  computedAt: string;
  status: "OK" | "FAILED";
  productionStatus: string;
  productionRelationship: string | null;
  proposedRelationship: string | null;
  agreement: string;
  /** The parsed proposed_evidence JSON blob (already bounded — counts/enums/booleans only). */
  evidence: Record<string, unknown>;
};

export type DecisionTraceDeviceShadow = {
  present: true;
  policyVersion: string;
  computedAt: string;
  status: "OK" | "FAILED";
  /** "Verified upload passport: YES/NO" */
  verifiedUploadPassport: boolean;
  productionStatus: string;
  productionRelationship: string | null;
  proposedRelationship: string | null;
  agreement: string;
  wouldDowngrade: boolean;
  deviceSelfCandidateCount: number;
  exactSameDeviceMatchCount: number;
  independentBlockedCandidateCount: number;
  matchesEvaluated: number;
  deviceDistinctAccounts: number;
  deviceSubmissionCount: number;
  deviceAnonUploads: number;
  deviceSharedAcrossAccounts: boolean;
  /** evidence.reason — e.g. "SAME_DEVICE_EXACT_DOCUMENT" | "SAME_DEVICE_STRONG_TEXT_DOCUMENT" | "NO_DEVICE_DOWNGRADE" | "NO_MATCH_TO_EVALUATE". */
  reason: string | null;
  /** evidence.candidateReason for the strongest candidate — e.g. "SAME_DEVICE_EXACT_DOCUMENT" | "SAME_DEVICE_STRONG_TEXT_DOCUMENT". */
  candidateReason: string | null;
  /** The shadow's proposal for the historical relationship: "SELF" only when wouldDowngrade. */
  shadowProposal: "SELF" | "NONE";
  /** Human display line requested by the admin trace spec — always literally false here (Phase 4 is observation only). */
  productionScoreChangedByShadow: false;
};

// ---------------------------------------------------------------------------
// Phase B2 corpus-duplicate suppression shadow (measurement only)
// ---------------------------------------------------------------------------

/**
 * One corpus_duplicate_suppression_shadow_evaluations row (drizzle/0044), read
 * by the admin-gated data layer and passed through this builder verbatim.
 * Every field is already a bounded count / enum / integer score / timestamp /
 * version string — drizzle/0044 has, by construction, no account id, email,
 * device-passport id, HMAC, source_ref, canonical hash, representation id,
 * provenance id, or document / passage text column to begin with.
 */
export type DecisionTraceCorpusDuplicateShadowInput = {
  policyVersion: string;
  /** 'OK' | 'BOUNDED' | 'FAILED' | 'SKIPPED_NOT_MATCHED' | 'SKIPPED_NO_AUTHORITATIVE'. */
  status: string;
  computedAt: string;
  /** NULL unless status = 'FAILED'. */
  errorCode: string | null;
  authoritativeScore: number | null;
  hypotheticalScore: number | null;
  scoreDelta: number | null;
  candidateCount: number | null;
  measurementCategory: string | null;
  originConfidence: string | null;
  multiOriginEvidence: string | null;
  archiveOnlyWordsSurviving: number | null;
  liveAcademicOnlyWordsSurviving: number | null;
  previousUploadOnlyWordsSurviving: number | null;
  overlapWordsSurviving: number | null;
  authoritativeUniqueMatchedWords: number | null;
  hypotheticalUniqueMatchedWords: number | null;
  uniqueMatchedWordsRemoved: number | null;
  candidateMatchedWords: number | null;
  candidatesExcluded: number | null;
  checkerAccountsStatus: string;
  distinctCheckerAccountsBucket: string | null;
  authoritativeCorpusGeneration: number | null;
  authoritativeSnapshotComputedAt: string | null;
  evaluationTruncated: boolean;
};

export type DecisionTraceCorpusDuplicateShadow = {
  present: true;
  policyVersion: string;
  status: string;
  computedAt: string;
  errorCode: string | null;
  /** NULL where a real counterfactual measurement was never computed (FAILED / SKIPPED_*). Never rendered as 0. */
  authoritativeScore: number | null;
  hypotheticalScore: number | null;
  scoreDelta: number | null;
  candidateCount: number | null;
  measurementCategory: string | null;
  originConfidence: string | null;
  multiOriginEvidence: string | null;
  archiveOnlyWordsSurviving: number | null;
  liveAcademicOnlyWordsSurviving: number | null;
  previousUploadOnlyWordsSurviving: number | null;
  overlapWordsSurviving: number | null;
  authoritativeUniqueMatchedWords: number | null;
  hypotheticalUniqueMatchedWords: number | null;
  uniqueMatchedWordsRemoved: number | null;
  candidateMatchedWords: number | null;
  candidatesExcluded: number | null;
  checkerAccountsStatus: string;
  distinctCheckerAccountsBucket: string | null;
  authoritativeCorpusGeneration: number | null;
  authoritativeSnapshotComputedAt: string | null;
  evaluationTruncated: boolean;
  /** Literal — Phase B is shadow MEASUREMENT only; the authoritative score is never changed by this evaluation. */
  productionScoreChangedByShadow: false;
};

function projectCorpusDuplicateShadow(
  input: DecisionTraceCorpusDuplicateShadowInput,
): DecisionTraceCorpusDuplicateShadow {
  const intOrNull = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const strOrNull = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;
  return {
    present: true,
    policyVersion: input.policyVersion,
    status: input.status,
    computedAt: input.computedAt,
    errorCode: strOrNull(input.errorCode),
    authoritativeScore: intOrNull(input.authoritativeScore),
    hypotheticalScore: intOrNull(input.hypotheticalScore),
    scoreDelta: intOrNull(input.scoreDelta),
    candidateCount: intOrNull(input.candidateCount),
    measurementCategory: strOrNull(input.measurementCategory),
    originConfidence: strOrNull(input.originConfidence),
    multiOriginEvidence: strOrNull(input.multiOriginEvidence),
    archiveOnlyWordsSurviving: intOrNull(input.archiveOnlyWordsSurviving),
    liveAcademicOnlyWordsSurviving: intOrNull(input.liveAcademicOnlyWordsSurviving),
    previousUploadOnlyWordsSurviving: intOrNull(input.previousUploadOnlyWordsSurviving),
    overlapWordsSurviving: intOrNull(input.overlapWordsSurviving),
    authoritativeUniqueMatchedWords: intOrNull(input.authoritativeUniqueMatchedWords),
    hypotheticalUniqueMatchedWords: intOrNull(input.hypotheticalUniqueMatchedWords),
    uniqueMatchedWordsRemoved: intOrNull(input.uniqueMatchedWordsRemoved),
    candidateMatchedWords: intOrNull(input.candidateMatchedWords),
    candidatesExcluded: intOrNull(input.candidatesExcluded),
    checkerAccountsStatus: input.checkerAccountsStatus,
    distinctCheckerAccountsBucket: strOrNull(input.distinctCheckerAccountsBucket),
    authoritativeCorpusGeneration: intOrNull(input.authoritativeCorpusGeneration),
    authoritativeSnapshotComputedAt: strOrNull(input.authoritativeSnapshotComputedAt),
    evaluationTruncated: input.evaluationTruncated === true,
    productionScoreChangedByShadow: false,
  };
}

// ---------------------------------------------------------------------------
// refined CONSERVATIVE_COMBINED (Policy D) shared-device SCORING guard
// (optional gate layered on the Device Passport SELF rule — bounded, no identity)
// ---------------------------------------------------------------------------

/** What lib/report-primary-similarity.ts's resolvePrimarySimilaritySummary hands the admin trace (a DeviceSelfSharedGuardResult). */
export type DecisionTraceDeviceSelfSharedGuardInput = {
  enabled: boolean;
  passed: boolean;
  reason: ConservativeSharedGuardReason;
  /** The report's own Passport's durable actor-usage completeness — a boolean, never the version number. */
  durableActorHistoryComplete: boolean | null;
  deviceDistinctAccounts: number | null;
  deviceAnonUploads: number | null;
  unorderedDeviceAccountPairCount: number | null;
  pairOtherVerifiedPassportCount: number | null;
};

export type DecisionTraceDeviceSelfSharedGuard = {
  /** Whether DEVICE_PASSPORT_CONSERVATIVE_SHARED_GUARD_ENABLED was on when this resolution ran. */
  sharedGuardEnabled: boolean;
  /**
   * The refined Policy D verdict over the durable shared-device fan-out facts,
   * surfaced for ADMIN TELEMETRY:
   *   true  => the fan-out facts satisfy a Policy D branch (or the guard was
   *            off, or a same-account-only candidate the guard never acts on).
   *   false => a conservative / blocked verdict (account fan-out, anonymous
   *            use, multiple pairs, incomplete actor history, or insufficient
   *            evidence).
   * This verdict does NOT change the score — an accepted Device Passport SELF
   * is kept regardless. It measures shared-device risk; it is not a veto.
   */
  sharedGuardPassed: boolean;
  sharedGuardReason: ConservativeSharedGuardReason;
  /**
   * The report's own verified Passport's durable actor-usage completeness — a
   * BOOLEAN only, NEVER the tracking-version number:
   *   true  => tracked since birth (actor_usage_tracking_version >= 1).
   *   false => the Passport exists but its actor history is incomplete (version 0).
   *   null  => not evaluated / unavailable.
   * No Passport id, account id, or actor key accompanies it.
   */
  durableActorHistoryComplete: boolean | null;
  /** The four bounded facts the refined Policy D decided over — no Passport id, no account id, no key. */
  deviceDistinctAccounts: number | null;
  deviceAnonUploads: number | null;
  unorderedDeviceAccountPairCount: number | null;
  pairOtherVerifiedPassportCount: number | null;
};

const SHARED_GUARD_REASONS: readonly ConservativeSharedGuardReason[] = [
  "PAIR_OTHER_PASSPORT",
  "LOW_RISK_SINGLE_PAIR",
  "BLOCKED_ACCOUNT_FANOUT",
  "BLOCKED_ANONYMOUS_USE",
  "BLOCKED_MULTIPLE_PAIRS",
  "BLOCKED_INCOMPLETE_ACTOR_HISTORY",
  "BLOCKED_INSUFFICIENT_EVIDENCE",
  "NOT_APPLIED",
];

function projectDeviceSelfSharedGuard(
  input: DecisionTraceDeviceSelfSharedGuardInput,
): DecisionTraceDeviceSelfSharedGuard {
  const intOrNull = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const boolOrNull = (value: unknown): boolean | null =>
    value === true ? true : value === false ? false : null;
  return {
    sharedGuardEnabled: input.enabled === true,
    sharedGuardPassed: input.passed === true,
    sharedGuardReason: SHARED_GUARD_REASONS.includes(input.reason) ? input.reason : "NOT_APPLIED",
    durableActorHistoryComplete: boolOrNull(input.durableActorHistoryComplete),
    deviceDistinctAccounts: intOrNull(input.deviceDistinctAccounts),
    deviceAnonUploads: intOrNull(input.deviceAnonUploads),
    unorderedDeviceAccountPairCount: intOrNull(input.unorderedDeviceAccountPairCount),
    pairOtherVerifiedPassportCount: intOrNull(input.pairOtherVerifiedPassportCount),
  };
}

// ---------------------------------------------------------------------------
// output shape
// ---------------------------------------------------------------------------

export type DecisionTraceSource = {
  sourceKey: string;
  sourceKind: DecisionTraceSourceKind;
  label: string;
  /** ADMIN-ONLY internal identity — representation id / academic identity key. null for the blended archive channel. */
  sourceId: string | null;
  /**
   * The BASELINE relationship production's matcher persisted for this source —
   * never rewritten. When the Preview-gated same-device SELF rule downgrades a
   * source, this still reads e.g. "TURNITPLUS_CORPUS_SOURCE" while
   * effectiveScoringRelationship reads "SELF".
   */
  relationshipType: DecisionTraceRelationship;
  /**
   * The relationship actually applied to this source BEFORE the scored
   * matched-position union. Equals relationshipType unless the Preview-gated
   * same-device SELF rule downgraded it, in which case this is "SELF".
   */
  effectiveScoringRelationship: DecisionTraceRelationship;
  /**
   * Why effectiveScoringRelationship differs from relationshipType:
   * "SAME_DEVICE_EXACT_DOCUMENT" for a byte-identical re-upload,
   * "SAME_DEVICE_STRONG_TEXT_DOCUMENT" for a near-identical one. null when they
   * are identical (no downgrade was applied).
   */
  effectiveScoringReason: "SAME_DEVICE_EXACT_DOCUMENT" | "SAME_DEVICE_STRONG_TEXT_DOCUMENT" | null;
  matchType: DecisionTraceMatchType;
  containment: number | null;
  historicalSubmissionCount: number | null;
  /** production's own reported matched-word count (matcher output). null when not available (archive channel / no snapshot). */
  productionReportedMatchedWordCount: number | null;
  /** Position-derived: this source's own clamped matched-position footprint, before any cross-source dedup. */
  rawMatchedWordCount: number;
  /** How many of this source's matched positions are in the final included union (rawMatchedWordCount minus positions clamped out or excluded). */
  countedWordCount: number;
  /** Positions this source is the FIRST counted source to contribute (union accumulation order = unionAccumulationOrder). */
  newUniqueWordContribution: number;
  /** countedWordCount minus newUniqueWordContribution — positions already contributed by an earlier counted source. */
  overlappingWordCount: number;
  countedTowardScore: boolean;
  countedReason: DecisionTraceCountedReason | null;
  exclusionReason: DecisionTraceExclusionReason | null;
  /** Set when the source's relationship IS eligible but every one of its positions was already counted by an earlier source. */
  contributionNote: "ALL_POSITIONS_ALREADY_COUNTED" | null;
  accountEvidence: DecisionTraceAccountEvidence | null;
  deviceEvidence: DecisionTraceDeviceEvidence | null;
};

export type DecisionTraceZeroExplanation = {
  reason: DecisionTraceZeroReason;
  detail: string;
  excludedSelfSourceCount: number;
  /** Sources the Preview-gated same-device SELF rule downgraded to an effective SELF. */
  excludedEffectiveDeviceSelfSourceCount: number;
  excludedUnknownSourceCount: number;
  /** Candidate-rejection detail does not survive production matching into the persisted result — see the admin trace spec §7. */
  candidateRejectionDetailAvailable: false;
};

export type DecisionTraceFullCoverageExplanation = {
  reason: "INCLUDED_UNION_COVERS_EVERY_SUBMITTED_WORD";
  submittedWordCount: number;
  includedUnionWordCount: number;
  /** sourceKeys that contributed at least one new unique word position. */
  drivingSources: string[];
};

export type AdminSimilarityDecisionTrace = {
  schemaVersion: typeof ADMIN_SIMILARITY_DECISION_TRACE_SCHEMA_VERSION;

  /** false when there is no finalized unified-similarity result to explain (legacy/failed report). */
  resolvable: boolean;
  unresolvableReason:
    | "UNIFIED_SIMILARITY_NOT_PERSISTED"
    | "HISTORICAL_MATCH_UNAVAILABLE"
    | null;

  finalScore: number;
  finalScoreBasis: "UNIFIED" | "ARCHIVE_ONLY_FALLBACK";
  submittedWordCount: number;

  includedMatchedWordCount: number;
  finalIncludedUnionWordCount: number;
  excludedSelfMatchedWordCount: number;
  /**
   * Matched words excluded because the Preview-gated same-device SELF rule
   * (flag DEVICE_PASSPORT_SELF_ENABLED) downgraded a production-counted
   * historical source to an EFFECTIVE SELF for scoring — 0 in every
   * configuration where that flag is off. Reported separately from
   * excludedSelfMatchedWordCount so genuine same-account SELF totals are
   * unchanged.
   */
  excludedEffectiveDeviceSelfMatchedWordCount: number;
  excludedUnknownMatchedWordCount: number;

  archiveOnlyWordCount: number;
  scholarlyOnlyWordCount: number;
  priorSubmissionOnlyWordCount: number;
  multiSourceOverlapWordCount: number;

  /** How the final percentage is derived: round(finalIncludedUnionWordCount / max(1, submittedWordCount) * 100), capped at 100. */
  scoreDerivation: {
    numerator: number;
    denominator: number;
    rawPercent: number;
    roundedPercent: number;
    cappedAt100: boolean;
  };

  /** The order counted sources were accumulated into the union — newUniqueWordContribution is relative to this order. */
  unionAccumulationOrder: string[];
  /** Positions in the final union not attributable to any reconstructed source (should be 0 — non-zero only when archiveMatchedPositions was unavailable). */
  unattributedUnionWordCount: number;

  sources: DecisionTraceSource[];

  zeroScoreExplanation: DecisionTraceZeroExplanation | null;
  fullCoverageExplanation: DecisionTraceFullCoverageExplanation | null;

  deviceShadow: DecisionTraceDeviceShadow | null;

  /** Literal — Phase 4 device-provenance is shadow telemetry only. */
  scoreUnchangedByDeviceShadow: true;

  /**
   * The Phase B2 corpus-duplicate suppression shadow row for this report
   * (corpus_duplicate_suppression_shadow_evaluations, drizzle/0044), when one
   * exists — bounded counts / enums / integer scores only, no identifier.
   * `null` when the deferred evaluator has not written a row yet. Every score
   * field is `null` (NOT 0) where a real counterfactual measurement was never
   * computed (status FAILED / SKIPPED_*).
   */
  corpusDuplicateSuppressionShadow: DecisionTraceCorpusDuplicateShadow | null;

  /** Literal — Phase B2 corpus-duplicate suppression is shadow MEASUREMENT only. */
  scoreUnchangedByCorpusDuplicateShadow: true;

  /**
   * The refined CONSERVATIVE_COMBINED (Policy D) shared-device fan-out
   * TELEMETRY verdict for this resolution — bounded counts + one short enum +
   * one boolean (durableActorHistoryComplete), no identity. `null` whenever
   * DEVICE_PASSPORT_SELF_ENABLED is off (the guard is never consulted). When
   * present, `sharedGuardEnabled` is
   * DEVICE_PASSPORT_CONSERVATIVE_SHARED_GUARD_ENABLED and `sharedGuardPassed`
   * records the Policy D verdict — it no longer affects the score (an accepted
   * Device Passport SELF is kept regardless).
   */
  deviceSelfSharedGuard: DecisionTraceDeviceSelfSharedGuard | null;
};

// ---------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------

export type BuildAdminSimilarityDecisionTraceInput = {
  /** The archive-only fallback value (report.archiveScore ?? report.score). */
  archiveScore: number;
  /** payload.unifiedSimilarity — the finalized result to explain. Absent/null => resolvable:false. */
  unifiedSimilarity: UnifiedSimilarityResult | null | undefined;
  /** payload.archiveMatchedPositions — needed to attribute the archive channel's positions. */
  archiveMatchedPositions?: number[] | null;
  /** payload.externalAcademicEvidence — used only for nicer scholarly-source labels. */
  externalAcademicEvidence?: ExternalAcademicEvidence[] | null;
  /** The cached historical-match snapshot, when readable — status "UNAVAILABLE" is tolerated. Used for matchType/containment enrichment only. */
  historicalSubmissionMatch?: ReportHistoricalSubmissionMatch | null;
  /** repId -> supplementary facts from the snapshot (redundant with historicalSubmissionMatch; either may be supplied). */
  historicalMatchFacts?: Record<string, DecisionTraceHistoricalMatchFacts>;
  /** repId -> ADMIN-resolved account evidence. */
  accountEvidenceByRepresentation?: Record<string, DecisionTraceAccountEvidence>;
  /** repId -> ADMIN-resolved device/backing evidence. */
  deviceEvidenceByRepresentation?: Record<string, DecisionTraceDeviceEvidence>;
  /** The device-provenance shadow row (parsed), when one exists. */
  deviceShadow?: DecisionTraceDeviceShadowInput | null;
  /** The Phase B2 corpus-duplicate suppression shadow row (parsed), when one exists. Absent/null => the deferred evaluator has not written a row for this report. */
  corpusDuplicateSuppressionShadow?: DecisionTraceCorpusDuplicateShadowInput | null;
  /** Whether the report was uploaded with a verified device passport — read as a plain boolean by the admin data layer, never the identifier itself. */
  hasVerifiedUploadPassport?: boolean;
  /**
   * The refined CONSERVATIVE_COMBINED shared-device guard decision from
   * lib/report-primary-similarity.ts's resolvePrimarySimilaritySummary
   * (resolution.deviceSelfSharedGuard). Absent/null => DEVICE_PASSPORT_SELF_ENABLED
   * was off (the guard was never consulted).
   */
  deviceSelfSharedGuard?: DecisionTraceDeviceSelfSharedGuardInput | null;
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function academicIdentityKey(evidence: {
  doi: string | null;
  url: string | null;
  provider: string;
  providerId: string;
}): string {
  if (evidence.doi) return `doi:${evidence.doi.trim().toLowerCase()}`;
  if (evidence.url) return `url:${evidence.url.trim().toLowerCase()}`;
  return `provider:${evidence.provider}:${evidence.providerId}`;
}

function clampInclusiveRange(
  start: number,
  end: number,
  wordCount: number,
): [number, number] | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return null;
  const clampedStart = Math.max(0, start);
  const clampedEnd = Math.min(wordCount - 1, end);
  if (clampedEnd < clampedStart || wordCount <= 0) return null;
  return [clampedStart, clampedEnd];
}

function addInclusive(target: Set<number>, start: number, end: number): void {
  for (let position = start; position <= end; position += 1) target.add(position);
}

const num = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const bool = (value: unknown): boolean => value === true;
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

// ---------------------------------------------------------------------------
// device shadow projection
// ---------------------------------------------------------------------------

function projectDeviceShadow(
  input: DecisionTraceDeviceShadowInput,
  hasVerifiedUploadPassport: boolean,
): DecisionTraceDeviceShadow {
  const evidence = input.evidence ?? {};
  const wouldDowngrade = bool(evidence.wouldDowngrade);
  return {
    present: true,
    policyVersion: input.policyVersion,
    computedAt: input.computedAt,
    status: input.status,
    // hasReportPassport is only ever `true` on a real evidence blob (the
    // shadow never writes a row without one) — fall back to the report's own
    // "was a verified device passport used for upload" boolean for the
    // FAILED / degenerate case.
    verifiedUploadPassport: bool(evidence.hasReportPassport) || hasVerifiedUploadPassport,
    productionStatus: input.productionStatus,
    productionRelationship: input.productionRelationship,
    proposedRelationship: input.proposedRelationship,
    agreement: input.agreement,
    wouldDowngrade,
    deviceSelfCandidateCount: num(evidence.deviceSelfCandidateCount),
    exactSameDeviceMatchCount: num(evidence.exactSameDeviceMatchCount),
    independentBlockedCandidateCount: num(evidence.independentBlockedCandidateCount),
    matchesEvaluated: num(evidence.matchesEvaluated),
    deviceDistinctAccounts: num(evidence.deviceDistinctAccounts),
    deviceSubmissionCount: num(evidence.deviceSubmissionCount),
    deviceAnonUploads: num(evidence.deviceAnonUploads),
    deviceSharedAcrossAccounts: bool(evidence.deviceSharedAcrossAccounts),
    reason: str(evidence.reason),
    candidateReason: str(evidence.candidateReason),
    shadowProposal: wouldDowngrade ? "SELF" : "NONE",
    productionScoreChangedByShadow: false,
  };
}

// ---------------------------------------------------------------------------
// builder
// ---------------------------------------------------------------------------

type ReconstructedSource = {
  sourceKey: string;
  sourceKind: DecisionTraceSourceKind;
  label: string;
  sourceId: string | null;
  relationshipType: DecisionTraceRelationship;
  /** "SELF" when the Preview-gated same-device rule downgraded this source; else equal to relationshipType. */
  effectiveScoringRelationship: DecisionTraceRelationship;
  effectiveScoringReason: "SAME_DEVICE_EXACT_DOCUMENT" | "SAME_DEVICE_STRONG_TEXT_DOCUMENT" | null;
  /** the source's own clamped matched-position footprint. */
  positions: Set<number>;
  /** "included" | "excluded_self" | "excluded_unknown" | "excluded_effective_device_self" — from contributions[].evidenceStatus (archive always "included"). */
  evidenceStatus: UnifiedEvidenceContribution["evidenceStatus"];
};

function emptyTrace(
  input: BuildAdminSimilarityDecisionTraceInput,
  unresolvableReason: AdminSimilarityDecisionTrace["unresolvableReason"],
): AdminSimilarityDecisionTrace {
  const deviceShadow = input.deviceShadow
    ? projectDeviceShadow(input.deviceShadow, Boolean(input.hasVerifiedUploadPassport))
    : null;
  const deviceSelfSharedGuard = input.deviceSelfSharedGuard
    ? projectDeviceSelfSharedGuard(input.deviceSelfSharedGuard)
    : null;
  const corpusDuplicateSuppressionShadow = input.corpusDuplicateSuppressionShadow
    ? projectCorpusDuplicateShadow(input.corpusDuplicateSuppressionShadow)
    : null;
  return {
    schemaVersion: ADMIN_SIMILARITY_DECISION_TRACE_SCHEMA_VERSION,
    resolvable: false,
    unresolvableReason,
    finalScore: Math.max(0, Math.min(100, Math.round(num(input.archiveScore)))),
    finalScoreBasis: "ARCHIVE_ONLY_FALLBACK",
    submittedWordCount: 0,
    includedMatchedWordCount: 0,
    finalIncludedUnionWordCount: 0,
    excludedSelfMatchedWordCount: 0,
    excludedEffectiveDeviceSelfMatchedWordCount: 0,
    excludedUnknownMatchedWordCount: 0,
    archiveOnlyWordCount: 0,
    scholarlyOnlyWordCount: 0,
    priorSubmissionOnlyWordCount: 0,
    multiSourceOverlapWordCount: 0,
    scoreDerivation: { numerator: 0, denominator: 1, rawPercent: 0, roundedPercent: 0, cappedAt100: false },
    unionAccumulationOrder: [],
    unattributedUnionWordCount: 0,
    sources: [],
    zeroScoreExplanation: null,
    fullCoverageExplanation: null,
    deviceShadow,
    scoreUnchangedByDeviceShadow: true,
    corpusDuplicateSuppressionShadow,
    scoreUnchangedByCorpusDuplicateShadow: true,
    deviceSelfSharedGuard,
  };
}

export function buildAdminSimilarityDecisionTrace(
  input: BuildAdminSimilarityDecisionTraceInput,
): AdminSimilarityDecisionTrace {
  const unified = input.unifiedSimilarity;
  if (!unified) {
    return emptyTrace(input, "UNIFIED_SIMILARITY_NOT_PERSISTED");
  }

  const wordCount =
    Number.isInteger(unified.wordCount) && unified.wordCount > 0 ? unified.wordCount : 0;

  // Ground truth: the ONE canonical included union computeUnifiedSimilarity
  // itself scored (archive ∪ live-academic ∪ eligible-prior). Never
  // recomputed — read straight off the persisted result.
  const groundTruthUnion = new Set<number>(
    (unified.matchedPositions ?? []).filter(
      (position) => Number.isInteger(position) && position >= 0 && position < wordCount,
    ),
  );

  // ----- reconstruct each source's own matched-position footprint ---------
  const factsByRep: Record<string, DecisionTraceHistoricalMatchFacts> = {
    ...(input.historicalMatchFacts ?? {}),
  };
  for (const match of input.historicalSubmissionMatch?.matches ?? []) {
    if (factsByRep[match.matchedRepresentationId]) continue;
    factsByRep[match.matchedRepresentationId] = {
      matchType: match.matchType,
      containment: match.containment,
      passageCount: match.passageCount,
      longestMatchWords: match.longestMatchWords,
      historicalSubmissionCount: match.historicalSubmissionCount,
      matchedWordCount: match.matchedWordCount,
    };
  }

  const academicTitleByKey = new Map<string, string | null>();
  for (const evidence of input.externalAcademicEvidence ?? []) {
    const key = academicIdentityKey(evidence);
    if (!academicTitleByKey.has(key)) academicTitleByKey.set(key, evidence.title ?? null);
  }

  const reconstructed: ReconstructedSource[] = [];

  // Archive channel — a single blended set of matched positions (individual
  // archive source spans are not preserved on the report payload).
  const archivePositions = new Set<number>(
    (input.archiveMatchedPositions ?? []).filter(
      (position) => Number.isInteger(position) && position >= 0 && position < wordCount,
    ),
  );
  const archiveContributesToGroundTruth =
    unified.archiveOnlyWords > 0 || unified.overlapWords > 0 || archivePositions.size > 0;
  if (archivePositions.size > 0 || archiveContributesToGroundTruth) {
    reconstructed.push({
      sourceKey: "archive",
      sourceKind: "ARCHIVE",
      label: "TurnitPlus reference archive",
      sourceId: null,
      relationshipType: "N/A",
      effectiveScoringRelationship: "N/A",
      effectiveScoringReason: null,
      positions: archivePositions,
      evidenceStatus: "included",
    });
  }

  // Live-academic + previous-upload channels — grouped by contribution
  // sourceId, first-seen order preserved.
  const groupIndex = new Map<string, number>();
  let scholarlyOrdinal = 0;
  let priorOrdinal = 0;
  for (const contribution of unified.contributions ?? []) {
    const isArchive = contribution.sourceType === "archive";
    if (isArchive) continue; // archive contributions are not emitted by computeUnifiedSimilarity, but guard anyway
    const groupKey = `${contribution.sourceType === "previous_upload" ? "prior" : "scholarly"}:${contribution.sourceId}`;
    let index = groupIndex.get(groupKey);
    if (index === undefined) {
      const isPrior = contribution.sourceType === "previous_upload";
      const relationshipType: DecisionTraceRelationship = isPrior
        ? ((contribution.relationship ?? "PRIOR_SUBMISSION") as DecisionTraceRelationship)
        : "N/A";
      const label = isPrior
        ? priorSubmissionLabel(relationshipType, contribution.sourceId)
        : scholarlySourceLabel(contribution.sourceId, academicTitleByKey.get(contribution.sourceId) ?? null);
      const sourceKey = isPrior
        ? `prior:${priorOrdinal++}`
        : `scholarly:${scholarlyOrdinal++}`;
      // The Preview-gated same-device SELF rule downgrades a WHOLE source
      // (representation), so every contribution in a "prior" group carries the
      // same effectiveScoringRelationship — seeded here from the first-seen
      // contribution, reinforced below if a later one disagrees. A DOWNGRADE
      // is signalled ONLY by contribution.effectiveScoringRelationship ===
      // "SELF" (set by computeUnifiedSimilarity for an effective-device-self
      // exclusion) — a source whose BASELINE relationship is already "SELF"
      // (an ordinary same-account SELF match) is not a downgrade, so its
      // effectiveScoringReason stays null.
      const isDowngradedToSelf = isPrior && contribution.effectiveScoringRelationship === "SELF";
      const effectiveScoringRelationship: DecisionTraceRelationship =
        isDowngradedToSelf ? "SELF" : relationshipType;
      const effectiveScoringReason: "SAME_DEVICE_EXACT_DOCUMENT" | "SAME_DEVICE_STRONG_TEXT_DOCUMENT" | null =
        isDowngradedToSelf ? contribution.effectiveScoringReason ?? "SAME_DEVICE_EXACT_DOCUMENT" : null;
      index = reconstructed.length;
      groupIndex.set(groupKey, index);
      reconstructed.push({
        sourceKey,
        sourceKind: isPrior ? "PREVIOUS_SUBMISSION" : "SCHOLARLY",
        label,
        sourceId: contribution.sourceId,
        relationshipType,
        effectiveScoringRelationship,
        effectiveScoringReason,
        positions: new Set<number>(),
        evidenceStatus: contribution.evidenceStatus,
      });
    }
    const target = reconstructed[index];
    // A group's evidenceStatus is stable across its own contributions (all
    // share one relationship); keep the strictest (excluded) if they ever
    // disagree.
    if (contribution.evidenceStatus !== "included") target.evidenceStatus = contribution.evidenceStatus;
    if (contribution.effectiveScoringRelationship === "SELF" && target.relationshipType !== "SELF") {
      target.effectiveScoringRelationship = "SELF";
      target.effectiveScoringReason = contribution.effectiveScoringReason ?? "SAME_DEVICE_EXACT_DOCUMENT";
    }
    const clamped = clampInclusiveRange(
      contribution.submittedWordStart,
      contribution.submittedWordEnd,
      wordCount,
    );
    if (clamped) addInclusive(target.positions, clamped[0], clamped[1]);
  }

  // ----- accumulate the included union in a documented, stable order ------
  const running = new Set<number>();
  const unionAccumulationOrder: string[] = [];
  let excludedSelfSourceCount = 0;
  let excludedUnknownSourceCount = 0;
  let excludedEffectiveDeviceSelfSourceCount = 0;

  const sources: DecisionTraceSource[] = reconstructed.map((source) => {
    const facts = source.sourceId ? factsByRep[source.sourceId] : undefined;
    const rawMatchedWordCount = source.positions.size;

    const excludedSelf = source.evidenceStatus === "excluded_self";
    const excludedUnknown = source.evidenceStatus === "excluded_unknown";
    const excludedDeviceSelf = source.evidenceStatus === "excluded_effective_device_self";
    if (excludedSelf) excludedSelfSourceCount += 1;
    if (excludedUnknown) excludedUnknownSourceCount += 1;
    if (excludedDeviceSelf) excludedEffectiveDeviceSelfSourceCount += 1;

    // "counted" positions = this source's footprint intersected with the
    // canonical included union computeUnifiedSimilarity actually scored.
    const countedPositions = excludedSelf || excludedUnknown || excludedDeviceSelf
      ? new Set<number>()
      : new Set<number>([...source.positions].filter((position) => groundTruthUnion.has(position)));
    const countedWordCount = countedPositions.size;

    let newUniqueWordContribution = 0;
    if (countedWordCount > 0) {
      for (const position of countedPositions) {
        if (!running.has(position)) {
          newUniqueWordContribution += 1;
          running.add(position);
        }
      }
      unionAccumulationOrder.push(source.sourceKey);
    }
    const overlappingWordCount = countedWordCount - newUniqueWordContribution;

    let countedTowardScore: boolean;
    let countedReason: DecisionTraceCountedReason | null = null;
    let exclusionReason: DecisionTraceExclusionReason | null = null;
    let contributionNote: DecisionTraceSource["contributionNote"] = null;

    if (excludedSelf) {
      countedTowardScore = false;
      exclusionReason = "EXCLUDED_SELF";
    } else if (excludedDeviceSelf) {
      countedTowardScore = false;
      exclusionReason = "EXCLUDED_EFFECTIVE_DEVICE_SELF";
    } else if (excludedUnknown) {
      countedTowardScore = false;
      exclusionReason = "EXCLUDED_UNKNOWN_RELATIONSHIP";
    } else if (rawMatchedWordCount === 0) {
      countedTowardScore = false;
      exclusionReason = "NO_VERIFIED_CORRESPONDENCE";
    } else if (countedWordCount === 0) {
      // eligible relationship, real footprint, but every position was
      // clamped out or (defensively) not part of the scored union.
      countedTowardScore = false;
      exclusionReason = "NO_VERIFIED_CORRESPONDENCE";
    } else {
      countedTowardScore = true;
      countedReason = countedReasonFor(source);
      if (newUniqueWordContribution === 0) contributionNote = "ALL_POSITIONS_ALREADY_COUNTED";
    }

    return {
      sourceKey: source.sourceKey,
      sourceKind: source.sourceKind,
      label: source.label,
      sourceId: source.sourceId,
      relationshipType: source.relationshipType,
      effectiveScoringRelationship: source.effectiveScoringRelationship,
      effectiveScoringReason: source.effectiveScoringReason,
      matchType: (facts?.matchType as DecisionTraceMatchType) ?? "N/A",
      containment: facts ? facts.containment : null,
      historicalSubmissionCount: facts ? facts.historicalSubmissionCount : null,
      productionReportedMatchedWordCount: facts ? facts.matchedWordCount : null,
      rawMatchedWordCount,
      countedWordCount,
      newUniqueWordContribution,
      overlappingWordCount,
      countedTowardScore,
      countedReason,
      exclusionReason,
      contributionNote,
      accountEvidence: source.sourceId
        ? input.accountEvidenceByRepresentation?.[source.sourceId] ?? null
        : null,
      deviceEvidence: source.sourceId
        ? input.deviceEvidenceByRepresentation?.[source.sourceId] ?? null
        : null,
    };
  });

  const unattributedUnionWordCount = groundTruthUnion.size - running.size;

  // ----- final-score derivation (mirrors combineMatchedWordPositions) ----
  const includedUnionWordCount = groundTruthUnion.size;
  const denominator = Math.max(1, wordCount);
  const rawPercent = (includedUnionWordCount / denominator) * 100;
  const roundedPercent = Math.round(rawPercent);
  const cappedAt100 = roundedPercent > 100;
  const finalScore = Math.min(100, roundedPercent);

  // ----- zero / full-coverage explanations ------------------------------
  let zeroScoreExplanation: DecisionTraceZeroExplanation | null = null;
  if (finalScore === 0) {
    const anyFootprint = reconstructed.some((source) => source.positions.size > 0);
    let reason: DecisionTraceZeroReason;
    let detail: string;
    if (wordCount === 0) {
      reason = "SUBMISSION_EMPTY";
      detail = "The submission has no counted words, so there is nothing to match against.";
    } else if (!anyFootprint) {
      reason = "NO_MATCHES_FOUND";
      detail = "No archive, scholarly, or previous-submission source reported any matching words.";
    } else if (
      includedUnionWordCount === 0 &&
      (excludedSelfSourceCount > 0 || excludedUnknownSourceCount > 0 || excludedEffectiveDeviceSelfSourceCount > 0)
    ) {
      reason = "MATCHES_PRESENT_BUT_ALL_EXCLUDED";
      detail =
        `${excludedSelfSourceCount} SELF, ${excludedEffectiveDeviceSelfSourceCount} effective same-device SELF, and ` +
        `${excludedUnknownSourceCount} UNKNOWN-relationship source(s) reported matches, ` +
        "but SELF, same-device SELF, and UNKNOWN matches are all excluded from the score.";
    } else {
      reason = "VERIFIED_MATCHES_CONTRIBUTE_ZERO_NEW_POSITIONS";
      detail =
        "Matches were reported, but none of their word positions survived into the final counted union.";
    }
    zeroScoreExplanation = {
      reason,
      detail,
      excludedSelfSourceCount,
      excludedEffectiveDeviceSelfSourceCount,
      excludedUnknownSourceCount,
      candidateRejectionDetailAvailable: false,
    };
  }

  let fullCoverageExplanation: DecisionTraceFullCoverageExplanation | null = null;
  if (wordCount > 0 && includedUnionWordCount === wordCount) {
    fullCoverageExplanation = {
      reason: "INCLUDED_UNION_COVERS_EVERY_SUBMITTED_WORD",
      submittedWordCount: wordCount,
      includedUnionWordCount,
      drivingSources: sources
        .filter((source) => source.newUniqueWordContribution > 0)
        .map((source) => source.sourceKey),
    };
  }

  const deviceShadow = input.deviceShadow
    ? projectDeviceShadow(input.deviceShadow, Boolean(input.hasVerifiedUploadPassport))
    : null;
  const deviceSelfSharedGuard = input.deviceSelfSharedGuard
    ? projectDeviceSelfSharedGuard(input.deviceSelfSharedGuard)
    : null;
  const corpusDuplicateSuppressionShadow = input.corpusDuplicateSuppressionShadow
    ? projectCorpusDuplicateShadow(input.corpusDuplicateSuppressionShadow)
    : null;

  return {
    schemaVersion: ADMIN_SIMILARITY_DECISION_TRACE_SCHEMA_VERSION,
    resolvable: true,
    unresolvableReason:
      input.historicalSubmissionMatch?.status === "UNAVAILABLE" ? "HISTORICAL_MATCH_UNAVAILABLE" : null,
    finalScore,
    finalScoreBasis: "UNIFIED",
    submittedWordCount: wordCount,
    includedMatchedWordCount: includedUnionWordCount,
    finalIncludedUnionWordCount: includedUnionWordCount,
    excludedSelfMatchedWordCount: num(unified.selfExcludedWords),
    excludedEffectiveDeviceSelfMatchedWordCount: num(unified.deviceSelfExcludedWords),
    excludedUnknownMatchedWordCount: num(unified.unknownExcludedWords),
    archiveOnlyWordCount: num(unified.archiveOnlyWords),
    scholarlyOnlyWordCount: num(unified.liveAcademicOnlyWords),
    priorSubmissionOnlyWordCount: num(unified.previousUploadOnlyWords),
    multiSourceOverlapWordCount: num(unified.overlapWords),
    scoreDerivation: {
      numerator: includedUnionWordCount,
      denominator,
      rawPercent,
      roundedPercent,
      cappedAt100,
    },
    unionAccumulationOrder,
    unattributedUnionWordCount,
    sources,
    zeroScoreExplanation,
    fullCoverageExplanation,
    deviceShadow,
    scoreUnchangedByDeviceShadow: true,
    corpusDuplicateSuppressionShadow,
    scoreUnchangedByCorpusDuplicateShadow: true,
    deviceSelfSharedGuard,
  };
}

function countedReasonFor(source: ReconstructedSource): DecisionTraceCountedReason {
  if (source.sourceKind === "ARCHIVE") return "COUNTED_ARCHIVE_SOURCE";
  if (source.sourceKind === "SCHOLARLY") return "COUNTED_SCHOLARLY_SOURCE";
  if (source.relationshipType === "TURNITPLUS_CORPUS_SOURCE") return "COUNTED_CORPUS_SOURCE";
  return "COUNTED_PRIOR_SUBMISSION";
}

function priorSubmissionLabel(relationship: DecisionTraceRelationship, repId: string): string {
  const shortId = repId.length > 12 ? `${repId.slice(0, 8)}…` : repId;
  if (relationship === "TURNITPLUS_CORPUS_SOURCE") return `TurnitPlus corpus reference source (${shortId})`;
  if (relationship === "SELF") return `Your own earlier TurnitPlus submission (${shortId})`;
  if (relationship === "UNKNOWN_RELATIONSHIP") return `Unclassified prior TurnitPlus submission (${shortId})`;
  return `Prior TurnitPlus submission by another account (${shortId})`;
}

function scholarlySourceLabel(identityKey: string, title: string | null): string {
  if (title && title.trim()) return `${title.trim()} [${identityKey}]`;
  return `Live academic source [${identityKey}]`;
}
