import type { SpecifiedValue } from "./corpus-admission-types";

/**
 * "First accepted sample wins" article-family resolution (requirement 2).
 * Pure — no I/O, no database — callers supply an already-computed
 * containment reading from wherever the candidate pool lives:
 * lib/corpus-admission-gate.ts queries the REAL
 * corpus_document_representations/corpus_document_shingles via
 * lib/user-submission-corpus.ts's existing corpusShingleHashes/
 * findCandidateCorpusRepresentations (whose own returned `containment`
 * field is reused directly here, not recomputed) for cross-run duplicates,
 * while tools/corpus-admission-dry-run.ts additionally supplies an
 * in-process, never-persisted registry of candidates already ACCEPTed
 * earlier in the same batch, computing containment the same way via
 * lib/similarity-core.ts's containment(). Both funnel through this one
 * resolver.
 *
 * containment() (lib/similarity-core.ts) is already symmetric — its
 * denominator is Math.min(a, b) — so no separate "symmetric similarity"
 * implementation exists anywhere in this feature.
 */

export const CORPUS_ADMISSION_FAMILY_POLICY_VERSION = "corpus-admission-family-v1";

export type CorpusFamilyCandidate = {
  /** Opaque identifier of the earlier family member — a representation id (real corpus) or an earlier-in-batch decision's sourceRef (in-batch registry). */
  sourceRef: string;
  canonicalSha256: string;
  wordCount: number;
  /** Already-computed via lib/similarity-core.ts's symmetric containment() — see this module's own header comment for why it is not recomputed here. */
  containment: number;
};

export type CorpusFamilyResolution =
  | { relation: "NONE" }
  | { relation: "EXACT_DUPLICATE"; matchedSourceRef: string }
  | { relation: "EDITED_VERSION"; matchedSourceRef: string; containment: number };

export type CorpusFamilyThresholds = {
  /** Containment (shared / min(targetShingles, candidateShingles)) at or above which two documents are treated as the same article, edited/reformatted. */
  editedVersionContainmentFloor: SpecifiedValue<number>;
  /** min(wordCountA, wordCountB) / max(wordCountA, wordCountB) at or above which two documents are "compatible lengths" — keeps a short excerpt of a much longer article from resolving as "the same article." */
  lengthCompatibilityFloor: SpecifiedValue<number>;
};

export const DEFAULT_CORPUS_FAMILY_THRESHOLDS: CorpusFamilyThresholds = {
  editedVersionContainmentFloor: { value: 0.85, status: "ENGINEERING_DEFAULT", rationale: "Placeholder pending 770-article calibration (spec section 6) — high enough that ordinary topical/citation overlap between two different articles should not cross it, while a lightly-edited reupload of the same article should." },
  lengthCompatibilityFloor: { value: 0.7, status: "ENGINEERING_DEFAULT", rationale: "Placeholder — keeps a short excerpt/abstract from resolving as 'the same article' as a much longer work it partially overlaps, since high containment alone does not distinguish those two cases." },
};

function lengthCompatible(wordCountA: number, wordCountB: number, floor: number): boolean {
  if (wordCountA <= 0 || wordCountB <= 0) return false;
  return Math.min(wordCountA, wordCountB) / Math.max(wordCountA, wordCountB) >= floor;
}

export function resolveCorpusArticleFamily(
  target: { canonicalSha256: string; wordCount: number },
  candidates: CorpusFamilyCandidate[],
  thresholds: CorpusFamilyThresholds = DEFAULT_CORPUS_FAMILY_THRESHOLDS,
): CorpusFamilyResolution {
  const exactMatch = candidates.find((c) => c.canonicalSha256 === target.canonicalSha256);
  if (exactMatch) return { relation: "EXACT_DUPLICATE", matchedSourceRef: exactMatch.sourceRef };

  let best: { candidate: CorpusFamilyCandidate; containment: number } | null = null;
  for (const candidate of candidates) {
    if (!lengthCompatible(target.wordCount, candidate.wordCount, thresholds.lengthCompatibilityFloor.value)) continue;
    const value = candidate.containment;
    if (value >= thresholds.editedVersionContainmentFloor.value && (best === null || value > best.containment)) {
      best = { candidate, containment: value };
    }
  }

  if (best) return { relation: "EDITED_VERSION", matchedSourceRef: best.candidate.sourceRef, containment: best.containment };
  return { relation: "NONE" };
}
