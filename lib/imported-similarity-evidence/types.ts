/**
 * IMPORTED SIMILARITY EVIDENCE — generic types.
 *
 * A production-capable scoring channel for text-passage evidence imported
 * from a previously-issued third-party similarity report (e.g. a Turnitin
 * report the account holder supplies for a manuscript). Structurally this is
 * a lighter-weight, gram-hash-indexed passage store — closer to the static
 * Archive search index than to the SQL-backed compact-fingerprint scheme
 * (lib/archive-fingerprint.ts) — so its own normalization/version identifier
 * is deliberately independent of ARCHIVE_COMPACT_FINGERPRINT_VERSION; see
 * IMPORTED_SIMILARITY_EVIDENCE_NORMALIZATION_VERSION below.
 *
 * No file in this directory ever contains report-derived passage text, a
 * report SHA used as behavior logic, or a hardcoded score. The actual
 * evidence data is an external, versioned package loaded at runtime (see
 * ./package.ts) — these are only the shapes it must conform to.
 */

/** Only provenance this channel currently supports; a fail-closed union (not a bare string) so an unrecognized future value is a type error, not a silent pass-through. */
export type ImportedSimilarityEvidenceProvenanceType = "TURNITIN_REPORT_IMPORT";

/**
 * How confidently the evidence unit's underlying original source is known.
 * Preserves the validated distinction — never claim an original source is
 * verified when it is not:
 *
 *  - ORIGINAL_SOURCE_VERIFIED: the actual original source document/URL was
 *    independently resolved and confirmed to contain this passage.
 *  - ORIGINAL_SOURCE_IDENTIFIED_BUT_NOT_OWNED: a plausible original source
 *    was identified (e.g. from the report's own source list) but not
 *    independently verified/owned by this system.
 *  - TURNITIN_SOURCE_MARKER_ONLY: the report attributed this passage to one
 *    of its own numbered source markers, with no further independent
 *    resolution performed.
 *  - REPORT_DERIVED_REFERENCE: the passage is known only because the report
 *    itself flagged it; no source marker or identity is available at all.
 */
export type ImportedSimilarityEvidenceSourceAttributionState =
  | "ORIGINAL_SOURCE_VERIFIED"
  | "ORIGINAL_SOURCE_IDENTIFIED_BUT_NOT_OWNED"
  | "TURNITIN_SOURCE_MARKER_ONLY"
  | "REPORT_DERIVED_REFERENCE";

export type ImportedSimilarityEvidenceConfidence = "HIGH" | "MEDIUM";

/**
 * One record per imported report. Groups the units extracted from that
 * report and carries report-level provenance that would be wasteful to
 * repeat per unit — see production-data-model.md (validated design).
 */
export type ImportedSimilarityEvidenceSet = {
  evidenceSetId: string;
  provenanceType: ImportedSimilarityEvidenceProvenanceType;
  /** Provenance metadata only. Never read by any scoring/matching logic. */
  reportSha256: string;
  /** Provenance metadata only. Never read by any scoring/matching logic — see the module header comment: no hardcoded score override exists anywhere in this channel. */
  reportedSimilarityPercent: number | null;
  normalizationVersion: string;
  /** sha256 of the manuscript this set's units were extracted from, when known. Provenance/audit only. */
  manuscriptIdentitySha256: string | null;
  createdAt: string;
  unitCount: number;
  totalScoreMaskWords: number;
};

/**
 * One passage-level evidence unit — the reusable detection primitive. NOT a
 * raw geometry span; each unit's anchor is a merged, safety-filtered window
 * (validated design: production-import-coverage.json's MIN_ANCHOR_WINDOW/
 * MAX_INTERNAL_GAP filtering).
 */
export type ImportedSimilarityEvidenceUnit = {
  evidenceUnitId: string;
  evidenceSetId: string;
  provenanceType: ImportedSimilarityEvidenceProvenanceType;
  reportSha256: string;
  reportedSimilarityPercent: number | null;
  normalizationVersion: string;
  sourceAttributionState: ImportedSimilarityEvidenceSourceAttributionState;
  /** The report's own numbered source badges, where geometrically recovered. Empty when none were resolved. */
  sourceMarkerNumbers: readonly number[];
  /** Human-readable source names/titles, where available (audit/attribution only — never a customer-facing source-search control). */
  sourceNames: readonly string[];
  /**
   * The unit's FULL normalized window (not just the highlighted sub-words) —
   * this is what candidate lookup indexes AND what verification compares
   * exactly. See production-data-model.md's own header comment for why this
   * carries the full window rather than only the credited words: it is what
   * makes short/common highlighted fragments safely reusable — they can
   * never trigger a match on their own, only as part of a verified,
   * sufficiently-long, exact surrounding passage.
   */
  anchorNormalizedText: string;
  /**
   * anchorNormalizedText, pre-tokenized with this channel's own production
   * tokenizer (lib/similarity-core.ts's tokens()) — computed once at package
   * build/load time so every consumer shares the identical word sequence.
   * Always anchorNormalizedText re-derived, never a second, independently
   * maintained token list.
   */
  anchorTokens: readonly string[];
  anchorTokenCount: number;
  /** sha256(anchorNormalizedText) — exact-match dedup across imports and package integrity checks. */
  anchorTextSha256: string;
  /**
   * 0-based offsets INTO the anchor window that are actually credited on a
   * verified match — NOT "all anchor tokens." Gap-filler tokens used to
   * build a safe-length anchor must match exactly for verification to
   * succeed, but are never themselves claimed as matched. Strictly
   * ascending, de-duplicated, each within [0, anchorTokenCount).
   */
  scoreMaskRelativePositions: readonly number[];
  scoreMaskWordCount: number;
  /** Provenance back to the original geometry extraction. Audit trail only — never read by matching/scoring logic. */
  goldSpanIds: readonly string[];
  /** Where this exact anchor text was originally observed in the source report's own manuscript. Audit/provenance only — never required for, or used by, matching against a NEW manuscript. */
  originalManuscriptTokenPositions: readonly number[];
  originalReportPage: number | null;
  confidence: ImportedSimilarityEvidenceConfidence;
  createdAt: string;
};

/** The exact value this channel currently standardizes on — see the module header comment for why it is independent of ARCHIVE_COMPACT_FINGERPRINT_VERSION. Bump this (and reject/ignore any package built under a different value) whenever the tokenization word-boundary rule, Unicode normalization form, or punctuation-stripping rule this channel relies on changes. */
export const IMPORTED_SIMILARITY_EVIDENCE_NORMALIZATION_VERSION = "imported-similarity-evidence-v1";

/** Candidate-lookup shingle size. Matches the shipped Archive index's own shingle size for consistency (implementation-spec.md) — the two representations are not otherwise related, so this is not derived from any Archive constant. */
export const IMPORTED_SIMILARITY_EVIDENCE_SHINGLE_SIZE = 5;

/** One word beyond the bare shingle floor — see final-policy.md's negative-control finding: the sole 5-token unit at the bare floor was the one false-positive source across 30 unrelated real documents. */
export const IMPORTED_SIMILARITY_EVIDENCE_MIN_ANCHOR_WINDOW = 6;
