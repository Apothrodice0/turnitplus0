import { grams, gramHash, mergeAdjacentPositions, tokens } from "../similarity-core";
import {
  IMPORTED_SIMILARITY_EVIDENCE_SHINGLE_SIZE,
  type ImportedSimilarityEvidenceSourceAttributionState,
  type ImportedSimilarityEvidenceUnit,
} from "./types";
import type { ImportedSimilarityEvidencePackage } from "./package";

/**
 * IMPORTED SIMILARITY EVIDENCE — candidate lookup + exact verification +
 * score-mask projection. Implements implementation-spec.md's validated
 * algorithm (Steps 1-5) exactly:
 *
 *   1. CANDIDATE LOOKUP  — every 5-word shingle of a unit's own anchorTokens
 *      is indexed, tagged with its offset WITHIN that unit's own token
 *      sequence, so a document-side hit implies where the unit's window
 *      would have to start.
 *   2. DOCUMENT SCAN     — the submission is tokenized with the SAME
 *      tokenizer (lib/similarity-core.ts's tokens()) used to build every
 *      unit's own anchorTokens (see ./package.ts's tokenizer-parity check at
 *      load time) and shingled the same way.
 *   3. EXACT VERIFICATION — a shared shingle is candidate discovery ONLY. A
 *      match requires an exact, word-for-word comparison of the FULL anchor
 *      window; this is the one and only step that may turn a candidate into
 *      a scored match.
 *   4. SCORE MASK APPLICATION — only scoreMaskRelativePositions (never the
 *      whole anchor window) are credited on a verified match.
 *   5. UNION ACROSS OCCURRENCES — every qualifying occurrence of a unit
 *      contributes (final-policy.md's multi-occurrence product decision);
 *      their score-mask positions are unioned per unit, then merged into
 *      contiguous runs (lib/similarity-core.ts's mergeAdjacentPositions) so
 *      the output can flow through the same
 *      {submittedWordStart,submittedWordEnd,matchedWordCount} passage shape
 *      every other unified-similarity evidence channel already uses.
 */

type CandidateEntry = { unitIndex: number; internalOffset: number };

export type ImportedSimilarityEvidenceCandidateIndex = {
  packageContentSha256: string;
  units: readonly ImportedSimilarityEvidenceUnit[];
  byGramHash: ReadonlyMap<string, readonly CandidateEntry[]>;
};

/** Builds the candidate-discovery index once per loaded package (see ./index.ts's cache). A gram hit is candidate discovery only — it never scores by itself. */
export function buildImportedSimilarityEvidenceCandidateIndex(
  pkg: ImportedSimilarityEvidencePackage,
): ImportedSimilarityEvidenceCandidateIndex {
  const byGramHash = new Map<string, CandidateEntry[]>();
  pkg.units.forEach((unit, unitIndex) => {
    const unitGrams = grams([...unit.anchorTokens], IMPORTED_SIMILARITY_EVIDENCE_SHINGLE_SIZE);
    unitGrams.forEach((gram, internalOffset) => {
      const hash = gramHash(gram);
      const bucket = byGramHash.get(hash);
      if (bucket) bucket.push({ unitIndex, internalOffset });
      else byGramHash.set(hash, [{ unitIndex, internalOffset }]);
    });
  });
  return { packageContentSha256: pkg.metadata.contentSha256, units: pkg.units, byGramHash };
}

export type ImportedSimilarityEvidenceMatchedPassage = {
  submittedWordStart: number;
  submittedWordEnd: number;
  matchedWordCount: number;
};

export type ImportedSimilarityEvidenceMatchedSource = {
  sourceId: string;
  matchedPassages: ImportedSimilarityEvidenceMatchedPassage[];
  /** For internal audit/debugging attribution only (STEP 11) — never used to decide whether/how this source scores. */
  sourceAttributionState: ImportedSimilarityEvidenceSourceAttributionState;
  evidenceSetId: string;
};

/**
 * Runs candidate discovery + exact verification + score-mask projection for
 * one submission against a candidate index. Returns one entry per unit that
 * verified at least once, in package unit order. Pure, synchronous,
 * deterministic; never throws — a pathological/empty submission simply
 * yields no matches.
 */
export function matchImportedSimilarityEvidence(
  submissionText: string,
  index: ImportedSimilarityEvidenceCandidateIndex,
): ImportedSimilarityEvidenceMatchedSource[] {
  if (index.units.length === 0) return [];
  const submissionTokens = tokens(submissionText);
  if (submissionTokens.length < IMPORTED_SIMILARITY_EVIDENCE_SHINGLE_SIZE) return [];

  const submissionGrams = grams(submissionTokens, IMPORTED_SIMILARITY_EVIDENCE_SHINGLE_SIZE);

  // Deduplicate (unitIndex, candidateStart) pairs before verification — a
  // unit's anchor can hit the same implied start position via more than one
  // of its own internal shingles; verification must run at most once per
  // pair regardless of how many shingles pointed at it.
  const candidateStartsByUnit = new Map<number, Set<number>>();
  for (let gramIndex = 0; gramIndex < submissionGrams.length; gramIndex += 1) {
    const bucket = index.byGramHash.get(gramHash(submissionGrams[gramIndex]));
    if (!bucket) continue;
    for (const { unitIndex, internalOffset } of bucket) {
      const candidateStart = gramIndex - internalOffset;
      if (candidateStart < 0) continue;
      let starts = candidateStartsByUnit.get(unitIndex);
      if (!starts) { starts = new Set<number>(); candidateStartsByUnit.set(unitIndex, starts); }
      starts.add(candidateStart);
    }
  }

  const matched: ImportedSimilarityEvidenceMatchedSource[] = [];
  for (const [unitIndex, candidateStarts] of candidateStartsByUnit) {
    const unit = index.units[unitIndex];
    const verifiedPositions = new Set<number>();

    for (const candidateStart of candidateStarts) {
      if (candidateStart + unit.anchorTokenCount > submissionTokens.length) continue; // out of bounds — never a match

      // EXACT VERIFICATION — the ONLY step that turns a candidate into a
      // match. A shared 5-gram alone is never sufficient by itself.
      let exact = true;
      for (let offset = 0; offset < unit.anchorTokenCount; offset += 1) {
        if (submissionTokens[candidateStart + offset] !== unit.anchorTokens[offset]) { exact = false; break; }
      }
      if (!exact) continue;

      // MULTIPLE_VERIFIED_OCCURRENCES_COUNT = YES (final-policy.md): every
      // qualifying occurrence projects its own score mask; this loop never
      // stops after the first verified occurrence.
      for (const relative of unit.scoreMaskRelativePositions) verifiedPositions.add(candidateStart + relative);
    }

    if (verifiedPositions.size === 0) continue;
    const runs = mergeAdjacentPositions(verifiedPositions);
    matched.push({
      sourceId: unit.evidenceUnitId,
      matchedPassages: runs.map(([start, end]) => ({
        submittedWordStart: start,
        submittedWordEnd: end,
        matchedWordCount: end - start + 1,
      })),
      sourceAttributionState: unit.sourceAttributionState,
      evidenceSetId: unit.evidenceSetId,
    });
  }
  return matched;
}
