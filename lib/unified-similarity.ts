import type { ExternalAcademicEvidence } from "./academic-search/types";
import { combineMatchedWordPositions, type ExternalMatchedWordRange } from "./similarity-enrichment";
import type { HistoricalSubmissionMatchEntry, ReportHistoricalSubmissionMatch } from "./report-types";

/**
 * Phase 4A: the unified-similarity computation — EXPERIMENTAL, additive,
 * not wired into report generation, not used by score/archiveScore/E8S/E8P.
 * See the Phase 4 design report for why this shape was chosen (in short:
 * every source already reports matched positions as indices into the
 * SAME tokenization of the submission — lib/similarity-core.ts's tokens(),
 * verified empirically across real documents up to 13,430 words — so a
 * plain word-position union is a valid, meaningful merge; the three
 * sources' own reported percentages are NOT on the same scale and must
 * never be combined directly).
 *
 * Deliberately reuses lib/similarity-enrichment.ts's
 * combineMatchedWordPositions() for the actual union+score arithmetic —
 * the same function already merging archive + Wikipedia positions into
 * `report.score` in production today — rather than inventing a second
 * merge algorithm. This file's own job is narrower: decide WHICH ranges
 * from WHICH sources are even eligible to reach that function, which is
 * where the real design risk lives (see DECISION 1/2 below), plus a
 * diagnostic per-source breakdown the existing function doesn't compute.
 */

export const UNIFIED_SIMILARITY_VERSION = "unified-similarity-v1";

export type UnifiedEvidenceSourceType = "archive" | "openaire" | "europe_pmc" | "previous_upload";
/**
 * "excluded_effective_device_self": a production-counted previous-upload
 * source the Preview-gated same-device SELF rule
 * (lib/report-primary-similarity.ts, flag DEVICE_PASSPORT_SELF_ENABLED)
 * downgraded to an EFFECTIVE SELF for scoring — treated exactly like
 * "excluded_self" here (contributes nothing), but tracked under its own
 * status/counter so genuine same-account SELF telemetry stays unchanged, and
 * the contribution still records the unchanged BASELINE relationship. Only
 * ever produced when the caller passes effectiveDeviceSelfRepresentationIds.
 */
export type UnifiedEvidenceStatus = "included" | "excluded_self" | "excluded_unknown" | "excluded_effective_device_self";

/**
 * One passage's contribution, kept for internal source attribution (STEP
 * "DATA MODEL": "Preserve source attribution internally"). Never surfaced
 * as a standalone plagiarism claim — `evidenceStatus` records exactly why
 * an excluded entry was excluded, so the exclusion itself stays auditable
 * rather than silently disappearing.
 */
export type UnifiedEvidenceContribution = {
  sourceType: UnifiedEvidenceSourceType;
  /** Stable identity for this contribution's underlying document — a bare-lowercased DOI when available, else a canonical URL, else a provider/representation id. Used only for internal dedup/attribution, never displayed as-is. */
  sourceId: string;
  submittedWordStart: number;
  /** Inclusive, matching MatchedPassage/HistoricalMatchPassage's own existing convention — NOT the half-open convention combineMatchedWordPositions's own ExternalMatchedWordRange uses internally. */
  submittedWordEnd: number;
  matchedWordCount: number;
  /**
   * Only present for sourceType "previous_upload". This is the UNCHANGED
   * BASELINE relationship production's matcher persisted (e.g.
   * TURNITPLUS_CORPUS_SOURCE) — the same-device SELF rule never rewrites it;
   * see effectiveScoringRelationship below.
   */
  relationship?: HistoricalSubmissionMatchEntry["relationshipType"];
  /**
   * Set ONLY when the Preview-gated same-device SELF rule downgraded this
   * "previous_upload" contribution to an effective SELF for scoring. The
   * baseline `relationship` above is preserved verbatim; this records the
   * EFFECTIVE SCORING RELATIONSHIP that was applied before the matched-
   * position union, so an admin can see both. Absent for every other
   * contribution.
   */
  effectiveScoringRelationship?: "SELF";
  /**
   * Why the effective relationship differs from the baseline:
   * "SAME_DEVICE_EXACT_DOCUMENT" for a byte-identical canonical re-upload,
   * "SAME_DEVICE_STRONG_TEXT_DOCUMENT" for a near-identical (STRONG_TEXT_MATCH)
   * one. Both exclude the contribution from the score identically. Paired with
   * effectiveScoringRelationship.
   */
  effectiveScoringReason?: "SAME_DEVICE_EXACT_DOCUMENT" | "SAME_DEVICE_STRONG_TEXT_DOCUMENT";
  evidenceStatus: UnifiedEvidenceStatus;
};

export type UnifiedSimilarityResult = {
  version: typeof UNIFIED_SIMILARITY_VERSION;
  wordCount: number;
  /** 0..100 — DECISION 3: an experimental, additive field. Never read by, or written into, score/archiveScore/aiScore/verifiedSimilarity/E8S/E8P. */
  unifiedScore: number;
  uniqueMatchedWords: number;
  /** Words matched ONLY by the archive (no live-academic or eligible-prior-upload overlap at that position). */
  archiveOnlyWords: number;
  /** Words matched ONLY by live academic evidence (OpenAIRE and/or Europe PMC — already deduplicated upstream by lib/academic-search/deduplicator.ts before this function ever sees them). */
  liveAcademicOnlyWords: number;
  /** Words matched ONLY by an eligible (non-SELF, non-UNKNOWN) previous-upload match. */
  previousUploadOnlyWords: number;
  /** Words matched by more than one source at the same submitted position — the exact case the CRITICAL RULE example describes ("the same submitted passage found by multiple sources counts ONCE"), reported here as a count of how often that happened, not lost. */
  overlapWords: number;
  /** Matched words from SELF-relationship entries — computed for transparency (STEP 6/benchmark reporting) but NEVER included in unifiedScore. DECISION 1: no override. Genuine same-account SELF only — an effective same-device SELF downgrade is tallied under deviceSelfExcludedWords below so this figure is unchanged by that Preview rule. */
  selfExcludedWords: number;
  /** Matched words from UNKNOWN_RELATIONSHIP entries — same transparency-only treatment. DECISION 2: no override, no guessing. */
  unknownExcludedWords: number;
  /**
   * Matched words from a production-counted historical source the Preview-
   * gated same-device SELF rule (lib/report-primary-similarity.ts, flag
   * DEVICE_PASSPORT_SELF_ENABLED) downgraded to an EFFECTIVE SELF for scoring
   * — excluded from unifiedScore exactly like selfExcludedWords, tracked
   * separately so genuine same-account SELF telemetry is untouched. Always 0
   * unless the caller passed effectiveDeviceSelfRepresentationIds (i.e. 0 in
   * every configuration where that flag is off).
   */
  deviceSelfExcludedWords: number;
  /** Full per-passage attribution, including excluded entries (see evidenceStatus) — internal use (debugging, calibration, a future admin view), never rendered to an end user as-is. */
  contributions: UnifiedEvidenceContribution[];
  /**
   * Highlighting fix: the deduplicated union of every word position that
   * contributed to unifiedScore/uniqueMatchedWords — previously computed
   * internally (as allEligiblePositions, just below) purely to derive the
   * *OnlyWords/overlapWords counts, then discarded. Persisting it here is
   * the ONE canonical, presentation-safe position set the render layer
   * must read (never independently recompute or infer from a percentage)
   * to visually account for the full matched-word result — see
   * lib/report-types.ts's unifiedMatchedPositions() and this codebase's
   * own LEGACY ROOM BUG precedent for why "throws away the position union,
   * persists only counts" is exactly the class of gap that produces a
   * correct number with an incomplete presentation. Word indices only —
   * carries no source identity, so it needs no privacy gating.
   */
  matchedPositions: number[];
  /**
   * The exclusive subset of matchedPositions attributable ONLY to the
   * previous-upload/corpus-source channel (both PRIOR_SUBMISSION and
   * TURNITPLUS_CORPUS_SOURCE relationship types alike — the same
   * "included" set previousUploadOnlyWords already counts, just as
   * positions instead of a count). Deliberately carries no
   * matchedRepresentationId, no relationshipType, no account/report
   * identity of any kind — privacy-safe by construction, needed so the
   * render layer can draw ONE generic "TurnitPlus reference sources"
   * highlight/Source Details entry without ever touching per-contribution
   * sourceId data (which stays admin-only — see UnifiedEvidenceContribution's
   * own comment and app/reports/[id]/page.tsx's contributions stripping for
   * non-admins).
   */
  previousUploadPositions: number[];
};

export type ComputeUnifiedSimilarityParams = {
  wordCount: number;
  /** SimilarityReport.archiveMatchedPositions — reused exactly as computed by app/similarity-worker.ts's analyze(), never reconstructed from the displayed archive percentage. */
  archiveMatchedPositions?: number[] | null;
  /** SimilarityReport.externalAcademicEvidence — already gated at the orchestrator's own evidence threshold (Phase 2/3) before ever reaching this function; every passage here already represents a CONFIRMED comparison, never a discovery-only/topic-only/metadata-only candidate (those never make it into this array to begin with). */
  externalAcademicEvidence?: ExternalAcademicEvidence[] | null;
  /** SimilarityReport.historicalSubmissionMatch — already gated at strongCorrespondence/exactCanonicalMatch by lib/user-submission-matching.ts before this function sees it; relationshipType is inspected here, never re-derived. */
  historicalSubmissionMatch?: ReportHistoricalSubmissionMatch | null;
  /**
   * matchedRepresentationId values that the Preview-gated same-device SELF
   * rule (lib/report-primary-similarity.ts, flag DEVICE_PASSPORT_SELF_ENABLED
   * — resolved from the report's OWN verified upload Device Passport plus the
   * deterministic per-backing provenance evidence, NEVER from
   * historical_match_shadow_evaluations) has classified as an EFFECTIVE SELF
   * for scoring: a production-counted historical source whose matchType is an
   * EXACT_CANONICAL_MATCH or a STRONG_TEXT_MATCH, backed only by the report's
   * own verified passport with zero independent backing (see
   * lib/device-self-scoring-rule.ts's classifyDeviceSelfMatch).
   *
   * Their matched positions are excluded from the scored union exactly like a
   * SELF-relationship match — WITHOUT rewriting production's persisted
   * relationshipType: the contribution keeps its baseline `relationship` and
   * gains effectiveScoringRelationship "SELF" plus an effectiveScoringReason of
   * "SAME_DEVICE_EXACT_DOCUMENT" (exact) or "SAME_DEVICE_STRONG_TEXT_DOCUMENT"
   * (strong). Independent archive / scholarly positions are untouched (they
   * enter the union through their own channels).
   *
   * Empty / absent (the production default) => this function's output is
   * byte-identical to before this parameter existed.
   */
  effectiveDeviceSelfRepresentationIds?: readonly string[] | ReadonlySet<string> | null;
};

function clampedPositions(start: number, end: number, wordCount: number): [number, number] | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return null;
  const clampedStart = Math.max(0, start);
  const clampedEnd = Math.min(wordCount - 1, end);
  if (clampedEnd < clampedStart || wordCount <= 0) return null;
  return [clampedStart, clampedEnd];
}

function addRange(target: Set<number>, start: number, end: number): void {
  for (let position = start; position <= end; position += 1) target.add(position);
}

/**
 * Phase 4B finding: lib/document-correspondence.ts's computeDocumentCorrespondence
 * deliberately short-circuits on an exact canonical-text match (see that
 * file's own header comment — "checked first as a cheap, unambiguous
 * short-circuit") and returns matchedWordCount = the full submitted word
 * count WITHOUT populating `passages` (its emptyResult() helper hard-codes
 * passages: [] and the exact-match branch never overrides it — there was
 * never a prior consumer that needed passages for this branch). Discovered
 * via a real end-to-end PRIOR_SUBMISSION test
 * (tests/unified-similarity-relationship-integration.test.mjs, SCENARIO C)
 * where a genuine matchedWordCount=77 exact match silently contributed 0 to
 * unifiedScore because this function previously read ONLY match.passages.
 * Falling back to the full [0, wordCount) range for this one specific case
 * reflects the real matcher's own documented semantics (exactCanonicalMatch
 * means the ENTIRE submission matched) rather than inventing new matching
 * logic — lib/document-correspondence.ts and lib/user-submission-matching.ts
 * are not modified.
 */
function previousUploadPassageRanges(
  match: HistoricalSubmissionMatchEntry,
  wordCount: number,
): Array<{ submittedWordStart: number; submittedWordEnd: number; matchedWordCount: number }> {
  if (match.passages && match.passages.length > 0) return match.passages;
  if (match.matchType === "EXACT_CANONICAL_MATCH" && match.matchedWordCount > 0 && wordCount > 0) {
    return [{ submittedWordStart: 0, submittedWordEnd: wordCount - 1, matchedWordCount: match.matchedWordCount }];
  }
  return [];
}

/** DOI first, then canonical URL, then provider:externalId — the exact identity precedence lib/academic-search/deduplicator.ts already uses; duplicated here (not imported) since this file intentionally has no dependency on lib/academic-search/ beyond the plain ExternalAcademicEvidence type, matching this project's existing convention of small, independent identity-key helpers per consumer (see components/report/similarity-report-papers.tsx's own dedupeExternalAcademicEvidence). Purely a defensive second pass — evidence[] should already be unique by the time it reaches this function. */
function academicIdentityKey(evidence: ExternalAcademicEvidence): string {
  if (evidence.doi) return `doi:${evidence.doi.trim().toLowerCase()}`;
  if (evidence.url) return `url:${evidence.url.trim().toLowerCase()}`;
  return `provider:${evidence.provider}:${evidence.providerId}`;
}

function academicSourceType(provider: string): UnifiedEvidenceSourceType {
  if (provider === "europe-pmc") return "europe_pmc";
  // "openaire" and any future provider id both fall back to the openaire
  // bucket's shape here (sourceType is diagnostic, not scoring — an unknown
  // future provider still contributes its matched words correctly either
  // way; only the label would be imprecise until this map is extended).
  return "openaire";
}

/**
 * Constructs the eligible unified matched-position set from three already-
 * independently-gated sources, then hands it to the existing, unmodified
 * combineMatchedWordPositions() for the actual union+score arithmetic —
 * see this file's own header comment for why no second merge algorithm was
 * written. Pure, synchronous, deterministic; never throws (malformed/
 * missing input degrades to "that source contributes nothing," never an
 * error — matching every other stage of this pipeline's own "absence is a
 * normal outcome" discipline).
 */
export function computeUnifiedSimilarity(params: ComputeUnifiedSimilarityParams): UnifiedSimilarityResult {
  const wordCount = Number.isInteger(params.wordCount) && params.wordCount > 0 ? params.wordCount : 0;

  // The Preview-gated same-device SELF rule's already-decided set of
  // representation ids (see effectiveDeviceSelfRepresentationIds' own comment).
  // Empty when the caller passed nothing — the production default.
  const effectiveDeviceSelfSet: ReadonlySet<string> =
    params.effectiveDeviceSelfRepresentationIds instanceof Set
      ? params.effectiveDeviceSelfRepresentationIds
      : new Set(params.effectiveDeviceSelfRepresentationIds ?? []);

  const archivePositions = (params.archiveMatchedPositions ?? []).filter(
    (position) => Number.isInteger(position) && position >= 0 && position < wordCount,
  );
  const archiveSet = new Set(archivePositions);

  const eligibleRanges: ExternalMatchedWordRange[] = [];
  const liveSet = new Set<number>();
  const priorSet = new Set<number>();
  const contributions: UnifiedEvidenceContribution[] = [];

  // --- Source: live academic evidence (OpenAIRE / Europe PMC) ---------------
  const seenAcademic = new Set<string>();
  for (const evidence of params.externalAcademicEvidence ?? []) {
    const identityKey = academicIdentityKey(evidence);
    const firstOccurrence = !seenAcademic.has(identityKey);
    seenAcademic.add(identityKey);
    const sourceType = academicSourceType(evidence.provider);

    for (const passage of evidence.matchedPassages ?? []) {
      const clamped = clampedPositions(passage.submittedWordStart, passage.submittedWordEnd, wordCount);
      contributions.push({
        sourceType,
        sourceId: identityKey,
        submittedWordStart: passage.submittedWordStart,
        submittedWordEnd: passage.submittedWordEnd,
        matchedWordCount: passage.matchedWordCount,
        evidenceStatus: "included",
      });
      if (!clamped || !firstOccurrence) continue; // defensive dedup: a repeated identity's positions are already covered by its first occurrence
      const [start, end] = clamped;
      addRange(liveSet, start, end);
      eligibleRanges.push({ wordStart: start, wordEnd: end + 1 });
    }
  }

  // --- Source: previous uploads / growing corpus -----------------------------
  // DECISION 1 (no override): SELF is always excluded.
  // DECISION 2 (no guessing): UNKNOWN_RELATIONSHIP is always excluded.
  // Preview rule: an EFFECTIVE same-device SELF is also excluded — the
  // baseline relationshipType is left exactly as production persisted it.
  let selfExcludedWords = 0;
  let unknownExcludedWords = 0;
  let deviceSelfExcludedWords = 0;
  const seenPriorRepresentation = new Set<string>();
  if (params.historicalSubmissionMatch?.status === "MATCHED") {
    for (const match of params.historicalSubmissionMatch.matches ?? []) {
      const identityKey = match.matchedRepresentationId;
      const firstOccurrence = !seenPriorRepresentation.has(identityKey);
      seenPriorRepresentation.add(identityKey);

      // Only a production-counted baseline relationship can be downgraded — a
      // genuine SELF / UNKNOWN_RELATIONSHIP is already excluded and keeps its
      // own status and its own tally.
      const isEffectiveDeviceSelf =
        effectiveDeviceSelfSet.has(identityKey) &&
        match.relationshipType !== "SELF" &&
        match.relationshipType !== "UNKNOWN_RELATIONSHIP";

      const status: UnifiedEvidenceStatus =
        match.relationshipType === "SELF" ? "excluded_self"
        : match.relationshipType === "UNKNOWN_RELATIONSHIP" ? "excluded_unknown"
        : isEffectiveDeviceSelf ? "excluded_effective_device_self"
        : "included";

      const passageRanges = previousUploadPassageRanges(match, wordCount);
      for (const passage of passageRanges) {
        contributions.push({
          sourceType: "previous_upload",
          sourceId: identityKey,
          submittedWordStart: passage.submittedWordStart,
          submittedWordEnd: passage.submittedWordEnd,
          matchedWordCount: passage.matchedWordCount,
          relationship: match.relationshipType,
          ...(isEffectiveDeviceSelf
            ? {
                effectiveScoringRelationship: "SELF" as const,
                effectiveScoringReason:
                  match.matchType === "STRONG_TEXT_MATCH"
                    ? ("SAME_DEVICE_STRONG_TEXT_DOCUMENT" as const)
                    : ("SAME_DEVICE_EXACT_DOCUMENT" as const),
              }
            : {}),
          evidenceStatus: status,
        });
      }

      if (!firstOccurrence) continue; // same underlying representation already accounted for once — "the growing corpus must not count the same underlying article five times"

      if (status === "excluded_self") {
        selfExcludedWords += match.matchedWordCount;
        continue;
      }
      if (status === "excluded_unknown") {
        unknownExcludedWords += match.matchedWordCount;
        continue;
      }
      if (status === "excluded_effective_device_self") {
        deviceSelfExcludedWords += match.matchedWordCount;
        continue;
      }
      for (const passage of passageRanges) {
        const clamped = clampedPositions(passage.submittedWordStart, passage.submittedWordEnd, wordCount);
        if (!clamped) continue;
        const [start, end] = clamped;
        addRange(priorSet, start, end);
        eligibleRanges.push({ wordStart: start, wordEnd: end + 1 });
      }
    }
  }

  // --- The existing, unmodified merge/scoring function does the real work ---
  const combined = combineMatchedWordPositions(archivePositions, eligibleRanges, wordCount);

  // --- Diagnostic per-source breakdown (new, but plain Set arithmetic over
  //     the same three position sets above — not a second scoring engine) ---
  let archiveOnlyWords = 0;
  let liveAcademicOnlyWords = 0;
  let previousUploadOnlyWords = 0;
  let overlapWords = 0;
  const previousUploadPositions: number[] = [];
  const allEligiblePositions = new Set<number>([...archiveSet, ...liveSet, ...priorSet]);
  for (const position of allEligiblePositions) {
    const sourcesHere = (archiveSet.has(position) ? 1 : 0) + (liveSet.has(position) ? 1 : 0) + (priorSet.has(position) ? 1 : 0);
    if (sourcesHere > 1) { overlapWords += 1; continue; }
    if (archiveSet.has(position)) archiveOnlyWords += 1;
    else if (liveSet.has(position)) liveAcademicOnlyWords += 1;
    else { previousUploadOnlyWords += 1; previousUploadPositions.push(position); }
  }

  return {
    version: UNIFIED_SIMILARITY_VERSION,
    wordCount,
    unifiedScore: combined.score,
    uniqueMatchedWords: combined.matchedWordCount,
    archiveOnlyWords,
    liveAcademicOnlyWords,
    previousUploadOnlyWords,
    overlapWords,
    selfExcludedWords,
    unknownExcludedWords,
    deviceSelfExcludedWords,
    contributions,
    matchedPositions: [...allEligiblePositions].sort((left, right) => left - right),
    previousUploadPositions: previousUploadPositions.sort((left, right) => left - right),
  };
}
