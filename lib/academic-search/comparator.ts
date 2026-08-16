import {
  computeDocumentCorrespondence,
  DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS,
  type DocumentCorrespondenceThresholds,
} from "../document-correspondence";
import type { MatchedPassage } from "./types";

/**
 * Stage 7 of the pipeline (local comparison). Deliberately NOT a new
 * similarity algorithm: this is a thin wrapper around
 * lib/document-correspondence.ts's computeDocumentCorrespondence, which is
 * already the project's purpose-built "does this specific retrieved
 * external text correspond to this specific submitted document" engine
 * (Phase E6C) — independently thresholded from report-scoring, exactly the
 * property STEP 6 asks for ("keep this entirely separate from score,
 * archiveScore, aiScore, verifiedSimilarity, historical-match state, E8S").
 * Reusing it here is the "cleanest integration point" for comparison:
 * reimplementing shingle containment a second time would only add a second,
 * competing algorithm with no behavioral benefit.
 */

export type ComparisonResult = {
  /** 0..100, from computeDocumentCorrespondence's containment — "how much of the submission's distinctive content appears in this external source." */
  similarity: number;
  matchedPassages: MatchedPassage[];
  /** lib/document-correspondence.ts's own strongCorrespondence verdict (containment + matched-word floor), passed through unchanged. */
  strongMatch: boolean;
  exactMatch: boolean;
};

export function compareSubmissionToExternalText(
  submittedText: string,
  externalText: string,
  thresholds: DocumentCorrespondenceThresholds = DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS,
): ComparisonResult {
  const result = computeDocumentCorrespondence(submittedText, externalText, thresholds);
  return {
    similarity: Math.round(result.containment * 100),
    matchedPassages: result.passages.map((passage) => ({
      submittedText: passage.submittedText,
      submittedWordStart: passage.submittedWordStart,
      submittedWordEnd: passage.submittedWordEnd,
      matchedWordCount: passage.matchedWordCount,
    })),
    strongMatch: result.strongCorrespondence,
    exactMatch: result.exactCanonicalMatch,
  };
}
