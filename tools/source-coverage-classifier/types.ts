/**
 * TurnitPlus source-coverage failure classifier — V1 (post adversarial-review repair).
 *
 * OFFLINE DIAGNOSTIC TOOLING ONLY. This module classifies WHY an expected
 * source was or was not recovered, by re-running the same frozen, already-
 * live matching primitives (lib/academic-search/comparator.ts's
 * compareSubmissionToExternalText, lib/selective-corpus/verify.ts's
 * admitSelectiveCorpusCandidate) against caller-supplied case data. It
 * implements NO new discovery, retrieval, extraction, matching, or admission
 * logic of its own, and changes NO threshold — see academic-search-lane.ts
 * and selective-corpus-lane.ts for exactly which existing function/constant
 * each outcome is read from.
 *
 * Not imported by app/ or any production route, and not a runtime
 * dependency of the live product. Does not import the DEAD discovery/
 * retrieval/provenance/E7 pipeline (lib/discovery-*.ts,
 * lib/retrieval-repository.ts, lib/retrieval-correspondence-bridge.ts,
 * lib/provenance-*.ts, lib/source-discovery-workflow*.ts, lib/e7-*.ts) — it
 * DOES import the type-only RetrievalStatus vocabulary from
 * lib/retrieval-types.ts, which is a live, already-shared dependency of
 * production's own lib/academic-search/text-retriever.ts, not part of the
 * dead pipeline. See tests/source-coverage-classifier.test.mjs's
 * structural-safety tests for the exact, justified allowlist.
 */

export type SourceCoverageLane = "ACADEMIC_SEARCH" | "SELECTIVE_CORPUS";

export type SourceCoverageOutcome =
  | "SOURCE_ABSENT"
  | "CANDIDATE_MISSED"
  | "RETRIEVAL_FAILED"
  | "EXTRACTION_FAILED"
  | "MATCHER_FAILED"
  | "ADMISSION_OR_ATTRIBUTION_FAILED"
  | "VERIFIED_RECOVERED";

export type SourceCoverageFailureStage =
  | "ground-truth"
  | "discovery"
  | "retrieval"
  | "extraction"
  | "matcher"
  | "admission"
  | "recovered";

/**
 * An inclusive [start,end] word-index span into the manuscript's own
 * tokens() sequence — the same position space lib/document-correspondence.ts's
 * CorrespondencePassage and lib/selective-corpus/verify.ts's
 * SelectiveCorpusVerifiedSpan already use. Valid indices are
 * 0 .. manuscriptWordCount-1 (confirmed against lib/document-correspondence.ts's
 * own `submittedWords.slice(start, end + 1)` usage — see
 * verified-word-count.ts's own header comment for the full derivation).
 */
export type VerifiedWordSpan = { start: number; end: number };

export type MatcherDiagnosticsSummary = {
  /** Whether the real matcher actually ran for this case (false for cases resolved before reaching it — ground-truth/discovery/retrieval/extraction failures). */
  ran: boolean;
  /** 0..100 — lib/document-correspondence.ts's containment, unchanged. null when the underlying pipeline output for this lane does not expose it (see each lane's own comment) — never fabricated. */
  similarity: number | null;
  strongMatch: boolean | null;
  exactMatch: boolean | null;
  /** Raw union of every span the matcher returned, regardless of whether the lane's own evidence/admission gate accepted it — informational only, never the success metric. See verifiedMatchedWordCount. */
  rawMatchedWordCount: number | null;
  longestSpanWords: number | null;
};

export type AdmissionDiagnosticsSummary = {
  admitted: boolean;
  /** lib/selective-corpus/verify.ts's own reason string, passed through verbatim — never paraphrased or re-derived. */
  reason: string;
  strictSpanPass: boolean;
  dominantSpanBoilerplate: boolean;
  familyGuardActivated: boolean;
  sourceSpecificWords: number;
};

export type SourceCoverageClassification = {
  caseId: string;
  lane: SourceCoverageLane;
  outcome: SourceCoverageOutcome;
  failureStage: SourceCoverageFailureStage;
  reasonCode: string;
  reasonDetail: string;
  expectedSourceId: string;
  candidateRank: number | null;
  retrievalSource: "provider" | "http-fallback" | "unavailable" | "artifact-text" | null;
  matcherDiagnostics: MatcherDiagnosticsSummary | null;
  admissionDiagnostics: AdmissionDiagnosticsSummary | null;
  /**
   * PRIMARY SUCCESS METRIC. Manuscript words actually verified by the
   * existing, lane-appropriate matcher/admission gate — the exact union of
   * verified word positions, each manuscript word counted once regardless of
   * how many spans cover it. 0 when the case is not VERIFIED_RECOVERED (a
   * real, exact fact: zero words were accepted as recovered evidence for
   * this expected source) — never null merely because nothing recovered.
   * null ONLY when the supplied case data structurally lacks exact position
   * information to derive this — never a fabricated estimate.
   */
  verifiedMatchedWordCount: number | null;
  diagnostics: Record<string, unknown>;
};

/**
 * Thrown when a case-input object is missing a field its own other fields
 * require, or contains a self-contradictory combination (e.g. proven-absent
 * ground truth supplied alongside a "discovered" state, or retrieved text
 * supplied alongside a "retrieval unavailable" state). Both lane classifiers
 * validate their input up front and throw this rather than silently
 * resolving the contradiction by branch order.
 */
export class SourceCoverageInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceCoverageInputError";
  }
}

/**
 * Thrown by verified-word-count.ts's unionVerifiedWordCount when a supplied
 * span (or the manuscript word count itself) is malformed — never silently
 * repaired (no endpoint swapping, no clamping), so a caller's bug surfaces
 * immediately instead of producing a plausible-looking wrong count.
 */
export class SourceCoverageSpanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceCoverageSpanValidationError";
  }
}
