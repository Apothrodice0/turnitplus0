import { canonicalSha256 } from "./document-identity";
import { documentShingleHashes } from "./document-family";
import { acceptedSimilaritySpans, containment, grams, gramHash, informativeGram, tokens } from "./similarity-core";

/**
 * Phase E6C: the pure provenance-correspondence engine — deliberately
 * separate from the report-scoring pipeline (lib/similarity-core.ts's own
 * consumers in app/similarity-worker.ts, lib/similarity-enrichment.ts).
 * This module answers a narrower, different question: "does THIS specific
 * retrieved external text correspond to THIS specific submitted document,"
 * for provenance-evidence purposes — never "what is this document's
 * verified-similarity score." Nothing here is imported by, or imports,
 * any report-scoring file — see tests/provenance-scoring-invariance.test.mjs,
 * extended in this phase.
 *
 * Reuses lib/similarity-core.ts's primitives (tokens/grams/informativeGram/
 * gramHash/containment/acceptedSimilaritySpans) and lib/document-family.ts's
 * documentShingleHashes exactly as Phase B already does for document-family
 * matching — this is the same "distinctive shingle" concept applied to an
 * external source instead of another TurnitPlus submission, not a second,
 * competing algorithm. informativeGram()'s existing common-word/length
 * filter is what keeps generic phrases ("Introduction," "The results of
 * this study indicate...") from ever contributing a matching shingle — see
 * this phase's own task description, section 16.
 *
 * Passage text in the output is a RECONSTRUCTION from normalized/matched
 * words (join(" ") of the matched span's tokens), not a verbatim excerpt of
 * the original submission — a deliberate, documented simplification, not a
 * hidden inaccuracy: the task's own field list allows "matched passage text
 * OR safe bounded representation," and reconstructing from already-matched
 * tokens is exactly that. External-source passage position is left null
 * (this method proves a submitted passage's shingles appear SOMEWHERE in
 * the external text's shingle set, not at a specific tracked position in
 * it) — recorded honestly as unavailable rather than guessed.
 */

export type DocumentCorrespondenceThresholds = {
  /** Independent of Phase B's DEFAULT_DOCUMENT_FAMILY_THRESHOLDS.shingleSize and of the live report-scoring pipeline's own shingle size — see this phase's own task description, section 14: "Create provenance-correspondence configuration separately." */
  shingleSize: number;
  /** Distinct name and distinct value from any report-scoring threshold, deliberately — see this phase's own task description, section 14 example (DOCUMENT_CORRESPONDENCE_THRESHOLD vs REPORT_SIMILARITY_THRESHOLD). */
  strongContainmentThreshold: number;
  minimumMatchedWords: number;
  minimumPassageLengthWords: number;
  maxPassages: number;
  maxPassageWords: number;
};

/**
 * A starting point for testing/development, not a calibrated or permanent
 * product decision (this phase's own task description, section 15: "Do NOT
 * claim they are calibrated yet") — same disclaimer as
 * lib/document-family-config.ts's DEFAULT_DOCUMENT_FAMILY_THRESHOLDS and
 * lib/discovery-candidates.ts's DEFAULT_CANDIDATE_RANKING_WEIGHTS.
 */
export const DOCUMENT_CORRESPONDENCE_THRESHOLDS_VERSION = "document-correspondence-thresholds-v1";

export const DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS: DocumentCorrespondenceThresholds = {
  shingleSize: 5,
  strongContainmentThreshold: 0.6,
  minimumMatchedWords: 20,
  minimumPassageLengthWords: 8,
  maxPassages: 10,
  maxPassageWords: 60,
};

export type CorrespondencePassage = {
  submittedText: string;
  submittedWordStart: number;
  submittedWordEnd: number;
  /** Null — this method does not track a specific position within the external text; see this file's own header comment. */
  externalWordStart: number | null;
  matchedWordCount: number;
};

export type DocumentCorrespondenceResult = {
  method: "canonical_hash" | "shingle_containment";
  /** shared informative shingles / min(submitted, external) shingle count — lib/similarity-core.ts's existing containment() definition. */
  containment: number;
  /** shared informative shingles / external shingle count — "how much of the EXTERNAL page's distinctive content is accounted for by the match," distinct from `containment` above. */
  sourceConcentration: number;
  /** Raw count of shared informative shingles between the two texts. */
  overlapSharedShingleCount: number;
  matchedWordCount: number;
  submittedWordCount: number;
  externalWordCount: number;
  longestMatchWords: number;
  passages: CorrespondencePassage[];
  thresholds: DocumentCorrespondenceThresholds;
  thresholdsVersion: string;
  exactCanonicalMatch: boolean;
  strongCorrespondence: boolean;
};

function emptyResult(
  method: DocumentCorrespondenceResult["method"],
  submittedWordCount: number,
  externalWordCount: number,
  thresholds: DocumentCorrespondenceThresholds,
  overrides: Partial<DocumentCorrespondenceResult> = {},
): DocumentCorrespondenceResult {
  return {
    method,
    containment: 0,
    sourceConcentration: 0,
    overlapSharedShingleCount: 0,
    matchedWordCount: 0,
    submittedWordCount,
    externalWordCount,
    longestMatchWords: 0,
    passages: [],
    thresholds,
    thresholdsVersion: DOCUMENT_CORRESPONDENCE_THRESHOLDS_VERSION,
    exactCanonicalMatch: false,
    strongCorrespondence: false,
    ...overrides,
  };
}

/**
 * Compares a submitted document's text against a retrieved external
 * source's text. Pure and deterministic — no I/O, no randomness. Order of
 * checks: an exact canonical-text match (reusing lib/document-identity.ts's
 * canonicalSha256, the same hash Phase A already computes for every
 * submission) is checked first as a cheap, unambiguous short-circuit;
 * otherwise falls through to shingle-based containment.
 */
export function computeDocumentCorrespondence(
  submittedText: string,
  externalText: string,
  thresholds: DocumentCorrespondenceThresholds = DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS,
): DocumentCorrespondenceResult {
  const submittedWordCount = tokens(submittedText).length;
  const externalWordCount = tokens(externalText).length;

  // Two empty (or whitespace-only) texts are technically canonically
  // identical, but a comparison against no real content is meaningless and
  // must never be reported as correspondence — this guards against a
  // degenerate empty submission or a retrieval that slipped through as
  // "SUCCESS" with vacuous extracted text ever producing a misleading
  // exact-match evidence record.
  if (submittedWordCount === 0 || externalWordCount === 0) {
    return emptyResult("shingle_containment", submittedWordCount, externalWordCount, thresholds);
  }

  if (canonicalSha256(submittedText) === canonicalSha256(externalText)) {
    return emptyResult("canonical_hash", submittedWordCount, externalWordCount, thresholds, {
      containment: 1,
      sourceConcentration: 1,
      matchedWordCount: submittedWordCount,
      longestMatchWords: submittedWordCount,
      exactCanonicalMatch: true,
      strongCorrespondence: true,
    });
  }

  const submittedShingles = documentShingleHashes(submittedText, thresholds.shingleSize);
  const externalShingles = documentShingleHashes(externalText, thresholds.shingleSize);
  if (submittedShingles.size === 0 || externalShingles.size === 0) {
    return emptyResult("shingle_containment", submittedWordCount, externalWordCount, thresholds);
  }

  let sharedCount = 0;
  for (const hash of submittedShingles) if (externalShingles.has(hash)) sharedCount += 1;

  const submittedWords = tokens(submittedText);
  const matchedPositions = new Set<number>();
  const submittedGrams = grams(submittedWords, thresholds.shingleSize);
  for (let index = 0; index < submittedGrams.length; index += 1) {
    const gram = submittedGrams[index];
    if (!informativeGram(gram)) continue;
    if (!externalShingles.has(gramHash(gram))) continue;
    for (let position = index; position < index + thresholds.shingleSize; position += 1) matchedPositions.add(position);
  }

  const { acceptedGlobalSpans, acceptedPositions } = acceptedSimilaritySpans(
    new Map([[0, matchedPositions]]),
    thresholds.minimumPassageLengthWords,
  );

  const passages: CorrespondencePassage[] = acceptedGlobalSpans
    .map(([start, end]): CorrespondencePassage => {
      const words = submittedWords.slice(start, Math.min(end + 1, start + thresholds.maxPassageWords));
      return {
        submittedText: words.join(" "),
        submittedWordStart: start,
        submittedWordEnd: end,
        externalWordStart: null,
        matchedWordCount: end - start + 1,
      };
    })
    .sort((a, b) => b.matchedWordCount - a.matchedWordCount)
    .slice(0, thresholds.maxPassages);

  const longestMatchWords = acceptedGlobalSpans.reduce((max, [start, end]) => Math.max(max, end - start + 1), 0);
  const overallContainment = containment(sharedCount, submittedShingles.size, externalShingles.size);
  const sourceConcentration = sharedCount / Math.max(1, externalShingles.size);
  const strongCorrespondence = overallContainment >= thresholds.strongContainmentThreshold
    && acceptedPositions.size >= thresholds.minimumMatchedWords;

  return {
    method: "shingle_containment",
    containment: overallContainment,
    sourceConcentration,
    overlapSharedShingleCount: sharedCount,
    matchedWordCount: acceptedPositions.size,
    submittedWordCount,
    externalWordCount,
    longestMatchWords,
    passages,
    thresholds,
    thresholdsVersion: DOCUMENT_CORRESPONDENCE_THRESHOLDS_VERSION,
    exactCanonicalMatch: false,
    strongCorrespondence,
  };
}
