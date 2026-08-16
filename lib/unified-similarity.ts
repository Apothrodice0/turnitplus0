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
export type UnifiedEvidenceStatus = "included" | "excluded_self" | "excluded_unknown";

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
  /** Only present for sourceType "previous_upload". */
  relationship?: HistoricalSubmissionMatchEntry["relationshipType"];
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
  /** Matched words from SELF-relationship entries — computed for transparency (STEP 6/benchmark reporting) but NEVER included in unifiedScore. DECISION 1: no override. */
  selfExcludedWords: number;
  /** Matched words from UNKNOWN_RELATIONSHIP entries — same transparency-only treatment. DECISION 2: no override, no guessing. */
  unknownExcludedWords: number;
  /** Full per-passage attribution, including excluded entries (see evidenceStatus) — internal use (debugging, calibration, a future admin view), never rendered to an end user as-is. */
  contributions: UnifiedEvidenceContribution[];
};

export type ComputeUnifiedSimilarityParams = {
  wordCount: number;
  /** SimilarityReport.archiveMatchedPositions — reused exactly as computed by app/similarity-worker.ts's analyze(), never reconstructed from the displayed archive percentage. */
  archiveMatchedPositions?: number[] | null;
  /** SimilarityReport.externalAcademicEvidence — already gated at the orchestrator's own evidence threshold (Phase 2/3) before ever reaching this function; every passage here already represents a CONFIRMED comparison, never a discovery-only/topic-only/metadata-only candidate (those never make it into this array to begin with). */
  externalAcademicEvidence?: ExternalAcademicEvidence[] | null;
  /** SimilarityReport.historicalSubmissionMatch — already gated at strongCorrespondence/exactCanonicalMatch by lib/user-submission-matching.ts before this function sees it; relationshipType is inspected here, never re-derived. */
  historicalSubmissionMatch?: ReportHistoricalSubmissionMatch | null;
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
  let selfExcludedWords = 0;
  let unknownExcludedWords = 0;
  const seenPriorRepresentation = new Set<string>();
  if (params.historicalSubmissionMatch?.status === "MATCHED") {
    for (const match of params.historicalSubmissionMatch.matches ?? []) {
      const identityKey = match.matchedRepresentationId;
      const firstOccurrence = !seenPriorRepresentation.has(identityKey);
      seenPriorRepresentation.add(identityKey);

      const status: UnifiedEvidenceStatus =
        match.relationshipType === "SELF" ? "excluded_self"
        : match.relationshipType === "UNKNOWN_RELATIONSHIP" ? "excluded_unknown"
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
  const allEligiblePositions = new Set<number>([...archiveSet, ...liveSet, ...priorSet]);
  for (const position of allEligiblePositions) {
    const sourcesHere = (archiveSet.has(position) ? 1 : 0) + (liveSet.has(position) ? 1 : 0) + (priorSet.has(position) ? 1 : 0);
    if (sourcesHere > 1) { overlapWords += 1; continue; }
    if (archiveSet.has(position)) archiveOnlyWords += 1;
    else if (liveSet.has(position)) liveAcademicOnlyWords += 1;
    else previousUploadOnlyWords += 1;
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
    contributions,
  };
}
